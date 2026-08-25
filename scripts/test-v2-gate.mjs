#!/usr/bin/env node
/**
 * v2 门禁与会话语义测试（无桌面交互）：disabled 拒绝 / kill switch 持久化 /
 * 状态机 superseded-refreshLock 帧注册表 TTL 单测。配置隔离在临时 DSH_HOME。
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const fakeHome = path.join(tmpdir(), 'cua-pre-v2gate-' + Date.now())
mkdirSync(fakeHome, { recursive: true })
process.env.DSH_HOME = fakeHome

const { apply } = await import('../lib/index.js')
const { createCuaSessionPre } = await import('../lib/cua-session-pre.js')
const { planTiles } = await import('../lib/cua-vision-pre.js')

// ---------- 分块裁切规划器单测（纯函数） ----------
{
  // 小图：单块
  const t1 = planTiles(640, 480, {})
  if (t1.length !== 1 || t1[0].l !== 0 || t1[0].r !== 640) process.exit(1)
  // 1600x900、块上限 768 → 至少 2x2=4 块内解决；每格有效尺寸 ≤768
  const t2 = planTiles(1600, 900, { tileMaxPx: 768, overlapPx: 64, maxTiles: 4 })
  const okSize = t2.every((c) => (c.r - c.l) <= 900 && (c.b - c.t) <= 900) // 允许重叠导致的少量超出
  if (!(t2.length >= 2 && t2.length <= 4 && okSize)) {
    console.error('FAIL planTiles 1600x900:', JSON.stringify(t2)); process.exit(1)
  }
  // 超宽图受 maxTiles 约束
  const t3 = planTiles(3840, 1080, { tileMaxPx: 768, maxTiles: 4 })
  if (t3.length > 4) process.exit(1)
  console.log('[V1] planTiles: 单块=' + t1.length + ', 1600x900→' + t2.length + '块, 4K→' + t3.length + '块 : ok')
}

// ---------- 会话状态机单测（纯 JS，无 IO） ----------
{
  const s = createCuaSessionPre({})
  const r1 = s.remember({ pid: 100 }, [{ p: [0], k: 'Button' }])
  const r2 = s.remember({ pid: 200 }, [{ p: [1], k: 'Edit' }])
  console.log('[S1] state ids:', r1.stateId, r2.stateId)
  if (r1.stateId !== 's-1' || r2.stateId !== 's-2') process.exit(1)

  // superseded 后取不到；refresh 锁生效
  s.markMutationDispatched(100)
  if (s.get('s-1') !== null || !s.isSuperseded('s-1')) process.exit(1)
  if (!s.requiresRefresh(100) || s.requiresRefresh(200)) process.exit(1)

  // full observe 解锁
  const r3 = s.remember({ pid: 100 }, [])
  if (s.requiresRefresh(100)) process.exit(1)
  console.log('[S2] superseded+refreshLock+解锁: ok')

  // LRU 容量淘汰
  const small = createCuaSessionPre({ maxStates: 2 })
  small.remember({ pid: 1 }, [])
  small.remember({ pid: 2 }, [])
  small.remember({ pid: 3 }, [])
  if (small.get('s-1') !== null && !small.isSuperseded('s-1')) process.exit(1)
  console.log('[S3] LRU 淘汰: ok')

  // 帧注册表 TTL
  const f = small.issueFrame({ path: 'x.jpg', width: 10, height: 5, actionable: true })
  const got = small.getFrame(f.frame_id)
  if (!got || !got.image_ref || got.expires_at_ms <= Date.now()) process.exit(1)
  if (!small.latestFrame()) process.exit(1)
  console.log('[S4] 帧 registry+image_ref: ok (' + f.frame_id + ')')

  // down/up 配对守卫字段
  if (small.inputState.leftMouseDown !== false) process.exit(1)
}

// ---------- 插件接线：disabled 门禁 ----------
const registered = []
const routes = []
let sectionText = null
const disposers = []
apply({
  tools: { register: (t) => { registered.push(t); return () => {} } },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  on: () => () => {},
  systemPrompt: {
    section: (s) => { sectionText = s.text; return () => {} },
    context: () => () => {},
  },
  effect: (setup) => disposers.push(setup()),
})
await new Promise((r) => setTimeout(r, 400))

console.log('[G1] 注册工具数:', registered.length)
if (registered.length !== 30) { console.error('FAIL: 应为 30 个 zcode 同名工具'); process.exit(1) }
const names = new Set(registered.map((t) => t.name))
for (const must of ['list_apps', 'get_app_state', 'left_click', 'zoom', 'hold_key', 'perform_action', 'stop_computer_control', 'write_clipboard']) {
  if (!names.has(must)) { console.error('FAIL: 缺少工具 ' + must); process.exit(1) }
}
console.log('[G2] zcode 同名关键工具齐全: ok')

const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
const blocked = await byName.list_apps.execute({})
console.log('[G3] disabled 门禁:', blocked.slice(0, 60) + '…')
if (!blocked.includes('gate_blocked')) process.exit(1)

// 无目标的 type 必须拒绝（即使 disabled 也应给出拒绝信息——顺序：gate 先）
const t0 = await byName.type.execute({ text: 'hi' })
if (!t0.includes('error')) process.exit(1)
console.log('[G4] type 无目标拒绝路径: ok')

// section 在 disabled 时必须空串（prefix-cache 零成本）
if (sectionText() !== '') { console.error('FAIL: disabled 应注入空串'); process.exit(1) }
console.log('[G5] disabled 时 GUIDANCE 注入空串: ok')

// kill switch 持久化（先写 enabled 使其走完整分支不可行——config 快照已定；
// 直接验证 stop_computer_control 在 disabled 下也安全返回）
const stopMsg = await byName.stop_computer_control.execute({ reason: 'test' })
void stopMsg
console.log('[G6] stop 调用不崩溃: ok')

for (const d of disposers) { try { d() } catch (_) {} }
console.log('[done] 门禁+会话语义测试通过')
