/* dsh-cua-pre — browser half (hand-written __ModuleLoader__ bundle).
 * Registers three additive surfaces (same mechanism as dsh-auto-memory):
 *   1. floating FAB (fixed, right-bottom corner — decoupled from third-party sidebar)
 *   2. shell.overlay         — 电脑控制面板: 实况(操作流) / 画面(帧+vision描述)
 *   3. settings.section      — 「电脑控制」设置页(基础 / 视觉识图 / 安全)
 * Data flows over /api/dsh-cua-pre/* (loopback-only host routes).
 */
console.log('[dsh-cua-pre] client v0.6.0 loading')
window.__ModuleLoader__.load({
  id: '@a9i5k4/dsh-cua-pre',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef

    var API = {
      state: '/api/dsh-cua-pre/state',
      config: '/api/dsh-cua-pre/config',
      ops: '/api/dsh-cua-pre/ops',
      frames: '/api/dsh-cua-pre/frames',
      frameFile: '/api/dsh-cua-pre/frame-file?id=',
      detect: '/api/dsh-cua-pre/detect',
      installDeps: '/api/dsh-cua-pre/install-deps',
      bootstrap: '/api/dsh-cua-pre/bootstrap',
      urlConsumed: '/api/dsh-cua-pre/url-consumed',
      watch: '/api/dsh-cua-pre/watch',
    }

    function apiGet(path) {
      return fetch(path).then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json() })
    }
    function apiPost(path, body) {
      return fetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json() })
    }

    // ───────────────────────── 样式 ─────────────────────────
    var GLASS = {
      background: 'color-mix(in srgb, var(--dsw-alias-bg-overlay, rgba(22,24,30,0.9)) 88%, transparent)',
      backdropFilter: 'blur(18px) saturate(140%)',
      WebkitBackdropFilter: 'blur(18px) saturate(140%)',
      border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.12))',
      borderRadius: 14,
      color: 'var(--dsw-alias-label-primary, #e8eaf0)',
      boxShadow: '0 10px 40px rgba(0,0,0,0.35)',
    }
    var MUTED = 'var(--dsw-alias-label-secondary, rgba(160,170,185,0.95))'
    var C_TEXT = 'var(--dsw-alias-label-primary, #e8eaf0)'
    var C_BG = 'color-mix(in srgb, var(--dsw-alias-bg-overlay, rgba(22,26,34,0.9)) 90%, transparent)'
    var C_LAYER = 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08)))'
    var C_BORDER = 'var(--dsw-alias-border-l1, rgba(128,128,128,0.35))'
    var C_BRAND = 'var(--dsw-alias-brand-primary, #4f7cff)'
    var C_OK = '#3fb950'   /* 双主题可读（GitHub 中间调） */
    var C_ERR = '#f85149'

    // ───────────────────────── i18n（zh/en，默认跟随系统）─────────────────────────
    var LANG_KEY = 'dsh-cua-pre.lang'
    var I18N = {
      zh: {
        title: '电脑控制', badge: '桌面自动化', tab_live: '实况', tab_frames: '画面', tab_about: '说明',
        on: '已启用', off: '未启用', stopped: '已紧急停止', wl: '白名单×', relaxed: '(宽松)', strict: '(严格)',
        worker_run: 'worker 运行中', worker_idle: 'worker 空闲', reqs: '请求', ok: '成功', dropped: '丢弃',
        breaker: '断路器熔断', vision_on: 'vision 开', recent_ops: '最近操作（新→旧）', no_ops: '暂无操作记录',
        loading: '加载中…', loading_cfg: '加载配置…',
        frames_empty: '暂无画面帧。模型执行 screenshot 或 get_app_state(include_screenshot) 后这里会显示截图与识图描述。',
        expired: '过期', valid: '有效', file_gone: '（截图文件已清理）', vision_d: '[vision] 识图描述', tiles: ' 块)',
        read_fail: '读取失败: ', load_fail: '加载失败: ', detect_fail: '检测失败: ', save_fail: '保存失败: ', apply_fail: '应用失败: ', install_fail: '安装失败: ',
        about1: '桌面自动化控制：无障碍树优先、元素/坐标双目标、strategy 路由、写后作废、action_sent 幂等纪律。',
        about2: '· 默认关闭：设置页或 ~/.dsh/cua-pre.json {"enabled":true}',
        about3: '· 紧急停止：stop_computer_control 持久生效，恢复需清理配置并重启',
        about4: '· 识图：开启后截图自动分块裁切送 VLM，低分辨率模型也能读清屏幕',
        settings_title: '电脑控制 (dsh-cua-pre)',
        settings_sub: '桌面自动化插件：无障碍树优先、30 个标准电脑控制工具。默认关闭；配置文件 ',
        onb_title: '首次使用引导',
        onb_body: '安装完成，还差一步就能用了：点击下方按钮，插件会自动检测本机 Python、缺少依赖时自动安装，然后即时启用。',
        boot_btn: '一键启用', boot_ing: '正在一键启用…',
        boot_ok: '已启用 ✓（python=', deps_inst: '，依赖已装', deps_ok: '，依赖齐全',
        sec_basic: '基础', enable: '启用电脑控制', py_env: 'Python 环境', py_env_hint: '自动检测本机可用解释器；点击即切换并即时生效',
        redetect: '重新检测', detecting: '检测中…', worker_adv: '高级：workerPath 手动覆盖',
        artifacts: '截屏保存目录', prefix: '工具名前缀', prefix_hint: '与宿主撞名时使用；默认空=标准名',
        max_el: '观察元素上限', max_depth: '观察树深度', timeout: '请求超时(ms)',
        sec_vision: '视觉识图 (vision)', vision_enable: '启用识图', auto_describe: '自动描述截图', vision_model: '识图模型',
        vision_model_hint: '自动列出模型目录（启发式标记疑似具备视觉能力）；默认跟随系统路由',
        tile_px: '分块目标边长(px)', tile_hint: '低分辨率模型建议 ≤768', overlap: '分块重叠(px)', max_tiles: '最多分块数', vis_timeout: '识图超时(ms)',
        sec_security: '安全', allowlist: 'PID 白名单',
        wl_hint: '逗号分隔的进程 id；留空=不限制。启用后白名单外应用的观察/操作被拒；坐标类、剪贴板、全屏截图默认拒绝（宽松模式可放开）。保存即时生效。',
        wl_ph: '如 1234, 5678（留空不限制）', relaxed_mode: '白名单宽松模式',
        relaxed_hint: '放开坐标类/剪贴板/全屏截图的限制（作用域化检查仍然生效）',
        ks_state: 'kill switch 状态', ks_hint: '见面板「实况」页签；stop_computer_control 后持久停止，恢复需删除配置中 stoppedByUser 并重启',
        saving: '保存中…', save: '保存配置', saved_restart: '已保存。重启 dsh web 后完全生效。',
        probing: '正在检测 Python 环境…', not_probed: '（未检测）', deps_ok_badge: '依赖齐全',
        installing: '安装中…', deps_missing_btn: '缺依赖·一键安装', unavailable: '不可用',
        worker_auto_pre: 'worker 脚本：自动使用内置', worker_auto_suf: '（workerPath 留空即自动）',
        py_hint: '点击任一可用解释器即切换并即时生效；「依赖齐全」= 可直接运行电脑控制。',
        follow_route: '跟随系统路由（默认，推荐）', likely_vis: '疑似具备视觉能力（启发式）', all_models: '全部模型',
        manual_input: '手动输入…', models_unavail: '（模型目录不可用，请手动输入模型名）', model_ph: '输入模型 id，如 qwen2.5-vl-7b-instruct',
        py_switched: 'Python 已切换并即时生效',
        openurls: 'URL 打开方式', openurls_hint: 'panel=沙箱浏览器面板（不占前台）；system=系统默认浏览器',
        openurls_panel: '沙箱面板（推荐）', openurls_system: '系统浏览器',
        preferbg: '后台优先操作', preferbg_hint: '语义不可用且窗口非前台时拒绝物理点击（不抢焦点）；关闭后允许置前', installing_deps: '正在为该 Python 安装 uiautomation+pillow（可能 1-2 分钟）…',
        deps_done: '依赖安装完成，该解释器已可用',
        tab_browser: '浏览器', url_opened: '已在沙箱浏览器打开', url_hint: '输入网址（http/https）',
        go: '打开', sys_open: '在系统浏览器打开', iframe_blocked: '该网站禁止内嵌显示（X-Frame-Options）。点「在系统浏览器打开」。',
        live_preview: '实时窗口画面', preview_none: '暂无操作目标。agent 操作应用后这里显示其画面。',
        needs_fg: '目标窗口不在前台且语义不可用。传 allowFocus:true 可置前操作。',
      },
      en: {
        title: 'Computer Control', badge: 'desktop automation', tab_live: 'Live', tab_frames: 'Frames', tab_about: 'About',
        on: 'Enabled', off: 'Disabled', stopped: 'Emergency stopped', wl: 'Allowlist ×', relaxed: '(relaxed)', strict: '(strict)',
        worker_run: 'worker running', worker_idle: 'worker idle', reqs: 'requests', ok: 'ok', dropped: 'dropped',
        breaker: 'circuit breaker open', vision_on: 'vision on', recent_ops: 'Recent ops (new→old)', no_ops: 'No operations yet',
        loading: 'Loading…', loading_cfg: 'Loading config…',
        frames_empty: 'No frames yet. They appear after the model runs screenshot or get_app_state(include_screenshot).',
        expired: 'expired', valid: 'valid', file_gone: '(screenshot file cleaned up)', vision_d: '[vision] describe', tiles: ' tiles)',
        read_fail: 'Read failed: ', load_fail: 'Load failed: ', detect_fail: 'Detect failed: ', save_fail: 'Save failed: ', apply_fail: 'Apply failed: ', install_fail: 'Install failed: ',
        about1: 'Desktop automation: accessibility-first, element/coordinate dual targets, strategy routing, write-invalidation, action_sent idempotency discipline.',
        about2: '· Default off: settings page or ~/.dsh/cua-pre.json {"enabled":true}',
        about3: '· Emergency stop: stop_computer_control persists until you clean the config and restart',
        about4: '· Vision: screenshots are grid-tiled to a VLM so low-res models can still read the screen',
        settings_title: 'Computer Control (dsh-cua-pre)',
        settings_sub: 'Desktop automation plugin: accessibility-first, 30 standard tools. Default off; config file ',
        onb_title: 'First-run setup',
        onb_body: 'One step left: click below — the plugin detects a local Python, auto-installs missing deps, then enables itself instantly.',
        boot_btn: 'One-click enable', boot_ing: 'Enabling…',
        boot_ok: 'Enabled ✓ (python=', deps_inst: ', deps installed', deps_ok: ', deps ready',
        sec_basic: 'General', enable: 'Enable computer control', py_env: 'Python environment', py_env_hint: 'Probes local interpreters; click to switch — takes effect instantly',
        redetect: 'Re-detect', detecting: 'Detecting…', worker_adv: 'Advanced: workerPath override',
        artifacts: 'Screenshots dir', prefix: 'Tool prefix', prefix_hint: 'Used on name clash with the host; default empty = standard names',
        max_el: 'Max elements', max_depth: 'Observe depth', timeout: 'Request timeout(ms)',
        sec_vision: 'Vision', vision_enable: 'Enable vision', auto_describe: 'Auto-describe shots', vision_model: 'Vision model',
        vision_model_hint: 'Lists the model catalog (heuristic ✔ on likely-vision names); default follows the system route',
        tile_px: 'Tile target edge(px)', tile_hint: '≤768 recommended for low-res models', overlap: 'Tile overlap(px)', max_tiles: 'Max tiles', vis_timeout: 'Vision timeout(ms)',
        sec_security: 'Security', allowlist: 'PID allowlist',
        wl_hint: 'Comma-separated pids; empty = unrestricted. Observing/operating outside the list is refused; coordinates, clipboard and full-screen capture are refused in strict mode. Instant effect.',
        wl_ph: 'e.g. 1234, 5678 (empty = unrestricted)', relaxed_mode: 'Relaxed allowlist',
        relaxed_hint: 'Lifts coordinate/clipboard/full-screen limits (scoped checks still apply)',
        ks_state: 'kill switch', ks_hint: 'See the Live tab; stop_computer_control persists — remove stoppedByUser from config and restart to restore',
        saving: 'Saving…', save: 'Save config', saved_restart: 'Saved. Restart dsh web for full effect.',
        probing: 'Probing Python environments…', not_probed: '(not probed)', deps_ok_badge: 'deps ready',
        installing: 'Installing…', deps_missing_btn: 'deps missing · install', unavailable: 'unavailable',
        worker_auto_pre: 'worker script: bundled ', worker_auto_suf: ' (workerPath empty = auto)',
        py_hint: 'Click any usable interpreter to switch instantly; "deps ready" = computer control can run.',
        follow_route: 'Follow system route (default, recommended)', likely_vis: 'Likely vision-capable (heuristic)', all_models: 'All models',
        manual_input: 'Manual input…', models_unavail: '(model catalog unavailable — type the model id)', model_ph: 'model id, e.g. qwen2.5-vl-7b-instruct',
        py_switched: 'Python switched — instant effect',
        openurls: 'URL opening', openurls_hint: 'panel = sandbox browser panel (no foreground steal); system = default browser',
        openurls_panel: 'Sandbox panel (recommended)', openurls_system: 'System browser',
        preferbg: 'Background-first ops', preferbg_hint: 'Refuse physical clicks when semantics fail and window is not foreground; turn off to allow focusing', installing_deps: 'Installing uiautomation+pillow for this Python (may take 1-2 min)…',
        deps_done: 'Dependencies installed — interpreter ready',
        tab_browser: 'Browser', url_opened: 'Opened in sandbox browser', url_hint: 'URL (http/https)',
        go: 'Go', sys_open: 'Open in system browser', iframe_blocked: 'This site blocks embedding (X-Frame-Options). Use \'Open in system browser\'.',
        live_preview: 'Live window', preview_none: 'No target yet. Once the agent operates an app, its live view appears here.',
        needs_fg: 'Target window is not foreground and semantics failed. Retry with allowFocus:true.',
      },
    }
    var lang = 'zh'
    try {
      var savedLang = localStorage.getItem(LANG_KEY)
      if (savedLang === 'zh' || savedLang === 'en') lang = savedLang
      else if (navigator.language && String(navigator.language).toLowerCase().indexOf('en') === 0) lang = 'en'
    } catch (_) {}
    var langListeners = new Set()
    function t(key) { return (I18N[lang] && I18N[lang][key]) || I18N.zh[key] || key }
    function setLang(l) {
      if (l !== 'zh' && l !== 'en') return
      lang = l
      try { localStorage.setItem(LANG_KEY, l) } catch (_) {}
      langListeners.forEach(function (fn) { try { fn() } catch (_) {} })
    }
    function useLang() {
      var _s = useState(lang)
      var v = _s[0]; var setV = _s[1]
      useEffect(function () {
        var fn = function () { setV(lang) }
        langListeners.add(fn)
        return function () { langListeners.delete(fn) }
      }, [])
      return v
    }
    function langBtn() {
      return h('button', {
        onClick: function () { setLang(lang === 'zh' ? 'en' : 'zh') },
        title: '中文 / English',
        style: { background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08))', border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.16))', borderRadius: 7, padding: '2px 8px', color: 'inherit', fontSize: 11, cursor: 'pointer', flexShrink: 0 },
      }, lang === 'zh' ? 'EN' : '中')
    }

    function Pill(props) {
      var bg = props.ok === true ? 'rgba(76,175,80,0.25)' : props.ok === false ? 'rgba(244,67,54,0.25)' : 'var(--dsw-alias-border-l1, rgba(255,255,255,0.12))'
      return h('span', { style: { background: bg, borderRadius: 999, padding: '1px 8px', fontSize: 11, marginRight: 6 } }, props.text)
    }

    // ───────────────────────── 实况 Tab ─────────────────────────
    function LiveTab(props) {
      var state = props.state
      var ops = (state && state.lastOps) || []
      var w = state && state.worker
      return h('div', { style: { padding: 12 } },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 } },
          h(Pill, { text: state && state.enabled ? t('on') : t('off'), ok: !!(state && state.enabled) }),
          state && state.stoppedByUser ? h(Pill, { text: t('stopped'), ok: false }) : null,
          state && state.whitelist && state.whitelist.active ? h(Pill, { text: t('wl') + state.whitelist.size + (state.whitelist.relaxed ? t('relaxed') : t('strict')) }) : null,
          h(Pill, { text: (w && w.started ? t('worker_run') : t('worker_idle')), ok: !!(w && w.started) }),
          w ? h(Pill, { text: t('reqs') + ' ' + w.stats.requests + ' · ' + t('ok') + ' ' + w.stats.succeeded }) : null,
          w && w.breaker && w.breaker.open ? h(Pill, { text: t('breaker'), ok: false }) : null,
          state && state.visionEnabled ? h(Pill, { text: t('vision_on') }) : null,
        ),
        h('div', { style: { fontSize: 12, color: MUTED, marginBottom: 6 } }, t('recent_ops')),
        ops.length === 0
          ? h('div', { style: { fontSize: 12, color: MUTED } }, t('no_ops'))
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, ops.map(function (o, i) {
              return h('div', {
                key: i,
                style: {
                  display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12,
                  background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.05))', borderRadius: 8, padding: '5px 8px',
                },
              },
                h('span', { style: { color: o.ok ? '#3fb950' : '#ff7b72', flexShrink: 0 } }, o.ok ? '✓' : '✗'),
                h('span', { style: { fontWeight: 600, flexShrink: 0 } }, o.title || o.tool),
                h('span', { style: { color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, o.brief || ''),
                h('span', { style: { color: MUTED, flexShrink: 0, fontSize: 10 } }, o.ms + 'ms'),
              )
            })),
      )
    }

    // ───────────────────────── 画面 Tab ─────────────────────────
    function FramesTab() {
      var _s = useState(null)
      var frames = _s[0]; var setFrames = _s[1]
      useEffect(function () {
        var alive = true
        var tick = function () { apiGet(API.frames).then(function (d) { if (alive) setFrames((d && d.frames) || []) }).catch(function () {}) }
        tick()
        var t = setInterval(tick, 3000)
        return function () { alive = false; clearInterval(t) }
      }, [])
      if (!frames || !frames.length) {
        return h('div', { style: { padding: 12, fontSize: 12, color: MUTED } }, t('frames_empty'))
      }
      return h('div', { style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' } },
        frames.map(function (f) {
          return h('div', { key: f.frame_id, style: { background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.05))', borderRadius: 10, padding: 8 } },
            h('div', { style: { display: 'flex', gap: 6, marginBottom: 6, fontSize: 11, color: MUTED, alignItems: 'center' } },
              h('code', { style: { fontSize: 10 } }, f.frame_id),
              h('span', null, f.width + '×' + f.height),
              f.crop ? h('span', null, String(f.crop)) : null,
              f.expired ? h(Pill, { text: t('expired'), ok: false }) : h(Pill, { text: t('valid') }),
            ),
            h('img', {
              src: API.frameFile + encodeURIComponent(f.frame_id),
              alt: f.frame_id,
              style: { width: '100%', borderRadius: 8, display: 'block', background: 'rgba(0,0,0,0.3)' },
            }),
            f.vision_description
              ? h('details', { style: { marginTop: 6, fontSize: 12 } },
                  h('summary', { style: { cursor: 'pointer', color: 'var(--dsw-alias-brand-primary, #4f7cff)' } }, t('vision_d') + ' (' + (f.vision_tiles || '?') + t('tiles')),
                  h('pre', { style: { whiteSpace: 'pre-wrap', margin: '6px 0 0', fontSize: 11, color: 'var(--dsw-alias-label-primary, #c9d1d9)' } }, f.vision_description))
              : (f.vision_error ? h('div', { style: { marginTop: 6, fontSize: 11, color: MUTED } }, '[vision] ' + f.vision_error) : null),
          )
        })
      )
    }

    // ───────────────────────── 面板开关（模块级，按钮/面板共享） ─────────────────────────
    var uiOpen = false
    var uiListeners = new Set()
    var renderTick = 0
    function setPanelOpen(v) {
      uiOpen = !!v
      renderTick += 1
      uiListeners.forEach(function (fn) { try { fn() } catch (_) {} })
    }
    function useUiOpen() {
      var _s = useState(uiOpen)
      var v = _s[0]; var setV = _s[1]
      useEffect(function () {
        var fn = function () { setV(uiOpen) }
        uiListeners.add(fn)
        return function () { uiListeners.delete(fn) }
      }, [])
      return v
    }

    // ───────────────────────── 主面板 ─────────────────────────
    function CuaPanel(props) {
      var open = useUiOpen()
      if (!open) return null
      // renderTick 仅仅是为了让 overlay 槽知道需要重渲染（槽回调本身在组件外）
      void (props._tick || 0)
      var _t = useState('live')
      var tab = _t[0]; var setTab = _t[1]
      var _st = useState(null)
      var state = _st[0]; var setState = _st[1]
      useEffect(function () {
        var alive = true
        var tick = function () { apiGet(API.state).then(function (d) { if (alive) setState(d) }).catch(function () {}) }
        tick()
        var t = setInterval(tick, 2500)
        return function () { alive = false; clearInterval(t) }
      }, [])
      var tabBtn = function (id, label) {
        return h('button', {
          onClick: function () { setTab(id) },
          style: {
            flex: 1, padding: '6px 0', fontSize: 12, cursor: 'pointer',
            background: tab === id ? 'var(--dsw-alias-border-l1, rgba(255,255,255,0.16))' : 'transparent',
            color: tab === id ? '#fff' : MUTED,
            border: 'none', borderRadius: 8,
          },
        }, label)
      }
      return h('div', { style: Object.assign({}, GLASS, { width: props.width || 430, height: props.height || 560, display: 'flex', flexDirection: 'column', overflow: 'hidden' }) },
        h('div', { style: { display: 'flex', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08))' } },
          h('span', { style: { fontWeight: 700, fontSize: 13 } }, t('title')),
          h('span', { style: { marginLeft: 8, fontSize: 11, color: MUTED } }, t('badge')),
          h('span', { style: { flex: 1 } }),
          h('button', {
            onClick: props.onClose, style: { background: 'transparent', border: 'none', color: MUTED, fontSize: 16, cursor: 'pointer' },
          }, '✕'),
        ),
        h('div', { style: { display: 'flex', gap: 4, padding: '8px 10px 0' } },
          tabBtn('live', t('tab_live')), tabBtn('frames', t('tab_frames')), tabBtn('about', t('tab_about'))),
        h('div', { style: { flex: 1, overflowY: 'auto' } },
          tab === 'live' ? h(LiveTab, { state: state })
            : tab === 'frames' ? h(FramesTab, null)
              : h('div', { style: { padding: 12, fontSize: 12, lineHeight: 1.7, color: MUTED } },
                  h('div', null, t('about1')),
                  h('div', { style: { marginTop: 8 } }, t('about2')),
                  h('div', null, t('about3')),
                  h('div', null, t('about4')),
                ),
        ),
      )
    }

    // ───────────────────────── 设置页 ─────────────────────────
    var FIELD_STYLE = { display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' }
    var LABEL_STYLE = { width: 170, fontSize: 12, color: MUTED, flexShrink: 0 }
    var INPUT_STYLE = { flex: 1, background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08))', border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.14))', borderRadius: 8, padding: '5px 8px', color: 'inherit', fontSize: 12 }

    function Row(props) {
      return h('div', { style: FIELD_STYLE },
        h('label', { style: LABEL_STYLE, title: props.hint }, props.label),
        props.children,
      )
    }
    function Toggle(props) {
      return h('button', {
        onClick: function () { props.onChange(!props.value) },
        style: {
          width: 40, height: 20, borderRadius: 999, border: 'none', cursor: 'pointer',
          background: props.value ? 'rgba(76,175,80,0.6)' : 'var(--dsw-alias-border-l1, rgba(255,255,255,0.15))',
          position: 'relative',
        },
      }, h('span', { style: { position: 'absolute', top: 2, left: props.value ? 22 : 2, width: 16, height: 16, borderRadius: 999, background: '#fff', transition: 'left .15s' } }))
    }

    function SettingsPage() {
      useLang()
      var _c = useState(null)
      var cfg = _c[0]; var setCfg = _c[1]
      var _m = useState('')
      var msg = _m[0]; var setMsg = _m[1]
      var _saving = useState(false)
      var saving = _saving[0]; var setSaving = _saving[1]

      useEffect(function () {
        apiGet(API.config).then(function (d) { setCfg(d && d.config) }).catch(function (e) { setMsg(t('load_fail') + e.message) })
      }, [])

      // ---- 环境自动检测 ----
      var _det = useState(null)
      var det = _det[0]; var setDet = _det[1]
      var _detBusy = useState(false)
      var detBusy = _detBusy[0]; var setDetBusy = _detBusy[1]
      var _installing = useState('')
      var installing = _installing[0]; var setInstalling = _installing[1]
      var _manualModel = useState(false)
      var manualModel = _manualModel[0]; var setManualModel = _manualModel[1]
      function runDetect() {
        setDetBusy(true)
        apiGet(API.detect).then(function (d) { setDet(d) }).catch(function (e) { setMsg(t('detect_fail') + e.message) }).finally(function () { setDetBusy(false) })
      }
      useEffect(function () { runDetect() }, [])

      // ---- 一键启用（首次引导） ----
      var _bs = useState(false)
      var bootstrapping = _bs[0]; var setBootstrapping = _bs[1]
      var _bsMsg = useState('')
      var bootstrapMsg = _bsMsg[0]; var setBootstrapMsg = _bsMsg[1]
      function bootstrapOneClick() {
        setBootstrapping(true); setBootstrapMsg('')
        apiPost(API.bootstrap, {}).then(function (r) {
          if (r && r.ok) {
            setBootstrapMsg(t('boot_ok') + r.python + (r.depsInstalled ? t('deps_inst') : t('deps_ok')) + '）')
            set('enabled', true)
            set('pythonExecutable', r.python)
            runDetect()
          } else {
            setBootstrapMsg(t('install_fail') + ' ' + ((r && r.error) || ''))
          }
        }).catch(function (e) { setBootstrapMsg(t('install_fail') + ' ' + (e.message || e)) }).finally(function () { setBootstrapping(false) })
      }
      function applyPython(p2) {
        set('pythonExecutable', p2)
        apiPost(API.config, { pythonExecutable: p2 }).then(function (r) {
          setMsg(r && r.ok ? t('py_switched') : t('apply_fail') + ' ' + (r && r.error))
        }).catch(function (e) { setMsg(t('apply_fail') + e.message) })
      }
      function installDeps(p2) {
        setInstalling(p2)
        setMsg(t('installing_deps'))
        apiPost(API.installDeps, { python: p2 }).then(function (r) {
          setMsg(r && r.ok ? t('deps_done') : t('install_fail') + ' ' + ((r && r.tail) || (r && r.error) || ''))
          runDetect()
        }).catch(function (e) { setMsg(t('install_fail') + e.message) }).finally(function () { setInstalling('') })
      }
      function PythonEnvCard() {
        if (!det) return h('div', { style: { fontSize: 12, color: MUTED } }, detBusy ? t('probing') : t('not_probed'))
        var rows = (det.pythons || []).map(function (c) {
          var selected = String(cfg.pythonExecutable || '') === c.path
          var badge = c.status === 'ready'
            ? h('span', { style: { background: 'rgba(76,175,80,.22)', borderRadius: 999, padding: '1px 8px', fontSize: 11, flexShrink: 0 } }, t('deps_ok_badge'))
            : c.status === 'no-deps'
              ? h('button', {
                  onClick: function (e) { e.stopPropagation(); installDeps(c.path) },
                  style: { background: 'rgba(230,162,60,.22)', borderRadius: 999, padding: '1px 8px', fontSize: 11, border: 'none', cursor: 'pointer', color: 'inherit', flexShrink: 0 },
                }, installing === c.path ? t('installing') : t('deps_missing_btn'))
              : h('span', { style: { background: 'rgba(244,67,54,.18)', borderRadius: 999, padding: '1px 8px', fontSize: 11, flexShrink: 0, opacity: .7 } }, t('unavailable'))
          return h('div', {
            key: c.path,
            onClick: function () { if (c.status !== 'missing') applyPython(c.path) },
            style: {
              display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 9, marginBottom: 4,
              cursor: c.status === 'missing' ? 'default' : 'pointer',
              background: selected ? 'rgba(121,192,255,0.16)' : 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.05))',
              border: selected ? '1px solid rgba(121,192,255,0.5)' : '1px solid transparent',
              opacity: c.status === 'missing' ? .5 : 1,
            },
          },
            h('span', { style: { fontSize: 13, flexShrink: 0 } }, selected ? '◉' : '○'),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontSize: 12, fontWeight: 600 } }, c.label || c.path),
              h('div', { style: { fontSize: 10, color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.path)),
            badge,
          )
        })
        var w = det.worker || {}
        return h('div', null,
          rows,
          h('div', { style: { fontSize: 11, color: MUTED, marginTop: 6 } },
            t('worker_auto_pre') + (w.exists ? '✓ ' : '✗ ') + (w.path || '') + t('worker_auto_suf')),
          h('div', { style: { fontSize: 11, color: MUTED, marginTop: 2 } },
            t('py_hint')),
        )
      }
      function VisionModelSelect() {
        var cur = String(cfg.visionModel || '')
        var known = false
        var visOpt = [], allOpt = []
        if (det && det.models && !det.models.unsupported) {
          (det.models.providers || []).forEach(function (pv) {
            (pv.models || []).forEach(function (m) {
              if (m.id === cur) known = true
              var opt = h('option', { key: pv.id + ':' + m.id, value: m.id }, m.name ? (m.name + ' (' + m.id + ')') : m.id)
              if (m.likelyVision) visOpt.push(opt); else allOpt.push(opt)
            })
          })
        }
        var manual = manualModel || (cur !== '' && !known)
        return h('div', null,
          h('select', {
            value: manual ? '__manual__' : cur,
            onChange: function (e) {
              var v = e.target.value
              if (v === '__manual__') { setManualModel(true); return }
              setManualModel(false)
              set('visionModel', v)
            },
            style: INPUT_STYLE,
          },
            h('option', { value: '' }, t('follow_route')),
            det && det.models && !det.models.unsupported && visOpt.length
              ? h('optgroup', { label: t('likely_vis') }, visOpt)
              : null,
            det && det.models && !det.models.unsupported && allOpt.length
              ? h('optgroup', { label: t('all_models') }, allOpt)
              : null,
            h('option', { value: '__manual__' }, t('manual_input')),
          ),
          det && det.models && det.models.unsupported
            ? h('div', { style: { fontSize: 11, color: MUTED, marginTop: 3 } }, t('models_unavail'))
            : null,
          manual
            ? h('input', {
                value: cur, placeholder: t('model_ph'),
                onChange: function (e) { set('visionModel', e.target.value) },
                style: Object.assign({}, INPUT_STYLE, { marginTop: 4 }),
              })
            : null,
        )
      }
      function set(k, v) { setCfg(function (prev) { return Object.assign({}, prev, (function () { var o = {}; o[k] = v; return o })()) }) }
      function save() {
        setSaving(true)
        apiPost(API.config, cfg).then(function (r) {
          setMsg(r && r.ok ? t('saved_restart') : t('save_fail') + ' ' + ((r && r.error) || ''))
        }).catch(function (e) { setMsg(t('save_fail') + e.message) }).finally(function () { setSaving(false) })
      }
      if (!cfg) return h('div', { style: { padding: 16, fontSize: 13 } }, msg || t('loading_cfg'))

      var num = function (k) {
        return h('input', { type: 'number', value: cfg[k], onChange: function (e) { set(k, Number(e.target.value)) }, style: INPUT_STYLE })
      }
      var txt = function (k, ph) {
        return h('input', { value: cfg[k] == null ? '' : cfg[k], placeholder: ph || '', onChange: function (e) { set(k, e.target.value) }, style: INPUT_STYLE })
      }

      return h('div', { style: { maxWidth: 640, fontSize: 13 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('h3', { style: { margin: '4px 0 10px', flex: 1 } }, t('settings_title')),
          langBtn()),
        h('div', { style: { fontSize: 12, color: MUTED, marginBottom: 12 } }, t('settings_sub') + '~/.dsh/cua-pre.json'),

        // 首次引导横幅（未启用时显示）
        !cfg.enabled
          ? h('div', {
              style: {
                background: 'rgba(121,192,255,0.14)', border: '1px solid rgba(121,192,255,0.4)',
                borderRadius: 12, padding: '12px 14px', marginBottom: 14,
              },
            },
              h('div', { style: { fontWeight: 700, fontSize: 13, marginBottom: 4 } }, t('onb_title')),
              h('div', { style: { fontSize: 12, lineHeight: 1.7, color: MUTED, marginBottom: 8 } },
                t('onb_body')),
              h('button', {
                onClick: bootstrapOneClick,
                disabled: bootstrapping,
                style: {
                  background: 'rgba(121,192,255,0.28)', border: '1px solid rgba(121,192,255,0.6)',
                  borderRadius: 9, padding: '7px 16px', color: 'var(--dsw-alias-label-primary, #fff)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                },
              }, bootstrapping ? t('boot_ing') : t('boot_btn')),
              h('span', { style: { fontSize: 11, color: MUTED, marginLeft: 10 } }, bootstrapMsg),
            )
          : null,

        h('div', { style: { fontWeight: 600, margin: '10px 0 2px' } }, t('sec_basic')),
        h(Row, { label: t('enable') }, h(Toggle, { value: !!cfg.enabled, onChange: function (v) { set('enabled', v) } })),
        h(Row, { label: t('py_env'), hint: t('py_env_hint') }, PythonEnvCard()),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '2px 0 8px' } },
          h('button', {
            onClick: runDetect, disabled: detBusy,
            style: { background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08))', border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.16))', borderRadius: 8, padding: '4px 12px', color: 'inherit', fontSize: 12, cursor: 'pointer' },
          }, detBusy ? t('detecting') : t('redetect')),
          h('span', { style: { fontSize: 11, color: MUTED } }, t('worker_adv')),
          txt('workerPath', '')),
        h(Row, { label: t('openurls'), hint: t('openurls_hint') },
          h('select', { value: cfg.openUrlsIn === 'system' ? 'system' : 'panel', onChange: function (e) { set('openUrlsIn', e.target.value) }, style: INPUT_STYLE },
            h('option', { value: 'panel' }, t('openurls_panel')),
            h('option', { value: 'system' }, t('openurls_system')))),
        h(Row, { label: t('preferbg'), hint: t('preferbg_hint') }, h(Toggle, { value: cfg.preferBackground !== false, onChange: function (v) { set('preferBackground', v) } })),
        h(Row, { label: t('artifacts') }, txt('artifactsDir', '~/.dsh/cua-pre/artifacts')),
        h(Row, { label: t('prefix'), hint: t('prefix_hint') }, txt('toolNamePrefix', '')),
        h(Row, { label: t('max_el') }, num('maxObserveElements')),
        h(Row, { label: t('max_depth') }, num('observeMaxDepth')),
        h(Row, { label: t('timeout') }, num('requestTimeoutMs')),

        h('div', { style: { fontWeight: 600, margin: '14px 0 2px' } }, t('sec_vision')),
        h(Row, { label: t('vision_enable') }, h(Toggle, { value: !!cfg.visionEnabled, onChange: function (v) { set('visionEnabled', v) } })),
        h(Row, { label: t('auto_describe') }, h(Toggle, { value: !!cfg.visionAutoDescribe, onChange: function (v) { set('visionAutoDescribe', v) } })),
        h(Row, { label: t('vision_model'), hint: t('vision_model_hint') }, VisionModelSelect()),
        h(Row, { label: t('tile_px'), hint: t('tile_hint') }, num('tileMaxPx')),
        h(Row, { label: t('overlap') }, num('tileOverlapPx')),
        h(Row, { label: t('max_tiles') }, num('visionMaxTiles')),
        h(Row, { label: t('vis_timeout') }, num('visionTimeoutMs')),

        h('div', { style: { fontWeight: 600, margin: '14px 0 2px', color: 'var(--dsw-alias-state-warn-primary, #d29922)' } }, t('sec_security')),
        h(Row, { label: t('allowlist'), hint: t('wl_hint') },
          h('input', {
            value: Array.isArray(cfg.allowedPids) ? cfg.allowedPids.join(',') : String(cfg.allowedPids || ''),
            placeholder: t('wl_ph'),
            onChange: function (e) {
              var v = e.target.value.split(',').map(function (x) { return parseInt(x.trim(), 10) }).filter(Number.isFinite)
              set('allowedPids', v)
            },
            style: INPUT_STYLE,
          })),
        h(Row, { label: t('relaxed_mode'), hint: t('relaxed_hint') },
          h(Toggle, { value: !!cfg.whitelistRelaxed, onChange: function (v) { set('whitelistRelaxed', v) } })),
        h(Row, { label: t('ks_state') },
          h('span', { style: { fontSize: 12 } }, t('ks_hint'))),

        h('div', { style: { display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' } },
          h('button', {
            onClick: save, disabled: saving,
            style: { background: 'rgba(121,192,255,0.25)', border: '1px solid rgba(121,192,255,0.5)', color: 'inherit', borderRadius: 8, padding: '6px 18px', cursor: 'pointer', fontSize: 13 },
          }, saving ? t('saving') : t('save')),
          h('span', { style: { fontSize: 12, color: MUTED } }, msg),
        ),
      )
    }

    // ───────────────────────── apply ─────────────────────────
    // 不依赖第三方侧栏的任何槽；悬浮按钮 + 独立面板全部直挂 document.body（fixed）。
    function apply(ctx) {
      var slots = ctx.slots

      // 设置面注册独立于 DOM 挂载：即使 DOM 未就绪/挂载失败也不丢设置页。
      try {
        slots.inject('settings.section', function () {
          return slots.register({ name: 'settings.section', id: 'cua-host-pre', order: 26, label: '电脑控制' }, function () {
            return h(SettingsPage, null)
          })
        })
      } catch (e) {
        console.error('[dsh-cua-pre] settings.section 注册失败:', e)
      }

      // ====== Better Sidebar 集成（若宿主提供 ctx.betterSidebar）======
      // 注意：动态插件 runner 的代理 ctx 对「未声明属性」的读取会抛错而非返回
      // undefined（inject 声明门控）。因此绝不能用 ctx.betterSidebar 直接探测——
      // 用 ctx.get('betterSidebar') 这个运行时提供的不受门控的可选查找。
      var bsRegistered = false
      try {
        var bs = null
        try { bs = (typeof ctx.get === 'function') ? ctx.get('betterSidebar') : null } catch (_) {}
        if (!bs || typeof bs.registerTab !== 'function') {
          // inject 声明后属性应可用（官方姿势）；runner 代理放行时直接读属性
          try { if (ctx.betterSidebar && typeof ctx.betterSidebar.registerTab === 'function') bs = ctx.betterSidebar } catch (_) {}
        }
        if (bs && typeof bs.registerTab === 'function') {
          var CuaSidebarTab = function (props) {
            // props: {ctx, store, scope, tab, visible}
            var live = props && props.visible !== false
            return h(CuaPanelInline, { visible: live })
          }
          ctx.effect(function () {
            return bs.registerTab({
              id: 'cua-pre:control',
              title: function () { return t('title') },
              icon: function (size) { return h('span', { style: { font: '700 ' + Math.max(9, (size || 14) - 3) + 'px ui-monospace,monospace', color: 'var(--dsw-alias-brand-primary, #4f7cff)' } }, 'CUA') },
              order: 40,
              single: true,
              component: CuaSidebarTab,
            })
          })
          bsRegistered = true
          console.log('[dsh-cua-pre] Better Sidebar tab registered')
        }
      } catch (e) {
        console.error('[dsh-cua-pre] betterSidebar 注册失败（回退 FAB）:', e)
        bsRegistered = false
      }

      // ====== DOM 直挂统一延迟到 body 可用 ======
      // 若已注册 Better Sidebar Tab，跳过悬浮 FAB（避免两处入口）。
      function shouldMountFAB() { return !bsRegistered }
      function whenBodyReady(fn) {
        if (typeof document !== 'undefined' && document.body) { try { fn() } catch (e) { console.error('[dsh-cua-pre] DOM mount error:', e) } return }
        if (typeof document !== 'undefined' && document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', function () { try { fn() } catch (e) { console.error('[dsh-cua-pre] DOM mount error:', e) } })
          return
        }
        setTimeout(function () { try { fn() } catch (e) { console.error('[dsh-cua-pre] DOM mount error:', e) } }, 150)
      }
      var domMounted = false
      function mountDom() {
        if (domMounted) return
        domMounted = true
        if (shouldMountFAB()) {
          ensurePanelRoot()
          setPanelVisible(uiOpen)
          ensureFAB()
          uiListeners.add(function () { setPanelVisible(uiOpen); renderFAB(false) })
        }
        console.log('[dsh-cua-pre] client ready: ' + (bsRegistered ? 'better-sidebar tab' : 'floating FAB') + ' + settings page')
      }
      whenBodyReady(mountDom)
      setTimeout(whenBodyReady.bind(null, mountDom), 800) // 双保险

      // ====== 沙箱浏览器：消费 host 队列中的待打开 URL ======
      function openUrlSomewhere(url) {
        // 1) Better Sidebar 内嵌浏览器优先
        try {
          if (bsRegistered) {
            var bs = null
            try { bs = (typeof ctx.get === 'function') ? ctx.get('betterSidebar') : null } catch (_) {}
            if (!bs) { try { bs = ctx.betterSidebar } catch (_) {} }
            if (bs && typeof bs.openTab === 'function') {
              bs.openTab({ type: 'browser', path: url, title: url.replace(/^https?:\/\//, '').slice(0, 40) })
              return 'better-sidebar'
            }
          }
        } catch (_) {}
        // 2) 浮窗面板的浏览器页签（沙箱 iframe）
        try {
          setPanelOpen(true)
          if (panelRoot) {
            panelRoot.style.display = 'flex'
            var tb = panelRoot.querySelectorAll('button')
            for (var i = 0; i < tb.length; i++) {
              if (tb[i].textContent === t('tab_browser')) { tb[i].click(); break }
            }
            var inp = panelRoot.querySelector('input')
            if (inp) {
              inp.value = url
              var goBtn = inp.parentElement.querySelector('button')
              if (goBtn) goBtn.click()
            }
            return 'panel-iframe'
          }
        } catch (_) {}
        // 3) 兜底：系统浏览器（不打扰面板）
        try { window.open(url, '_blank') } catch (_) {}
        return 'system'
      }
      setInterval(function () {
        apiGet(API.state).then(function (st) {
          var pu = st && st.pendingUrl
          if (!pu || pu._consumed) return
          pu._consumed = true
          var via = openUrlSomewhere(pu.url)
          apiPost(API.urlConsumed, { url: pu.url }).catch(function () {})
          console.log('[dsh-cua-pre] sandbox browser opened:', via, pu.url)
        }).catch(function () {})
      }, 2500)

        // ====== 独立面板（固定在右下角 FAB 上方） ======
        var panelRoot = null
        var panelLoaded = false
        function ensurePanelRoot() {
          var m = document.getElementById('cua-panel-root')
          if (m) { panelRoot = m; return m }
          m = document.createElement('div')
          m.id = 'cua-panel-root'
          m.style.cssText =
            'position:fixed;right:16px;bottom:152px;z-index:9997;' +
            'width:420px;max-width:calc(100vw - 32px);max-height:min(72vh,640px);' +
            'display:none;flex-direction:column;overflow:hidden;' +
            'border-radius:16px;border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.16));' +
            'background:color-mix(in srgb, var(--dsw-alias-bg-overlay, rgba(22,26,34,0.9)) 90%, transparent);backdrop-filter:blur(22px) saturate(1.35);' +
            ' -webkit-backdrop-filter:blur(22px) saturate(1.35);' +
            'box-shadow:0 16px 48px rgba(0,0,0,0.45);color:var(--dsw-alias-label-primary, #e8eaf0);'
          var header = document.createElement('div')
          header.style.cssText =
            'display:flex;align-items:center;gap:8px;padding:10px 12px;' +
            'border-bottom:1px solid var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.1));font-weight:700;font-size:13px;'
          var title = document.createElement('span'); title.textContent = t('title'); header.appendChild(title)
          var badge = document.createElement('span'); badge.textContent = t('badge')
          badge.style.cssText = 'opacity:.6;font-size:11px;font-weight:500;'; header.appendChild(badge)
          var langBtnEl = document.createElement('button')
          langBtnEl.textContent = lang === 'zh' ? 'EN' : '中'
          langBtnEl.style.cssText = 'margin-left:6px;background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08));border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.16));border-radius:7px;padding:1px 7px;color:inherit;font-size:11px;cursor:pointer;'
          langBtnEl.onclick = function () { setLang(lang === 'zh' ? 'en' : 'zh'); langBtnEl.textContent = lang === 'zh' ? 'EN' : '中'; title.textContent = t('title'); badge.textContent = t('badge') }
          header.appendChild(langBtnEl)
          var sp = document.createElement('span'); sp.style.cssText = 'flex:1'; header.appendChild(sp)
          var closeBtn = document.createElement('button')
          closeBtn.textContent = '✕'
          closeBtn.style.cssText = 'background:transparent;border:0;color:inherit;opacity:.7;cursor:pointer;font-size:18px;'
          closeBtn.onclick = function () { setPanelOpen(false) }
          header.appendChild(closeBtn)
          m.appendChild(header)

          var tabs = document.createElement('div')
          tabs.style.cssText = 'display:flex;gap:6px;padding:8px 10px 0;'
          var tabLive = document.createElement('button'); tabLive.textContent = t('tab_live')
          var tabFrames = document.createElement('button'); tabFrames.textContent = t('tab_frames')
          var tabBrowser = document.createElement('button'); tabBrowser.textContent = t('tab_browser')
          ;[tabLive, tabFrames].forEach(function (b) {
            b.style.cssText='flex:1;padding:6px 0;border:0;border-radius:999px;cursor:pointer;font-size:12px;background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.1));color:var(--dsw-alias-label-primary, #e8eaf0);'
          })
          tabs.appendChild(tabLive); tabs.appendChild(tabFrames); tabs.appendChild(tabBrowser); m.appendChild(tabs)

          var body = document.createElement('div')
          body.id = 'cua-panel-body'
          body.style.cssText = 'padding:10px 14px 14px;font-size:12px;line-height:1.6;overflow:auto;white-space:pre-wrap;word-break:break-word;max-height:360px;'
          m.appendChild(body)

          var urlBar = document.createElement('div')
          urlBar.style.cssText = 'display:none;gap:6px;padding:8px 10px 0;'
          var urlInput = document.createElement('input')
          urlInput.placeholder = t('url_hint'); urlInput.spellcheck = false
          urlInput.style.cssText = 'flex:1;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,0.08));border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,0.35));border-radius:8px;padding:5px 8px;color:inherit;font-size:12px;'
          var urlGo = document.createElement('button'); urlGo.textContent = t('go')
          urlGo.style.cssText = 'background:var(--dsw-alias-brand-primary,#4f7cff);border:0;border-radius:8px;padding:5px 12px;color:#fff;font-size:12px;cursor:pointer;'
          var sysOpen = document.createElement('button'); sysOpen.textContent = t('sys_open')
          sysOpen.style.cssText = 'background:transparent;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,0.35));border-radius:8px;padding:5px 10px;color:inherit;font-size:12px;cursor:pointer;'
          urlBar.appendChild(urlInput); urlBar.appendChild(urlGo); urlBar.appendChild(sysOpen)
          m.appendChild(urlBar)
          function openIframe(url) {
            body.innerHTML = ''
            body.style.display = 'block'
            var frame = document.createElement('iframe')
            frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups')
            frame.src = url
            frame.style.cssText = 'width:100%;height:calc(100vh - 220px);min-height:380px;border:0;border-radius:10px;background:#fff;'
            var hint = document.createElement('div')
            hint.style.cssText = 'font-size:11px;color:rgba(128,140,160,0.9);padding:6px 2px;'
            hint.textContent = url
            body.appendChild(hint)
            body.appendChild(frame)
            // 沙箱 iframe 无法探测 X-Frame-Options 拒绝；给手动兜底入口
            var fallback = document.createElement('div')
            fallback.style.cssText = 'padding:6px 2px;font-size:11px;'
            var b = document.createElement('button'); b.textContent = t('sys_open')
            b.style.cssText = 'background:transparent;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,0.35));border-radius:7px;padding:3px 10px;color:inherit;font-size:11px;cursor:pointer;'
            b.onclick = function () { try { window.open(url, '_blank') } catch (_) {} }
            fallback.appendChild(b); body.appendChild(fallback)
          }
          urlGo.onclick = function () {
            var u = String(urlInput.value || '').trim()
            if (!u) return
            if (!/^https?:\/\//i.test(u)) u = 'https://' + u
            openIframe(u)
          }
          sysOpen.onclick = function () {
            var u = String(urlInput.value || '').trim()
            if (u) { try { window.open(/^https?:/i.test(u) ? u : 'https://' + u, '_blank') } catch (_) {} }
          }
          function setBody(text) {
            body.textContent = ''
            var pre = document.createElement('pre')
            pre.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-all;font:12px/1.6 system-ui;'
            pre.textContent = text
            body.appendChild(pre)
          }
          var activeTab = 'live'
          function syncTab(active) {
            activeTab = active
            ;[tabLive, tabFrames].forEach(function (b) { b.style.background='var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.1))'; b.style.fontWeight='500' })
            ;(active==='frames'?tabFrames:tabLive).style.background='rgba(121,192,255,0.24)'
            ;(active==='frames'?tabFrames:tabLive).style.fontWeight='700'
          }
          function loadLive() {
            syncTab('live'); urlBar.style.display = 'none'
            var body = document.getElementById('cua-panel-body')
            if (!body) { console.error('[dsh-cua-pre] loadLive: body 未挂载'); return }
            body.innerHTML = ''
            var loading = document.createElement('div'); loading.textContent = t('loading'); loading.style.cssText = 'color:var(--dsw-alias-label-secondary, rgba(160,170,185,0.95));padding:6px 0;'
            body.appendChild(loading)
            apiGet(API.state).then(function (s) {
              body.innerHTML = ''
              // — status strip —
              var w = (s && s.worker) || {}
              var stats = (w && w.stats) || {}
              var drops = (stats && stats.dropped) || {}
              var failed = (stats && stats.failed) || {}
              var strip = document.createElement('div')
              strip.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;'
              function addPill(text, ok) {
                var bg = ok===true ? 'rgba(76,175,80,.22)' : ok===false ? 'rgba(244,67,54,.22)' : 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.08))';
                var pill = document.createElement('span')
                pill.style.cssText = 'background:'+bg+';border-radius:999px;padding:1px 8px;font-size:11px;'
                pill.textContent = text; strip.appendChild(pill)
              }
              addPill((s && s.enabled) ? t('on') : t('off'), s && s.enabled)
              if (s && s.stoppedByUser) addPill(t('stopped'), false)
              addPill(t('reqs') + ' ' + (stats.requests||0) + ' · ' + t('ok') + ' ' + (stats.succeeded||0))
              if (w && w.breaker && w.breaker.open) addPill(t('breaker'), false)
              if (s && s.visionEnabled) addPill(t('vision_on'))
              // 健康小行：失败原因 + 丢弃计数（替代 raw JSON）
              var health = document.createElement('div')
              health.style.cssText = 'font-size:10px;color:var(--dsw-alias-label-secondary, rgba(160,170,185,0.95));margin:4px 0 8px;display:flex;gap:8px;flex-wrap:wrap;'
              function dot(k, v) { if(!v) return; var el=document.createElement('span'); el.textContent = t('dropped')+':'+v; health.appendChild(el) }
              dot('pending', w && w.pending)
              dot('timeout', String(failed.timeout||0)!=='0'?failed.timeout:0)
              if(drops && (drops.badJson||drops.badEnvelope||drops.staleEpoch)){
                dot(t('dropped'), 'json'+(drops.badJson||0)+'/env'+(drops.badEnvelope||0)+'/epoch'+(drops.staleEpoch||0))
              }
              health.appendChild(document.createTextNode('')); // placeholder to force flex close
              if (stats.lastExit) {
                var ex = document.createElement('span'); ex.textContent = 'lastExit:'+JSON.stringify(stats.lastExit).slice(0,40); health.appendChild(ex)
              }
              strip.appendChild(health)
              body.appendChild(strip)
              // — ops timeline —
              var secLabel = document.createElement('div')
              secLabel.textContent = t('recent_ops')
              secLabel.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-secondary, rgba(160,170,185,0.95));margin-bottom:6px;'
              body.appendChild(secLabel)
              var ops = (s && s.lastOps) || []
              if (!ops.length) { var empty=document.createElement('div'); empty.textContent=t('no_ops'); empty.style.cssText='font-size:12px;color:var(--dsw-alias-label-secondary, rgba(160,170,185,0.95));'; body.appendChild(empty); return }
              ops.forEach(function (o) {
                var row = document.createElement('div')
                row.style.cssText = 'display:flex;align-items:baseline;gap:8px;font-size:12px;background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.06));border-radius:8px;padding:6px 8px;margin-bottom:4px;'
                var okMark = document.createElement('span'); okMark.textContent = o.ok ? '✓' : '✗'; okMark.style.cssText='color:'+(o.ok?'#3fb950':'#ff7b72')+';font-weight:700;flex-shrink:0;'
                var title = document.createElement('span'); title.textContent = o.title || o.tool; title.style.cssText='font-weight:600;flex-shrink:0;'
                var brief = document.createElement('span'); brief.textContent = o.brief || ''; brief.style.cssText='color:var(--dsw-alias-label-secondary, rgba(160,170,185,0.95));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;'
                var ms = document.createElement('span'); ms.textContent = (o.ms||0)+'ms'; ms.style.cssText='color:var(--dsw-alias-label-secondary, rgba(160,170,185,0.95));font-size:10px;flex-shrink:0;'
                row.appendChild(okMark); row.appendChild(title); row.appendChild(brief); row.appendChild(ms)
                body.appendChild(row)
              })
            }).catch(function (e) { setBody(t('read_fail') + (e.message||e)) })
          }
          var framesTimer = null
          function loadFrames() {
            syncTab('frames'); urlBar.style.display = 'none'
            var body = document.getElementById('cua-panel-body')
            if (!body) return
            body.innerHTML = ''
            var loading = document.createElement('div')
            loading.textContent = t('loading')
            loading.style.cssText = 'color:var(--dsw-alias-label-secondary, rgba(160,170,185,0.95));padding:6px 0;'
            body.appendChild(loading)
            function render(s) {
              var frames = (s && s.frames) || []
              body.innerHTML = ''
              if (!frames.length) {
                var empty = document.createElement('div')
                empty.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary, rgba(160,170,185,0.95));line-height:1.7;padding:4px 0;'
                empty.textContent = t('frames_empty')
                body.appendChild(empty)
                return
              }
              frames.forEach(function (f) {
                var card = document.createElement('div')
                card.style.cssText = 'background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.06));border-radius:10px;padding:8px;margin-bottom:10px;'
                var meta = document.createElement('div')
                meta.style.cssText = 'display:flex;gap:8px;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary, rgba(160,170,185,0.95));margin-bottom:6px;flex-wrap:wrap;'
                var idEl = document.createElement('code'); idEl.textContent = f.frame_id; idEl.style.cssText = 'font-size:10px;'; meta.appendChild(idEl)
                var dim = document.createElement('span'); dim.textContent = f.width + '×' + f.height; meta.appendChild(dim)
                if (f.crop) { var cr = document.createElement('span'); cr.textContent = String(f.crop); meta.appendChild(cr) }
                var st = document.createElement('span')
                st.textContent = f.expired ? t('expired') : t('valid')
                st.style.cssText = 'background:' + (f.expired ? 'rgba(244,67,54,.22)' : 'rgba(76,175,80,.22)') + ';border-radius:999px;padding:1px 8px;font-size:11px;'
                meta.appendChild(st)
                card.appendChild(meta)
                var img = document.createElement('img')
                img.src = '/api/dsh-cua-pre/frame-file?id=' + encodeURIComponent(f.frame_id)
                img.alt = f.frame_id
                img.style.cssText = 'width:100%;border-radius:8px;display:block;background:rgba(0,0,0,0.3);'
                img.onerror = function () {
                  var miss = document.createElement('div')
                  miss.textContent = t('file_gone')
                  miss.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-secondary, rgba(160,170,185,0.95));padding:12px 0;text-align:center;'
                  img.replaceWith(miss)
                }
                card.appendChild(img)
                if (f.vision_description) {
                  var d = document.createElement('details'); d.style.cssText = 'margin-top:6px;font-size:12px;'
                  var sum = document.createElement('summary'); sum.textContent = t('vision_d'); sum.style.cssText = 'cursor:pointer;color:var(--dsw-alias-brand-primary, #4f7cff);'
                  var pre = document.createElement('pre'); pre.textContent = f.vision_description
                  pre.style.cssText = 'white-space:pre-wrap;margin:6px 0 0;font-size:11px;color:var(--dsw-alias-label-primary, #c9d1d9);'
                  d.appendChild(sum); d.appendChild(pre); card.appendChild(d)
                } else if (f.vision_error) {
                  var ve = document.createElement('div'); ve.textContent = '[vision] ' + f.vision_error
                  ve.style.cssText = 'margin-top:6px;font-size:11px;color:var(--dsw-alias-label-secondary, rgba(160,170,185,0.95));'
                  card.appendChild(ve)
                }
                body.appendChild(card)
              })
            }
            apiGet(API.frames).then(render).catch(function (e) {
              body.innerHTML = ''
              var err = document.createElement('div')
              err.textContent = t('read_fail') + (e.message || e)
              err.style.cssText = 'font-size:12px;color:#ff7b72;'
              body.appendChild(err)
            })
            // 面板打开且停在画面页签时，每 3s 静默刷新
            if (framesTimer) clearInterval(framesTimer)
            framesTimer = setInterval(function () {
              if (!uiOpen || activeTab !== 'frames') { clearInterval(framesTimer); framesTimer = null; return }
              apiGet(API.frames).then(render).catch(function () {})
            }, 3000)
          }
          function syncBrowserTab() {
            urlBar.style.display = activeTab === 'browser' ? 'flex' : 'none'
          }
          tabBrowser.onclick = function () { syncTab('browser'); body.innerHTML = ''; body.style.display = 'block'; setBody(t('url_hint')); syncBrowserTab() }
          tabLive.onclick = function () { syncBrowserTab(); loadLive() }
          tabFrames.onclick = function () { syncBrowserTab(); loadFrames() }

          // 暴露给 setPanelVisible 按需刷新（loadLive 内部依赖已挂载的 body，#cua-panel-body）
          try { m._loadLive = loadLive } catch (_) {}

          document.body.appendChild(m)
          panelRoot = m
          return m
        }

        function setPanelVisible(show) {
          if (!panelRoot) ensurePanelRoot()
          if (!panelRoot) return
          panelRoot.style.display = show ? 'flex' : 'none'
          if (show) {
            // 面板已挂载后首次显示：加载实况（内部 body 一定存在）
            try { if (panelRoot._loadLive) panelRoot._loadLive() } catch (e) { console.error('[dsh-cua-pre] loadLive on open error:', e) }
          }
        }
        // ====== 悬浮按钮（独立 FAB，直接操作 uiOpen，不走任何侧栏槽） ======
        var fabRoot = null
        function ensureFAB() {
          if (fabRoot && document.getElementById('cua-fab-root')) return
          var mount = document.getElementById('cua-fab-root')
          if (!mount) {
            mount = document.createElement('div')
            mount.id = 'cua-fab-root'
            mount.style.cssText = 'position:fixed;right:16px;bottom:96px;z-index:9998;'
            // 不使用内联 round 样式：背景给按钮本身
            document.body.appendChild(mount)
          }
          fabRoot = mount
          renderFAB(false)
        }
        function renderFAB(silent) {
          if (!fabRoot) return
          var open = uiOpen
          fabRoot.innerHTML = ''
          var btn = document.createElement('button')
          btn.setAttribute('aria-label', t('title'))
          btn.textContent = 'CUA'
          btn.style.cssText =
            'width:44px;height:44px;border-radius:999px;cursor:pointer;font:700 13px ui-monospace,monospace;letter-spacing:0.5px;' +
            'border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.18));box-shadow:0 8px 32px rgba(0,0,0,0.35);' +
            'background:' + (open ? 'rgba(121,192,255,0.92)' : 'rgba(30,34,44,0.88)') + ';' +
            'color:' + (open ? '#0b1220' : 'var(--dsw-alias-label-primary, #e8eaf0)') + ';font-size:18px;' +
            'display:flex;align-items:center;justify-content:center;'
          btn.onclick = function () {
            // 直接翻转状态，面板由 DOM setPanelVisible 显示/隐藏（不在 overlay 槽里）
            var next = !uiOpen
            setPanelOpen(next)
            setPanelVisible(next)
            renderFAB(false)
          }
          fabRoot.appendChild(btn)
          if (!silent && !open && !document.getElementById('cua-fab-tip')) {
            var tip = document.createElement('div')
            tip.id = 'cua-fab-tip'
            tip.style.cssText =
              'position:absolute;right:52px;top:50%;transform:translateY(-50%);' +
              'white-space:nowrap;background:var(--dsw-alias-bg-overlay, rgba(20,24,32,0.92));color:var(--dsw-alias-label-primary, #e8eaf0);' +
              'border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.14));border-radius:999px;' +
              'padding:4px 10px;font-size:12px;pointer-events:none;'
            tip.textContent = t('title')
            fabRoot.appendChild(tip)
            setTimeout(function () { try { tip.remove(); } catch (_) {} }, 3600)
          }
        }
    }

    // ───────────────────────── 侧边栏内嵌面板（better-sidebar Tab 用）─────────────────────────
    // 与固定面板同内容，但去除 fixed 定位，随侧边栏容器滚动/布局。
    function CuaPanelInline(props) {
      useLang()
      var _s = useState(null)
      var state = _s[0]; var setState = _s[1]
      var _t = useState('live')
      var tab = _t[0]; var setTab = _t[1]
      useEffect(function () {
        if (!props.visible) return
        var alive = true
        var tick = function () { apiGet(API.state).then(function (d) { if (alive) setState(d) }).catch(function () {}) }
        tick()
        var t = setInterval(tick, 2500)
        return function () { alive = false; clearInterval(t) }
      }, [props.visible])
      if (!props.visible) return null
      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        h('div', { style: { display: 'flex', gap: 6, padding: '8px 10px 0', borderBottom: '1px solid var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08))' } },
          
          h('button', { onClick: function () { setTab('live') }, style: tabBtnStyle(tab === 'live') }, t('tab_live')),
          h('button', { onClick: function () { setTab('frames') }, style: tabBtnStyle(tab === 'frames') }, t('tab_frames')),
          h('button', { onClick: function () { setTab('about') }, style: tabBtnStyle(tab === 'about') }, t('tab_about')),
          h('button', { onClick: function () { setLang(lang === 'zh' ? 'en' : 'zh') }, style: { marginLeft: 'auto', background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08))', border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.16))', borderRadius: 7, padding: '2px 8px', color: 'inherit', fontSize: 11, cursor: 'pointer', flexShrink: 0 } }, lang === 'zh' ? 'EN' : '中'),
        ),
        h('div', { style: { flex: 1, overflowY: 'auto', padding: 12 } },
          tab === 'live' ? h(LiveTab, { state: state })
            : tab === 'frames' ? h(FramesTab, null)
              : h('div', { style: { fontSize: 12, lineHeight: 1.7, color: MUTED } },
                  h('div', null, t('about1')),
                  h('div', { style: { marginTop: 8 } }, t('about2')),
                  h('div', null, t('about3')),
                  h('div', null, t('about4')),
                ),
        ),
      )
    }
    function tabBtnStyle(active) {
      return {
        flex: 1, padding: '6px 0', fontSize: 12, cursor: 'pointer',
        background: active ? 'rgba(121,192,255,0.2)' : 'transparent',
        color: active ? '#fff' : MUTED,
        border: 'none', borderRadius: 8,
      }
    }

    // 面板自给自足，不再依赖 shell.overlay 的宿主重渲染。

    exports.inject = ['slots', 'betterSidebar']
    exports.apply = apply
    return module.exports
  },
})