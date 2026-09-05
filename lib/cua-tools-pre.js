/**
 * cua-tools-pre — zcode-cua 工具面移植（30 个同名工具，元素/坐标双目标 + strategy 路由）。
 *
 * 与 zcode-cua 的对齐点：
 *   - 目标形态：{"type":"element","state_id","index"} | {"type":"coordinate","x","y"}
 *   - strategy: auto（坐标先 a11y 命中测试）/ a11y（无障碍失败即 fail-closed，不注入）/
 *               event（强制裸输入）；元素目标在 event 下拒绝
 *   - return_state: none|compact|full —— 变更成功后服务端自动重观察并返回新 state
 *   - action_sent 纪律：预检失败 action_sent=false；timeout/crashed 视为"可能已发生"
 *   - get_app_state/screenshot/zoom 的帧注册表与 image_ref；repeat_observation 检测
 *   - left_mouse_down/up 配对守卫；hold_key 30s 钳制；scroll amount 0..100 钳制
 * 已知偏离（诚实声明）：帧绑定坐标为软绑定（不拒绝过期帧像素，仅标注 frame_stale）；
 *   bundle_id(AUMID) 不支持；app_ref 键盘注入要求目标窗口前台（Windows 无后台键盘路由）。
 */

function f(err) { throw err }

class ToolError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.code = code
    this.extra = extra
  }
}

const TARGET_SCHEMA = {
  type: 'object',
  description: '目标。element={type:"element",state_id,index}（推荐，来自最近一次 get_app_state）；coordinate={type:"coordinate",x,y}（只能取自最近返回的图像/状态中的整数像素）。',
}

const STRATEGY_SCHEMA = {
  type: 'string',
  enum: ['auto', 'a11y', 'event'],
  description: 'auto=坐标先做无障碍命中测试（默认）；a11y=只允许无障碍动作，够不到就 fail-closed 拒绝；event=跳过无障碍直接裸输入。',
}

const RETURN_STATE_SCHEMA = {
  type: 'string',
  enum: ['compact', 'full', 'none'],
  description: '变更类动作成功后是否附带重观察结果。默认 compact。',
}

