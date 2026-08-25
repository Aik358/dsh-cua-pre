#!/usr/bin/env node
/**
 * M-CUA-4 专项测试（只读 + 假宿主服务）：
 *   [A] 审计落盘：操作后 artifactsDir/audit/YYYY-MM-DD.jsonl 出现且含记录
 *   [B] pid 白名单：POST /config 即时生效 → 白名单外观察被拒 → 放行恢复
 *   [C] 卡片嵌图：screenshot 输出带 att= 标记；presentationMeta 投影出 image meta
 *   [D] 识图缓存与增量：同一帧二次 describe 走缓存（subagent 调用数不增）；分块级增量只送新块
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const fakeHome = path.join(tmpdir(), 'cua-pre-m4-' + Date.now())
mkdirSync(fakeHome, { recursive: true })
const ART = path.join(fakeHome, 'artifacts')
writeFileSync(path.join(fakeHome, 'cua-pre.json'), JSON.stringify({
  artifactsDir: ART,
  enabled: true,
  visionEnabled: true,
  pythonExecutable: process.argv[2] || 'python',
}))
process.env.DSH_HOME = fakeHome

const { apply } = await import('../lib/index.js')

// ---- 假宿主服务 ----
const savedImages = []
const subagentCalls = []
let parentAgent = { session: {}, ctx: { get: () => undefined } }
// 注意：attachmentId 必须是 sha256:<hex>（与真实附件服务一致的格式，卡片标记解析依赖）
const fakeHex = () => 'sha256:' + Date.now().toString(16) + Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')
const fakeAttachments = {
  async saveImage(input) {
    savedImages.push(input.data.length)
    return {
      attachmentId: fakeHex(),
      mediaType: input.mediaType || 'image/jpeg',
      bytes: input.data.length,
      width: 800, height: 600,
      name: input.name,
    }
  },
}
const fakeSubagents = {
  list: () => ['spawn'],
  async start(name, req) {
    subagentCalls.push({ images: req.prompt.filter((b) => b.type === 'image').length })
    return { result: Promise.resolve({ output: [{ type: 'text', text: '[块1] Button "确定"\n概述: 模拟界面' }] }) }
  },
}

const registered = []
const routes = []
const disposers = []
apply({
  tools: { register: (t) => { registered.push(t); return () => {} } },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  get(key) {
    if (key === 'attachments') return fakeAttachments
    if (key === 'subagents') return fakeSubagents
    return undefined
  },
  on: () => () => {},
  systemPrompt: { section: (s) => s.text, context: () => () => {} },
  effect: (setup) => disposers.push(setup()),
})
await new Promise((r) => setTimeout(r, 400))

const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
const routeByPath = Object.fromEntries(routes.map((r) => [r.path.split('/').pop(), r]))
const ok = (cond, label) => { console.log((cond ? '[ok] ' : '[FAIL] ') + label); if (!cond) process.exit(1) }

function mockReq(body) {
  return Object.assign((async function* () { yield Buffer.from(JSON.stringify(body || {})) })(), {
    method: 'POST', url: '/x', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'x' },
  })
}
function mockRes() {
  return { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = String(b || '') } }
}
async function postRoute(name, body) {
  const res = mockRes()
  await routeByPath[name].handler(mockReq(body), res)
  return JSON.parse(res.body)
}

// ---- [C] 卡片附件标记 ----
const shot = await byName.screenshot.execute({}, { agent: parentAgent })
const attMatch = shot.match(/att=(sha256:[0-9a-f]+)\|b=(\d+)\|w=(\d+)\|h=(\d+)/)
ok(!!attMatch, 'screenshot 输出 att= 标记: ' + (attMatch ? attMatch[1].slice(0, 24) + '… ' + attMatch[3] + 'x' + attMatch[4] : 'MISS'))
const frameId = (shot.match(/frame=(frame-[0-9a-f]{8})/) || [])[1]

// presentationMeta 纯投影验证：直接从工具定义取
const shotDef = registered.find((t) => t.name === 'screenshot')
const meta = shotDef.output.presentationMeta({}, shot)
ok(meta && meta.image && meta.image.attachmentId === attMatch[1], 'presentationMeta 投影 image meta')

// presentResult 投影 ImageBlock（模拟 result.meta）
const view = shotDef.presentResult({}, { isError: false, content: [{ type: 'text', text: shot }], meta })
ok(view && view.content[0].type === 'image' && view.content[0].attachment.attachmentId === attMatch[1],
  'presentResult 首块为 ImageBlock')

// ---- [D] 识图缓存：同帧二次 describe 不再调 VLM ----
await postRoute('describe', { frame_id: frameId })
const callsAfterFirst = subagentCalls.length
ok(callsAfterFirst >= 1, '首次 describe 调用 VLM ×' + callsAfterFirst)
const second = await postRoute('describe', { frame_id: frameId })
ok(second.ok && subagentCalls.length === callsAfterFirst, '同帧二次 describe 走缓存（VLM 调用不增）')

// 增量/缓存确定性验证：对同一源帧做两次相同区域 zoom → 字节级相同的子帧
// （真实桌面连续截屏像素必变，全帧缓存本就不该命中；zoom 路径才是确定性等价）
const zr = { region: [0, 0, 400, 300], frame_id: frameId }
const za = await byName.zoom.execute(zr)
const faId = (za.match(/frame=(frame-[0-9a-f]{8})/) || [])[1]
const zb = await byName.zoom.execute(zr)
const fbId = (zb.match(/frame=(frame-[0-9a-f]{8})/) || [])[1]
ok(faId && fbId && faId !== fbId, '两次 zoom 产生独立子帧')
await postRoute('describe', { frame_id: faId })
const callsAfterZa = subagentCalls.length
const dFb = await postRoute('describe', { frame_id: fbId })
ok(dFb.ok && subagentCalls.length === callsAfterZa && dFb.cached === true,
  '字节相同的新子帧命中全帧缓存（0 次新调用, cached=' + dFb.cached + '）')

// ---- [A] 审计落盘 ----
await new Promise((r) => setTimeout(r, 300)) // 等 auditChain 追加完成
const auditDir = path.join(ART, 'audit')
ok(existsSync(auditDir), 'audit 目录已创建')
const files = readdirSync(auditDir)
ok(files.length >= 1 && files.every((f) => f.endsWith('.jsonl')), '按天 jsonl: ' + files.join(','))
const lines = readFileSync(path.join(auditDir, files[0]), 'utf8').trim().split('\n')
const parsedOk = lines.every((l) => { const o = JSON.parse(l); return typeof o.tool === 'string' && typeof o.ts === 'number' })
ok(parsedOk && lines.length >= 3, '审计行可解析且 ≥3 条 (' + lines.length + '：screenshot+zoom×2；describe 走路由不计)')

// ---- [B] pid 白名单即时生效 ----
const apps = await byName.list_apps.execute({})
const targetPid = Number(apps.match(/pid=(\d+)/)[1])
const setWl = await postRoute('config', { allowedPids: [999999] })
ok(setWl.ok === true, 'POST config 设置白名单 [999999]')
const blocked = await byName.get_app_state.execute({ app_ref: { pid: targetPid } })
ok(blocked.includes('pid_blocked') && blocked.includes('白名单'), '白名单外观察被拒: ' + blocked.slice(0, 70))
// 坐标点击也应被拒（strict 默认）
const coordBlocked = await byName.left_click.execute({ target: { type: 'coordinate', x: -5000, y: -5000 } })
ok(coordBlocked.includes('pid_scope_required'), '坐标操作 strict 拒绝: ' + coordBlocked.slice(0, 60))
// 放行后恢复
await postRoute('config', { allowedPids: [targetPid] })
const allowed = await byName.get_app_state.execute({ app_ref: { pid: targetPid } })
ok(/\[state s-\d+\]/.test(allowed), '白名单内观察恢复')
// relaxed 模式放开坐标类
await postRoute('config', { whitelistRelaxed: true })
const coordOk = await byName.mouse_move.execute({ coordinate: { type: 'coordinate', x: -5000, y: -5000 } })
ok(coordOk.includes('pointer→'), '宽松模式坐标移动放行')
await postRoute('config', { whitelistRelaxed: false })

for (const d of disposers) { try { d() } catch (_) {} }
console.log('[done] M-CUA-4 专项测试全部通过')
