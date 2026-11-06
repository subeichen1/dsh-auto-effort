import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The plugin resolves its state file from the home directory at import time, so point that at a
// scratch directory before loading it: the suite must never read or write the real mode file.
const scratchHome = mkdtempSync(join(tmpdir(), 'ae-home-'))
process.env.USERPROFILE = scratchHome
process.env.HOME = scratchHome

const { apply } = await import('../index.js')

const heavy = '重构整个项目的测试与部署流水线，排查并发死锁和内存泄漏。\n```js\nconst x = 1\n```\n'
  + '填充内容。'.repeat(300)

function makeHarness(config, llm) {
  const handlers = new Map()
  const routes = new Map()
  const ctx = {
    on(name, fn) {
      const list = handlers.get(name) || []
      list.push(fn)
      handlers.set(name, list)
    },
    get(name) {
      return name === 'llm' ? llm : undefined
    },
    inject(names, factory) {
      factory({
        get: (name) => (name === 'webServer'
          ? {
            register: (route) => {
              routes.set(route.path, route)
              return () => routes.delete(route.path)
            },
          }
          : undefined),
        effect: (fn) => fn(),
      })
    },
  }
  apply(ctx, config)
  return {
    routes,
    async claim(message, turn, sessionId) {
      for (const fn of handlers.get('agent/inbox/claimed') || []) {
        await fn({ message, turn, agent: { session: { id: sessionId } } }, async () => undefined)
      }
    },
    async request(turn, seed, sessionId) {
      let result
      for (const fn of handlers.get('agent/request') || []) {
        result = await fn({ turn, agent: { session: { id: sessionId } } }, async () => seed)
      }
      return result
    },
  }
}

function makeLlm(efforts) {
  return {
    resolveModelInfo: async () => ({
      reasoning: { efforts: efforts.map((id) => ({ id })), defaultEffort: efforts[0] },
    }),
  }
}

function mockRequest(method, headers, body, url) {
  const listeners = new Map()
  return {
    method,
    url,
    headers,
    on(event, listener) {
      listeners.set(event, listener)
      if (event === 'end') {
        setImmediate(() => {
          if (body !== undefined) {
            const data = listeners.get('data')
            if (data !== undefined) data(body)
          }
          listener()
        })
      }
      return this
    },
  }
}

function callRoute(route, options) {
  const method = options.method === undefined ? 'GET' : options.method
  // Every route is reached over loopback in real use, and the host guard is part of the contract.
  const headers = { host: '127.0.0.1:10175', ...(options.headers === undefined ? {} : options.headers) }
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(key, value) { this.headers[key.toLowerCase()] = value },
      end(text) {
        resolve({
          status: this.statusCode,
          headers: this.headers,
          body: typeof text === 'string' && text !== '' ? JSON.parse(text) : null,
        })
      },
    }
    const url = options.url === undefined ? '/auto-effort/state' : options.url
    route.handler(mockRequest(method, headers, options.body, url), res)
  })
}

test('tool output never becomes the task', async () => {
  const app = makeHarness({ mode: 'auto' }, makeLlm(['xhigh', 'max']))
  await app.claim({ id: 'tool-1', role: 'tool', content: [{ type: 'text', text: heavy }] }, 1, 's1')
  const served = await app.request(1, { provider: 'magpie', model: 'group/1' }, 's1')
  assert.equal(served.reasoningEffort, 'xhigh')
})

test('the user message drives the tier and later steps inherit it', async () => {
  const app = makeHarness({ mode: 'auto' }, makeLlm(['xhigh', 'max']))
  await app.claim({ id: 'user-1', role: 'user', content: [{ type: 'text', text: heavy }] }, 2, 's1')
  const served = await app.request(2, { provider: 'magpie', model: 'group/1' }, 's1')
  assert.equal(served.reasoningEffort, 'max')

  const nextStep = await app.request(3, { provider: 'magpie', model: 'group/1' }, 's1')
  assert.equal(nextStep.reasoningEffort, 'max')
})

test('an explicit effort is left alone and reported as deferred', async () => {
  const app = makeHarness({ mode: 'auto', respectExplicit: true }, makeLlm(['xhigh', 'max']))
  await app.claim({ id: 'user-2', role: 'user', content: [{ type: 'text', text: '简短说一下' }] }, 1, 's2')
  const served = await app.request(1, { provider: 'magpie', model: 'group/1', reasoningEffort: 'max' }, 's2')
  assert.equal(served.reasoningEffort, 'max')

  const state = await callRoute(app.routes.get('/auto-effort/state'), {})
  assert.equal(state.body.last.note, 'explicit')
  assert.equal(state.body.last.effort, 'max')
})

