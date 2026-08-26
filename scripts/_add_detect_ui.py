# -*- coding: utf-8 -*-
"""Settings UI: env auto-detect cards for python/worker + vision model dropdown."""
import pathlib
p = pathlib.Path('E:/dsh-cua-pre/lib/client.js')
s = p.read_text(encoding='utf-8')
orig = s
n = 0

def rep(old, new):
    global s, n
    assert old in s, 'MISS: ' + old[:90].replace('\n', '\\n')
    s = s.replace(old, new, 1)
    n += 1

# API map
rep("""      frameFile: '/api/dsh-cua-pre/frame-file?id=',
    }""",
    """      frameFile: '/api/dsh-cua-pre/frame-file?id=',
      detect: '/api/dsh-cua-pre/detect',
      installDeps: '/api/dsh-cua-pre/install-deps',
    }""")

# detect state + helpers inside SettingsPage (after config load effect)
rep("""      useEffect(function () {
        apiGet(API.config).then(function (d) { setCfg(d && d.config) }).catch(function (e) { setMsg('加载失败: ' + e.message) })
      }, [])""",
    """      useEffect(function () {
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
      }""")

# replace python/worker rows with detect card
rep("""        h(Row, { label: 'Python 解释器', hint: '推荐指向项目 venv' }, txt('pythonExecutable', 'python')),
        h(Row, { label: 'worker 脚本路径', hint: '留空=内置 python/worker_cua_v2.py' }, txt('workerPath', '')),""",
    """        h(Row, { label: 'Python 环境', hint: '自动检测本机可用解释器；点击即切换并即时生效' }, PythonEnvCard()),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '2px 0 8px' } },
          h('button', {
            onClick: runDetect, disabled: detBusy,
            style: { background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 8, padding: '4px 12px', color: 'inherit', fontSize: 12, cursor: 'pointer' },
          }, detBusy ? '检测中…' : '重新检测'),
          h('span', { style: { fontSize: 11, color: MUTED } }, '高级：workerPath 手动覆盖'),
          txt('workerPath', '')),""")

# replace vision model row
rep("""        h(Row, { label: '识图模型', hint: '留空=跟随系统路由；如 deepseek-vl 类' }, txt('visionModel', '')),""",
    """        h(Row, { label: '识图模型', hint: '自动列出模型目录（启发式标记疑似具备视觉能力）；默认跟随系统路由' }, VisionModelSelect()),""")

assert s != orig
p.write_text(s, encoding='utf-8')
print('client patched:', n)
