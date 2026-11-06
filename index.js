/**
 * dsh-auto-effort — per-turn thinking-effort routing for every model, including Magpie.
 *
 * The original dsh-router-laya swaps the whole provider/model route (deepseek-flash / qwen), so it
 * does nothing in a profile where those providers do not exist. This plugin keeps whatever
 * provider/model the request already carries and only tunes `reasoningEffort` against that model's
 * declared effort vocabulary (`llm.resolveModelInfo().reasoning.efforts`). That makes it work with
 * Magpie models whose ids and effort sets differ per model (xhigh+max, low+high, high only, ...).
 *
 * A small deterministic judge maps the claimed user message to a tier (low | high | max):
 * intent words, length, code/stack traces, multi-question prompts, correction/retry detection and
 * escalation from the previous turn. An optional `judgeUrl` can delegate the same decision to the
 * Laya HTTP service with the original v2 wire format.
 *
 * Everything is fail-safe: a missing llm service, an unknown model, a model without reasoning
 * support, or a judge failure all leave the request exactly as its owner configured it.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'auto-effort'

/** Node builtins only: this plugin talks to `llm` per request and serves three same-origin routes. */
export const inject = []

const LOG_PREFIX = '[auto-effort]'
export const MODE_NS = 'auto-effort'
export const MODES = ['auto', 'manual']
export const TIERS = ['low', 'high', 'max']

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
/** The host reads DSH_HOME; following it keeps two profiles from sharing one mode file. */
const DSH_HOME = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh')
const STATE_PATH = join(DSH_HOME, 'auto-effort-mode.json')

const JUDGE_MAX_CHARS = 4000
const REMOTE_JUDGE_TIMEOUT_MS = 1000
const JUDGE_BREAKER_FAILURES = 3
const JUDGE_BREAKER_COOLDOWN_MS = 60 * 1000
const MODEL_INFO_TTL_MS = 5 * 60 * 1000
const HISTORY_LIMIT = 20
const SESSION_LIMIT = 40

/** Scoring defaults; a profile may override the numbers and add keywords through Config. */
export const JUDGE_DEFAULTS = {
  scoreHigh: 3,
  scoreMax: 6,
  lengthTiers: [160, 500, 1200],
  judgeMaxChars: JUDGE_MAX_CHARS,
  hardKeywords: [],
  broadKeywords: [],
}

/** pi-ai's own level order; used to rank whatever a model declares. */
export const EFFORT_RANK = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

/** Preferred effort id per tier, before intersecting with the model's declared efforts. */
export const TIER_EFFORT_ORDER = {
  low: ['low', 'minimal', 'medium', 'high', 'xhigh', 'max', 'off'],
  high: ['high', 'medium', 'xhigh', 'max', 'low', 'minimal', 'off'],
  max: ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'off'],
}

const TIER_RANK = { low: 2, high: 4, max: 6 }

/**
 * One line per event on stderr, tagged with a level so `2>&1 | grep warn` works. The harness
 * captures plugin stderr, so there is no log file to rotate here.
 */
function log(message, level) {
  const tag = level === undefined ? 'info' : level
  process.stderr.write(`${LOG_PREFIX} ${new Date().toISOString()} ${tag} ${message}\n`)
}

function tierOf(value) {
  return TIERS.includes(value) ? value : 'low'
}

function bump(tier) {
  return tier === 'low' ? 'high' : 'max'
}

function normalize(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim()
}

/** Keep both ends of an oversized prompt: pasted logs usually hide the actual question last. */
export function clipTask(text, maxChars) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.round(maxChars) : JUDGE_MAX_CHARS
  const s = String(text === undefined || text === null ? '' : text)
  if (s.length <= limit) return s
  const marker = '\n…\n'
  const tail = Math.min(Math.floor(limit / 4), 1000)
  return s.slice(0, limit - tail - marker.length) + marker + s.slice(-tail)
}

