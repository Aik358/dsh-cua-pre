#!/usr/bin/env node
/**
 * vision 管线端到端测试：真实 worker 截屏 → planTiles 分块裁切 → 假 attachments.saveImage /
 * 假 subagents.start 验证调用形状（prompt 块结构、图片块数量、模型透传）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const fakeHome = path.join(tmpdir(), 'cua-pre-vision-' + Date.now())
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
const fakeAttachments = {
  async saveImage(input) {
    savedImages.push({ bytes: input.data.length, mediaType: input.mediaType, name: input.name })
    return {
      attachmentId: 'sha256:fake' + savedImages.length,
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 800, height: 600,
      name: input.name,
    }
  },
}
const fakeSubagents = {
  list: () => ['spawn'],
  async start(name, req) {
    subagentCalls.push({
      name,
      label: req.label,
      promptTypes: req.prompt.map((b) => b.type),
      imageBlocks: req.prompt.filter((b) => b.type === 'image').length,
      model: (req.agentOptions && req.agentOptions.model) || '',
      parentOk: !!(req.parent && req.parent.session),
    })
    return {
      result: Promise.resolve({ output: [{ type: 'text', text: '模拟：这是一个桌面截图，包含侧栏与主编辑区。' }] }),
    }
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
  systemPrompt: {
    section: (s) => s.text,
    context: () => () => {},
  },
  effect: (setup) => disposers.push(setup()),
})
await new Promise((r) => setTimeout(r, 400))

const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
// 注入假父 agent（vision 需要 parent.session/parent.ctx）
process._cuaLastAgentForTest = null

// [1] screenshot 自动识图（无父 agent 时应给出可读原因而不是崩溃）
const shot = await byName.screenshot.execute({})
console.log('[1] screenshot+vision(无父):', shot.includes('[vision]') ? shot.split('\n').find((l) => l.startsWith('[vision]')).slice(0, 60) : 'FAIL 无 [vision] 区块')
if (!shot.includes('[vision]')) process.exit(1)

// [2] 带父 agent 的完整链路：screenshot → 分块 → saveImage×N → subagent×1
// 通过 ctx.on('agent/session-start') 桩不可用（apply 已注册），直接构造：
// index.js 的 lastAgent 由 execute(args, exec) 与 session-start 更新；这里用 exec 参数通道。
const shot2 = await byName.screenshot.execute({}, { agent: { session: {}, ctx: { get: () => undefined } } })
const framesMatch = shot2.match(/frame=(frame-[0-9a-f]{8})/)
if (!framesMatch) { console.error('FAIL 无帧'); process.exit(1) }
console.log('[2] 带父 screenshot:', shot2.split('\n').filter((l) => l.startsWith('[vision]')).join(' | ').slice(0, 80))
if (!subagentCalls.length) { console.error('FAIL 未调用 subagent'); process.exit(1) }
const call = subagentCalls[0]
if (call.promptTypes[0] !== 'text' || call.imageBlocks < 1 || !call.parentOk) {
  console.error('FAIL 调用形状', JSON.stringify(call)); process.exit(1)
}
console.log('[3] subagent 调用形状: provider=' + call.name + ' 文本块=1 图片块=' + call.imageBlocks + ' label=' + call.label)
if (savedImages.length < call.imageBlocks) { console.error('FAIL 附件数不匹配'); process.exit(1) }
console.log('[4] saveImage 调用 ' + savedImages.length + ' 次, mediaType=' + savedImages[0].mediaType + ', 单块字节=' + savedImages[0].bytes)

for (const d of disposers) { try { d() } catch (_) {} }
console.log('[done] vision 管线测试通过')
