/* dsh-cua-pre — browser half (hand-written __ModuleLoader__ bundle).
 * Registers three additive surfaces (same mechanism as dsh-auto-memory):
 *   1. floating FAB (fixed, right-bottom corner — decoupled from third-party sidebar)
 *   2. shell.overlay         — 电脑控制面板: 实况(操作流) / 画面(帧+vision描述)
 *   3. settings.section      — 「电脑控制」设置页(基础 / 视觉识图 / 安全)
 * Data flows over /api/dsh-cua-pre/* (loopback-only host routes).
 */
console.log('[dsh-cua-pre] client v0.4.0 loading')
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
      background: 'rgba(22,24,30,0.72)',
      backdropFilter: 'blur(18px) saturate(140%)',
      WebkitBackdropFilter: 'blur(18px) saturate(140%)',
      border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 14,
      color: '#e8eaf0',
      boxShadow: '0 10px 40px rgba(0,0,0,0.35)',
    }
    var MUTED = 'rgba(232,234,240,0.55)'

    function Pill(props) {
      var bg = props.ok === true ? 'rgba(76,175,80,0.25)' : props.ok === false ? 'rgba(244,67,54,0.25)' : 'rgba(255,255,255,0.12)'
      return h('span', { style: { background: bg, borderRadius: 999, padding: '1px 8px', fontSize: 11, marginRight: 6 } }, props.text)
    }

    // ───────────────────────── 实况 Tab ─────────────────────────
    function LiveTab(props) {
      var state = props.state
      var ops = (state && state.lastOps) || []
      var w = state && state.worker
      return h('div', { style: { padding: 12 } },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 } },
          h(Pill, { text: state && state.enabled ? '已启用' : '未启用', ok: !!(state && state.enabled) }),
          state && state.stoppedByUser ? h(Pill, { text: '⛔ 已紧急停止', ok: false }) : null,
          state && state.whitelist && state.whitelist.active ? h(Pill, { text: '白名单×' + state.whitelist.size + (state.whitelist.relaxed ? '(宽松)' : '(严格)') }) : null,
          h(Pill, { text: 'worker ' + (w && w.started ? '运行中' : '空闲'), ok: !!(w && w.started) }),
          w ? h(Pill, { text: '请求 ' + w.stats.requests + ' 成功 ' + w.stats.succeeded }) : null,
          w && w.breaker && w.breaker.open ? h(Pill, { text: '断路器熔断', ok: false }) : null,
          state && state.visionEnabled ? h(Pill, { text: 'vision 开' }) : null,
        ),
        h('div', { style: { fontSize: 12, color: MUTED, marginBottom: 6 } }, '最近操作（新→旧）'),
        ops.length === 0
          ? h('div', { style: { fontSize: 12, color: MUTED } }, '暂无操作记录')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, ops.map(function (o, i) {
              return h('div', {
                key: i,
                style: {
                  display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12,
                  background: 'rgba(255,255,255,0.05)', borderRadius: 8, padding: '5px 8px',
                },
              },
                h('span', { style: { color: o.ok ? '#7ee787' : '#ff7b72', flexShrink: 0 } }, o.ok ? '✓' : '✗'),
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
        return h('div', { style: { padding: 12, fontSize: 12, color: MUTED } }, '暂无画面帧。模型执行 screenshot 或 get_app_state(include_screenshot) 后这里会显示截图与识图描述。')
      }
      return h('div', { style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' } },
        frames.map(function (f) {
          return h('div', { key: f.frame_id, style: { background: 'rgba(255,255,255,0.05)', borderRadius: 10, padding: 8 } },
            h('div', { style: { display: 'flex', gap: 6, marginBottom: 6, fontSize: 11, color: MUTED, alignItems: 'center' } },
              h('code', { style: { fontSize: 10 } }, f.frame_id),
              h('span', null, f.width + '×' + f.height),
              f.crop ? h('span', null, String(f.crop)) : null,
              f.expired ? h(Pill, { text: '过期', ok: false }) : h(Pill, { text: '有效' }),
            ),
            h('img', {
              src: API.frameFile + encodeURIComponent(f.frame_id),
              alt: f.frame_id,
              style: { width: '100%', borderRadius: 8, display: 'block', background: 'rgba(0,0,0,0.3)' },
            }),
            f.vision_description
              ? h('details', { style: { marginTop: 6, fontSize: 12 } },
                  h('summary', { style: { cursor: 'pointer', color: '#79c0ff' } }, '[vision] 识图描述 (' + (f.vision_tiles || '?') + ' 块)'),
                  h('pre', { style: { whiteSpace: 'pre-wrap', margin: '6px 0 0', fontSize: 11, color: '#c9d1d9' } }, f.vision_description))
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
            background: tab === id ? 'rgba(255,255,255,0.16)' : 'transparent',
            color: tab === id ? '#fff' : MUTED,
            border: 'none', borderRadius: 8,
          },
        }, label)
      }
      return h('div', { style: Object.assign({}, GLASS, { width: props.width || 430, height: props.height || 560, display: 'flex', flexDirection: 'column', overflow: 'hidden' }) },
        h('div', { style: { display: 'flex', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)' } },
          h('span', { style: { fontWeight: 700, fontSize: 13 } }, '🖥️ 电脑控制'),
          h('span', { style: { marginLeft: 8, fontSize: 11, color: MUTED } }, 'zcode-cua 对齐版'),
          h('span', { style: { flex: 1 } }),
          h('button', {
            onClick: props.onClose, style: { background: 'transparent', border: 'none', color: MUTED, fontSize: 16, cursor: 'pointer' },
          }, '✕'),
        ),
        h('div', { style: { display: 'flex', gap: 4, padding: '8px 10px 0' } },
          tabBtn('live', '实况'), tabBtn('frames', '画面'), tabBtn('about', '说明')),
        h('div', { style: { flex: 1, overflowY: 'auto' } },
          tab === 'live' ? h(LiveTab, { state: state })
            : tab === 'frames' ? h(FramesTab, null)
              : h('div', { style: { padding: 12, fontSize: 12, lineHeight: 1.7, color: MUTED } },
                  h('div', null, '与 ZCode Computer Use 同构的桌面控制：无障碍树优先、元素/坐标双目标、strategy 路由、写后作废、action_sent 幂等纪律。'),
                  h('div', { style: { marginTop: 8 } }, '· 默认关闭：设置页或 ~/.dsh/cua-pre.json {"enabled":true}'),
                  h('div', null, '· 紧急停止：stop_computer_control 持久生效，恢复需清理配置并重启'),
                  h('div', null, '· 识图：开启后截图自动分块裁切送 VLM，低分辨率模型也能读清屏幕'),
                ),
        ),
      )
    }

    // ───────────────────────── 设置页 ─────────────────────────
    var FIELD_STYLE = { display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' }
    var LABEL_STYLE = { width: 170, fontSize: 12, color: MUTED, flexShrink: 0 }
    var INPUT_STYLE = { flex: 1, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '5px 8px', color: 'inherit', fontSize: 12 }

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
          background: props.value ? 'rgba(76,175,80,0.6)' : 'rgba(255,255,255,0.15)',
          position: 'relative',
        },
      }, h('span', { style: { position: 'absolute', top: 2, left: props.value ? 22 : 2, width: 16, height: 16, borderRadius: 999, background: '#fff', transition: 'left .15s' } }))
    }

    function SettingsPage() {
      var _c = useState(null)
      var cfg = _c[0]; var setCfg = _c[1]
      var _m = useState('')
      var msg = _m[0]; var setMsg = _m[1]
      var _saving = useState(false)
      var saving = _saving[0]; var setSaving = _saving[1]

      useEffect(function () {
        apiGet(API.config).then(function (d) { setCfg(d && d.config) }).catch(function (e) { setMsg('加载失败: ' + e.message) })
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
        apiGet(API.detect).then(function (d) { setDet(d) }).catch(function (e) { setMsg('检测失败: ' + e.message) }).finally(function () { setDetBusy(false) })
      }
      useEffect(function () { runDetect() }, [])
      function applyPython(p2) {
        set('pythonExecutable', p2)
        apiPost(API.config, { pythonExecutable: p2 }).then(function (r) {
          setMsg(r && r.ok ? 'Python 已切换并即时生效' : '应用失败: ' + (r && r.error))
        }).catch(function (e) { setMsg('应用失败: ' + e.message) })
      }
      function installDeps(p2) {
        setInstalling(p2)
        setMsg('正在为该 Python 安装 uiautomation+pillow（可能 1-2 分钟）…')
        apiPost(API.installDeps, { python: p2 }).then(function (r) {
          setMsg(r && r.ok ? '依赖安装完成，该解释器已可用' : '安装失败: ' + ((r && r.tail) || (r && r.error) || ''))
          runDetect()
        }).catch(function (e) { setMsg('安装失败: ' + e.message) }).finally(function () { setInstalling('') })
      }
      function PythonEnvCard() {
        if (!det) return h('div', { style: { fontSize: 12, color: MUTED } }, detBusy ? '正在检测 Python 环境…' : '（未检测）')
        var rows = (det.pythons || []).map(function (c) {
          var selected = String(cfg.pythonExecutable || '') === c.path
          var badge = c.status === 'ready'
            ? h('span', { style: { background: 'rgba(76,175,80,.22)', borderRadius: 999, padding: '1px 8px', fontSize: 11, flexShrink: 0 } }, '依赖齐全')
            : c.status === 'no-deps'
              ? h('button', {
                  onClick: function (e) { e.stopPropagation(); installDeps(c.path) },
                  style: { background: 'rgba(230,162,60,.22)', borderRadius: 999, padding: '1px 8px', fontSize: 11, border: 'none', cursor: 'pointer', color: 'inherit', flexShrink: 0 },
                }, installing === c.path ? '安装中…' : '缺依赖·一键安装')
              : h('span', { style: { background: 'rgba(244,67,54,.18)', borderRadius: 999, padding: '1px 8px', fontSize: 11, flexShrink: 0, opacity: .7 } }, '不可用')
          return h('div', {
            key: c.path,
            onClick: function () { if (c.status !== 'missing') applyPython(c.path) },
            style: {
              display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 9, marginBottom: 4,
              cursor: c.status === 'missing' ? 'default' : 'pointer',
              background: selected ? 'rgba(121,192,255,0.16)' : 'rgba(255,255,255,0.05)',
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
            'worker 脚本：自动使用内置 ' + (w.exists ? '✓ ' : '✗ ') + (w.path || '') + '（workerPath 留空即自动）'),
          h('div', { style: { fontSize: 11, color: MUTED, marginTop: 2 } },
            '点击任一可用解释器即切换并即时生效；「依赖齐全」= 可直接运行电脑控制。'),
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
            h('option', { value: '' }, '跟随系统路由（默认，推荐）'),
            det && det.models && !det.models.unsupported && visOpt.length
              ? h('optgroup', { label: '疑似具备视觉能力（启发式）' }, visOpt)
              : null,
            det && det.models && !det.models.unsupported && allOpt.length
              ? h('optgroup', { label: '全部模型' }, allOpt)
              : null,
            h('option', { value: '__manual__' }, '手动输入…'),
          ),
          det && det.models && det.models.unsupported
            ? h('div', { style: { fontSize: 11, color: MUTED, marginTop: 3 } }, '（模型目录不可用，请手动输入模型名）')
            : null,
          manual
            ? h('input', {
                value: cur, placeholder: '输入模型 id，如 qwen2.5-vl-7b-instruct',
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
          setMsg(r && r.ok ? '已保存。重启 dsh web 后完全生效。' : ('保存失败: ' + (r && r.error)))
        }).catch(function (e) { setMsg('保存失败: ' + e.message) }).finally(function () { setSaving(false) })
      }
      if (!cfg) return h('div', { style: { padding: 16, fontSize: 13 } }, msg || '加载配置…')

      var num = function (k) {
        return h('input', { type: 'number', value: cfg[k], onChange: function (e) { set(k, Number(e.target.value)) }, style: INPUT_STYLE })
      }
      var txt = function (k, ph) {
        return h('input', { value: cfg[k] == null ? '' : cfg[k], placeholder: ph || '', onChange: function (e) { set(k, e.target.value) }, style: INPUT_STYLE })
      }

      return h('div', { style: { maxWidth: 640, fontSize: 13 } },
        h('h3', { style: { margin: '4px 0 10px' } }, '🖥️ 电脑控制 (dsh-cua-pre)'),
        h('div', { style: { fontSize: 12, color: MUTED, marginBottom: 12 } }, '与 ZCode Computer Use 同构的桌面控制。默认关闭；配置文件 ' + '~/.dsh/cua-pre.json'),

        h('div', { style: { fontWeight: 600, margin: '10px 0 2px' } }, '基础'),
        h(Row, { label: '启用电脑控制' }, h(Toggle, { value: !!cfg.enabled, onChange: function (v) { set('enabled', v) } })),
        h(Row, { label: 'Python 环境', hint: '自动检测本机可用解释器；点击即切换并即时生效' }, PythonEnvCard()),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '2px 0 8px' } },
          h('button', {
            onClick: runDetect, disabled: detBusy,
            style: { background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 8, padding: '4px 12px', color: 'inherit', fontSize: 12, cursor: 'pointer' },
          }, detBusy ? '检测中…' : '重新检测'),
          h('span', { style: { fontSize: 11, color: MUTED } }, '高级：workerPath 手动覆盖'),
          txt('workerPath', '')),
        h(Row, { label: '截屏保存目录' }, txt('artifactsDir', '~/.dsh/cua-pre/artifacts')),
        h(Row, { label: '工具名前缀', hint: '与宿主撞名时使用；默认空=zcode 同名' }, txt('toolNamePrefix', '')),
        h(Row, { label: '观察元素上限' }, num('maxObserveElements')),
        h(Row, { label: '观察树深度' }, num('observeMaxDepth')),
        h(Row, { label: '请求超时(ms)' }, num('requestTimeoutMs')),

        h('div', { style: { fontWeight: 600, margin: '14px 0 2px' } }, '视觉识图 (vision)'),
        h(Row, { label: '启用识图' }, h(Toggle, { value: !!cfg.visionEnabled, onChange: function (v) { set('visionEnabled', v) } })),
        h(Row, { label: '自动描述截图' }, h(Toggle, { value: !!cfg.visionAutoDescribe, onChange: function (v) { set('visionAutoDescribe', v) } })),
        h(Row, { label: '识图模型', hint: '自动列出模型目录（启发式标记疑似具备视觉能力）；默认跟随系统路由' }, VisionModelSelect()),
        h(Row, { label: '分块目标边长(px)', hint: '低分辨率模型建议 ≤768' }, num('tileMaxPx')),
        h(Row, { label: '分块重叠(px)' }, num('tileOverlapPx')),
        h(Row, { label: '最多分块数' }, num('visionMaxTiles')),
        h(Row, { label: '识图超时(ms)' }, num('visionTimeoutMs')),

        h('div', { style: { fontWeight: 600, margin: '14px 0 2px', color: '#ff9a8b' } }, '安全'),
        h(Row, { label: 'PID 白名单', hint: '逗号分隔的进程 id；留空=不限制。启用后白名单外应用的观察/操作被拒；坐标类、剪贴板、全屏截图默认拒绝（宽松模式可放开）。保存即时生效。' },
          h('input', {
            value: Array.isArray(cfg.allowedPids) ? cfg.allowedPids.join(',') : String(cfg.allowedPids || ''),
            placeholder: '如 1234, 5678（留空不限制）',
            onChange: function (e) {
              var v = e.target.value.split(',').map(function (x) { return parseInt(x.trim(), 10) }).filter(Number.isFinite)
              set('allowedPids', v)
            },
            style: INPUT_STYLE,
          })),
        h(Row, { label: '白名单宽松模式', hint: '放开坐标类/剪贴板/全屏截图的限制（作用域化检查仍然生效）' },
          h(Toggle, { value: !!cfg.whitelistRelaxed, onChange: function (v) { set('whitelistRelaxed', v) } })),
        h(Row, { label: 'kill switch 状态' },
          h('span', { style: { fontSize: 12 } }, '见面板「实况」页签；stop_computer_control 后持久停止，恢复需删除配置中 stoppedByUser 并重启')),

        h('div', { style: { display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' } },
          h('button', {
            onClick: save, disabled: saving,
            style: { background: 'rgba(121,192,255,0.25)', border: '1px solid rgba(121,192,255,0.5)', color: 'inherit', borderRadius: 8, padding: '6px 18px', cursor: 'pointer', fontSize: 13 },
          }, saving ? '保存中…' : '保存配置'),
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

      // ====== DOM 直挂统一延迟到 body 可用 ======
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
        ensurePanelRoot()
        setPanelVisible(uiOpen)
        ensureFAB()
        uiListeners.add(function () { setPanelVisible(uiOpen); renderFAB(false) })
        console.log('[dsh-cua-pre] client ready: floating FAB + fixed panel + settings page')
      }
      whenBodyReady(mountDom)
      setTimeout(whenBodyReady.bind(null, mountDom), 800) // 双保险

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
            'border-radius:16px;border:1px solid rgba(255,255,255,0.16);' +
            'background:rgba(22,26,34,0.94);backdrop-filter:blur(22px) saturate(1.35);' +
            ' -webkit-backdrop-filter:blur(22px) saturate(1.35);' +
            'box-shadow:0 16px 48px rgba(0,0,0,0.45);color:#e8eaf0;'
          var header = document.createElement('div')
          header.style.cssText =
            'display:flex;align-items:center;gap:8px;padding:10px 12px;' +
            'border-bottom:1px solid rgba(255,255,255,0.1);font-weight:700;font-size:13px;'
          var title = document.createElement('span'); title.textContent = '🖥️ 电脑控制'; header.appendChild(title)
          var badge = document.createElement('span'); badge.textContent = 'zcode-cua 对齐版'
          badge.style.cssText = 'opacity:.6;font-size:11px;font-weight:500;'; header.appendChild(badge)
          var sp = document.createElement('span'); sp.style.cssText = 'flex:1'; header.appendChild(sp)
          var closeBtn = document.createElement('button')
          closeBtn.textContent = '✕'
          closeBtn.style.cssText = 'background:transparent;border:0;color:inherit;opacity:.7;cursor:pointer;font-size:18px;'
          closeBtn.onclick = function () { setPanelOpen(false) }
          header.appendChild(closeBtn)
          m.appendChild(header)

          var tabs = document.createElement('div')
          tabs.style.cssText = 'display:flex;gap:6px;padding:8px 10px 0;'
          var tabLive = document.createElement('button'); tabLive.textContent = '实况'
          var tabFrames = document.createElement('button'); tabFrames.textContent = '画面'
          ;[tabLive, tabFrames].forEach(function (b) {
            b.style.cssText='flex:1;padding:6px 0;border:0;border-radius:999px;cursor:pointer;font-size:12px;background:rgba(255,255,255,0.1);color:#e8eaf0;'
          })
          tabs.appendChild(tabLive); tabs.appendChild(tabFrames); m.appendChild(tabs)

          var body = document.createElement('div')
          body.id = 'cua-panel-body'
          body.style.cssText = 'padding:10px 14px 14px;font-size:12px;line-height:1.6;overflow:auto;white-space:pre-wrap;word-break:break-word;max-height:360px;'
          m.appendChild(body)

          function setBody(text) {
            body.textContent = ''
            var pre = document.createElement('pre')
            pre.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-all;font:12px/1.6 system-ui;'
            pre.textContent = text
            body.appendChild(pre)
          }
          function syncTab(active) {
            ;[tabLive, tabFrames].forEach(function (b) { b.style.background='rgba(255,255,255,0.1)'; b.style.fontWeight='500' })
            ;(active==='frames'?tabFrames:tabLive).style.background='rgba(121,192,255,0.24)'
            ;(active==='frames'?tabFrames:tabLive).style.fontWeight='700'
          }
          function loadLive() {
            syncTab('live')
            var body = document.getElementById('cua-panel-body')
            if (!body) { console.error('[dsh-cua-pre] loadLive: body 未挂载'); return }
            body.innerHTML = ''
            var loading = document.createElement('div'); loading.textContent = '加载中…'; loading.style.cssText = 'color:rgba(232,234,240,.45);padding:6px 0;'
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
                var bg = ok===true ? 'rgba(76,175,80,.22)' : ok===false ? 'rgba(244,67,54,.22)' : 'rgba(255,255,255,.08)';
                var pill = document.createElement('span')
                pill.style.cssText = 'background:'+bg+';border-radius:999px;padding:1px 8px;font-size:11px;'
                pill.textContent = text; strip.appendChild(pill)
              }
              addPill((s && s.enabled) ? '已启用' : '未启用', s && s.enabled)
              if (s && s.stoppedByUser) addPill('⛔ 已紧急停止', false)
              addPill('请求 ' + (stats.requests||0) + ' · 成功 ' + (stats.succeeded||0))
              if (w && w.breaker && w.breaker.open) addPill('断路器熔断', false)
              if (s && s.visionEnabled) addPill('vision 开')
              // 健康小行：失败原因 + 丢弃计数（替代 raw JSON）
              var health = document.createElement('div')
              health.style.cssText = 'font-size:10px;color:rgba(232,234,240,.45);margin:4px 0 8px;display:flex;gap:8px;flex-wrap:wrap;'
              function dot(k, v) { if(!v) return; var el=document.createElement('span'); el.textContent = k+':'+v; health.appendChild(el) }
              dot('pending', w && w.pending)
              dot('timeout', String(failed.timeout||0)!=='0'?failed.timeout:0)
              if(drops && (drops.badJson||drops.badEnvelope||drops.staleEpoch)){
                dot('丢弃', 'json'+(drops.badJson||0)+'/env'+(drops.badEnvelope||0)+'/epoch'+(drops.staleEpoch||0))
              }
              health.appendChild(document.createTextNode('')); // placeholder to force flex close
              if (stats.lastExit) {
                var ex = document.createElement('span'); ex.textContent = 'lastExit:'+JSON.stringify(stats.lastExit).slice(0,40); health.appendChild(ex)
              }
              strip.appendChild(health)
              body.appendChild(strip)
              // — ops timeline —
              var secLabel = document.createElement('div')
              secLabel.textContent = '最近操作（新→旧）'
              secLabel.style.cssText = 'font-size:11px;color:rgba(232,234,240,.45);margin-bottom:6px;'
              body.appendChild(secLabel)
              var ops = (s && s.lastOps) || []
              if (!ops.length) { var empty=document.createElement('div'); empty.textContent='暂无操作记录'; empty.style.cssText='font-size:12px;color:rgba(232,234,240,.45);'; body.appendChild(empty); return }
              ops.forEach(function (o) {
                var row = document.createElement('div')
                row.style.cssText = 'display:flex;align-items:baseline;gap:8px;font-size:12px;background:rgba(255,255,255,0.06);border-radius:8px;padding:6px 8px;margin-bottom:4px;'
                var okMark = document.createElement('span'); okMark.textContent = o.ok ? '✓' : '✗'; okMark.style.cssText='color:'+(o.ok?'#7ee787':'#ff7b72')+';font-weight:700;flex-shrink:0;'
                var title = document.createElement('span'); title.textContent = o.title || o.tool; title.style.cssText='font-weight:600;flex-shrink:0;'
                var brief = document.createElement('span'); brief.textContent = o.brief || ''; brief.style.cssText='color:rgba(232,234,240,.55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;'
                var ms = document.createElement('span'); ms.textContent = (o.ms||0)+'ms'; ms.style.cssText='color:rgba(232,234,240,.45);font-size:10px;flex-shrink:0;'
                row.appendChild(okMark); row.appendChild(title); row.appendChild(brief); row.appendChild(ms)
                body.appendChild(row)
              })
            }).catch(function (e) { setBody('读取失败: ' + (e.message||e)) })
          }
          function loadFrames() {
            syncTab('frames'); setBody('加载中…')
            apiGet(API.frames).then(function (s) {
              var frames = (s && s.frames) || []
              if (!frames.length) { setBody('(暂无画面帧)\n模型执行 screenshot 或 get_app_state(include_screenshot) 后出现。'); return }
              setBody('共 ' + frames.length + ' 帧（新→旧）：\n' + frames.map(function (f) {
                return '- ' + f.frame_id + '  ' + f.width + 'x' + f.height + '  crop=' + (f.crop||'-') + '  ' + (f.expired?'过期':'有效')
                  + (f.vision_description ? ('\n  [vision] ' + f.vision_description.slice(0,240)) : '')
              }).join('\n'))
            }).catch(function (e) { setBody('读取失败: ' + (e.message||e)) })
          }
          tabLive.onclick = loadLive
          tabFrames.onclick = loadFrames

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
          btn.setAttribute('aria-label', '电脑控制')
          btn.textContent = '🖥️'
          btn.style.cssText =
            'width:44px;height:44px;border-radius:999px;cursor:pointer;' +
            'border:1px solid rgba(255,255,255,0.18);box-shadow:0 8px 32px rgba(0,0,0,0.35);' +
            'background:' + (open ? 'rgba(121,192,255,0.92)' : 'rgba(30,34,44,0.88)') + ';' +
            'color:' + (open ? '#0b1220' : '#e8eaf0') + ';font-size:18px;' +
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
              'white-space:nowrap;background:rgba(20,24,32,0.92);color:#e8eaf0;' +
              'border:1px solid rgba(255,255,255,0.14);border-radius:999px;' +
              'padding:4px 10px;font-size:12px;pointer-events:none;'
            tip.textContent = '电脑控制'
            fabRoot.appendChild(tip)
            setTimeout(function () { try { tip.remove(); } catch (_) {} }, 3600)
          }
        }
    }

    // 面板自给自足，不再依赖 shell.overlay 的宿主重渲染。

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})