/** Merge a partial judge config over the defaults; bad values fall back instead of throwing. */
export function judgeOptions(options) {
  const given = options !== undefined && options !== null && typeof options === 'object' ? options : {}
  const number = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback)
  const lengths = Array.isArray(given.lengthTiers) && given.lengthTiers.length === 3
    && given.lengthTiers.every((n) => Number.isFinite(n) && n > 0)
    ? given.lengthTiers
    : JUDGE_DEFAULTS.lengthTiers
  const words = (value) => (Array.isArray(value) ? value.filter((w) => typeof w === 'string' && w !== '') : [])
  return {
    scoreHigh: number(given.scoreHigh, JUDGE_DEFAULTS.scoreHigh),
    scoreMax: number(given.scoreMax, JUDGE_DEFAULTS.scoreMax),
    lengthTiers: lengths,
    judgeMaxChars: number(given.judgeMaxChars, JUDGE_DEFAULTS.judgeMaxChars),
    hardKeywords: words(given.hardKeywords),
    broadKeywords: words(given.broadKeywords),
  }
}

const extraCache = new Map()

/** Extra keywords are matched as plain text, so a stray `(` in config cannot break the regex. */
function extraRegex(words) {
  if (words.length === 0) return null
  const key = words.join('\u0000')
  const hit = extraCache.get(key)
  if (hit !== undefined) return hit
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const built = new RegExp(escaped.join('|'), 'i')
  extraCache.set(key, built)
  return built
}

