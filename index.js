/**
 * dsh-auto-effort — per-turn thinking-effort routing for every model, including Magpie.
 *
 * The plugin keeps whatever provider/model the turn already uses and only tunes
 * `reasoningEffort` against that model's declared effort vocabulary
 * (`llm.resolveModelInfo().reasoning.efforts`). The declared array is treated as an
 * ordered ladder: two levels are split 50/50, three levels 33/67, four 25/50/75,
 * and any other count is divided proportionally. Nothing is hard-coded to a model
 * name, so every model DSH can describe works without a plugin update.
 *
 * A small deterministic scorer maps the claimed user message to 0–100. It uses
 * intent words, length, code/stack traces, multi-question prompts, correction/retry
 * detection and continuation from the previous turn. An optional `judgeUrl` can
 * pre-score a message with the original Laya v2 wire format; the local score is
 * always available without a network call.
 *
 * All failures are fail-safe: a missing llm service, an unknown model, a model
 * without reasoning support, or a score failure leaves the request untouched.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'auto-effort'

/** Node builtins only: this plugin talks to `llm` in the host and serves three same-origin routes. */
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

/** Scoring defaults; a profile may override any numeric weight or add keywords via Config. */
export const JUDGE_DEFAULTS = {
  maxChars: JUDGE_MAX_CHARS,
  lengthCuts: [80, 200, 500, 1200, 3000],
  lengthScores: [0, 4, 8, 12, 16, 20],
  codeSmall: 8,
  codeMedium: 14,
  codeLarge: 20,
  errorWord: 8,
  stackSignal: 7,
  extremeKeyword: 20,
  hardKeyword: 10,
  mediumKeyword: 4,
  question2: 2,
  question4: 4,
  numbered3: 3,
  numbered5: 5,
  files2: 2,
  files4: 3,
  regenerate: 15,
  correction: 10,
  shortCap: 20,
  forceHigh: 85,
  hardRetry: 100,
  extremeKeywords: [
    '整个项目', '全项目', '从零实现', '架构设计', '系统设计', '分布式', '高并发',
    '安全审计', '性能优化', '迁移方案', '多模块', '端到端', '生产环境', '源码',
    'entire codebase', 'whole repo', 'from scratch', 'distributed system', 'high concurrency',
    'security audit', 'performance optimization', 'migration plan', 'end-to-end',
    'production environment', 'mission critical',
  ],
  hardKeywords: [
    '重构', '优化', '排查', '调试', '分析', '修复', '并发', '数据库', '算法', '协议',
    '部署', '编译', 'refactor', 'optimize', 'debug', 'diagnose', 'fix', 'concurrency',
    'database', 'algorithm', 'protocol', 'deploy', 'compile',
  ],
  mediumKeywords: [
    '实现', '设计', '方案', '对比', '示例', '脚本', '文档', '配置', '接口', '组件',
    '页面', '样式', 'implement', 'design', 'plan', 'compare', 'example', 'script',
    'document', 'config', 'interface', 'component', 'page', 'style',
  ],
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

/**
 * Legacy tier preference table. It is kept exported so older callers of `chooseEffort`
 * keep working; the request path uses the score-driven ladder instead.
 */
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

function clampScore(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

function tierOf(value) {
  return TIERS.includes(value) ? value : 'low'
}

function bump(tier) {
  return tier === 'low' ? 'high' : 'max'
}

function scoreForTier(tier) {
  if (tier === 'max') return 90
  if (tier === 'high') return 55
  return 15
}

function tierForScore(score) {
  const s = clampScore(score)
  if (s >= 67) return 'max'
  if (s >= 34) return 'high'
  return 'low'
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

function numberOr(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function words(value) {
  return Array.isArray(value) ? value.filter((word) => typeof word === 'string' && word !== '') : []
}

function numberList(value, fallback) {
  if (!Array.isArray(value) || value.length !== fallback.length) return fallback.slice()
  if (!value.every((n) => Number.isFinite(n) && n >= 0)) return fallback.slice()
  return value.slice()
}

/** Merge a partial judge config over the defaults; bad values fall back instead of throwing. */
export function judgeOptions(options) {
  const given = options !== undefined && options !== null && typeof options === 'object' ? options : {}
  const numeric = (value, fallback) => numberOr(value, fallback)
  return {
    maxChars: numeric(given.maxChars, JUDGE_DEFAULTS.maxChars),
    lengthCuts: numberList(given.lengthCuts || given.lengthTiers, JUDGE_DEFAULTS.lengthCuts),
    lengthScores: numberList(given.lengthScores, JUDGE_DEFAULTS.lengthScores),
    codeSmall: numeric(given.codeSmall, JUDGE_DEFAULTS.codeSmall),
    codeMedium: numeric(given.codeMedium, JUDGE_DEFAULTS.codeMedium),
    codeLarge: numeric(given.codeLarge, JUDGE_DEFAULTS.codeLarge),
    errorWord: numeric(given.errorWord, JUDGE_DEFAULTS.errorWord),
    stackSignal: numeric(given.stackSignal, JUDGE_DEFAULTS.stackSignal),
    extremeKeyword: numeric(given.extremeKeyword, JUDGE_DEFAULTS.extremeKeyword),
    hardKeyword: numeric(given.hardKeyword, JUDGE_DEFAULTS.hardKeyword),
    mediumKeyword: numeric(given.mediumKeyword, JUDGE_DEFAULTS.mediumKeyword),
    question2: numeric(given.question2, JUDGE_DEFAULTS.question2),
    question4: numeric(given.question4, JUDGE_DEFAULTS.question4),
    numbered3: numeric(given.numbered3, JUDGE_DEFAULTS.numbered3),
    numbered5: numeric(given.numbered5, JUDGE_DEFAULTS.numbered5),
    files2: numeric(given.files2, JUDGE_DEFAULTS.files2),
    files4: numeric(given.files4, JUDGE_DEFAULTS.files4),
    regenerate: numeric(given.regenerate, JUDGE_DEFAULTS.regenerate),
    correction: numeric(given.correction, JUDGE_DEFAULTS.correction),
    shortCap: numeric(given.shortCap, JUDGE_DEFAULTS.shortCap),
    forceHigh: numeric(given.forceHigh, JUDGE_DEFAULTS.forceHigh),
    hardRetry: numeric(given.hardRetry, JUDGE_DEFAULTS.hardRetry),
    extremeKeywords: [...JUDGE_DEFAULTS.extremeKeywords, ...words(given.extremeKeywords), ...words(given.broadKeywords)],
    hardKeywords: [...JUDGE_DEFAULTS.hardKeywords, ...words(given.hardKeywords)],
    mediumKeywords: [...JUDGE_DEFAULTS.mediumKeywords, ...words(given.mediumKeywords)],
  }
}

const extraCache = new Map()

/** Extra keywords are matched as plain text, so a stray `(` in config cannot break the regex. */
function extraRegex(wordsList) {
  if (wordsList.length === 0) return null
  const key = wordsList.join('\u0000')
  const hit = extraCache.get(key)
  if (hit !== undefined) return hit
  const escaped = wordsList.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const built = new RegExp(escaped.join('|'), 'i')
  extraCache.set(key, built)
  return built
}

/**
 * Count distinct words in one category. English words need word boundaries; Chinese words are
 * matched as plain substrings because JavaScript's \b does not treat CJK as word characters.
 */
function keywordHits(text, wordsList) {
  let hits = 0
  for (const word of wordsList) {
    if (typeof word !== 'string' || word === '') continue
    if (/^[A-Za-z]/.test(word)) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?:s|es|ed|d|ing)?(?=$|[^A-Za-z0-9_])`, 'i')
      if (re.test(text)) hits += 1
    } else if (text.includes(word)) {
      hits += 1
    }
  }
  return hits
}

const GREETING_RE = /^(?:hi|hello|hey|你好|您好|嗨|在吗|谢谢|多谢|thanks|thank you|ok|okay|好的|好|嗯|收到)[\s!！。.?？~～]*$/i
const CONTINUE_RE = /^(?:(?:继续|接着|然后|往下|下一步)(?:[\s,，。.!！]|$)|(?:go on|continue)\b)/i
const CORRECTION_RE = /(?:不对|错了|还是不行|再试|重新|重试|换个|不是这个|又错|没用|不行|失败|bug still|still (?:wrong|failing)|try again|doesn'?t work)/i
const HARD_RETRY_RE = /(?:第三次|又是?错|还是(?:错|不对)|仍然不对|still failing|third time)/i

const FORCE_LOW_RE = /(?:简单(?:回答|说说|解释)|简短|一句话|不用(?:太)?(?:深入|复杂|思考)|别想太多|快速回答|简答|briefly|one sentence|quick answer|keep it short)/i
const FORCE_HIGH_RE = /(?:仔细(?:想|思考|分析|检查)|认真(?:想|思考|分析)|想清楚|深度思考|深入(?:分析|思考|研究)|全面(?:分析|考虑|调研)|系统性|严谨|一步一步|逐步|max effort|think (?:hard|carefully)|in[- ]depth|step by step)/i
const FORCE_MAX_RE = /(?:最高(?:强度|档)|最强|全力|彻底|穷尽|非常复杂|极其复杂|maximum effort|as hard as possible)/i

const CODE_FENCE_RE = /```|~~~/
const ERROR_WORD_RE = /\b(?:error|errors|exception|exceptions|failed|failure|crash|crashes)\b|报错|错误|异常|崩溃|闪退|失败|不工作/i
const STACK_RE = /(?:Traceback \(most recent call last\)|Caused by:|npm ERR!|^\s*at\s+.+\(.+:\d+(?::\d+)?\)|^\s*File ".*", line \d+|^\s*(?:TypeError|ReferenceError|SyntaxError|RangeError|LlmError|Error):)/m
const FILE_RE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|cpp|cc|c|h|hpp|json|ya?ml|toml|sql|sh|ps1|html|css)\b/gi

function codeScore(raw, opt) {
  const blocks = []
  const re = /```[\s\S]*?```|~~~[\s\S]*?~~~/g
  let match
  while ((match = re.exec(raw)) !== null) blocks.push(match[0])
  if (blocks.length === 0) return 0
  const lines = blocks.reduce((total, block) => total + block.split('\n').length, 0)
  if (blocks.length >= 2 || lines > 60) return opt.codeLarge
  if (lines >= 20) return opt.codeMedium
  return opt.codeSmall
}

function previousScore(value) {
  if (Number.isFinite(value)) return clampScore(value)
  if (TIERS.includes(value)) return scoreForTier(value)
  return undefined
}

/**
 * Pure 0–100 local scorer. Exported for tests and for anyone who wants to reuse the same
 * deterministic judgement outside the plugin. `prevScore` is the previous turn's score (or a
 * legacy tier string); `prevTask` is its clipped task text.
 */
export function scoreTask(text, prevScore, prevTask, options) {
  const merged = judgeOptions(options)
  const opt = merged
  const raw = String(text === undefined || text === null ? '' : text).trim()
  const prev = previousScore(prevScore)
  if (raw === '') {
    return { score: prev === undefined ? 0 : prev, triggered_by: 'empty', labels: [] }
  }
  const flat = normalize(raw)
  const labels = []

  // A regenerate resends the same prompt: that is the strongest escalation signal we get.
  if (prevTask !== undefined && prevTask !== null && normalize(prevTask) === flat) {
    return {
      score: clampScore((prev === undefined ? 40 : prev) + opt.regenerate),
      triggered_by: 'regenerate',
      labels: ['same-task'],
    }
  }
  if (HARD_RETRY_RE.test(flat)) {
    return { score: opt.hardRetry, triggered_by: 'hard-retry', labels: ['hard-retry'] }
  }
  if (prev !== undefined && CORRECTION_RE.test(flat)) {
    return { score: clampScore(prev + opt.correction), triggered_by: 'correction', labels: ['correction'] }
  }
  if (GREETING_RE.test(flat)) {
    return { score: 0, triggered_by: 'short', labels: ['greeting'] }
  }
  if (CONTINUE_RE.test(flat) && prev !== undefined) {
    return { score: prev, triggered_by: 'intent_inherit', labels: ['continue'] }
  }

  // Length is a weak signal on its own: a long pasted log usually contains the real question at
  // the end, but a long greeting or a long URL should not dominate the other signals.
  let score = 0
  const len = raw.length
  for (let i = 0; i < opt.lengthCuts.length - 1; i += 1) {
    if (len >= opt.lengthCuts[i]) {
      score = opt.lengthScores[i + 1]
      labels.push(i === 0 ? 'long' : i === 1 ? 'very-long' : i === 2 ? 'huge' : 'massive')
    }
  }

  const code = codeScore(raw, opt)
  if (code > 0) {
    score += code
    labels.push('code')
  }

  let error = 0
  if (ERROR_WORD_RE.test(raw)) {
    error += opt.errorWord
    labels.push('error')
  }
  if (STACK_RE.test(raw)) {
    error += opt.stackSignal
    labels.push('stack')
  }
  score += Math.min(15, error)

  let keywords = 0
  const extreme = keywordHits(raw, merged.extremeKeywords)
  const hard = keywordHits(raw, merged.hardKeywords)
  const medium = keywordHits(raw, merged.mediumKeywords)
  keywords += Math.min(35, extreme * opt.extremeKeyword + hard * opt.hardKeyword + medium * opt.mediumKeyword)
  if (extreme > 0) labels.push('broad-scope')
  if (hard > 0) labels.push('hard-topic')
  if (medium > 0) labels.push('topic')
  score += keywords

  let structure = 0
  const questions = (raw.match(/[?？]/g) || []).length
  if (questions >= 4) {
    structure += opt.question4
    labels.push('many-questions')
  } else if (questions >= 2) {
    structure += opt.question2
    labels.push('multi-question')
  }

  const numbered = (raw.match(/^\s*(?:\d+[.、)]|[-*])\s+/gm) || []).length
  if (numbered >= 5) {
    structure += opt.numbered5
    labels.push('checklist')
  } else if (numbered >= 3) {
    structure += opt.numbered3
    labels.push('checklist')
  }

  const files = (raw.match(FILE_RE) || []).length
  if (files >= 4) {
    structure += opt.files4
    labels.push('multi-file')
  } else if (files >= 2) {
    structure += opt.files2
    labels.push('multi-file')
  }
  score += Math.min(10, structure)

  if (prev === undefined && CORRECTION_RE.test(flat)) {
    score += opt.correction
    labels.push('correction')
  }
  if (FORCE_LOW_RE.test(flat)) {
    if (score > opt.shortCap) {
      score = opt.shortCap
      labels.push('explicit-short')
    }
  }
  if (FORCE_MAX_RE.test(flat)) {
    score = 100
    labels.push('explicit-max')
    return { score, triggered_by: 'intent_force', labels }
  }
  if (FORCE_HIGH_RE.test(flat)) {
    score = Math.max(score, opt.forceHigh)
    labels.push('explicit-high')
    return { score: clampScore(score), triggered_by: 'intent_force', labels }
  }

  return {
    score: clampScore(score),
    triggered_by: FORCE_LOW_RE.test(flat) && score <= opt.shortCap ? 'intent_exclude' : 'content',
    labels,
  }
}

/**
 * Tier-compatible wrapper kept for older callers. New code should use `scoreTask` so the
 * original 0–100 signal is not collapsed to three buckets.
 */
export function judgeTaskLocal(text, prevTier, prevTask, options) {
  const verdict = scoreTask(text, prevTier, prevTask, options)
  return { ...verdict, tier: tierForScore(verdict.score) }
}

/** Build the ordered effort ladder a model actually advertises. `off` is not a strength. */
export function buildEffortLadder(efforts, options) {
  const includeOff = options !== undefined && options !== null && options.includeOff === true
  const list = []
  const seen = new Set()
  for (const item of Array.isArray(efforts) ? efforts : []) {
    const id = typeof item === 'string' ? item : item !== null && typeof item === 'object' ? item.id : undefined
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    seen.add(id)
    list.push({ id, name: typeof item === 'object' && item !== null && typeof item.name === 'string' ? item.name : id })
  }
  const usable = list.filter((entry) => includeOff || entry.id !== 'off')
  if (usable.length === 0) return []
  // The adapter advertises efforts weakest → strongest, which is also pi-ai's order. If every id
  // is one of the standard levels, sort explicitly so a hand-written custom adapter cannot
  // accidentally reverse the ladder.
  if (usable.every((entry) => EFFORT_RANK[entry.id] !== undefined)) {
    usable.sort((a, b) => EFFORT_RANK[a.id] - EFFORT_RANK[b.id])
  }
  return usable
}

/**
 * Pick a rung from the model's own ladder. Examples: 2 levels split 0–49/50–100, 3 levels
 * 0–33/34–66/67–100, 4 levels 0–24/25–49/50–74/75–100.
 */
export function chooseEffortForScore(score, efforts, options) {
  const ladder = buildEffortLadder(efforts, options)
  if (ladder.length === 0) return null
  const s = clampScore(score)
  const index = Math.min(ladder.length - 1, Math.floor((s / 100) * ladder.length))
  return { effort: ladder[index].id, index, count: ladder.length, ladder: ladder.map((entry) => entry.id) }
}

/** Legacy tier-based selector. Kept for compatibility; not used by the request path. */
export function chooseEffort(tier, efforts, overrides) {
  const ids = Array.isArray(efforts)
    ? efforts.map((item) => (typeof item === 'string' ? item : item !== null && typeof item === 'object' ? item.id : undefined)).filter((id) => typeof id === 'string')
    : []
  if (ids.length === 0) return null
  const order = overrides !== undefined && overrides !== null && Array.isArray(overrides[tier])
    ? overrides[tier]
    : TIER_EFFORT_ORDER[tier]
  for (const id of order || []) {
    if (ids.includes(id)) return id
  }
  const target = TIER_RANK[tier]
  let best = null
  let bestDistance = Infinity
  for (const id of ids) {
    if (EFFORT_RANK[id] === undefined) continue
    const distance = Math.abs(EFFORT_RANK[id] - target)
    if (distance < bestDistance || (distance === bestDistance && EFFORT_RANK[id] > EFFORT_RANK[best])) {
      best = id
      bestDistance = distance
    }
  }
  if (best !== null) return best
  const last = ids.length - 1
  if (tier === 'low') return ids[0]
  if (tier === 'max') return ids[last]
  return ids[Math.floor(last / 2)]
}

/** Legacy tier-vs-effort probe, retained for older callers. */
export function effortMapping(tier, effort) {
  const want = TIER_RANK[tier]
  const got = EFFORT_RANK[effort]
  if (want === undefined || got === undefined) return 'exact'
  if (got === want) return 'exact'
  return got > want ? 'raised' : 'capped'
}

/** POST the original Laya v2 wire format; any failure returns null so the local scorer wins. */
export async function judgeTaskRemote(url, text, prevScore, prevTask, sessionId, signal, timeoutMs) {
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
        prev_score: prevScore === undefined ? null : prevScore,
        prev_tier: typeof prevScore === 'string'
          ? prevScore
          : Number.isFinite(Number(prevScore))
            ? (Number(prevScore) >= 67 ? 'max' : Number(prevScore) >= 34 ? 'high' : 'low')
            : null,
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
    if (Number.isFinite(Number(body.score))) {
      return {
        score: clampScore(Number(body.score)),
        triggered_by: body.triggered_by || 'remote',
        labels: Array.isArray(body.labels) ? body.labels : null,
      }
    }
    const tier = body.tier ?? body.level
    if (!TIERS.includes(tier)) {
      log(`judge ${url} returned no usable score`, 'warn')
      return null
    }
    return { score: scoreForTier(tier), triggered_by: body.triggered_by || 'remote', labels: body.labels || null }
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

/** Tool results and runtime context travel through the same inbox. Only the human's own message may score. */
function isUserMessage(message) {
  if (message === undefined || message === null || message.role !== 'user') return false
  const kind = message.source !== undefined && message.source !== null ? message.source.kind : undefined
  return kind === undefined || kind === 'user'
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

/** One history row. The model's effort vocabulary is constant per model, so `/state` carries it once. */
function rowFor(judgment, selection, task, provider, model, note) {
  const score = judgment !== null && judgment !== undefined && Number.isFinite(judgment.score) ? scoreTaskGuard(judgment.score) : null
  return {
    ts: Math.round(Date.now() / 1000),
    score,
    tier: score === null ? null : tierForScore(score),
    effort: selection !== null && selection !== undefined ? selection.effort : null,
    levelIndex: selection !== null && selection !== undefined ? selection.index : null,
    levelCount: selection !== null && selection !== undefined ? selection.count : null,
    ladder: selection !== null && selection !== undefined ? selection.ladder : null,
    provider,
    model,
    task: task === undefined || task === null ? '' : clipTask(String(task), 120),
    triggered_by: judgment === null || judgment === undefined ? 'no-task' : judgment.triggered_by,
    labels: judgment === null || judgment === undefined ? null : judgment.labels,
    note: note === undefined ? '' : note,
  }
}

function scoreTaskGuard(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value))))
}

/** Find the index of an effort that is already in a model's ladder (used for deferred rows). */
function selectionForEffort(effort, capability) {
  const ladder = capability !== undefined && capability !== null && Array.isArray(capability.ladder) ? capability.ladder : []
  const index = ladder.indexOf(effort)
  return { effort, index: index >= 0 ? index : null, count: ladder.length || null, ladder: ladder.length ? ladder : null }
}

export function apply(ctx, config) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const mountMode = MODES.includes(cfg.mode) ? cfg.mode : (readModeFile() || 'auto')
  const mode = { value: mountMode }
  const useGlobal = cfg.global !== false
  const judgeConfig = judgeOptions(cfg.judge)
  const modelCache = new Map()
  const warming = new Map()
  const sessionState = new Map()
  const lastApplied = new Map()
  const claimState = new Map()
  const history = new Map()
  const remoteScores = new Map()
  const remotePending = new Set()
  const judgeTimeout = Number.isFinite(cfg.judgeTimeoutMs)
    ? Math.min(Math.max(Math.round(cfg.judgeTimeoutMs), 100), 10000)
    : REMOTE_JUDGE_TIMEOUT_MS
  let judgeFailures = 0
  let judgeSkipUntil = 0
  let warmTimer = null

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
    history.delete(key)
    history.set(key, rows)
    state.sessions[key] = rows
    state.last = row
    state.updatedAt = Date.now()
    if (history.size > SESSION_LIMIT) {
      const oldest = history.keys().next().value
      history.delete(oldest)
      delete state.sessions[oldest]
      sessionState.delete(oldest)
      lastApplied.delete(oldest)
      claimState.delete(oldest)
    }
  }

  function capabilityOf(info) {
    const declared = info !== undefined && info !== null && info.reasoning !== undefined && info.reasoning !== null
      ? info.reasoning
      : null
    const ladder = declared !== null ? buildEffortLadder(declared.efforts, { includeOff: cfg.includeOff === true }) : []
    return {
      at: Date.now(),
      supported: ladder.map((entry) => entry.id),
      ladder: ladder.map((entry) => entry.id),
      defaultEffort: declared === null ? undefined : declared.defaultEffort,
      error: null,
    }
  }

  function cacheKeyOf(provider, model) {
    return `${provider}\u0000${model}`
  }

  async function warmModel(provider, model, signal) {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (llm === undefined || llm === null || typeof llm.resolveModelInfo !== 'function') return null
    const cacheKey = cacheKeyOf(provider, model)
    const pending = warming.get(cacheKey)
    if (pending !== undefined) return pending
    const promise = (async () => {
      try {
        const info = await llm.resolveModelInfo(provider, model, signal)
        const capability = capabilityOf(info)
        modelCache.set(cacheKey, capability)
        return capability
      } catch (error) {
        log(`model info failed for ${provider}/${model}: ${error.message}`, 'warn')
        modelCache.set(cacheKey, { at: Date.now(), supported: [], ladder: [], defaultEffort: undefined, error: error.message })
        return null
      } finally {
        warming.delete(cacheKey)
      }
    })()
    warming.set(cacheKey, promise)
    return promise
  }

  function capabilityFor(provider, model) {
    const cacheKey = cacheKeyOf(provider, model)
    const hit = modelCache.get(cacheKey)
    if (hit === undefined) return null
    if (Date.now() - hit.at >= MODEL_INFO_TTL_MS) warmModel(provider, model).catch(() => {})
    return hit
  }

  async function warmAll() {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') return
    let providers = []
    try {
      providers = llm.listProviders()
    } catch (error) {
      log(`could not list providers: ${error.message}`, 'warn')
      return
    }
    for (const provider of Array.isArray(providers) ? providers : []) {
      const providerId = provider !== null && typeof provider === 'object' ? provider.id : undefined
      if (typeof providerId !== 'string' || providerId === '') continue
      let models = []
      try {
        models = await llm.listModels(providerId)
      } catch (error) {
        log(`could not list models for ${providerId}: ${error.message}`, 'warn')
        continue
      }
      for (const model of Array.isArray(models) ? models : []) {
        const modelId = typeof model === 'string' ? model : model !== null && typeof model === 'object' ? model.id : undefined
        if (typeof modelId === 'string' && modelId !== '') await warmModel(providerId, modelId).catch(() => {})
      }
    }
  }

  function scheduleWarmAll() {
    if (warmTimer !== null) return
    warmTimer = setTimeout(() => {
      warmTimer = null
      warmAll().catch((error) => log(`warm-up failed: ${error.message}`, 'warn'))
    }, 250)
    if (typeof warmTimer.unref === 'function') warmTimer.unref()
  }

  function remoteScoreFor(message, key) {
    if (message === undefined || message === null || typeof message.id !== 'string' || message.id === '') return undefined
    const hit = remoteScores.get(message.id)
    if (hit !== undefined) {
      remoteScores.delete(message.id)
      return hit
    }
    return undefined
  }

  function judgeRemoteInBackground(message, payload) {
    if (typeof cfg.judgeUrl !== 'string' || cfg.judgeUrl === '') return
    if (Date.now() < judgeSkipUntil) return
    if (message === undefined || message === null || typeof message.id !== 'string' || message.id === '') return
    if (remoteScores.has(message.id) || remotePending.has(message.id)) return
    const text = textOf(message)
    if (normalize(text) === '') return
    const key = keyOf(payload)
    const previous = sessionState.get(key)
    const session = payload !== undefined && payload !== null && payload.agent !== undefined ? payload.agent.session : undefined
    const sessionId = session !== undefined && session !== null ? session.id : undefined
    remotePending.add(message.id)
    judgeTaskRemote(cfg.judgeUrl, text, previous === undefined ? undefined : previous.score, previous === undefined ? undefined : previous.task, sessionId, undefined, judgeTimeout)
      .then((verdict) => {
        if (verdict !== null) {
          remoteScores.set(message.id, verdict)
          while (remoteScores.size > 100) {
            const oldest = remoteScores.keys().next().value
            remoteScores.delete(oldest)
          }
        } else {
          judgeFailures += 1
          if (judgeFailures >= JUDGE_BREAKER_FAILURES) {
            judgeFailures = 0
            judgeSkipUntil = Date.now() + JUDGE_BREAKER_COOLDOWN_MS
            log(`remote judge unreachable; skipping it for ${Math.round(JUDGE_BREAKER_COOLDOWN_MS / 1000)}s`, 'warn')
          }
        }
      })
      .catch((error) => log(`remote judge failed: ${error.message}`, 'warn'))
      .finally(() => remotePending.delete(message.id))
  }

  ctx.on('llm/adapters-updated', () => scheduleWarmAll())

  ctx.on('agent/inbox/inserted', (payload) => {
    const message = payload !== undefined && payload !== null ? payload.message : undefined
    if (!isUserMessage(message)) return
    judgeRemoteInBackground(message, payload)
  }, { global: useGlobal })

  ctx.on('agent/inbox/claimed', (payload) => {
    try {
      const message = payload !== undefined && payload !== null ? payload.message : undefined
      if (!isUserMessage(message)) return
      if (mode.value === 'manual') return
      const text = textOf(message)
      if (normalize(text) === '') return
      const agent = payload !== undefined && payload !== null ? payload.agent : undefined
      const model = agent !== undefined && agent !== null ? agent.model : undefined
      if (model === undefined || model === null || typeof model.current !== 'function' || typeof model.select !== 'function') return
      const current = model.current()
      if (current === undefined || current === null || typeof current.provider !== 'string' || typeof current.model !== 'string') return

      const key = keyOf(payload)
      const turn = payload !== undefined && payload !== null ? payload.turn : undefined
      let claim = claimState.get(key)
      if (claim === undefined || claim.turn !== turn) {
        const previous = sessionState.get(key)
        claim = {
          turn,
          previousScore: previous === undefined ? undefined : previous.score,
          previousTask: previous === undefined ? undefined : previous.task,
          bestScore: null,
        }
        claimState.set(key, claim)
      }

      const remote = remoteScoreFor(message)
      const judgment = remote !== undefined ? remote : scoreTask(text, claim.previousScore, claim.previousTask, judgeConfig)
      if (claim.bestScore !== null && judgment.score <= claim.bestScore) return

      const capability = capabilityFor(current.provider, current.model)
      if (capability === null) {
        warmModel(current.provider, current.model).catch(() => {})
        return
      }
      if (capability.error !== null || capability.ladder.length === 0) {
        record(key, rowFor(judgment, null, text, current.provider, current.model, 'unsupported'))
        claim.bestScore = judgment.score
        sessionState.set(key, { score: judgment.score, task: clipTask(text, judgeConfig.maxChars), turn })
        return
      }

      const selection = chooseEffortForScore(judgment.score, capability.ladder, { includeOff: cfg.includeOff === true })
      if (selection === null) {
        record(key, rowFor(judgment, null, text, current.provider, current.model, 'no-matching-effort'))
        claim.bestScore = judgment.score
        return
      }

      if (cfg.respectExplicit === true) {
        const recorded = typeof model.recordedSelection === 'function' ? model.recordedSelection() : null
        const recordedEffort = recorded !== null && recorded !== undefined ? recorded.reasoningEffort : undefined
        if (recordedEffort !== undefined) {
          const previous = lastApplied.get(key)
          const ours = previous !== undefined
            && previous.effort === recordedEffort
            && previous.provider === current.provider
            && previous.model === current.model
          if (!ours) {
            record(key, rowFor(judgment, selectionForEffort(recordedEffort, capability), text, current.provider, current.model, 'explicit'))
            claim.bestScore = judgment.score
            return
          }
        }
      }

      model.select({
        provider: current.provider,
        model: current.model,
        reasoningEffort: selection.effort,
      })
      lastApplied.set(key, { effort: selection.effort, provider: current.provider, model: current.model })
      claim.bestScore = judgment.score
      sessionState.set(key, { score: judgment.score, task: clipTask(text, judgeConfig.maxChars), turn, effort: selection.effort, provider: current.provider, model: current.model })
      record(key, rowFor(judgment, selection, text, current.provider, current.model, ''))
      log(`turn ${turn} score ${judgment.score} (${judgment.triggered_by})`
        + ` -> ${selection.effort} [${selection.index + 1}/${selection.count}] on ${current.provider}/${current.model}`)
    } catch (error) {
      log(`claim handler failed: ${error.message}`, 'warn')
    }
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
        const last = state.last
        json(res, 200, {
          mode: mode.value,
          tier: last === null ? null : last.tier,
          score: last === null ? null : last.score,
          effort: last === null ? null : last.effort,
          levelIndex: last === null ? null : last.levelIndex,
          levelCount: last === null ? null : last.levelCount,
          ladder: last === null ? null : last.ladder,
          updatedAt: state.updatedAt,
          last,
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

  warmAll().catch((error) => log(`initial warm-up failed: ${error.message}`, 'warn'))
  log(`mounted (mode ${mode.value}); score-driven effort routing on the turn's own model`)
  log('effort ladder = the current model reasoning.efforts, divided by its declared count')
  if (cfg.respectExplicit === true) {
    log('respectExplicit is on: a user/delegated explicit reasoningEffort is left untouched')
  }
  if (typeof cfg.judgeUrl === 'string' && cfg.judgeUrl !== '' && !/^https:/i.test(cfg.judgeUrl)) {
    log(`judgeUrl is not https: the task text (up to ${judgeConfig.maxChars} chars) will be sent in clear text to ${cfg.judgeUrl}`, 'warn')
  }
}
