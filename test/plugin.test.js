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

function makeLlm(models) {
  return {
    listProviders: () => [{ id: 'magpie' }],
    listModels: () => Object.keys(models).map((id) => ({ id })),
    resolveModelInfo: async (provider, model) => {
      const efforts = models[model]
      if (!Array.isArray(efforts) || efforts.length === 0) return {}
      return { reasoning: { efforts: efforts.map((id) => ({ id, name: id })), defaultEffort: efforts[0] } }
    },
  }
}

async function makeHarness(config, llm, options) {
  const opts = options === undefined ? {} : options
  const handlers = new Map()
  const routes = new Map()
  const selects = []
  const selection = {
    provider: opts.provider === undefined ? 'magpie' : opts.provider,
    model: opts.model === undefined ? 'group/1' : opts.model,
    reasoningEffort: opts.effort,
  }
  const model = {
    current: () => ({ ...selection }),
    recordedSelection: () => ({ ...selection }),
    select: (next) => {
      selects.push({ ...next })
      selection.provider = next.provider
      selection.model = next.model
      selection.reasoningEffort = next.reasoningEffort
    },
  }
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
  // start-up warm-up runs on a 250ms timer; let it land before assertions read the model cache.
  await new Promise((resolve) => setTimeout(resolve, 25))
  return {
    routes,
    selects,
    selection,
    async claim(message, turn, sessionId) {
      for (const fn of handlers.get('agent/inbox/claimed') || []) {
        await fn({ message, turn, agent: { session: { id: sessionId }, model } }, async () => undefined)
      }
    },
    async request(turn, seed, sessionId) {
      let result = seed
      for (const fn of handlers.get('agent/request') || []) {
        result = await fn({ turn, agent: { session: { id: sessionId }, model } }, async () => seed)
      }
      return result
    },
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

test('tool output never becomes the task and never moves the model', async () => {
  const app = await makeHarness({ mode: 'auto' }, makeLlm({ 'group/1': ['xhigh', 'max'] }))
  await app.claim({ id: 'tool-1', role: 'tool', content: [{ type: 'text', text: heavy }] }, 1, 's1')
  assert.equal(app.selects.length, 0)
  const state = await callRoute(app.routes.get('/auto-effort/state'), {})
  assert.deepEqual(state.body.sessions, {})
})

test('a heavy user message moves the current Magpie model to the top rung', async () => {
  const app = await makeHarness({ mode: 'auto' }, makeLlm({ 'group/1': ['xhigh', 'max'] }))
  await app.claim({ id: 'user-1', role: 'user', content: [{ type: 'text', text: heavy }] }, 2, 's1')
  assert.equal(app.selects.length, 1)
  assert.equal(app.selects[0].provider, 'magpie')
  assert.equal(app.selects[0].model, 'group/1')
  assert.equal(app.selects[0].reasoningEffort, 'max')
  assert.equal(app.selection.reasoningEffort, 'max')
  // The request path must stay read-only now that the choice is recorded before the step starts.
  const served = await app.request(2, { provider: 'magpie', model: 'group/1', reasoningEffort: 'max' }, 's1')
  assert.equal(served.reasoningEffort, 'max')
})

test('a model with four rungs gets a different rung for the same task', async () => {
  const app = await makeHarness({ mode: 'auto' }, makeLlm({ 'group/2': ['low', 'high', 'xhigh', 'max'] }), {
    model: 'group/2',
  })
  await app.claim({ id: 'user-2', role: 'user', content: [{ type: 'text', text: heavy }] }, 1, 's2')
  // 51/100 over four rungs lands on the third rung (xhigh), not the top.
  assert.equal(app.selects[0].reasoningEffort, 'xhigh')
})

test('an explicit effort is left alone and reported as deferred', async () => {
  const app = await makeHarness({ mode: 'auto', respectExplicit: true }, makeLlm({ 'group/1': ['xhigh', 'max'] }), {
    effort: 'max',
  })
  await app.claim({ id: 'user-3', role: 'user', content: [{ type: 'text', text: '简短说一下' }] }, 1, 's3')
  assert.equal(app.selects.length, 0)
  const state = await callRoute(app.routes.get('/auto-effort/state'), {})
  assert.equal(state.body.last.note, 'explicit')
  assert.equal(state.body.last.effort, 'max')
})

test('a model without reasoning metadata is skipped and reported as unsupported', async () => {
  const app = await makeHarness({ mode: 'auto' }, makeLlm({ 'plain/model': [] }), { model: 'plain/model' })
  await app.claim({ id: 'user-4', role: 'user', content: [{ type: 'text', text: heavy }] }, 1, 's4')
  assert.equal(app.selects.length, 0)
  const state = await callRoute(app.routes.get('/auto-effort/state'), {})
  assert.equal(state.body.last.note, 'unsupported')
  assert.equal(state.body.last.effort, null)
})

test('the mode route refuses cross-origin and non-json writes', async () => {
  const app = await makeHarness({ mode: 'auto' }, makeLlm({ 'group/1': ['xhigh', 'max'] }))
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
  const app = await makeHarness({ mode: 'auto' }, makeLlm({ 'group/1': ['xhigh', 'max'] }))
  await app.claim({ id: 'user-5', role: 'user', content: [{ type: 'text', text: '简短说一下' }] }, 1, 's5')
  const state = await callRoute(app.routes.get('/auto-effort/state'), {})
  assert.equal(state.status, 200)
  assert.equal(state.headers['cache-control'], 'no-store')
  assert.deepEqual(state.body.models['magpie/group/1'], ['xhigh', 'max'])
  assert.equal(state.body.sessions.s5[0].supported, undefined)
  assert.equal(state.body.sessions.s5[0].levelCount, 2)
  assert.equal(state.body.last.levelIndex, 0)
})

test('the state route only answers loopback hosts and can be narrowed to one session', async () => {
  const app = await makeHarness({ mode: 'auto' }, makeLlm({ 'group/1': ['xhigh', 'max'] }))
  await app.claim({ id: 'user-6', role: 'user', content: [{ type: 'text', text: '简短说一下' }] }, 1, 's6')
  await app.claim({ id: 'user-7', role: 'user', content: [{ type: 'text', text: '简短说一下' }] }, 1, 's7')

  const route = app.routes.get('/auto-effort/state')
  const rebound = await callRoute(route, { headers: { host: 'evil.example' } })
  assert.equal(rebound.status, 403)

  const narrowed = await callRoute(route, { url: '/auto-effort/state?session=s6' })
  assert.deepEqual(Object.keys(narrowed.body.sessions), ['s6'])

  const unknown = await callRoute(route, { url: '/auto-effort/state?session=nope' })
  assert.deepEqual(Object.keys(unknown.body.sessions), [])
})

test('the locale route serves the packaged dictionary and refuses anything else', async () => {
  const app = await makeHarness({ mode: 'auto' }, makeLlm({ 'group/1': ['xhigh', 'max'] }))
  const route = app.routes.get('/auto-effort/locale/')
  const zh = await callRoute(route, { url: '/auto-effort/locale/zh.json' })
  assert.equal(zh.status, 200)
  assert.equal(zh.headers['cache-control'], 'public, max-age=300')
  assert.equal(typeof zh.body.ui.state.offline, 'string')

  const traversal = await callRoute(route, { url: '/auto-effort/locale/..%2F..%2Fpackage.json' })
  assert.equal(traversal.status, 404)

  const missing = await callRoute(route, { url: '/auto-effort/locale/de.json' })
  assert.equal(missing.status, 404)
})
