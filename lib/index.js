/**
 * dsh-cua-pre — host half v3（呈现端对齐 zcode-cua + vision 识图）。
 *
 * 三层镜像 zcode-cua MCP 连接器（工具/状态机/worker），本版新增：
 *   - 对话卡片：每个工具带 presentCall/presentResult（GenericCallView/GenericResultView），
 *     点击/滚动/键入等以卡片标题+结构化摘要呈现在会话流里
 *   - 操作审计环形缓冲：每次工具调用记录 {tool,args,结果摘要,耗时,ok}，供侧栏实时展示
 *   - webServer 路由(loopback-only)：state / config(读写) / ops / frames / frame-file(画面)
 *   - vision 识图：screenshot 与 get_app_state(include_screenshot) 在开启时自动分块裁切+
 *     子代理 VLM 描述，响应附 [vision] 区块；帧元数据记录描述与附件 id
 *
 * 安全不变：默认关闭；stop_computer_control 持久 kill switch；路由仅回环。
 */

import { readFile, writeFile, stat, appendFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileP = promisify(execFile)
import { homedir, platform } from 'node:os'
import path from 'node:path'
import { createCuaSidecarClientPre, defaultWorkerScriptPathPre } from './cua-sidecar-client-pre.js'
import { createCuaSessionPre } from './cua-session-pre.js'
import { createCuaToolsPre } from './cua-tools-pre.js'
import { createCuaVisionPre } from './cua-vision-pre.js'

/** Stable cordis plugin name. */
export const name = 'cua-host-pre'

export const inject = ['tools', 'systemPrompt', 'webServer']

/**
 * SKILL 化使用纪律（浓缩自 zcode-cua SKILL.md，字节级稳定）。
 */
export const GUIDANCE = [
  '[dsh-cua-pre 电脑控制] 已启用桌面自动化工具面。核心循环=观察一次→动作一次→验证：',
  '1. request_access 探测就绪；list_apps 找应用；get_app_state 读无障碍树获得 state_id（主路径，语义精确、不抢焦点、无需截图）。目标一律用 {type:"element",state_id,index}。',
  '2. 仅当无障碍表达不了目标才截图（screenshot / get_app_state include_screenshot），坐标只能取自最近返回帧的整数像素 {type:"coordinate",x,y}；zoom 裁剪放大不重截。坐标动作 strategy 默认 auto（先无障碍命中）；a11y=够不到即拒绝；event=强制裸输入，仅限无障碍不可用时。',
  '3. 动作后旧 state 全部作废(superseded)+写入锁(refresh_required)：必须重新 get_app_state 才能再写。响应可能自带重观察结果(return_state)。',
  '4. action_sent 纪律：预检失败=未发生可安全重试；timeout/crashed=可能已发生——先重新观察确认实际状态，绝不原样重放非幂等操作（发送/删除/支付）。',
  '5. 键盘：key 用 ctrl（Windows 无 cmd）；无目标的 type/key 被拒绝；app_ref 方式要求目标窗口前台，否则先 open_application(activate=true,confirm_focus_steal=true) 双确认。',
  '6. 最小动作纪律：只执行用户明确要求的操作；付款/删除/外发前必须向用户复述确认。失控时立即 stop_computer_control（持久生效直到人工恢复）。',
].join('\n')

const GUIDANCE_VISION = '7. 识图已启用：screenshot / get_app_state(include_screenshot) 的响应附 [vision] 屏幕内容描述（低分辨率模型自动分块裁切保细节）；描述仅供参考，操作定位仍以无障碍元素为准。\n'

const DEFAULT_CONFIG = {
  enabled: false,
  pythonExecutable: 'python',
  workerPath: '',
  artifactsDir: '~/.dsh/cua-pre/artifacts',
  maxObserveElements: 300,
  observeMaxDepth: 7,
  requestTimeoutMs: 20000,
  maxStates: 16,
  frameTtlMs: 60000,
  toolNamePrefix: '',
  // ---- vision ----
  visionEnabled: false,
  visionModel: '',
  visionAutoDescribe: true,
  tileMaxPx: 768,
  tileOverlapPx: 64,
  visionMaxTiles: 4,
  visionTimeoutMs: 90000,
  // ---- pid 白名单 ----
  allowedPids: [],
  whitelistRelaxed: false,
}

function expandHome(p) {
  const s = String(p || '')
  if (s === '~') return homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(homedir(), s.slice(2))
  return s
}

async function loadConfig() {
  const file = process.env.DSH_HOME
    ? path.join(process.env.DSH_HOME, 'cua-pre.json')
    : path.join(homedir(), '.dsh', 'cua-pre.json')
  const cfg = { ...DEFAULT_CONFIG }
  try {
    const obj = JSON.parse(await readFile(file, 'utf8'))
    for (const k of Object.keys(DEFAULT_CONFIG)) if (obj[k] !== undefined) cfg[k] = obj[k]
    if (typeof obj.stoppedByUser === 'boolean') cfg.stoppedByUser = obj.stoppedByUser
    cfg._file = file
  } catch (_) {
    cfg._file = file
  }
  cfg._artifactsDir = expandHome(cfg.artifactsDir)
  return cfg
}

// ---------- 小工具 ----------
function writeJson(res, code, obj) {
  try {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  } catch (_) {}
}
function isLoopbackRequest(req) {
  const address = req.socket && req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === 'ffff:127.0.0.1' ||
    address === '::ffff:127.0.0.1'
}
async function readJsonBody(req, cap = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > cap) throw new Error('body too large')
    chunks.push(c)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

/** 目标的可读摘要（presentCall 卡片标题用；纯函数）。 */
function describeTarget(t) {
  if (!t) return '(无目标)'
  if (t.type === 'element') {
    const idx = t.index !== undefined ? '#' + t.index : ''
    return 'element ' + (t.state_id || '?') + idx
  }
  if (t.type === 'coordinate') return '@(' + t.x + ',' + t.y + ')'
  return JSON.stringify(t).slice(0, 40)
}

/** 各工具的卡片标题构建器（纯函数，仅依赖 args）。 */
function callTitleFor(toolName, args) {
  const a = args || {}
  switch (toolName) {
    case 'left_click': case 'double_click': case 'triple_click':
    case 'right_click': case 'middle_click': {
      const zh = { left_click: '单击', double_click: '双击', triple_click: '三击', right_click: '右击', middle_click: '中击' }[toolName]
      return zh + ' ' + describeTarget(a.target)
    }
    case 'scroll': return '滚动 ' + (a.scroll_direction === 'up' ? '↑' : a.scroll_direction === 'down' ? '↓' : a.scroll_direction === 'left' ? '←' : '→') + ' ×' + (a.scroll_amount || 3)
    case 'left_click_drag': return '拖拽 ' + describeTarget(a.from_target) + ' → ' + describeTarget(a.to)
    case 'mouse_move': return '移针 ' + describeTarget(a.coordinate)
    case 'type': return '输入 ' + String(a.text || '').length + ' 字 → ' + (a.target ? describeTarget(a.target) : a.app_ref ? 'app' : '?')
    case 'set_value': return '设值 → ' + describeTarget(a.target)
    case 'select_text': return '选区 ' + (a.text_range ? '[' + a.text_range.join(',') + ']' : '光标') + ' @ ' + describeTarget(a.target)
    case 'key': return '按键 ' + (a.text || '')
    case 'hold_key': return '按住 ' + (a.text || '') + ' ' + (a.duration || 0) + 's'
    case 'perform_action': return (a.action || '?') + ' @ ' + describeTarget(a.target)
    case 'get_app_state': {
      const ar = a.app_ref || {}
      return '观察 ' + (ar.window_id ? ('hwnd=' + ar.window_id) : ar.pid ? ('pid=' + ar.pid) : (ar.name || a.title || '')) +
        (a.include_screenshot ? ' +截图' : '')
    }
    case 'screenshot': return '截屏'
    case 'zoom': return 'zoom ' + (Array.isArray(a.region) ? '[' + a.region.join(',') + ']' : describeTarget(a.target))
    case 'open_application': return '启动 ' + ((a.app && a.app.name) || a.url || (a.app && a.app.pid) || '?')
    case 'list_apps': return '列出应用'
    case 'list_windows': return '列出窗口'
    case 'list_displays': return '显示器列表'
    case 'switch_display': return '切换显示器 #' + (a.index || 1)
    case 'cursor_position': return '指针位置'
    case 'request_access': return '探测就绪'
    case 'stop_computer_control': return '⛔ 紧急停止'
    case 'wait': return '等待 ' + (a.duration || 1) + 's'
    case 'read_clipboard': return '读剪贴板'
    case 'write_clipboard': return '写剪贴板 ' + String(a.text || '').length + ' 字'
    default: return toolName
  }
}

export function apply(ctx) {
  let config = null
  let stoppedByUserPersisted = false
  // 设置页保存的即时生效覆盖层（同时持久化到文件；重启后由 loadConfig 承接）
  const overrides = {}
  const effConfig = () => Object.assign({}, config || {}, overrides)
  let lastAgent = null

  const sidecar = createCuaSidecarClientPre({
    command: () => String(config.pythonExecutable || 'python'),
    scriptPath: () => {
      const p = String(config.workerPath || '').trim()
      return p || defaultWorkerScriptPathPre()
    },
    requestTimeoutMs: () => Number(config.requestTimeoutMs) || DEFAULT_CONFIG.requestTimeoutMs,
  })
  const session = createCuaSessionPre({ maxStates: () => (config && Number(config.maxStates)) || undefined })
  const vision = createCuaVisionPre({
    sidecar,
    session,
    getConfig: () => config,
    getAttachments: () => { try { return ctx.get('attachments') } catch (_) { return null } },
    getSubagents: () => { try { return ctx.get('subagents') } catch (_) { return null } },
    getLastAgent: () => lastAgent,
  })

  function gate() {
    if (!config) return '插件配置尚未加载完成，请稍后重试。'
    if (platform() !== 'win32') return '本插件原型仅支持 Windows（UIA/SendInput）。'
    if (!effConfig().enabled) return '电脑控制当前未启用。请在 ' + config._file + ' 写入 {"enabled": true} 后重启 dsh web（默认关闭是安全设计）。'
    if (stoppedByUserPersisted) return '电脑控制已被 stop_computer_control 紧急停止且持久生效（防循环失控）。恢复：删除 ' + config._file + ' 的 stoppedByUser 字段并重启 dsh web。'
    return null
  }

  async function killSwitch(reason) {
    if (!config || !config._file) return '电脑控制尚未完成初始化，无需停止。'
    try {
      const raw = await readFile(config._file, 'utf8').catch(() => '{}')
      const obj = JSON.parse(raw)
      obj.stoppedByUser = true
      await writeFile(config._file, JSON.stringify(obj, null, 2), 'utf8')
    } catch (_) { /* 配置不可写也照停（内存态已停） */ }
    stoppedByUserPersisted = true
    sidecar.restart('stop_computer_control' + (reason ? ': ' + reason : ''))
    session.clearAll()
    return '电脑控制已紧急停止并持久化' + (reason ? '（原因: ' + reason + '）' : '') +
      '。所有工具现在拒绝执行。恢复方法：删除 ' + config._file + ' 中 stoppedByUser 字段并重启 dsh web。'
  }

  // ---------- pid 白名单门禁 ----------
  function pidGate(pid) {
    const c = effConfig()
    const list = Array.isArray(c.allowedPids) ? c.allowedPids.map(Number).filter(Number.isFinite) : []
    if (!list.length) return null
    if (pid === null || pid === undefined || !Number.isFinite(Number(pid))) return null
    return list.includes(Number(pid))
      ? null
      : '目标 pid=' + pid + ' 不在白名单 [' + list.join(',') + '] 内（设置页可修改，立即生效）。'
  }

  // ---------- 卡片嵌图：帧 → 持久附件 ref ----------
  async function attachFrameForCard(fr) {
    if (!fr || !fr.path) return null
    if (fr.cardAttachment) return fr.cardAttachment
    let attachments = null
    try { attachments = ctx.get('attachments') } catch (_) { return null }
    if (!attachments || typeof attachments.saveImage !== 'function') return null
    try {
      const bytes = await readFile(fr.path)
      const ref = await attachments.saveImage({
        data: new Uint8Array(bytes),
        mediaType: 'image/jpeg',
        name: 'cua-card-' + (fr.frame_id || ''),
      })
      const info = { attachmentId: ref.attachmentId, mediaType: ref.mediaType || 'image/jpeg', bytes: ref.bytes, width: ref.width, height: ref.height }
      session.annotateFrame(fr.frame_id, { cardAttachment: info })
      return info
    } catch (_) { return null }
  }

  /** 截图后自动识图：把 [vision] 区块追加到响应文本并记进帧元数据。 */
  async function maybeAppendVision(outText, frameId) {
    const fr = session.getFrame(frameId)
    if (!fr) return outText
    // 帧级去重：同一帧已有描述（含 zoom 子帧继承场景）不再重复调 VLM
    if (fr.visionDescription) return outText + '\n[vision] (复用本帧已有描述)'
    const r = await vision.describeFrame({ ...fr, frame_id: frameId }, 'auto')
    if (r.error) {
      session.annotateFrame(frameId, { visionError: r.error })
      return outText + '\n[vision] 描述不可用: ' + r.error
    }
    session.annotateFrame(frameId, { visionDescription: r.description, visionTiles: r.tiles, attachmentIds: (r.refs || []).map((x) => x.attachmentId) })
    return outText + '\n[vision] 屏幕内容描述（' + r.tiles + ' 块）：\n' + r.description
  }

  // ---------- 组装 30 个 MCP 形态工具 ----------
  const tools = createCuaToolsPre({
    sidecar,
    session,
    get config() { return effConfig() },
    gate,
    killSwitch,
    attachFrame: attachFrameForCard,
    pidGate,
    afterScreenshot: async (outText, frameId) => {
      try {
        const c = effConfig()
        if (c.visionEnabled && c.visionAutoDescribe && frameId) {
          return await maybeAppendVision(outText, frameId)
        }
      } catch (_) {}
      return outText
    },
  })

  // ---------- 操作审计环形缓冲 ----------
  const opLog = []
  const OP_LOG_CAP = 200
  const auditChain = { p: Promise.resolve() }
  function recordOp(entry) {
    opLog.push(entry)
    while (opLog.length > OP_LOG_CAP) opLog.shift()
    // 审计落盘：JSONL 按天追加，失败静默不影响主链路
    auditChain.p = auditChain.p.then(async () => {
      try {
        const dir = path.join(effConfig()._artifactsDir || expandHome(DEFAULT_CONFIG.artifactsDir), 'audit')
        await mkdir(dir, { recursive: true })
        const day = new Date(entry.ts).toISOString().slice(0, 10)
        await appendFile(path.join(dir, day + '.jsonl'), JSON.stringify(entry) + '\n', 'utf8')
      } catch (_) {}
    })
  }

  /** cordis 注册；撞名时回退前缀名（默认 cua_）。 */
  function registerWithFallback() {
    const registeredNames = []
    for (const t of tools) {
      const schema = t.inputSchema || { type: 'object', properties: {} }
      const def = {
        name: (config.toolNamePrefix || '') + t.name,
        description: t.description,
        parameters: schema,
        output: {
          schema: { type: 'string' },
          render(_args, value) { return [{ type: 'text', text: String(value) }] },
          // 纯投影：从返回文本解析卡片附件标记 att=<id>|b=<bytes>|w=<w>|h=<h>，随会话日志持久化
          presentationMeta: (_args, value) => {
            const m = String(value).match(/att=(sha256:[0-9a-f]+)\|b=(\d+)\|w=(\d+)\|h=(\d+)/)
            if (!m) return undefined
            return { image: { attachmentId: m[1], mediaType: 'image/jpeg', bytes: Number(m[2]), width: Number(m[3]), height: Number(m[4]) } }
          },
        },
        // 会话卡片（provider-neutral render intent）：标题来自 args（纯函数，replay 安全）
        presentCall: (args) => ({
          card: 'generic',
          title: callTitleFor(t.name, args),
          kind: ['get_app_state', 'screenshot', 'zoom', 'read_clipboard', 'cursor_position', 'list_apps', 'list_windows', 'list_displays'].includes(t.name) ? 'read' : 'other',
          rawInput: undefined,
        }),
        presentResult: (args, result) => {
          try {
            const text = (result.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
            const firstLine = text.split('\n').find((l) => l.trim()) || ''
            const content = []
            // 卡片嵌图：meta 由 presentationMeta 持久化投影而来（replay 安全）。UI-facing，
            // 不进模型上下文——模型侧仍只读 render() 的纯文本。
            const img = result && result.meta && result.meta.image
            if (img && !result.isError && img.attachmentId) {
              content.push({ type: 'image', attachment: { attachmentId: img.attachmentId, mediaType: img.mediaType || 'image/jpeg', bytes: img.bytes || 0, width: img.width || 0, height: img.height || 0 } })
            }
            content.push({ type: 'text', text: (result.isError ? '✗ ' : '✓ ') + firstLine.slice(0, 220) })
            return { card: 'generic', title: callTitleFor(t.name, args), content }
          } catch (_) { return undefined }
        },
        async execute(args, exec) {
          const started = Date.now()
          try {
            if (exec && exec.agent) lastAgent = exec.agent
            const out = await t.handler(args || {})
            recordOp({
              ts: started, tool: t.name,
              title: callTitleFor(t.name, args || {}),
              ok: !/\berror\]/.test(String(out).slice(0, 80)),
              brief: String(out).split('\n')[0].slice(0, 220),
              ms: Date.now() - started,
            })
            return out
          } catch (e) {
            recordOp({ ts: started, tool: t.name, title: callTitleFor(t.name, args || {}), ok: false, brief: (e.message || String(e)).slice(0, 200), ms: Date.now() - started })
            const msg = e && e.message ? e.message : String(e)
            const sentFalse = e && e.extra && e.extra.action_sent === false
            return '[' + t.name + ' error] code=' + (e.code || 'internal') + ': ' + msg + (sentFalse ? ' (action_sent=false)' : '')
          }
        },
      }
      try {
        ctx.tools.register(def)
        registeredNames.push(def.name)
      } catch (_) {
        try {
          def.name = 'cua_' + t.name
          ctx.tools.register(def)
          registeredNames.push(def.name)
        } catch (e2) {
          console.error('[dsh-cua-pre] 无法注册工具 ' + t.name + ': ' + (e2.message || e2))
        }
      }
    }
    return registeredNames
  }

  // ---------- systemPrompt 注入 ----------
  const disposeSection = ctx.systemPrompt.section({
    name: 'dsh:cua-host-pre-rules',
    order: 9900,
    text: () => {
      try {
        if (!config || stoppedByUserPersisted || !effConfig().enabled) return ''
        return GUIDANCE + (effConfig().visionEnabled && effConfig().visionAutoDescribe ? GUIDANCE_VISION : '')
      } catch (_) { return '' }
    },
  })

  // ---------- webServer 路由（loopback-only） ----------
  const API = {
    state: '/api/dsh-cua-pre/state',
    config: '/api/dsh-cua-pre/config',
    ops: '/api/dsh-cua-pre/ops',
    frames: '/api/dsh-cua-pre/frames',
    'frame-file': '/api/dsh-cua-pre/frame-file',
    describe: '/api/dsh-cua-pre/describe',
    detect: '/api/dsh-cua-pre/detect',
    'install-deps': '/api/dsh-cua-pre/install-deps',
    bootstrap: '/api/dsh-cua-pre/bootstrap',
  }

  function framesSnapshot() {
    const out = []
    for (const fid of session.listFrameIds()) {
      const f = session.getFrame(fid)
      if (!f) continue
      out.push({
        frame_id: f.frame_id, width: f.width, height: f.height,
        created_at_ms: f.created_at_ms, expired: !!f.expired,
        crop: f.crop || null,
        vision_description: f.visionDescription || null,
        vision_error: f.visionError || null,
        attachment_ids: f.attachmentIds || [],
      })
    }
    return out.sort((x, y) => y.created_at_ms - x.created_at_ms)
  }

  // ---------- 环境自动检测（Python / worker / 视觉模型） ----------
  const VISION_RE = /(vl|vision|omni|multimodal|gemini|claude|gpt-4|gpt-5|qwen[\w-]*vl|glm-4v|glm-[45][\w-]*v\b|pixtral|llava|internvl|doubao[\w-]*vision|o[134])/i
  const detectCache = { pythons: null, at: 0 }
  async function probePython(pyPath, args) {
    return new Promise((resolve) => {
      let done = false
      const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false }) } }, 8000)
      try {
        execFile(pyPath, args, { timeout: 7500, windowsHide: true }, (err, stdout) => {
          if (done) return
          done = true; clearTimeout(t)
          resolve({ ok: !err, out: String(stdout || '').trim() })
        })
      } catch (_) { if (!done) { done = true; clearTimeout(t); resolve({ ok: false }) } }
    })
  }
  async function detectPythons() {
    const dshHome = (process.env.DSH_HOME && process.env.DSH_HOME.trim()) ? process.env.DSH_HOME.trim() : path.join(homedir(), '.dsh')
    const cands = [
      { path: path.join(dshHome, 'cua-pre', '.venv', 'Scripts', 'python.exe'), label: 'DSH 专用 venv（推荐）' },
      { path: path.join(path.dirname(defaultWorkerScriptPathPre()), '..', '.venv', 'Scripts', 'python.exe'), label: '插件目录 venv' },
      { path: 'python', label: '系统 PATH：python' },
      { path: 'python3', label: '系统 PATH：python3' },
    ]
    const out = []
    for (const c of cands) {
      const p2 = String(c.path)
      if (p2.includes('\\') || p2.includes('/')) {
        if (!existsSync(p2)) { out.push({ label: c.label, path: p2, status: 'missing' }); continue }
      }
      const base = await probePython(p2, ['-c', 'print("py-ok")'])
      if (!base.ok || base.out.indexOf('py-ok') === -1) { out.push({ label: c.label, path: p2, status: 'missing' }); continue }
      const deps = await probePython(p2, ['-c', 'import uiautomation, PIL; print("deps-ok")'])
      out.push({ label: c.label, path: p2, status: (deps.ok && deps.out.indexOf('deps-ok') !== -1) ? 'ready' : 'no-deps' })
    }
    return out
  }
  async function detectModels() {
    let llm = null
    try { llm = ctx.get('llm') } catch (_) {}
    if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
      return { unsupported: true, providers: [] }
    }
    const providers = []
    await Promise.all(llm.listProviders().map(async (provider) => {
      const pid = provider && provider.id !== undefined ? String(provider.id) : String(provider)
      const pname = provider && provider.name ? String(provider.name) : pid
      try {
        const models = await llm.listModels(pid)
        providers.push({
          id: pid, name: pname,
          models: (models || []).map((m2) => {
            const id = m2 && m2.id !== undefined ? String(m2.id) : String(m2)
            const nm = m2 && m2.name ? String(m2.name) : undefined
            return { id, name: nm, likelyVision: VISION_RE.test(id) || VISION_RE.test(String(nm || '')) }
          }),
        })
      } catch (_) { /* 单个 provider 失败不阻塞 */ }
    }))
    return { unsupported: false, providers }
  }

  const routes = [
    {
      kind: 'exact', path: API.state, handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'loopback-only' })
        const everEnabled = !!(effConfig().enabled)
        writeJson(res, 200, {
          plugin: 'dsh-cua-pre', version: 3,
          enabled: everEnabled,
          firstRun: !everEnabled && !stoppedByUserPersisted,
          stoppedByUser: stoppedByUserPersisted,
          visionEnabled: !!(config && config.visionEnabled),
          whitelist: { active: (effConfig().allowedPids || []).length > 0, size: (effConfig().allowedPids || []).length, relaxed: !!effConfig().whitelistRelaxed },
          platform: platform(),
          worker: sidecar.debugView(),
          session: { states: session.stateCount(), refreshLocks: session.refreshLockCount(), busyVision: vision.busy() },
          lastOps: opLog.slice(-20).reverse(),
        })
      },
    },
    {
      kind: 'exact', path: API.config, handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'loopback-only' })
        if ((req.method || 'GET') === 'GET') {
          if (!config) return writeJson(res, 503, { error: 'loading' })
          const pub = {}
          for (const k of Object.keys(DEFAULT_CONFIG)) pub[k] = config[k]
          return writeJson(res, 200, { config: pub, file: config._file, needsRestartNote: '修改保存后需重启 dsh web 生效' })
        }
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        if (!config || !config._file) return writeJson(res, 503, { error: 'config not loaded yet' })
        const body = await readJsonBody(req).catch(() => null)
        if (!body || typeof body !== 'object') return writeJson(res, 400, { error: 'invalid json' })
        try {
          const raw = await readFile(config._file, 'utf8').catch(() => '{}')
          const obj = JSON.parse(raw)
          for (const k of Object.keys(DEFAULT_CONFIG)) {
            if (body[k] !== undefined) {
              obj[k] = body[k]
              overrides[k] = body[k] // 白名单等即时生效；pythonExecutable 等进程级项重启完全生效
            }
          }
          await writeFile(config._file, JSON.stringify(obj, null, 2), 'utf8')
          recordOp({ ts: Date.now(), tool: '(settings)', title: '设置页保存配置', ok: true, brief: Object.keys(body).join(','), ms: 0 })
          return writeJson(res, 200, { ok: true, note: '已保存并即时生效；进程级项重启后完全生效' })
        } catch (e) {
          return writeJson(res, 500, { error: e.message })
        }
      },
    },
    {
      kind: 'exact', path: API.ops, handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'loopback-only' })
        const since = Number(new URL(req.url, 'http://x').searchParams.get('since')) || 0
        writeJson(res, 200, { ops: opLog.filter((o) => o.ts > since).slice(-100) })
      },
    },
    {
      kind: 'exact', path: API.frames, handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'loopback-only' })
        writeJson(res, 200, { frames: framesSnapshot() })
      },
    },
    {
      kind: 'exact', path: API['frame-file'], handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'loopback-only' })
        const id = new URL(req.url, 'http://x').searchParams.get('id')
        const f = session.getFrame(id)
        if (!f || !f.path) return writeJson(res, 404, { error: 'frame not found' })
        try {
          await stat(f.path)
        } catch (_) {
          return writeJson(res, 404, { error: 'file gone' })
        }
        try {
          const bytes = await readFile(f.path)
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' })
          res.end(bytes)
        } catch (e) {
          writeJson(res, 500, { error: e.message })
        }
      },
    },
    {
      kind: 'exact', path: API.describe, handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'loopback-only' })
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req).catch(() => ({}))
        const fr = session.getFrame(body.frame_id)
        if (!fr) return writeJson(res, 404, { error: 'frame not found or expired' })
        const r = await vision.describeFrame({ ...fr, frame_id: body.frame_id }, 'manual')
        if (r.error) return writeJson(res, 200, { ok: false, error: r.error })
        session.annotateFrame(body.frame_id, { visionDescription: r.description, visionTiles: r.tiles, attachmentIds: (r.refs || []).map((x) => x.attachmentId) })
        writeJson(res, 200, { ok: true, description: r.description, tiles: r.tiles, cached: !!r.cached, newTiles: r.newTiles || 0 })
      },
    },
    {
      kind: 'exact', path: API.detect, handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'loopback-only' })
        const now = Date.now()
        if (!detectCache.pythons || now - detectCache.at > 60000) {
          detectCache.pythons = await detectPythons().catch(() => [])
          detectCache.at = now
        }
        const bundledWorker = defaultWorkerScriptPathPre()
        const models = await detectModels().catch(() => ({ unsupported: true, providers: [] }))
        writeJson(res, 200, {
          pythons: detectCache.pythons,
          worker: { path: bundledWorker, exists: existsSync(bundledWorker) },
          models,
          current: { pythonExecutable: effConfig().pythonExecutable, workerPath: effConfig().workerPath, visionModel: effConfig().visionModel },
        })
      },
    },
    {
      kind: 'exact', path: API['install-deps'], handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'loopback-only' })
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req).catch(() => ({}))
        const py = String(body.python || '').trim()
        if (!py) return writeJson(res, 400, { error: 'missing python' })
        const runPip = async (extra) => {
          try {
            const r = await execFileP(py, ['-m', 'pip', 'install', '--quiet', 'uiautomation', 'pillow'].concat(extra || []),
              { timeout: 240000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
            return { ok: true, tail: String(r.stdout || '').slice(-400) }
          } catch (e) {
            return { ok: false, tail: String((e && (e.stderr || e.message)) || e).slice(-400) }
          }
        }
        let r = await runPip()
        if (!r.ok) r = await runPip(['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'])
        detectCache.pythons = null // 依赖装完失效缓存，下次 detect 重新探测
        writeJson(res, 200, r)
      },
    },
    {
      kind: 'exact', path: API.bootstrap, handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'loopback-only' })
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req).catch(() => ({}))
        // 探测可用 Python：优先显式指定的；否则取第一个 ready 的候选
        let py = String(body.python || '').trim()
        if (!py) {
          const pythons = await detectPythons().catch(() => [])
          const ready = pythons.find((x) => x.status === 'ready') || pythons.find((x) => x.status === 'no-deps')
          if (ready) py = ready.path
        }
        if (!py) return writeJson(res, 400, { error: '未检测到可用 Python。请先在系统安装 Python 3.9+，或手动填写 pythonExecutable。' })
        // 若该 Python 缺依赖，自动尝试安装（默认源失败切清华镜像）
        const probe = await probePython(py, ['-c', 'import uiautomation, PIL; print("deps-ok")'])
        let installedDeps = false
        if (!probe.ok || probe.out.indexOf('deps-ok') === -1) {
          const runPip = async (extra) => {
            try {
              const r = await execFileP(py, ['-m', 'pip', 'install', '--quiet', 'uiautomation', 'pillow'].concat(extra || []),
                { timeout: 240000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
              return { ok: true, tail: String(r.stdout || '').slice(-300) }
            } catch (e) { return { ok: false, tail: String((e && (e.stderr || e.message)) || e).slice(-300) } }
          }
          let r = await runPip()
          if (!r.ok) r = await runPip(['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'])
          if (!r.ok) return writeJson(res, 500, { error: '依赖安装失败: ' + (r.tail || ''), tail: r.tail })
          installedDeps = true
        }
        // 写配置：enabled + pythonExecutable（+ 保留现有其他字段）
        try {
          const raw = await readFile(config._file, 'utf8').catch(() => '{}')
          const obj = JSON.parse(raw)
          obj.enabled = true
          obj.pythonExecutable = py
          await writeFile(config._file, JSON.stringify(obj, null, 2), 'utf8')
        } catch (e) {
          return writeJson(res, 500, { error: '配置写入失败: ' + (e.message || e) })
        }
        // 即时生效（overrides + 状态机重置）
        overrides.enabled = true
        overrides.pythonExecutable = py
        detectCache.pythons = null
        sidecar.restart('bootstrap')
        session.clearAll()
        recordOp({ ts: Date.now(), tool: '(bootstrap)', title: '一键启用', ok: true, brief: 'python=' + py + (installedDeps ? ' +deps' : ''), ms: 0 })
        writeJson(res, 200, { ok: true, python: py, depsInstalled: installedDeps, note: '已启用并即时生效。' })
      },
    },
  ]

  ctx.on('agent/session-start', (payload) => {
    try {
      if (payload && payload.agent) lastAgent = payload.agent
    } catch (_) {}
  })

  const disposers = []
  for (const route of routes) disposers.push(ctx.webServer.register(route))

  ctx.effect(() => () => {
    try { disposeSection() } catch (_) {}
    try { sidecar.dispose('plugin disposed') } catch (_) {}
    for (const d of disposers) { try { d() } catch (_) {} }
    session.clearAll()
  }, 'dsh-cua-pre: surfaces')

  void loadConfig().then((cfg) => {
    config = cfg
    stoppedByUserPersisted = !!cfg.stoppedByUser
    const names = registerWithFallback()
    console.log('[dsh-cua-pre] ready: ' + names.length + '/' + tools.length + ' tools; enabled=' + cfg.enabled +
      '; vision=' + (!!cfg.visionEnabled) +
      '; routes=' + routes.length +
      (cfg.enabled ? '' : '（默认关闭；启用见 README）'))
  })

  console.log('[dsh-cua-pre] mounting…')
}