const GREETING_RE = /^(?:hi|hello|hey|你好|您好|嗨|在吗|谢谢|多谢|thanks|thank you|ok|okay|好的|好|嗯|收到)[\s!！。.?？~～]*$/i
const CONTINUE_RE = /^(?:(?:继续|接着|然后|往下|下一步)(?:[\s,，。.!！]|$)|(?:go on|continue)\b)/i
const CORRECTION_RE = /(?:不对|错了|还是不行|再试|重新|重试|换个|不是这个|又错|没用|不行|失败|bug still|still (?:wrong|failing)|try again|doesn'?t work)/i
const HARD_RETRY_RE = /(?:第三次|又是?错|还是(?:错|不对)|仍然不对|still failing|third time)/i

const FORCE_LOW_RE = /(?:简单(?:回答|说说|解释)|简短|一句话|不用(?:太)?(?:深入|复杂|思考)|别想太多|快速回答|简答|briefly|one sentence|quick answer|keep it short)/i
const FORCE_HIGH_RE = /(?:仔细(?:想|思考|分析|检查)|认真(?:想|思考|分析)|想清楚|深度思考|深入(?:分析|思考|研究)|全面(?:分析|考虑|调研)|系统性|严谨|一步一步|逐步|max effort|think (?:hard|carefully)|in[- ]depth|step by step)/i
const FORCE_MAX_RE = /(?:最高(?:强度|档)|最强|全力|彻底|穷尽|非常复杂|极其复杂|maximum effort|as hard as possible)/i

const CODE_FENCE_RE = /```|~~~/
const ERROR_RE = /\b(?:error|exception|traceback|segfault|stack trace|failed|failure)\b|报错|错误|异常|崩溃|闪退|堆栈/i
const HARD_RE = /(?:重构|架构|迁移|性能优化|并发|死锁|内存泄漏|安全|漏洞|算法|复杂度|编译|部署|调试|排查|修复|测试|单元测试|覆盖率|流水线|插件|协议|逆向|源码|解析)|(?:refactor|architect\w*|migrat\w*|optimi[sz]\w*|\bperformance\b|concurren\w*|\bdeadlock\w*|race condition|memory leak|\bsecurity\b|vulnerab\w*|\balgorithm\w*|\bdebug\w*|diagnos\w*|\bfix(?:es|ed|ing)?\b|test suite|\bcoverage\b|\bpipeline\w*|reverse[- ]engineer)/i
const MAX_RE = /(?:整个项目|代码库|多个文件|全量|端到端|设计文档|技术方案|调研报告|对比分析|评审|论文|白皮书)|(?:entire (?:codebase|project)|whole repo|multiple files|end[- ]to[- ]end|design doc\w*|architecture review|proof|theorem|from scratch|comprehensive|systematic)/i
const FILE_RE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|cpp|cc|c|h|hpp|json|ya?ml|toml|sql|sh|ps1|html|css)\b/gi

/**
 * Deterministic tier judgment. Exported so it can be exercised without a running harness.
 * `prevTier`/`prevTask` are the previous turn's served tier and its task text; `options` carries
 * the profile's thresholds and extra keywords (see `judgeOptions`).
 */
export function judgeTaskLocal(text, prevTier, prevTask, options) {
  const merged = judgeOptions(options)
  const opt = { ...merged, hard: extraRegex(merged.hardKeywords), broad: extraRegex(merged.broadKeywords) }
  const raw = String(text === undefined || text === null ? '' : text).trim()
  if (raw === '') {
    return { tier: prevTier === undefined ? 'low' : tierOf(prevTier), triggered_by: 'empty', labels: [] }
  }
  const flat = normalize(raw)
  const labels = []

  // A regenerate resends the same prompt: that is the strongest escalation signal we get.
  if (prevTask !== undefined && prevTask !== null && normalize(prevTask) === flat) {
    return { tier: bump(tierOf(prevTier)), triggered_by: 'regenerate', labels: ['same-task'] }
  }
  if (HARD_RETRY_RE.test(flat)) {
    return { tier: 'max', triggered_by: 'hard-retry', labels: ['hard-retry'] }
  }
  if (prevTier !== undefined && CORRECTION_RE.test(flat)) {
    return { tier: bump(tierOf(prevTier)), triggered_by: 'correction', labels: ['correction'] }
  }
  if (GREETING_RE.test(flat)) {
    return { tier: 'low', triggered_by: 'short', labels: ['greeting'] }
  }
  if (CONTINUE_RE.test(flat) && prevTier !== undefined) {
    return { tier: tierOf(prevTier), triggered_by: 'intent_inherit', labels: ['continue'] }
  }
  // "简短 / 一句话" asks for a shorter answer; it is not proof that the task is easy, so it
  // caps the tier instead of short-circuiting the content signals below.
  const wantsShort = FORCE_LOW_RE.test(flat)

  let score = 0
  const len = flat.length
  const [l1, l2, l3] = opt.lengthTiers
  if (len >= l1) { score += 1; labels.push('long') }
  if (len >= l2) { score += 1; labels.push('very-long') }
  if (len >= l3) { score += 2; labels.push('huge') }
  if (CODE_FENCE_RE.test(raw)) { score += 2; labels.push('code') }
  if (ERROR_RE.test(raw)) { score += 1; labels.push('error') }
  if (HARD_RE.test(raw) || (opt.hard !== null && opt.hard.test(raw))) { score += 2; labels.push('hard-topic') }
  if (MAX_RE.test(raw) || (opt.broad !== null && opt.broad.test(raw))) { score += 3; labels.push('broad-scope') }

  const questions = (raw.match(/[?？]/g) || []).length
  if (questions >= 2) { score += 1; labels.push('multi-question') }
  if (questions >= 4) { score += 1; labels.push('many-questions') }

  const files = (raw.match(FILE_RE) || []).length
  if (files >= 2) { score += 1; labels.push('multi-file') }
  if (files >= 5) { score += 1; labels.push('many-files') }

  const numbered = (raw.match(/^\s*(?:\d+[.、)]|[-*])\s+/gm) || []).length
  if (numbered >= 4) { score += 1; labels.push('checklist') }

  let tier = score >= opt.scoreMax ? 'max' : score >= opt.scoreHigh ? 'high' : 'low'
  let triggeredBy = 'content'

  if (wantsShort) {
    if (score < 2) {
      tier = 'low'
      triggeredBy = 'intent_exclude'
      labels.push('explicit-short')
    } else if (tier === 'max') {
      tier = 'high'
      labels.push('explicit-short')
    }
  }

  if (FORCE_MAX_RE.test(flat)) {
    tier = 'max'
    triggeredBy = 'intent_force'
    labels.push('explicit-max')
  } else if (FORCE_HIGH_RE.test(flat)) {
    if (tier === 'low') tier = 'high'
    triggeredBy = 'intent_force'
    labels.push('explicit-high')
  }

  return { tier, triggered_by: triggeredBy, labels }
}

/** First declared effort matching the tier's preference order, then nearest by rank. */
export function chooseEffort(tier, efforts, overrides) {
  if (!Array.isArray(efforts) || efforts.length === 0) return null
  const order = overrides !== undefined && overrides !== null && Array.isArray(overrides[tier])
    ? overrides[tier]
    : TIER_EFFORT_ORDER[tier]
  for (const id of order || []) {
    if (efforts.includes(id)) return id
  }
  const target = TIER_RANK[tier]
  let best = null
  let bestDistance = Infinity
  for (const id of efforts) {
    if (EFFORT_RANK[id] === undefined) continue
    const distance = Math.abs(EFFORT_RANK[id] - target)
    if (distance < bestDistance || (distance === bestDistance && EFFORT_RANK[id] > EFFORT_RANK[best])) {
      best = id
      bestDistance = distance
    }
  }
  if (best !== null) return best
  // The host calls effort ids adapter-owned opaque strings, so a model may advertise a vocabulary
  // this plugin cannot rank (none/thinking/deep). The advertised array is ordered weakest to
  // strongest, so fall back to its ends instead of silently doing nothing for that model.
  const last = efforts.length - 1
  if (tier === 'low') return efforts[0]
  if (tier === 'max') return efforts[last]
  return efforts[Math.floor(last / 2)]
}

/**
 * How far the served effort sits from the tier's own level. A model whose declared set is
 * narrower than the tier vocabulary cannot express every tier, so the served effort is reported
 * as `raised` (its lowest level is already above the tier) or `capped` (its highest is still
 * below it) instead of silently pretending the tier was met.
 */
export function effortMapping(tier, effort) {
  const want = TIER_RANK[tier]
  const got = EFFORT_RANK[effort]
  if (want === undefined || got === undefined) return 'exact'
  if (got === want) return 'exact'
  return got > want ? 'raised' : 'capped'
}

/** POST the original Laya v2 wire format; any failure returns null so the local judge takes over. */
export async function judgeTaskRemote(url, text, prevTier, prevTask, sessionId, signal, timeoutMs) {
  if (typeof url !== 'string' || url === '') return null
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : REMOTE_JUDGE_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), budget)
  const relay = () => controller.abort()
  if (signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', relay, { once: true })
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: clipTask(text),
        prev_tier: prevTier === undefined ? null : prevTier,
        prev_task: prevTask === undefined ? null : prevTask,
        session_id: sessionId === undefined ? null : sessionId,
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      log(`judge ${url} -> HTTP ${res.status}`, 'warn')
      return null
    }
    const body = await res.json()
    const tier = body.tier ?? body.level
    if (!TIERS.includes(tier)) {
      log(`judge ${url} returned no usable tier`, 'warn')
      return null
    }
    return { tier, triggered_by: body.triggered_by || 'remote', labels: body.labels || null }
  } catch (error) {
    log(`judge ${url} failed: ${error.message}`, 'warn')
    return null
  } finally {
    clearTimeout(timer)
    if (signal !== undefined && signal !== null && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', relay)
    }
  }
}

function readModeFile() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    return MODES.includes(parsed.mode) ? parsed.mode : null
  } catch {
    return null
  }
}

function writeModeFile(mode) {
  const temporary = `${STATE_PATH}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    writeFileSync(temporary, JSON.stringify({ mode, updatedAt: Date.now() }, null, 2), 'utf8')
    // rename is atomic on the same volume: a kill mid-write leaves the old file behind instead of
    // a truncated one that would silently read back as "auto".
    renameSync(temporary, STATE_PATH)
  } catch (error) {
    try { rmSync(temporary, { force: true }) } catch { /* nothing else to clean up */ }
    log(`could not persist mode: ${error.message}`, 'warn')
  }
}