test('the mode route refuses cross-origin and non-json writes', async () => {
  const app = makeHarness({ mode: 'auto' }, makeLlm(['xhigh', 'max']))
  const route = app.routes.get('/auto-effort/mode')

  const crossSite = await callRoute(route, {
    method: 'POST',
    headers: { origin: 'https://evil.test', host: '127.0.0.1:10175', 'content-type': 'application/json' },
    body: '{"mode":"manual"}',
  })
  assert.equal(crossSite.status, 403)

  const formPost = await callRoute(route, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:10175', host: '127.0.0.1:10175', 'content-type': 'text/plain' },
    body: '{"mode":"manual"}',
  })
  assert.equal(formPost.status, 415)

  const oversized = await callRoute(route, {
    method: 'POST',
    headers: { host: '127.0.0.1:10175', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'manual', pad: 'x'.repeat(5000) }),
  })
  assert.equal(oversized.status, 413)

  const bogus = await callRoute(route, {
    method: 'POST',
    headers: { host: '127.0.0.1:10175', 'content-type': 'application/json' },
    body: '{"mode":"bogus"}',
  })
  assert.equal(bogus.status, 400)

  const accepted = await callRoute(route, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:10175', host: '127.0.0.1:10175', 'content-type': 'application/json' },
    body: '{"mode":"auto"}',
  })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.body.mode, 'auto')
})

test('the state route is not cacheable and carries the model vocabulary once', async () => {
  const app = makeHarness({ mode: 'auto' }, makeLlm(['xhigh', 'max']))
  await app.claim({ id: 'user-3', role: 'user', content: [{ type: 'text', text: '简短说一下' }] }, 1, 's3')
  await app.request(1, { provider: 'magpie', model: 'group/1' }, 's3')
  const state = await callRoute(app.routes.get('/auto-effort/state'), {})
  assert.equal(state.status, 200)
  assert.equal(state.headers['cache-control'], 'no-store')
  assert.deepEqual(state.body.models['magpie/group/1'], ['xhigh', 'max'])
  // The declared set is constant per model, so rows must not repeat it twenty times over.
  assert.equal(state.body.sessions.s3[0].supported, undefined)
  assert.equal(state.body.sessions.s3[0].mapping, 'raised')
})

test('the state route only answers loopback hosts and can be narrowed to one session', async () => {
  const app = makeHarness({ mode: 'auto' }, makeLlm(['xhigh', 'max']))
  await app.claim({ id: 'user-4', role: 'user', content: [{ type: 'text', text: '简短说一下' }] }, 1, 's4')
  await app.request(1, { provider: 'magpie', model: 'group/1' }, 's4')
  await app.claim({ id: 'user-5', role: 'user', content: [{ type: 'text', text: '简短说一下' }] }, 1, 's5')
  await app.request(1, { provider: 'magpie', model: 'group/1' }, 's5')

  const route = app.routes.get('/auto-effort/state')
  const rebound = await callRoute(route, { headers: { host: 'evil.example' } })
  assert.equal(rebound.status, 403)

  const narrowed = await callRoute(route, { url: '/auto-effort/state?session=s4' })
  assert.deepEqual(Object.keys(narrowed.body.sessions), ['s4'])

  const unknown = await callRoute(route, { url: '/auto-effort/state?session=nope' })
  assert.deepEqual(Object.keys(unknown.body.sessions), [])
})

test('the locale route serves the packaged dictionary and refuses anything else', async () => {
  const app = makeHarness({ mode: 'auto' }, makeLlm(['xhigh', 'max']))
  const route = app.routes.get('/auto-effort/locale/')
  const zh = await callRoute(route, { url: '/auto-effort/locale/zh.json' })
  assert.equal(zh.status, 200)
  assert.equal(zh.headers['cache-control'], 'public, max-age=300')
  assert.equal(typeof zh.body.ui.tier.low, 'string')

  const traversal = await callRoute(route, { url: '/auto-effort/locale/..%2F..%2Fpackage.json' })
  assert.equal(traversal.status, 404)

  const missing = await callRoute(route, { url: '/auto-effort/locale/de.json' })
  assert.equal(missing.status, 404)
})