export function createCuaToolsPre(deps) {
  const { sidecar, session, gate, killSwitch, afterScreenshot, attachFrame, queueUrl } = deps
  // config 惰性取（apply 在 loadConfig 完成后才注册，但保持解耦不快照）
  const config = () => deps.config || {}
  // pid 白名单：deps.pidGate(pid) → null(放行) | 原因字符串
  const pidGate = (pid) => (typeof deps.pidGate === 'function' ? deps.pidGate(pid) : null)

  function whitelistActive() {
    const list = config().allowedPids || []
    return Array.isArray(list) && list.length > 0
  }

  /** 作用域化操作的 pid 门禁。 */
  function checkPid(pid) {
    const reason = pidGate(pid)
    if (reason) throw new ToolError('pid_blocked', reason, { action_sent: false })
  }

  /** 无作用域可查的全局效果操作（坐标/剪贴板/全屏截图/open）在白名单下的默认拒绝。 */
  function requireUnscopedAllowed(kind) {
    if (!whitelistActive()) return
    if (config().whitelistRelaxed) return
    throw new ToolError('pid_scope_required',
      'PID 白名单启用中（strict 模式）：' + kind + ' 无法确认目标归属，已被拒绝。' +
      '改用元素目标(element target)，在设置页添加对应 pid，或开启「白名单宽松模式」。', { action_sent: false })
  }

  // ---------- 渲染 ----------
  function renderElement(i, el, withRect) {
    const caps = []
    if ((el.a || '').includes('V')) caps.push('editable')
    if (/[ITESL]/.test(el.a || '')) caps.push('pressable')
    if (/menu/i.test(el.k || '')) caps.push('has_menu')
    if (el.f) caps.push('focused')
    if (!el.e) caps.push('disabled')
    let line = i + ': ' + (el.k || '?') + ' "' + (el.n || '') + '"'
    if (caps.length) line += ' [' + caps.join(',') + ']'
    if (withRect && el.r) line += ' @' + el.r[0] + ',' + el.r[1] + ',' + (el.r[2] - el.r[0]) + 'x' + (el.r[3] - el.r[1])
    return line
  }

  async function observeRaw(sel) {
    const r = await sidecar.request('observe', {
      sel,
      maxDepth: Number(config().observeMaxDepth),
      maxElements: Math.min(600, Number(config().maxObserveElements)),
    })
    if (!r.ok) throw new ToolError(r.code === 'worker-error' ? r.reason : r.code, workerMsg(r))
    const key = JSON.stringify([sel.pid, sel.hwnd, sel.title, r.payload.count])
    const repeat = session.noteObservation(key)
    const rec = session.remember(sel, r.payload.elements)
    rec.windowInfo = r.payload.window
    rec.truncated = r.payload.truncated
    rec.repeat = repeat
    return rec
  }

  function workerMsg(r) {
    if (r.code === 'worker-error') {
      let m = String(r.reasonText || r.reason)
      if (r.reason === 'stale_tree') m += ' —— 立即重新 get_app_state 获取新 state_id。'
      if (r.reason === 'CUA_DEP_MISSING') m += ' （.venv 缺依赖：pip install -r python/requirements.txt）'
      if (r.reason === 'needs_foreground') m = '后台优先：语义动作不可用且窗口非前台。重试传 allowFocus:true，或改用 set_value 等后台语义。'
      if (r.reason === 'needs_foreground') m += ' （后台优先模式；重试传 allowFocus:true 可置前操作）'
      return m
    }
    if (r.code === 'timeout') return 'timeout(' + r.timeoutMs + 'ms)。若是变更类操作，动作可能已发生：先重新观察确认，勿盲目重放。'
    if (r.code === 'crashed') return 'Python worker 崩溃退出，下次调用自动重生。'
    if (r.code === 'unavailable') return '无法启动 Python worker（检查 config.pythonExecutable）。'
    if (r.code === 'circuit-open') return '断路器熔断中，' + Math.ceil((r.retryInMs || 0) / 1000) + 's 后自动半开。'
    return r.code || 'unknown'
  }

  /** 变更后重观察并渲染 [state …] 块。 */
  async function postStateBlock(args, sel, fallbackMode) {
    const mode = args.return_state === undefined ? (fallbackMode || 'compact') : args.return_state
    if (mode === 'none') return ''
    try {
      const rec = await observeRaw(sel)
      return '\n' + formatState(rec, mode === 'full')
    } catch (_) {
      return '\n[state] 重观察失败（窗口可能已关闭）。请手动 get_app_state。'
    }
  }

  async function observeRaw(sel) {
    const r = await sidecar.request('observe', {
      sel,
      maxDepth: Number(config().observeMaxDepth),
      maxElements: Math.min(600, Number(config().maxObserveElements)),
    })
    if (!r.ok) throw new ToolError(r.code === 'worker-error' ? r.reason : r.code, workerMsg(r))
    const key = JSON.stringify([sel.pid, sel.hwnd, sel.title, r.payload.count])
    const repeat = session.noteObservation(key)
    const rec = session.remember(sel, r.payload.elements)
    rec.windowInfo = r.payload.window
    rec.truncated = r.payload.truncated
    rec.repeat = repeat
    return rec
  }

  function formatState(rec, full) {
    const w = rec.windowInfo || {}
    const head = '[state ' + rec.stateId + '] pid=' + w.pid + ' window_id=' + w.window_id +
      ' "' + (w.title || '') + '"' + (w.focused ? ' focused' : '') +
      ' elements=' + rec.elements.length + (rec.truncated ? '(截断)' : '') +
      (rec.repeat > 0 ? ' repeat_observation=' + rec.repeat : '')
    const lines = rec.elements.map((el, i) => renderElement(i, el, true))
    return head + '\n' + (lines.join('\n') || '(空树)')
  }

  // ---------- 目标解析 ----------
  function requireGate() {
    const g = gate()
    if (g) throw new ToolError('gate_blocked', g)
  }

  function resolveElementTarget(target) {
    if (!target || target.type !== 'element') throw new ToolError('bad_target', '此工具的 target 必须是 element 形态 {type:"element",state_id,index}', { action_sent: false })
    const st = session.get(target.state_id)
    if (!st) {
      const why = session.isSuperseded(target.state_id) ? '已被后续变更作废(superseded)' : '无效或已过期'
      throw new ToolError('element_stale', 'state_id ' + target.state_id + ' ' + why + '。请重新 get_app_state。', { action_sent: false })
    }
    if (session.requiresRefresh(st.sel.pid)) {
      throw new ToolError('refresh_required', '该应用存在未确认的变更，写入被锁定(refresh_required)。先 get_app_state 完成完整观察后再操作。', { action_sent: false, state_sync_status: 'refresh_required' })
    }
    const el = st.elements[target.index]
    if (!el) throw new ToolError('index_oob', 'index 越界（该 state 共 ' + st.elements.length + ' 个元素）', { action_sent: false })
    return { st, el }
  }

  function resolveCoordinateTarget(target, field = 'target') {
    if (!target || target.type !== 'coordinate') {
      throw new ToolError('bad_target', field + ' 必须是 coordinate 形态 {type:"coordinate",x,y}', { action_sent: false })
    }
    const x = Math.round(Number(target.x)); const y = Math.round(Number(target.y))
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ToolError('bad_target', '坐标必须是有限数字', { action_sent: false })
    const latest = session.latestFrame()
    const stale = latest && Date.now() > latest.expires_at_ms
    return { x, y, frame: latest, frame_stale: stale }
  }

  /** 变更派发标记：除"确定未发出"的结果外一律按已派发处理。 */
  function markDispatched(pid, result) {
    const notSentCodes = new Set(['unavailable', 'backpressure', 'disposed', 'circuit-open'])
    if (!result || !notSentCodes.has(result.code)) session.markMutationDispatched(pid)
  }

  async function call(op, payload, opts) {
    return sidecar.request(op, payload, opts)
  }

  function wrapErr(e, toolName) {
    if (e instanceof ToolError) {
      let s = '[' + toolName + ' error] code=' + e.code + ': ' + e.message +
        (e.extra.action_sent === false ? ' (action_sent=false)' : '')
      if (e.extra.state_sync_status) s += ' state_sync_status=' + e.extra.state_sync_status
      return s
    }
    return '[' + toolName + ' 失败] ' + (e.message || String(e))
  }

  // ---------- 工具定义 ----------
  const T = []

  function def(name, title, description, inputSchema, handler) {
    T.push({ name, title, description, inputSchema, handler })
  }

  const APP_REF = {
    type: 'object',
    description: '应用定位：{pid} 或 {name}(进程名，如 notepad) 或 {window_id}。Windows 不支持 bundle_id/AUMID。',
  }

  // ======== Observe and resolve ========

  def('request_access', '探测电脑控制可用性',
    '一次性探测电脑控制子系统是否就绪（配置开关、Python worker、依赖、权限面）。只读，不弹任何系统对话框。',
    { capabilities: { type: 'array', description: '要探测的能力名列表（可选）。' } },
    async () => {
      const h = await call('health', {}, {})
      const g = gate()
      const caps = {
        accessibilityTree: !!(h.ok && h.payload.deps.uiautomation),
        screenshot: !!(h.ok && h.payload.deps.pillow),
        inputInjection: h.ok,
      }
      return [
        '[request_access]',
        'status: ' + (h.ok && !g ? 'ready' : 'blocked'),
        'reason: ' + (g || (h.ok ? '-' : workerMsg(h))),
        'capabilities: ' + JSON.stringify(caps),
        'policy_mode: default',
      ].join('\n')
    })

  def('list_apps', '列出可控制的应用',
    '列出当前有可见顶层窗口的应用进程（pid/进程名/标题/active/main window_id）。电脑控制的入口。',
    {},
    async () => {
      requireGate()
      const r = await call('list_apps', {}, {})
      if (!r.ok) throw new ToolError(r.code, workerMsg(r))
      const lines = r.payload.apps.map((a) =>
        'pid=' + a.pid + ' name=' + a.name + (a.active ? ' [active]' : '') + ' main_window_id=' + a.main_window_id + ' "' + a.title.slice(0, 60) + '"')
      return '共 ' + lines.length + ' 个应用：\n' + (lines.join('\n') || '(无)')
    })

  def('open_application', '启动或解析应用',
    '启动应用（name=exe 名/路径/URL；ShellExecute 解析）或解析已在运行的 pid。activate=true 必须 confirm_focus_steal=true 双确认才抢前台。bundle_id 在 Windows 不支持。',
    {
      app: { type: 'object', description: '{name} 或 {pid}。' },
      url: { type: 'string', description: '用系统默认程序打开 URL（可选）。' },
      activate: { type: 'boolean', description: '尝试把新窗口带到前台。' },
      confirm_focus_steal: { type: 'boolean', description: 'activate=true 时必须同时为 true。' },
      new_instance: { type: 'boolean', description: '尽量另起实例（原型尽力而为）。' },
    },
    async (args) => {
      requireGate()
      if (args.app && args.app.bundle_id) throw new ToolError('unsupported', 'Windows 原型不支持 bundle_id(AUMID)，请改用 name 或 pid', { action_sent: false })
      if (args.pid !== undefined || (args.app && args.app.pid !== undefined)) {
        const pid = args.pid ?? args.app.pid
        const lw = await call('list_windows', { sel: { pid } }, {})
        if (!lw.ok) throw new ToolError(lw.code, workerMsg(lw))
        if (!lw.payload.windows.length) return 'pid=' + pid + ' 当前没有可见顶层窗口。'
        return 'pid=' + pid + ' 已在运行：\n' + lw.payload.windows.map((w) =>
          'window_id=' + w.hwnd + ' "' + w.title.slice(0, 70) + '"' + (w.focused ? ' [focused]' : '')).join('\n')
      }
      const target = args.url || (args.app && args.app.name)
      if (!target) throw new ToolError('bad_target', '需要 app.name / app.pid / url 之一', { action_sent: false })
      const isHttpUrl = /^https?:\/\//i.test(String(args.url || target))
      if (isHttpUrl && config().openUrlsIn === 'panel' && typeof queueUrl === 'function') {
        queueUrl(String(args.url || target))
        return 'URL 已在沙箱浏览器面板打开（后台，不占用前台窗口）：' + target +
          '\n（openUrlsIn=system 可改回系统浏览器打开）'
      }
      requireUnscopedAllowed('启动新应用')
      const r = await call('open_app', {
        target,
        activate: !!args.activate,
        confirmFocusSteal: !!args.confirm_focus_steal,
        newInstance: !!args.new_instance,
      }, { timeoutMs: 15000 })
      if (!r.ok) throw new ToolError(r.reason || r.code, workerMsg({ code: 'worker-error', reason: r.reason || r.code, reasonText: r.reasonText }))
      const p = r.payload
      return '已发起启动 ' + p.target + '。new_window_id=' + (p.new_window_id ?? '未知(可能聚焦了已有窗口)') +
        (p.activate_requested ? ' activated=' + p.activated : '') + (p.note ? '\n注意: ' + p.note : '')
    })

  def('list_windows', '列出应用的窗口',
    '列出全部或指定应用的可见顶层窗口：window_id(hwnd)/title/bounds/main/focused。多窗口应用用 window_id 精确观察特定窗口。',
    { app_ref: APP_REF },
    async (args) => {
      requireGate()
      const ar = args.app_ref || {}
      const r = await call('list_windows', { sel: { pid: ar.pid ?? null, name: ar.name || '' } }, {})
      if (!r.ok) throw new ToolError(r.code, workerMsg(r))
      const lines = r.payload.windows.map((w, i) =>
        i + ': window_id=' + w.hwnd + ' pid=' + w.pid + ' "' + w.title.slice(0, 60) + '"' +
        (w.main ? ' main' : '') + (w.focused ? ' focused' : '') + (w.minimized ? ' min' : '') +
        ' bounds=[' + w.bounds.join(',') + ']')
      return lines.join('\n') || '(无匹配窗口)'
    })

  def('get_app_state', '观察应用的无障碍树（核心入口）',
    '读取应用/窗口的 UIA 元素表并颁发 state_id。之后所有元素动作用 {"type":"element","state_id":…,"index":…} 引用。include_screenshot=true 会同时截窗并注册图像帧。',
    {
      app_ref: APP_REF,
      detail: { type: 'string', enum: ['compact', 'full'], description: 'full 附带更多字段。' },
      include_screenshot: { type: 'boolean', description: '同时截取窗口为图像帧。' },
      title: { type: 'string', description: '窗口标题子串（配合 pid 过滤）。' },
    },
    async (args) => {
      requireGate()
      const ar = args.app_ref || {}
      if (ar.bundle_id) throw new ToolError('unsupported', 'Windows 不支持 bundle_id，用 pid/name/window_id', { action_sent: false })
      const sel = {}
      if (ar.window_id !== undefined) sel.hwnd = ar.window_id
      if (ar.pid !== undefined) sel.pid = ar.pid
      if (args.title) sel.title = args.title
      if (sel.hwnd === undefined && sel.pid === undefined && !sel.title && ar.name) {
        // 按进程名解析：list_windows 支持 name 过滤，取第一个窗口的 hwnd 精确观察
        const lw = await call('list_windows', { sel: { name: ar.name } }, {})
        if (!lw.ok) throw new ToolError(lw.code, workerMsg(lw), { action_sent: false })
        const w = (lw.payload.windows || [])[0]
        if (!w) throw new ToolError('window_not_found', '没有找到进程名匹配 ' + ar.name + ' 的可见窗口（可先 list_apps）', { action_sent: false })
        sel.hwnd = w.hwnd
      }
      if (sel.hwnd === undefined && sel.pid === undefined && !sel.title) {
        throw new ToolError('bad_target', 'app_ref 需要 pid/name/window_id 之一（可先 list_apps）', { action_sent: false })
      }
      const rec = await observeRaw(sel)
      // 白名单：观察也是作用域化访问（屏幕内容即数据），拒绝后丢弃缓存
      if ((config().allowedPids || []).length > 0) {
        const reason = pidGate(rec.windowInfo && rec.windowInfo.pid)
        if (reason) {
          session.forgetState(rec.stateId)
          throw new ToolError('pid_blocked', reason, { action_sent: false })
        }
      }
      let out = formatState(rec, args.detail === 'full')
      let newFrameId = null
      if (args.include_screenshot) {
        const shot = await call('screenshot', { mode: 'window', sel, saveDir: config()._artifactsDir, quality: 80 }, {})
        if (shot.ok) {
          const fr = session.issueFrame({
            path: shot.payload.path, width: shot.payload.width, height: shot.payload.height, actionable: true,
          })
          newFrameId = fr.frame_id
          out += '\nframe=' + fr.frame_id + ' path=' + fr.path + ' ' + fr.width + 'x' + fr.height +
            ' (ttl 60s; 坐标只能来自这张图)'
          if (attachFrame) {
            try {
              const a = await attachFrame(fr)
              if (a) out += '\natt=' + a.attachmentId + '|b=' + a.bytes + '|w=' + a.width + '|h=' + a.height
            } catch (_) {}
          }
        } else {
          out += '\n[frame] 截图失败: ' + workerMsg(shot)
        }
      }
      if (afterScreenshot && newFrameId) out = await afterScreenshot(out, newFrameId)
      return out
    })

  def('screenshot', '全屏截图',
    '截取当前选定显示器保存为 JPEG 并注册图像帧（frame_id + 有效期）。zoom 可从该帧裁剪放大。开启识图时响应自动附 [vision] 屏幕内容描述。',
    {},
    async () => {
      requireGate()
      requireUnscopedAllowed('全屏截图')
      const di = session.getSelectedDisplay()
      const r = await call('screenshot', {
        mode: di ? 'display' : 'screen', displayIndex: di,
        saveDir: config()._artifactsDir, quality: 80,
      }, {})
      if (!r.ok) throw new ToolError(r.code, workerMsg(r))
      const fr = session.issueFrame({ path: r.payload.path, width: r.payload.width, height: r.payload.height, actionable: true })
      let out = 'frame=' + fr.frame_id + ' path=' + fr.path + ' ' + fr.width + 'x' + fr.height +
        ' bytes=' + r.payload.bytes + ' display=' + (di || '主屏(virtual)') +
        '\n坐标交互时只允许引用本帧内的整数像素。'
      if (attachFrame) {
        try {
          const a = await attachFrame(fr)
          if (a) out += '\natt=' + a.attachmentId + '|b=' + a.bytes + '|w=' + a.width + '|h=' + a.height
        } catch (_) {}
      }
      if (afterScreenshot) out = await afterScreenshot(out, fr.frame_id)
      return out
    })

  def('zoom', '从已有帧裁剪放大',
    '对最近一次截图帧做区域裁剪生成子帧（不重新截屏）。region=[x0,y0,x1,y1] 为该帧内像素；也可给 element target 直接裁其矩形。',
    {
      region: { type: 'array', description: '[x0,y0,x1,y1]，基于最近帧的像素坐标。与 target 二选一。' },
      target: TARGET_SCHEMA,
      frame_id: { type: 'string', description: '显式源帧（默认最近一帧）。' },
    },
    async (args) => {
      requireGate()
      let srcFrame = args.frame_id ? session.getFrame(args.frame_id) : session.latestFrame()
      if (!srcFrame) throw new ToolError('frame_missing', '没有可用源帧（先 screenshot 或 get_app_state(include_screenshot=true)）', { action_sent: false })
      if (srcFrame.expired) return '[zoom error] 源帧 ' + srcFrame.frame_id + ' 已过期(TTL)。请重新截图。'
      let region = args.region
      if (args.target && args.target.type === 'element') {
        const { st, el } = resolveElementTarget(args.target)
        if (!el.r) throw new ToolError('no_rect', '该元素没有矩形信息', { action_sent: false })
        // 全屏帧 vs 窗口帧坐标系换算：窗口帧以窗口左上为原点
        const off = srcFrame.crop && srcFrame.crop.startsWith('window:') && st.windowInfo.rect
          ? [st.windowInfo.rect[0], st.windowInfo.rect[1]] : [0, 0]
        region = [el.r[0] - off[0], el.r[1] - off[1], el.r[2] - off[0], el.r[3] - off[1]]
      }
      if (!Array.isArray(region) || region.length !== 4) throw new ToolError('bad_region', '需要 region=[x0,y0,x1,y1] 或 element target', { action_sent: false })
      const r = await call('crop', { srcPath: srcFrame.path, region, saveDir: config()._artifactsDir }, {})
      if (!r.ok) throw new ToolError(r.reason || r.code, workerMsg({ code: 'worker-error', reason: r.reason || r.code, reasonText: r.reasonText }))
      const fr = session.issueFrame({ path: r.payload.path, width: r.payload.width, height: r.payload.height, actionable: true, crop: 'child-of:' + srcFrame.frame_id, srcRegion: r.payload.src_region })
      return '子帧 frame=' + fr.frame_id + ' path=' + fr.path + ' ' + fr.width + 'x' + fr.height +
        ' src_region=' + JSON.stringify(r.payload.src_region) + '（子帧内选点即可提交坐标）'
    })

  def('list_displays', '列出显示器',
    '列出显示器：index/bounds/primary。switch_display 切换 screenshot 的捕获目标。',
    {},
    async () => {
      requireGate()
      const r = await call('list_displays', {}, {})
      if (!r.ok) throw new ToolError(r.code, workerMsg(r))
      return r.payload.displays.map((d) =>
        'index=' + d.index + (d.primary ? ' primary' : '') + ' bounds=[' + d.bounds.join(',') + ']').join('\n')
    })

  def('switch_display', '切换截图目标显示器',
    '选择未来 screenshot 捕获的显示器（1-based index）。只影响捕获，不影响指针。',
    { index: { type: 'number', description: 'list_displays 返回的 index。' } },
    async (args) => {
      requireGate()
      const idx = Math.max(1, Math.round(Number(args.index) || 1))
      session.setSelectedDisplay(idx)
      return '未来 screenshot 将捕获显示器 index=' + idx + '。'
    })

  def('cursor_position', '读取指针位置',
    '读取当前全局指针坐标（屏幕点）。',
    {},
    async () => {
      requireGate()
      const r = await call('cursor_pos', {}, {})
      if (!r.ok) throw new ToolError(r.code, workerMsg(r))
      return 'pointer=(' + r.payload.x + ',' + r.payload.y + ')'
    })

  // ======== Pointer ========

  function makePointerTool(name, desc, spec) {
    def(name, spec.title, desc, {
      target: TARGET_SCHEMA,
      strategy: STRATEGY_SCHEMA,
      modifiers: { type: 'array', description: '按住修饰键，如 ["ctrl"] 或 ["ctrl","shift"]。' },
      return_state: RETURN_STATE_SCHEMA,
    }, async (args) => {
      requireGate()
      if (!args.target) throw new ToolError('bad_target', '需要 target（element 或 coordinate）', { action_sent: false })
      const mods = Array.isArray(args.modifiers) ? args.modifiers.filter((m) => typeof m === 'string').slice(0, 3) : []
      let resultPayload
      let scopeSel = null
      if (args.target.type === 'element') {
        if (args.strategy === 'event') throw new ToolError('strategy_conflict', 'element 目标不支持 strategy=event', { action_sent: false })
        const { st, el } = resolveElementTarget(args.target)
        checkPid(st.sel.pid)
        scopeSel = st.sel
        const req = call('element_action', {
          sel: st.sel, path: el.p, action: 'click', button: spec.button || 'left',
          double: !!spec.double, triple: !!spec.triple, modifiers: mods,
          expectT: el.k, expectN: el.n || null,
          expectRid: el.rid || null, expectRect: el.r || null,
          allowFocus: !!(args.allowFocus || !config().preferBackground),
        }, {})
        checkPid(st.sel.pid)
        markDispatched(st.sel.pid, null) // 进入原生调用前冻结
        const r = await req
        markDispatched(st.sel.pid, r)
        if (!r.ok && r.reason === 'needs_foreground') {
          throw new ToolError('needs_foreground',
            '语义动作不可用且目标窗口不在前台。重试传 allowFocus:true（会置前窗口），或改用 set_value 等后台语义工具。',
            { action_sent: false })
        }
        if (!r.ok) throw new ToolError(r.code === 'worker-error' ? r.reason : r.code, workerMsg(r), { ambiguous: r.code === 'timeout' })
        resultPayload = r.payload
      } else {
        if (args.target.type === 'coordinate') requireUnscopedAllowed('坐标' + name)
        const c = resolveCoordinateTarget(args.target)
        const mode = args.strategy === 'a11y' ? 'semantic_only' : (args.strategy === 'event' ? 'raw' : 'auto')
        const req = call('hit_click', {
          x: c.x, y: c.y, button: spec.button || 'left', double: !!spec.double,
          triple: !!spec.triple, modifiers: mods, mode,
        }, {})
        markDispatched(-1, null)
        const r = await req
        markDispatched(-1, r)
        if (!r.ok && r.reason === 'needs_foreground') {
          throw new ToolError('needs_foreground',
            '目标窗口不在前台且语义动作不可用。选项：(1) 重试并传 allowFocus:true（会把窗口带到前台）；'
            + '(2) 改用键盘/Value 语义工具。', { action_sent: false })
        }
        if (!r.ok) throw new ToolError(r.code === 'worker-error' ? r.reason : r.code, workerMsg(r), { ambiguous: r.code === 'timeout' })
        if (mode === 'semantic_only' && r.payload.clicked === false) {
          throw new ToolError('a11y_miss', 'strategy=a11y：坐标处无可按压元素，已 fail-closed 未注入任何输入。改用 auto/event 或重新观察。', { action_sent: false })
        }
        resultPayload = r.payload
        resultPayload.frame_note = c.frame ? ('bound_frame=' + c.frame.frame_id + (c.frame_stale ? ' (stale!)' : '')) : ''
      }
      let out = name + ' 完成: strategy=' + (resultPayload.strategy || []).join('→') +
        (resultPayload.hit ? ' hit=' + JSON.stringify(resultPayload.hit) : '') +
        (resultPayload.point ? ' point=' + JSON.stringify(resultPayload.point) : '') +
        (resultPayload.frame_note ? ' ' + resultPayload.frame_note : '')
      out += '\n旧观察已全部作废（superseded）。'
      out += await postStateBlock(args, scopeSel, scopeSel ? 'compact' : 'none')
      return out
    })
  }

  makePointerTool('left_click', '点击（元素优先）',
    { title: '单击目标', button: 'left', double: false, triple: false })
  makePointerTool('double_click', '双击目标',
    { title: '双击目标', button: 'left', double: true })
  makePointerTool('triple_click', '三击目标',
    { title: '三击目标', button: 'left', triple: true })
  makePointerTool('right_click', '右键目标',
    { title: '右键目标', button: 'right' })
  makePointerTool('middle_click', '中键目标',
    { title: '中键目标', button: 'middle' })

  def('scroll', '滚动',
    '在目标点滚动滚轮。direction up/down/left/right；amount 钳制 1..100。target 必须是 coordinate。',
    {
      target: TARGET_SCHEMA,
      scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      scroll_amount: { type: 'number', description: '滚动量 1..100（钳制）。' },
      strategy: STRATEGY_SCHEMA,
      modifiers: { type: 'array' },
      return_state: RETURN_STATE_SCHEMA,
    },
    async (args) => {
      requireGate()
      requireUnscopedAllowed('坐标滚动')
      const c = resolveCoordinateTarget(args.target)
      const dir = ['up', 'down', 'left', 'right'].includes(args.scroll_direction) ? args.scroll_direction : 'down'
      const amt = Math.max(1, Math.min(100, Math.round(Number(args.scroll_amount) || 3)))
      markDispatched(-1, null)
      const r = await call('scroll', {
        x: c.x, y: c.y, direction: dir, amount: amt, modifiers: Array.isArray(args.modifiers) ? args.modifiers : [],
      }, {})
      markDispatched(-1, r)
      if (!r.ok) throw new ToolError(r.code === 'worker-error' ? r.reason : r.code, workerMsg(r), { ambiguous: r.code === 'timeout' })
      return 'scroll ' + dir + ' x' + amt + ' @(' + c.x + ',' + c.y + ')' + (c.frame ? ' bound_frame=' + c.frame.frame_id : '') +
        '\n旧观察已作废。' + await postStateBlock(args, null, 'none')
    })

  def('left_click_drag', '拖拽',
    '从 from_target 按住左键拖到 to（两端需同 scope；原型支持 coordinate/coordinate 或 element/element）。',
    {
      from_target: TARGET_SCHEMA,
      to: TARGET_SCHEMA,
      modifiers: { type: 'array' },
      return_state: { type: 'string', enum: ['compact', 'full', 'none'] },
    },
    async (args) => {
      requireGate()
      if (args.from_target && args.from_target.type === 'coordinate') requireUnscopedAllowed('坐标拖拽')
      async function pt(t, field) {
        if (t.type === 'coordinate') return resolveCoordinateTarget(t, field)
        const r0 = resolveElementTarget(t)
        const st = r0.st
        const el = r0.el
        checkPid(st.sel.pid)
        if (!el.r) throw new ToolError('no_rect', field + ' 元素无矩形', { action_sent: false })
        return { x: (el.r[0] + el.r[2]) >> 1, y: (el.r[1] + el.r[3]) >> 1 }
      }
      const from = await pt(args.from_target, 'from_target')
      const to = await pt(args.to, 'to')
      markDispatched(-1, null)
      const r = await call('drag', {
        from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y },
        modifiers: Array.isArray(args.modifiers) ? args.modifiers : [],
      }, {})
      markDispatched(-1, r)
      if (!r.ok) throw new ToolError(r.code === 'worker-error' ? r.reason : r.code, workerMsg(r), { ambiguous: r.code === 'timeout' })
      return 'drag (' + from.x + ',' + from.y + ')→(' + to.x + ',' + to.y + ') 完成。\n旧观察已作废。'
    })

  def('mouse_move', '移动指针（不点击）',
    '把虚拟指针移动到 coordinate（悬停）。coordinate only。',
    { coordinate: TARGET_SCHEMA },
    async (args) => {
      requireGate()
      requireUnscopedAllowed('指针移动')
      const c = resolveCoordinateTarget(args.coordinate, 'coordinate')
      const r = await call('mouse_move', { x: c.x, y: c.y }, {})
      if (!r.ok) throw new ToolError(r.code === 'worker-error' ? r.reason : r.code, workerMsg(r))
      return 'pointer→(' + c.x + ',' + c.y + ')'
    })

  def('left_mouse_down', '按住左键（高级）',
    '按下左键保持（配对 left_mouse_up 释放；释放前会话持锁，重复 down 拒绝）。必须先验证目标。',
    { target: TARGET_SCHEMA },
    async (args) => {
      requireGate()
      if (session.inputState.leftMouseDown) throw new ToolError('already_held', '左键已被本会话按住，先 left_mouse_up', { action_sent: false })
      const t = args.target
      if (t && t.type === 'coordinate') requireUnscopedAllowed('按住左键(坐标)')
      let x; let y
      if (t && t.type === 'coordinate') { const c = resolveCoordinateTarget(t); x = c.x; y = c.y } else if (t && t.type === 'element') { const r0 = resolveElementTarget(t); checkPid(r0.st.sel.pid); if (!r0.el.r) throw new ToolError('no_rect', '元素无矩形', { action_sent: false }); x = (r0.el.r[0] + r0.el.r[2]) >> 1; y = (r0.el.r[1] + r0.el.r[3]) >> 1 } else throw new ToolError('bad_target', '需要 target', { action_sent: false })
      markDispatched(-1, null)
      const r = await call('mouse_button_event', { action: 'down', x, y }, {})
      markDispatched(-1, r)
      if (!r.ok) throw new ToolError(r.code, workerMsg(r))
      session.inputState.leftMouseDown = true
      return '左键已在 (' + x + ',' + y + ') 按下。务必随后 left_mouse_up 释放。'
    })

  def('left_mouse_up', '释放左键',
    '释放本会话持有的左键。未按下时调用会被拒绝（防误放用户鼠标）。',
    {},
    async () => {
      requireGate()
      if (!session.inputState.leftMouseDown) throw new ToolError('not_held', '本会话没有按住的左键', { action_sent: false })
      const r = await call('mouse_button_event', { action: 'up' }, {})
      if (!r.ok) throw new ToolError(r.code, workerMsg(r))
      session.inputState.leftMouseDown = false
      return '左键已释放。建议重新 get_app_state 验证拖放结果。'
    })

  // ======== Text and keyboard ========

  def('type', '输入文本',
    '向 editable 元素输入文本（element target 推荐：聚焦+注入 Unicode）。无 target/app_ref 一律拒绝（防止打错地方）。app_ref 方式要求目标窗口前台。',
    {
      text: { type: 'string', description: '要输入的文本（支持中文/emoji）。' },
      target: TARGET_SCHEMA,
      app_ref: APP_REF,
      strategy: STRATEGY_SCHEMA,
    },
    async (args) => {
      requireGate()
      const text = String(args.text ?? '')
      if (!text) throw new ToolError('bad_args', 'text 不能为空', { action_sent: false })
      if (args.target && args.target.type === 'element') {
        const { st, el } = resolveElementTarget(args.target)
        checkPid(st.sel.pid)
        markDispatched(st.sel.pid, null)
        const r = await call('element_action', {
          sel: st.sel, path: el.p, action: 'typetext', value: text, allowFocus: !!(args.allowFocus || !config().preferBackground), expectT: el.k, expectN: el.n || null,
          expectRid: el.rid || null, expectRect: el.r || null,
        }, {})
        markDispatched(st.sel.pid, r)
        if (!r.ok) throw new ToolError(r.code === 'worker-error' ? r.reason : r.code, workerMsg(r), { ambiguous: r.code === 'timeout' })
        return 'type 完成: strategy=' + (r.payload.strategy || []).join('→') + '\n旧观察已作废。' +
          await postStateBlock(args, st.sel, 'compact')
      }
      if (args.target && args.target.type === 'coordinate') {
        requireUnscopedAllowed('坐标定位输入')
        const c = resolveCoordinateTarget(args.target)
        markDispatched(-1, null)
        await call('hit_click', { x: c.x, y: c.y, mode: 'raw' }, {})
        const r = await call('type', { text }, {})
        markDispatched(-1, r)
        if (!r.ok) throw new ToolError(r.code === 'worker-error' ? r.reason : r.code, workerMsg(r), { ambiguous: true })
        return 'type 完成（coordinate 定位焦点后注入）。\n旧观察已作废。'
      }
      if (args.app_ref) {
        await ensureFrontmost(args.app_ref)
        const r = await call('type', { text }, {})
        if (!r.ok) throw new ToolError(r.code === 'worker-error' ? r.reason : r.code, workerMsg(r), { ambiguous: true })
        return 'type 完成（app_ref 前台注入 ' + text.length + ' 字符）。'
      }
      throw new ToolError('targetless_refused', '无目标的 type 被拒绝。提供 element target（推荐）、coordinate 或 app_ref。', { action_sent: false })
    })

  async function ensureFrontmost(appRef) {
    const lw = await call('list_windows', { sel: { pid: appRef.pid ?? null, name: appRef.name || '' } }, {})
    if (!lw.ok) throw new ToolError(lw.code, workerMsg(lw), { action_sent: false })
    if ((config().allowedPids || []).length > 0) {
      const pidToCheck = appRef.pid !== undefined ? appRef.pid : ((lw.payload.windows || [])[0] || {}).pid
      const reason = pidGate(pidToCheck)
      if (reason) throw new ToolError('pid_blocked', reason, { action_sent: false })
    }
    const focused = (lw.payload.windows || []).some((w) => w.focused)
    if (!focused) {
      throw new ToolError('not_frontmost', '目标窗口不在前台，Windows 无法安全后台注入键盘。先 open_application(activate=true, confirm_focus_steal=true)，或改用 element target。', { action_sent: false })
    }
  }

  def('set_value', '语义设置控件值',
    '直接通过 UIA ValuePattern 设置控件值（后台安全、不动真实键盘）。注意：对单行输入是替换整个字段值；对多行 Document 控件自动回退为插入语义。element target only。',
    { target: TARGET_SCHEMA, value: { type: 'string', description: '目标值。' }, strategy: STRATEGY_SCHEMA, return_state: RETURN_STATE_SCHEMA },
    async (args) => {
      requireGate()
      const { st, el } = resolveElementTarget(args.target)
      checkPid(st.sel.pid)
        markDispatched(st.sel.pid, null)
      const r = await call('element_action', {
        sel: st.sel, path: el.p, action: 'setvalue', value: String(args.value ?? ''), allowFocus: !!(args.allowFocus || !config().preferBackground),
        expectT: el.k, expectN: el.n || null,
          expectRid: el.rid || null, expectRect: el.r || null,
      }, {})
      markDispatched(st.sel.pid, r)
      if (!r.ok) throw new ToolError(r.code === 'worker-error' ? r.reason : r.code, workerMsg(r), { ambiguous: r.code === 'timeout' })
      return 'set_value 完成: strategy=' + (r.payload.strategy || []).join('→') + '\n旧观察已作废。' +
        await postStateBlock(args, st.sel, 'compact')
    })

  def('select_text', '选择文本范围',
    '在元素内选择文本 [start,length]（键盘光标法）或仅放置光标（省略 text_range）。element target only。start≤5000, length≤2000。',
    { target: TARGET_SCHEMA, text_range: { type: 'array', description: '[start,length]。' } },
    async (args) => {
      requireGate()
      const { st, el } = resolveElementTarget(args.target)
      checkPid(st.sel.pid)
        markDispatched(st.sel.pid, null)
      const r = await call('select_text', {
        sel: st.sel, path: el.p, textRange: args.text_range || null, expectT: el.k, expectN: el.n || null,
        expectRid: el.rid || null, expectRect: el.r || null,
          expectRid: el.rid || null, expectRect: el.r || null,
      }, {})
      markDispatched(st.sel.pid, r)
      if (!r.ok) throw new ToolError(r.code === 'worker-error' ? r.reason : r.code, workerMsg(r), { ambiguous: r.code === 'timeout' })
      return 'select_text 完成: strategy=' + (r.payload.strategy || []).join('→')
    })

  def('key', '发送组合键',
    '发送键序列（如 "ctrl+c"、"enter"，Windows 用 ctrl 不是 cmd）。repeat 1..100。带 app_ref 时要求目标前台，否则拒绝。',
    {
      text: { type: 'string', description: '加号连接的键序列。' },
      repeat: { type: 'number', description: '重复次数。' },
      app_ref: APP_REF,
    },
    async (args) => {
      requireGate()
      if (!args.text) throw new ToolError('bad_args', 'text 不能为空，如 "ctrl+c"', { action_sent: false })
      if (args.app_ref) await ensureFrontmost(args.app_ref)
      const rep = Math.max(1, Math.min(100, Math.round(Number(args.repeat) || 1)))
      markDispatched(-1, null)
      const r = await call('key', { keys: args.text, repeat: rep }, {})
      markDispatched(-1, r)
      if (!r.ok) throw new ToolError(r.code === 'worker-error' ? r.reason : r.code, workerMsg(r), { ambiguous: r.code === 'timeout' })
      return 'key ' + args.text + (rep > 1 ? ' ×' + rep : '') + ' 已发送。受影响的窗口操作前请重新观察。'
    })

  def('hold_key', '按住组合键一段时长',
    '按住键序列 duration 秒（钳制 0..30s）。带 app_ref 要求前台。',
    { text: { type: 'string' }, duration: { type: 'number', description: '秒，0..30。' }, app_ref: APP_REF },
    async (args) => {
      requireGate()
      if (!args.text) throw new ToolError('bad_args', 'text 不能为空', { action_sent: false })
      if (args.app_ref) await ensureFrontmost(args.app_ref)
      const durMs = Math.round(Math.max(0, Math.min(30, Number(args.duration) || 0)) * 1000)
      if (durMs <= 0) throw new ToolError('bad_args', 'duration 必须大于 0 秒', { action_sent: false })
      markDispatched(-1, null)
      const r = await call('hold', { keys: args.text, durationMs: durMs }, { timeoutMs: durMs + 15000 })
      markDispatched(-1, r)
      if (!r.ok) throw new ToolError(r.code === 'worker-error' ? r.reason : r.code, workerMsg(r), { ambiguous: r.code === 'timeout' })
      return '已按住 ' + args.text + ' ' + (durMs / 1000) + 's 并释放。'
    })

  // ======== Semantic ========

  def('perform_action', '执行元素的命名无障碍动作',
    '对该元素执行其能力集内的命名动作：click/invoke/toggle/expand/collapse/select/setvalue/focus/rect。只执行元素实际支持的动作。',
    { target: TARGET_SCHEMA, action: { type: 'string', description: '命名动作。' }, value: { type: 'string', description: 'setvalue 时的值。' }, return_state: RETURN_STATE_SCHEMA },
    async (args) => {
      requireGate()
      const allowed = ['click', 'invoke', 'toggle', 'expand', 'collapse', 'select', 'setvalue', 'focus', 'rect']
      if (!allowed.includes(args.action)) throw new ToolError('bad_action', 'action 只支持: ' + allowed.join('/'), { action_sent: false })
      const { st, el } = resolveElementTarget(args.target)
      checkPid(st.sel.pid)
        markDispatched(st.sel.pid, null)
      const r = await call('element_action', {
        sel: st.sel, path: el.p, action: args.action, value: args.value, allowFocus: !!(args.allowFocus || !config().preferBackground),
        expectT: el.k, expectN: el.n || null,
          expectRid: el.rid || null, expectRect: el.r || null,
      }, {})
      markDispatched(st.sel.pid, r)
      if (!r.ok) throw new ToolError(r.code === 'worker-error' ? r.reason : r.code, workerMsg(r), { ambiguous: r.code === 'timeout' })
      return 'perform_action ' + args.action + ' 完成: strategy=' + (r.payload.strategy || []).join('→') + '\n旧观察已作废。' +
        await postStateBlock(args, st.sel, 'compact')
    })

  // ======== Runtime ========

  def('stop_computer_control', '紧急停止电脑控制（kill switch）',
    '立即持久停止：之后所有工具拒绝执行直到人工清理配置并重启 harness。用于失控/误操作风险。',
    { reason: { type: 'string', description: '停止原因（记录用）。' } },
    async (args) => {
      const msg = await deps.killSwitch(String(args.reason || ''))
      session.clearAll()
      return msg
    })

  def('wait', '等待',
    '暂停 0..30 秒（等待加载），然后应重新观察。不影响任何窗口。',
    { duration: { type: 'number', description: '秒，0..30。' } },
    async (args) => {
      requireGate()
      const sec = Math.max(0, Math.min(30, Number(args.duration) || 1))
      await new Promise((done) => setTimeout(done, sec * 1000))
      return '已等待 ' + sec + 's。继续操作前请 get_app_state 刷新。'
    })

  def('read_clipboard', '读剪贴板',
    '读取系统剪贴板文本（只读）。',
    {},
    async () => {
      requireGate()
      requireUnscopedAllowed('读取剪贴板')
      const r = await call('clipboard_read', {}, {})
      if (!r.ok) throw new ToolError(r.reason || r.code, workerMsg({ code: 'worker-error', reason: r.reason || r.code, reasonText: r.reasonText }))
      if (r.payload.text === null) return '剪贴板当前是 ' + (r.payload.format || 'empty') + '，无文本。'
      return '剪贴板文本（' + r.payload.length + ' chars）：\n' + String(r.payload.text).slice(0, 4000)
    })

  def('write_clipboard', '写剪贴板',
    '写入文本到系统剪贴板（会覆盖用户当前剪贴板内容——仅在任务明确需要时使用）。',
    { text: { type: 'string' } },
    async (args) => {
      requireGate()
      requireUnscopedAllowed('写入剪贴板')
      const r = await call('clipboard_write', { text: String(args.text ?? '') }, {})
      if (!r.ok) throw new ToolError(r.reason || r.code, workerMsg({ code: 'worker-error', reason: r.reason || r.code, reasonText: r.reasonText }))
      return '已写入 ' + r.payload.length + ' chars 到剪贴板。'
    })

  return T
}