function textOf(message) {
  if (message === undefined || message === null) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
      .map((block) => (typeof block.text === 'string' ? block.text : ''))
      .join('\n')
  }
  if (typeof message.text === 'string') return message.text
  return ''
}

function json(res, code, body) {
  const text = JSON.stringify(body)
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', String(Buffer.byteLength(text)))
  res.end(text)
}

/**
 * A browser page on another origin can still POST here with `mode: 'no-cors'` and a text/plain
 * body, so the write route refuses any Origin that is not the host it was reached on. Requests
 * without an Origin header (curl, tests, same-origin GET) are not browser cross-site writes.
 */
function isSameOrigin(req) {
  const headers = req !== undefined && req !== null ? req.headers : undefined
  if (headers === undefined || headers === null) return true
  const origin = headers.origin
  if (origin === undefined || origin === null || origin === '') return true
  const host = headers.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(String(origin)).host === host
  } catch {
    return false
  }
}

/**
 * DNS rebinding gives a page on `evil.example` a socket to 127.0.0.1 while its own host header
 * still says `evil.example`, so requiring a loopback Host is what keeps that page from reading the
 * state route. Local tools reach the route as 127.0.0.1 / localhost and keep working.
 */
function isLoopbackHost(req) {
  const headers = req !== undefined && req !== null ? req.headers : undefined
  if (headers === undefined || headers === null) return false
  const host = headers.host
  if (typeof host !== 'string' || host === '') return false
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

function keyOf(payload) {
  const session = payload !== undefined && payload !== null && payload.agent !== undefined ? payload.agent.session : undefined
  if (session !== undefined && session !== null) {
    if (typeof session.id === 'string' && session.id !== '') return session.id
    if (typeof session.sessionId === 'string' && session.sessionId !== '') return session.sessionId
  }
  return 'global'
}

/**
 * One wire row. The model's declared effort set is deliberately not repeated here: it is constant
 * per provider/model, so `/state` carries it once in `models` instead of once per row.
 */
function rowFor(tier, effort, judgment, task, provider, model, note, mapping) {
  return {
    ts: Math.round(Date.now() / 1000),
    tier,
    effort,
    provider,
    model,
    task: task === undefined ? '' : task.text.slice(0, 120),
    triggered_by: judgment === null ? 'no-task' : judgment.triggered_by,
    labels: judgment === null ? null : judgment.labels,
    note,
    mapping: mapping === undefined ? null : mapping,
  }
}

export function apply(ctx, config) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const mountMode = MODES.includes(cfg.mode) ? cfg.mode : (readModeFile() || 'auto')
  const mode = { value: mountMode }
  const useGlobal = cfg.global !== false
  const judgeConfig = judgeOptions(cfg.judge)
  const modelCache = new Map()
  const tasks = new Map()
  const verdicts = new Map()
  const sessionState = new Map()
  const lastApplied = new Map()
  const history = new Map()
  const judgeTimeout = Number.isFinite(cfg.judgeTimeoutMs)
    ? Math.min(Math.max(Math.round(cfg.judgeTimeoutMs), 100), 10000)
    : REMOTE_JUDGE_TIMEOUT_MS
  let judgeFailures = 0
  let judgeSkipUntil = 0

  const state = { mode: mountMode, updatedAt: Date.now(), sessions: {}, last: null }

  function setMode(next) {
    if (!MODES.includes(next) || next === mode.value) return
    mode.value = next
    state.mode = next
    state.updatedAt = Date.now()
    writeModeFile(next)
    log(`mode -> ${next}`)
  }

  function record(key, row) {
    const rows = history.get(key) || []
    rows.push(row)
    while (rows.length > HISTORY_LIMIT) rows.shift()
    // Re-insert on every write so Map order is recency order, not creation order.
    history.delete(key)
    history.set(key, rows)
    state.sessions[key] = rows
    state.last = row
    state.updatedAt = Date.now()
    if (history.size > SESSION_LIMIT) {
      const oldest = history.keys().next().value
      history.delete(oldest)
      delete state.sessions[oldest]
      tasks.delete(oldest)
      verdicts.delete(oldest)
      sessionState.delete(oldest)
      lastApplied.delete(oldest)
    }
  }

  async function effortsFor(llm, provider, model, signal) {
    const cacheKey = `${provider}\u0000${model}`
    const hit = modelCache.get(cacheKey)
    if (hit !== undefined && Date.now() - hit.at < MODEL_INFO_TTL_MS) return hit
    const info = await llm.resolveModelInfo(provider, model, signal)
    const declared = info !== undefined && info !== null && info.reasoning !== undefined && info.reasoning !== null
      ? info.reasoning
      : null
    const capability = {
      at: Date.now(),
      supported: declared !== null && Array.isArray(declared.efforts)
        ? declared.efforts.map((effort) => effort.id).filter((id) => typeof id === 'string')
        : [],
      defaultEffort: declared === null ? undefined : declared.defaultEffort,
    }
    modelCache.set(cacheKey, capability)
    return capability
  }

  /**
   * Remote judgment sits on the critical path of the turn, so a dead endpoint must not cost the
   * full budget on every request: after a few consecutive failures the judge is skipped for a
   * cooldown and the local scorer takes over.
   */
  async function judgeRemote(task, previous, payload) {
    if (typeof cfg.judgeUrl !== 'string' || cfg.judgeUrl === '') return null
    if (Date.now() < judgeSkipUntil) return null
    const verdict = await judgeTaskRemote(
      cfg.judgeUrl,
      task.text,
      previous === undefined ? undefined : previous.tier,
      previous === undefined ? undefined : previous.task,
      task.sessionId,
      payload !== undefined && payload !== null ? payload.signal : undefined,
      judgeTimeout,
    )
    if (verdict === null) {
      judgeFailures += 1
      if (judgeFailures >= JUDGE_BREAKER_FAILURES) {
        judgeFailures = 0
        judgeSkipUntil = Date.now() + JUDGE_BREAKER_COOLDOWN_MS
        log(`remote judge unreachable; skipping it for ${Math.round(JUDGE_BREAKER_COOLDOWN_MS / 1000)}s`, 'warn')
      }
    } else {
      judgeFailures = 0
    }
    return verdict
  }

  ctx.on('agent/inbox/claimed', (payload) => {
    const message = payload !== undefined && payload !== null ? payload.message : undefined
    // Tool results and injected context travel through the same inbox. Letting their text decide
    // the tier would mean a long file dump or a stack trace picks the effort, so only the user's
    // own message counts.
    if (message !== undefined && message !== null && typeof message.role === 'string' && message.role !== 'user') return
    const key = keyOf(payload)
    const text = textOf(message)
    if (normalize(text) === '') return
    const previous = tasks.get(key)
    if (previous !== undefined && message !== undefined && message !== null
      && typeof message.id === 'string' && previous.messageId === message.id) return
    const session = payload !== undefined && payload !== null && payload.agent !== undefined ? payload.agent.session : undefined
    tasks.set(key, {
      text: clipTask(text, judgeConfig.judgeMaxChars),
      messageId: message !== undefined && message !== null ? message.id : undefined,
      sessionId: session !== undefined && session !== null ? session.id : undefined,
    })
  }, { global: useGlobal })

  ctx.on('agent/request', async (payload, next) => {
    const requestConfig = await next()
    if (mode.value === 'manual') return requestConfig

    const key = keyOf(payload)
    const turn = payload !== undefined && payload !== null ? payload.turn : undefined
    const cached = verdicts.get(key)
    if (cached !== undefined && cached.turn === turn) {
      return cached.effort === null ? requestConfig : { ...requestConfig, reasoningEffort: cached.effort }
    }

    const task = tasks.get(key)
    const prev = sessionState.get(key)
    const stateEntry = prev !== undefined && turn !== undefined && prev.turn !== undefined && turn < prev.turn
      ? undefined
      : prev

    let judgment = null
    if (task !== undefined) {
      judgment = await judgeRemote(task, stateEntry, payload)
      if (judgment === null) {
        judgment = judgeTaskLocal(
          task.text,
          stateEntry === undefined ? undefined : stateEntry.tier,
          stateEntry === undefined ? undefined : stateEntry.task,
          judgeConfig,
        )
      }
    }
    // A step without new user text (tool loop, auto-continuation) keeps the tier of the turn it
    // belongs to instead of dropping to low halfway through a hard task.
    const tier = judgment !== null
      ? tierOf(judgment.tier)
      : stateEntry !== undefined ? tierOf(stateEntry.tier) : 'low'

    const provider = requestConfig !== undefined && requestConfig !== null ? requestConfig.provider : undefined
    const model = requestConfig !== undefined && requestConfig !== null ? requestConfig.model : undefined
    if (typeof provider !== 'string' || typeof model !== 'string') {
      verdicts.set(key, { turn, effort: null })
      return requestConfig
    }

    const llm = ctx.get('llm')
    if (llm === undefined || llm === null || typeof llm.resolveModelInfo !== 'function') {
      verdicts.set(key, { turn, effort: null })
      log('llm service unavailable; leaving the request untouched', 'warn')
      return requestConfig
    }

    let capability
    try {
      capability = await effortsFor(llm, provider, model, payload !== undefined && payload !== null ? payload.signal : undefined)
    } catch (error) {
      log(`model info failed for ${provider}/${model}: ${error.message}`, 'warn')
      verdicts.set(key, { turn, effort: null })
      return requestConfig
    }

    const supported = capability.supported
    const effort = chooseEffort(tier, supported, cfg.efforts)
    let note = ''

    if (effort === null) {
      note = supported.length === 0 ? 'unsupported' : 'no-matching-effort'
      verdicts.set(key, { turn, effort: null })
      record(key, rowFor(tier, null, judgment, task, provider, model, note))
      log(`turn ${turn} ${tier} -> ${note} (${provider}/${model})`, 'warn')
      return requestConfig
    }

    // A foreign explicit effort (subagent pin, session override) is respected when asked to.
    if (cfg.respectExplicit === true && requestConfig.reasoningEffort !== undefined) {
      const previous = lastApplied.get(key)
      const ours = previous !== undefined
        && previous.effort === requestConfig.reasoningEffort
        && previous.provider === provider
        && previous.model === model
      if (!ours) {
        note = 'explicit'
        verdicts.set(key, { turn, effort: null })
        record(key, rowFor(tier, requestConfig.reasoningEffort, judgment, task, provider, model, note))
        log(`turn ${turn} ${tier} -> deferring to explicit ${requestConfig.reasoningEffort}`)
        return requestConfig
      }
    }

    const mapping = effortMapping(tier, effort)
    lastApplied.set(key, { effort, provider, model, tier })
    verdicts.set(key, { turn, effort })
    if (task !== undefined) {
      sessionState.set(key, { tier, task: task.text, turn })
      tasks.delete(key)
    }
    record(key, rowFor(tier, effort, judgment, task, provider, model, '', mapping))

    const changed = requestConfig.reasoningEffort !== effort
    log(`turn ${turn} ${tier} (${judgment === null ? 'no-task' : judgment.triggered_by})`
      + ` -> ${effort}${mapping === 'exact' ? '' : ` (${mapping})`}${changed ? '' : ' (already)'}`
      + ` on ${provider}/${model}`)
    return { ...requestConfig, reasoningEffort: effort }
  }, { global: useGlobal })

  function modelIndex() {
    const out = {}
    for (const [cacheKey, capability] of modelCache) {
      out[cacheKey.replace('\u0000', '/')] = capability.supported
    }
    return out
  }

  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer')
    if (webServer === undefined || webServer === null) return

    scoped.effect(() => webServer.register({
      kind: 'exact',
      path: '/auto-effort/state',
      handler: (req, res) => {
        if (!isLoopbackHost(req)) {
          json(res, 403, { error: 'host not allowed' })
          return
        }
        if (req.method !== 'GET') {
          json(res, 405, { error: 'method not allowed' })
          return
        }
        // The chip only ever shows one session, so `?session=` keeps the poll small and stops the
        // route from handing every session's task text to whoever asks.
        const query = String(req.url === undefined ? '' : req.url)
        const mark = query.indexOf('session=')
        let only = null
        if (mark >= 0) {
          const raw = query.slice(mark + 'session='.length).split('&')[0]
          try { only = decodeURIComponent(raw) } catch { only = raw }
        }
        const sessions = only !== null && only !== ''
          ? (state.sessions[only] === undefined ? {} : { [only]: state.sessions[only] })
          : state.sessions
        json(res, 200, {
          mode: mode.value,
          tier: state.last === null ? null : state.last.tier,
          effort: state.last === null ? null : state.last.effort,
          updatedAt: state.updatedAt,
          last: state.last,
          sessions,
          models: modelIndex(),
        })
      },
    }))

    scoped.effect(() => webServer.register({
      kind: 'exact',
      path: '/auto-effort/mode',
      handler: (req, res) => {
        if (!isLoopbackHost(req)) {
          json(res, 403, { error: 'host not allowed' })
          return
        }
        if (req.method === 'GET') {
          json(res, 200, { mode: mode.value })
          return
        }
        if (req.method !== 'POST') {
          json(res, 405, { error: 'method not allowed' })
          return
        }
        if (!isSameOrigin(req)) {
          json(res, 403, { error: 'cross-origin write refused' })
          return
        }
        const contentType = String(req.headers !== undefined && req.headers !== null ? req.headers['content-type'] || '' : '').toLowerCase()
        if (!contentType.startsWith('application/json')) {
          json(res, 415, { error: 'content-type must be application/json' })
          return
        }
        let raw = ''
        let tooLarge = false
        req.on('data', (chunk) => {
          if (tooLarge) return
          raw += chunk
          if (raw.length > 4096) tooLarge = true
        })
        req.on('end', () => {
          if (tooLarge) {
            json(res, 413, { error: 'body too large' })
            return
          }
          let wanted
          try {
            wanted = JSON.parse(raw).mode
          } catch {
            json(res, 400, { error: 'body must be json' })
            return
          }
          if (!MODES.includes(wanted)) {
            json(res, 400, { error: `mode must be one of ${MODES.join('|')}` })
            return
          }
          setMode(wanted)
          json(res, 200, { mode: mode.value })
        })
      },
    }))

    // UI copy lives in locale/*.json so the client ships no user-visible literals of its own.
    scoped.effect(() => webServer.register({
      kind: 'prefix',
      path: '/auto-effort/locale/',
      handler: (req, res) => {
        if (!isLoopbackHost(req)) {
          json(res, 403, { error: 'host not allowed' })
          return
        }
        if (req.method !== 'GET') {
          json(res, 405, { error: 'method not allowed' })
          return
        }
        const path = String(req.url === undefined ? '' : req.url).split('?')[0]
        const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/, '')
        if (!/^[a-z]{2}(?:-[a-z]{2})?$/.test(name)) {
          json(res, 404, { error: 'unknown locale' })
          return
        }
        let body
        try {
          body = readFileSync(join(PLUGIN_DIR, 'locale', `${name}.json`), 'utf8')
        } catch {
          json(res, 404, { error: 'unknown locale' })
          return
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'public, max-age=300')
        res.setHeader('Content-Length', String(Buffer.byteLength(body)))
        res.end(body)
      },
    }))
  })

  log(`mounted (mode ${mode.value}); per-turn effort routing on the request's own model`)
  log('tiers low/high/max prefer low/medium, high, and max/xhigh when the model declares them')
  if (cfg.respectExplicit === true) {
    log('respectExplicit is on: a request that already carries reasoningEffort is left untouched, including the agent default')
  }
  if (typeof cfg.judgeUrl === 'string' && cfg.judgeUrl !== '' && !/^https:/i.test(cfg.judgeUrl)) {
    log(`judgeUrl is not https: the task text (up to ${judgeConfig.judgeMaxChars} chars) will be sent in clear text to ${cfg.judgeUrl}`, 'warn')
  }
}
