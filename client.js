/**
 * Browser half of dsh-auto-effort: the tier chip beside the composer.
 *
 * Executing this file only registers a lazy-CJS factory; React comes from the shell's module table.
 * The host half serves three same-origin routes: /auto-effort/state (read, optionally narrowed to
 * one session), /auto-effort/mode (switch auto/manual) and /auto-effort/locale/<lang>.json (copy).
 * No cross-origin service is involved, so the chip works on a fresh install without any extra
 * process.
 */
window.__ModuleLoader__.load({
  id: 'dsh-auto-effort',
  factory: (require) => {
    const React = require('react')

    const STATE_URL = '/auto-effort/state'
    const MODE_URL = '/auto-effort/mode'
    const LOCALE_URL = '/auto-effort/locale/'
    const POLL_MS = 3000
    const OFFLINE_AFTER = 2
    const TOAST_MS = 2200
    const WRITE_ERROR_MS = 3000
    const HISTORY_LIMIT = 20
    const TASK_CHARS = 34

    const TIER_ORDER = { low: 0, high: 1, max: 2 }
    const TIER_COLOR = { low: '#3fb950', high: '#d29922', max: '#f85149' }
    const MUTED = '#8b949e'

    /**
     * Chinese copy is the built-in fallback: the dictionary arrives over HTTP, and a chip that
     * renders its own translation keys when that request fails would be worse than a language
     * mismatch. Every user-visible string below goes through `t()`, so the dictionary wins.
     */
    const FALLBACK = {
      'tier.low': 'AUTO · 低',
      'tier.high': 'AUTO · 高',
      'tier.max': 'AUTO · MAX',
      'tier.short.low': '低',
      'tier.short.high': '高',
      'tier.short.max': 'MAX',
      'state.offline': 'AUTO · 离线',
      'state.pending': 'AUTO · 待判定',
      'state.unsupported': 'AUTO · 不支持',
      'state.deferred': 'AUTO · 已指定',
      'state.writeError': 'AUTO · 切换失败',
      'state.manual': '手动',
      'toast.raise': '⤴ 升档 · ',
      'toast.adjust': '↩ 调整 · ',
      'panel.title': '自动思考强度 · 最近判定',
      'panel.empty': '本会话还没有判定记录',
      'panel.global': '全局开关，影响所有会话',
      'hint.raised': '该模型最低只到 {effort}',
      'hint.capped': '该模型最高只到 {effort}',
      'hint.deferred': '本轮请求已自带 reasoningEffort={effort}，按 respectExplicit 保持原样',
      'hint.writeError': '切换失败：宿主拒绝了这次写入（跨站或非 JSON），3 秒后恢复显示',
      'hint.offline': '自动思考强度：宿主路由不可达',
      'hint.manual': '手动 · 点击恢复 Auto',
      'hint.pending': '自动 · 等待本轮判定',
      'hint.auto': '自动 · 点击切到手动',
      'hint.noEffort': '该模型未声明 reasoning effort',
      'hint.turn': '本轮 {tier} → {effort}',
      'hint.model': '{provider}/{model}',
      'cell.unsupported': '不支持',
      'cell.none': '—',
      'reason.content': '内容判断',
      'reason.short': '短任务',
      'reason.greeting': '寒暄',
      'reason.regenerate': '检测到重试·升档',
      'reason.hard-retry': '连续出错·升档',
      'reason.correction': '纠正·升档',
      'reason.intent_force': '用户要求深入',
      'reason.intent_inherit': '保持上轮',
      'reason.intent_exclude': '用户要求从简',
      'reason.continue': '继续上轮',
      'reason.remote': '远程判定',
      'reason.no-task': '无任务文本',
      'reason.empty': '空任务',
      'reason.no-matching-effort': '无匹配档位',
      'reason.unsupported': '模型不支持',
    }

    const CSS = `
@keyframes autoEffortPop{0%{transform:scale(1)}40%{transform:scale(1.08)}100%{transform:scale(1)}}
@keyframes autoEffortBreathe{0%,100%{opacity:.85}50%{opacity:1}}
@keyframes autoEffortToastIn{0%{opacity:0;transform:translateY(4px)}100%{opacity:1;transform:translateY(0)}}
@keyframes autoEffortToastOut{0%{opacity:1}100%{opacity:0}}
.autoEffortChip{display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;
  user-select:none;box-sizing:border-box;height:22px;padding:0 9px;border-radius:999px;font-size:11px;
  line-height:1;border:1px solid var(--dsw-alias-border-l1);background:transparent;
  transition:background-color .16s ease-out,border-color .16s ease-out,color .3s ease}
.autoEffortChip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.autoEffortDot{width:6px;height:6px;border-radius:999px;flex:none;transition:background-color .3s ease}
.autoEffortPop{animation:autoEffortPop 300ms ease-out}
.autoEffortMax{animation:autoEffortBreathe 2.4s ease-in-out infinite}
.autoEffortToast{position:absolute;bottom:calc(100% + 8px);right:0;white-space:nowrap;
  padding:4px 9px;border-radius:7px;font-size:11px;line-height:16px;pointer-events:none;
  background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-3,#fff));
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);
  box-shadow:0 6px 18px rgba(0,0,0,.14);animation:autoEffortToastIn .18s ease-out}
.autoEffortToastOut{animation:autoEffortToastOut .3s ease-in forwards}
.autoEffortPanel{position:absolute;bottom:calc(100% + 8px);right:0;width:340px;max-height:330px;
  overflow-y:auto;padding:6px;border-radius:9px;text-align:left;z-index:30;
  background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-3,#fff));
  border:1px solid var(--dsw-alias-border-l1);box-shadow:0 10px 28px rgba(0,0,0,.18)}
.autoEffortHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;
  padding:4px 6px 6px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary)}
.autoEffortMeta{font-weight:400;color:var(--dsw-alias-label-secondary);font-size:10px}
.autoEffortEmpty{padding:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.autoEffortRow{display:flex;align-items:center;gap:7px;padding:3px 6px;border-radius:5px;
  font-size:11px;line-height:16px}
.autoEffortRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.autoEffortTime{opacity:.55;font-variant-numeric:tabular-nums;flex:none}
.autoEffortTask{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-secondary)}
.autoEffortEffort{flex:none;padding:0 5px;border-radius:4px;font-size:10px;font-weight:600;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.autoEffortWhy{opacity:.6;flex:none}
`

    const store = {
      data: null,
      offline: false,
      failures: 0,
      mode: null,
      writeError: false,
      session: null,
      listeners: new Set(),
    }
    let poller = null
    let styleEl = null
    let dict = null
    let dictRequested = false

    function lookup(source, key) {
      let node = source
      for (const part of key.split('.')) {
        if (node === null || typeof node !== 'object') return undefined
        node = node[part]
      }
      return typeof node === 'string' ? node : undefined
    }

    function t(key, vars) {
      const found = dict === null ? undefined : lookup(dict, key)
      let text = found === undefined ? lookup(FALLBACK, key) : found
      if (text === undefined) text = key
      if (vars === undefined || vars === null) return text
      return text.replace(/\{(\w+)\}/g, (whole, name) => (vars[name] === undefined ? whole : String(vars[name])))
    }

    function loadDictionary() {
      if (dictRequested) return
      dictRequested = true
      const tag = typeof navigator !== 'undefined' && typeof navigator.language === 'string'
        ? navigator.language.toLowerCase().split('-')[0]
        : 'en'
      const lang = /^[a-z]{2}$/.test(tag) ? tag : 'en'
      fetch(LOCALE_URL + lang + '.json', { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          if (json !== null && typeof json === 'object' && json.ui !== null && typeof json.ui === 'object') {
            dict = json.ui
            notify()
          }
        })
        .catch(() => { /* keep the built-in copy */ })
    }

    function notify() {
      for (const fn of Array.from(store.listeners)) {
        try { fn() } catch { /* one bad subscriber must not stop the rest */ }
      }
    }

    /**
     * Only this session's rows. Falling back to the newest row of *any* session would show another
     * conversation's task in this composer, which reads as a wrong judgment rather than no data.
     */
    function rowsFor(sessionId) {
      const data = store.data
      if (data === null || typeof data !== 'object') return []
      const sessions = data.sessions
      if (sessions === null || typeof sessions !== 'object') return []
      if (sessionId === undefined || sessionId === null) return []
      return Array.isArray(sessions[sessionId]) ? sessions[sessionId] : []
    }

    function stateUrl() {
      return store.session === null || store.session === ''
        ? STATE_URL
        : STATE_URL + '?session=' + encodeURIComponent(store.session)
    }

    function pollOnce() {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      fetch(stateUrl(), { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error('http ' + String(res.status)))))
        .then((json) => {
          store.data = json
          store.failures = 0
          store.offline = false
          if (json !== null && typeof json === 'object' && (json.mode === 'auto' || json.mode === 'manual')) {
            store.mode = json.mode
          }
          notify()
        })
        .catch(() => {
          store.failures += 1
          if (store.failures >= OFFLINE_AFTER && !store.offline) {
            store.offline = true
            notify()
          }
        })
      if (store.mode === null) {
        fetch(MODE_URL, { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : null))
          .then((json) => {
            if (json !== null && (json.mode === 'auto' || json.mode === 'manual') && json.mode !== store.mode) {
              store.mode = json.mode
              notify()
            }
          })
          .catch(() => {})
      }
    }

    /** The chip follows one session, so a session change must not wait for the next tick. */
    function setSession(sessionId) {
      const next = typeof sessionId === 'string' ? sessionId : null
      if (store.session === next) return
      store.session = next
      pollOnce()
    }

    function writeMode(next) {
      return fetch(MODE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error('http ' + String(res.status)))))
        .then((json) => {
          if (json !== null && (json.mode === 'auto' || json.mode === 'manual')) {
            store.mode = json.mode
            notify()
          }
        })
        .catch(() => {
          // The route refuses cross-site and non-JSON writes; a silent no-op would look like a
          // dead chip, so say so for a moment and fall back to whatever the poller reports.
          store.writeError = true
          notify()
          setTimeout(() => {
            store.writeError = false
            notify()
          }, WRITE_ERROR_MS)
        })
    }

    function startPolling() {
      if (poller !== null) return
      pollOnce()
      poller = setInterval(pollOnce, POLL_MS)
    }

    function reasonText(triggeredBy) {
      if (triggeredBy === undefined || triggeredBy === null) return ''
      const key = 'reason.' + String(triggeredBy)
      const text = t(key)
      return text === key ? String(triggeredBy) : text
    }

    function mappingText(row) {
      if (row === null || row === undefined || typeof row.mapping !== 'string' || row.mapping === 'exact') return ''
      if (row.effort === null || row.effort === undefined) return ''
      return row.mapping === 'raised'
        ? t('hint.raised', { effort: row.effort })
        : t('hint.capped', { effort: row.effort })
    }

    function clockOf(ts) {
      if (typeof ts !== 'number' || !isFinite(ts)) return '--:--'
      const d = new Date(ts * 1000)
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    }

    function clip(text) {
      const s = typeof text === 'string' ? text : ''
      return s.length > TASK_CHARS ? s.slice(0, TASK_CHARS) + '…' : s
    }

    function useStore() {
      const [, setTick] = React.useState(0)
      React.useEffect(() => {
        startPolling()
        const fn = () => setTick((n) => n + 1)
        store.listeners.add(fn)
        return () => { store.listeners.delete(fn) }
      }, [])
      return store
    }

    function Chip(props) {
      const state = useStore()
      const [popover, setPopover] = React.useState(false)
      const [popKey, setPopKey] = React.useState(0)
      const [toast, setToast] = React.useState(null)
      const [toastOut, setToastOut] = React.useState(false)
      // Timers and the previous row are bookkeeping, not render inputs: a ref keeps them out of
      // the render path instead of scheduling a re-render on every hover.
      const hover = React.useRef(null)
      const previous = React.useRef(null)

      const sessionId = props === undefined || props === null ? undefined : props.sessionId
      const rows = rowsFor(sessionId).slice(-HISTORY_LIMIT)
      const latest = rows.length === 0 ? null : rows[rows.length - 1]
      const offline = state.offline
      const manual = state.mode === 'manual'
      const tier = latest !== null && typeof latest.tier === 'string' ? latest.tier : null
      const effort = latest !== null && typeof latest.effort === 'string' ? latest.effort : null
      const unsupported = latest !== null && (latest.note === 'unsupported' || latest.note === 'no-matching-effort')
      const deferred = latest !== null && latest.note === 'explicit'
      const writeError = state.writeError === true
      const mapping = latest !== null && typeof latest.mapping === 'string' ? latest.mapping : null
      const mapped = mapping !== null && mapping !== 'exact' && effort !== null && tier !== null

      React.useEffect(() => {
        loadDictionary()
        setSession(sessionId)
      }, [sessionId])

      React.useEffect(() => {
        if (latest === null) return
        const prev = previous.current
        previous.current = { tier: latest.tier, effort: latest.effort, ts: latest.ts, sessionId }
        if (prev === null || prev.sessionId !== sessionId) return
        if (prev.tier === latest.tier && prev.effort === latest.effort) return
        setPopKey((n) => n + 1)
        const up = TIER_ORDER[latest.tier] > TIER_ORDER[prev.tier]
        const text = (up ? t('toast.raise') : t('toast.adjust')) + reasonText(latest.triggered_by)
          + (effort === null ? '' : ' → ' + effort)
        setToast(text)
        setToastOut(false)
      }, [latest === null ? null : String(latest.ts) + ':' + String(latest.tier) + ':' + String(latest.effort), sessionId])

      React.useEffect(() => {
        if (toast === null) return undefined
        const hide = setTimeout(() => setToastOut(true), TOAST_MS)
        const clear = setTimeout(() => { setToast(null); setToastOut(false) }, TOAST_MS + 320)
        return () => { clearTimeout(hide); clearTimeout(clear) }
      }, [toast])

      const onEnter = () => {
        if (hover.current !== null) clearTimeout(hover.current)
        hover.current = setTimeout(() => setPopover(true), 300)
      }
      const onLeave = () => {
        if (hover.current !== null) clearTimeout(hover.current)
        hover.current = setTimeout(() => setPopover(false), 150)
      }
      React.useEffect(() => () => { if (hover.current !== null) clearTimeout(hover.current) }, [])

      const nothingYet = !offline && latest === null
      const color = offline || nothingYet || deferred || writeError ? MUTED : (manual ? null : TIER_COLOR[tier] || MUTED)
      const tierLabel = tier === null ? '' : t('tier.' + tier)
      const tierShort = tier === null ? '' : t('tier.short.' + tier)
      const text = writeError
        ? t('state.writeError')
        : offline
          ? t('state.offline')
          : manual
          ? (tier === null ? t('state.manual') : t('state.manual') + ' · ' + tierShort)
          : nothingYet
            ? t('state.pending')
            : unsupported
              ? t('state.unsupported')
              : deferred
                ? t('state.deferred') + (effort === null ? '' : ' · ' + effort)
                : mapped
                  ? (tierLabel || t('state.pending')) + ' → ' + effort
                  : tierLabel || t('state.pending')
      const mappingHint = mapping === 'raised'
        ? t('hint.raised', { effort })
        : mapping === 'capped'
          ? t('hint.capped', { effort })
          : ''
      const modelLine = latest !== null && latest.model
        ? '\n' + t('hint.model', { provider: latest.provider, model: latest.model })
        : ''
      const title = writeError
        ? t('hint.writeError')
        : offline
          ? t('hint.offline')
          : manual
          ? t('hint.manual')
          : nothingYet
            ? t('hint.pending')
            : deferred
              ? t('hint.deferred', { effort: effort === null ? '' : effort })
                + '\n' + t('hint.auto')
              : t('hint.auto') + '\n'
              + (effort === null ? t('hint.noEffort') : t('hint.turn', { tier, effort }))
              + (mappingHint === '' ? '' : '\n' + mappingHint)
              + modelLine

      const classes = ['autoEffortChip']
      if (!offline && !manual && tier === 'max') classes.push('autoEffortMax')

      // Re-mounting the chip on every tier change replays the pop animation; a class that is only
      // ever added would animate once and then stay silent for the rest of the session.
      const chip = React.createElement('div', {
        key: 'chip-' + String(popKey),
        className: classes.join(' '),
        style: { color: color === null ? 'var(--dsw-alias-label-primary)' : color, fontWeight: manual ? 400 : 600 },
        title,
        onClick: () => { writeMode(manual ? 'auto' : 'manual') },
        onMouseEnter: onEnter,
        onMouseLeave: onLeave,
      },
        React.createElement('span', {
          className: 'autoEffortDot',
          style: { background: color === null ? 'var(--dsw-alias-label-dimmed)' : color },
        }),
        React.createElement('span', null, text),
      )

      const toastNode = toast === null ? null : React.createElement('div', {
        className: 'autoEffortToast' + (toastOut ? ' autoEffortToastOut' : ''),
      }, toast)

      const panel = popover
        ? React.createElement('div', { className: 'autoEffortPanel' },
            React.createElement('div', { className: 'autoEffortHead' },
              React.createElement('span', null, t('panel.title')),
              React.createElement('span', { className: 'autoEffortMeta' },
                latest !== null && latest.model ? latest.model : t('panel.global')),
            ),
            rows.length === 0
              ? React.createElement('div', { className: 'autoEffortEmpty' }, t('panel.empty'))
              : rows.slice().reverse().map((row, index) => React.createElement('div', {
                key: String(row.ts) + ':' + String(index),
                className: 'autoEffortRow',
                title: mappingText(row) || (row.note === 'explicit' ? t('hint.deferred', { effort: row.effort === null ? '' : row.effort }) : undefined),
              },
                React.createElement('span', { className: 'autoEffortTime' }, clockOf(row.ts)),
                React.createElement('span', {
                  className: 'autoEffortDot',
                  style: { background: TIER_COLOR[row.tier] || MUTED },
                }),
                React.createElement('span', { className: 'autoEffortTask' }, clip(row.task)),
                React.createElement('span', { className: 'autoEffortEffort' },
                  row.effort === null || row.effort === undefined
                    ? (row.note === 'unsupported' ? t('cell.unsupported') : t('cell.none'))
                    : row.effort),
                React.createElement('span', { className: 'autoEffortWhy' }, reasonText(row.triggered_by)),
              )),
          )
        : null

      return React.createElement('div', {
        style: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
      }, chip, toastNode, panel)
    }

    function apply(ctx) {
      if (styleEl === null) {
        styleEl = document.createElement('style')
        styleEl.setAttribute('data-dsh-auto-effort', 'tier-chip')
        styleEl.textContent = CSS
        document.head.appendChild(styleEl)
      }
      loadDictionary()
      startPolling()
      ctx.effect(() => () => {
        if (poller !== null) { clearInterval(poller); poller = null }
        if (styleEl !== null && styleEl.parentNode !== null) styleEl.parentNode.removeChild(styleEl)
        styleEl = null
      })
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
        { name: 'conversation.input.right', id: 'auto-effort-tier', order: 5 },
        (slotProps) => React.createElement(Chip, {
          sessionId: slotProps === undefined || slotProps === null ? undefined : slotProps.sessionId,
        }),
      ))
    }

    return { name: 'auto-effort-client', inject: ['slots'], apply }
  },
})
