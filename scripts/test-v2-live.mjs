#!/usr/bin/env node
/**
 * v2 enabled 全链路只读测试：走完整插件栈验证 30 工具面的观察/帧/拒绝路径。
 * 绝不执行输入注入（click/type/key/scroll/drag/down-up 不测真实触发）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const fakeHome = path.join(tmpdir(), 'cua-pre-v2live-' + Date.now())
mkdirSync(fakeHome, { recursive: true })
const ART = path.join(fakeHome, 'artifacts')
writeFileSync(path.join(fakeHome, 'cua-pre.json'), JSON.stringify({
  artifactsDir: ART,
  enabled: true,
  pythonExecutable: process.argv[2] || 'python',
}))
process.env.DSH_HOME = fakeHome

const { apply, GUIDANCE } = await import('../lib/index.js')

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

const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
const routeByPath = Object.fromEntries(routes.map((r) => [r.path, r]))
const ok = (cond, label) => { console.log((cond ? '[ok] ' : '[FAIL] ') + label); if (!cond) process.exit(1) }

// [0] 路由注册
ok(routes.length === 11, 'webServer 路由 x6: ' + routes.map((r) => r.path.split('/').pop()).join(','))

// [1] SKILL 化 GUIDANCE
const g = sectionText()
ok(g.includes('superseded') && g.includes('action_sent') && g.length > 600, 'GUIDANCE 注入 (' + g.length + ' chars)')

// [2] request_access
const ra = await byName.request_access.execute({})
ok(ra.includes('status: ready'), 'request_access → ' + ra.split('\n')[1])

// [3] list_apps（优先挑一个可见非最小化的应用观察：ZCode/Chrome/explorer）
const apps = await byName.list_apps.execute({})
const allLines = apps.split('\n').filter((l) => l.startsWith('pid='))
const pick = allLines.find((l) => /name=ZCode/i.test(l)) ||
  allLines.find((l) => /name=chrome/i.test(l)) ||
  allLines.find((l) => /name=explorer/i.test(l)) || allLines[0]
ok(allLines.length > 0, 'list_apps → 共 ' + (apps.match(/共 (\d+) 个/) || [])[1] + ' 个应用，选中: ' + pick.slice(0, 60))
const pidMatch = pick.match(/pid=(\d+)/)
const pid = Number(pidMatch[1])

// [4] list_windows
const wins = await byName.list_windows.execute({ app_ref: { pid } })
const widMatch = wins.match(/window_id=(\d+)/)
ok(!!widMatch, 'list_windows → ' + wins.split('\n')[0].slice(0, 80))
const windowId = Number(widMatch[1])

// [5] get_app_state（元素表 + state 颁发）
const st1 = await byName.get_app_state.execute({ app_ref: { pid }, detail: 'compact' })
const sidMatch = st1.match(/\[state (s-\d+)\]/)
ok(!!sidMatch, 'get_app_state → ' + st1.split('\n')[0].slice(0, 100))
const sid = sidMatch[1]

// [6] repeat observation 检测
const st2 = await byName.get_app_state.execute({ app_ref: { pid }, detail: 'compact' })
ok(/repeat_observation=1/.test(st2), 'repeat_observation 检测')

// [7] include_screenshot 帧注册
const st3 = await byName.get_app_state.execute({ app_ref: { pid }, include_screenshot: true })
const frameMatch = st3.match(/frame=(frame-[0-9a-f]{8})/)
ok(!!frameMatch, 'include_screenshot → ' + (frameMatch ? frameMatch[1] : 'NO FRAME'))
const frameId = frameMatch[1]

// [8] zoom 从帧裁剪（取帧内左上角区域）
const zoom = await byName.zoom.execute({ region: [0, 0, 120, 90], frame_id: frameId })
ok(zoom.includes('子帧 frame='), 'zoom crop → ' + zoom.split('\n')[0].slice(0, 90))
const childFrame = zoom.match(/frame-(\w{8})/g)

// [9] element target 引用检查：合法 state + 越界 index
const badIdx = await byName.left_click.execute({ target: { type: 'element', state_id: sid, index: 99999 } })
ok(badIdx.includes('index_oob') && badIdx.includes('action_sent=false'), '越界 index fail-closed')
// 注意：不测合法 index 的 click（会真实注入）

// [10] 无效 state_id
const badSid = await byName.left_click.execute({ target: { type: 'element', state_id: 's-999', index: 0 } })
ok(badSid.includes('element_stale') || badSid.includes('无效或已过期'), '非法 state_id fail-closed')

// [11] strategy=event × element 目标冲突
const firstIdx = st1.split('\n').findIndex((l) => /\d+: .*/.test(l))
void firstIdx
const evConf = await byName.double_click.execute({ target: { type: 'element', state_id: sid, index: 0 }, strategy: 'event' })
// index 0 存在但 event 冲突应先拒绝（在解析后、派发前）
ok(evConf.includes('strategy_conflict') && evConf.includes('action_sent=false'), 'strategy=event×element 拒绝')

// [12] a11y 策略坐标 fail-closed 分支存在性（用屏幕外坐标保证无可按压元素且绝不注入）
const a11yMiss = await byName.left_click.execute({
  target: { type: 'coordinate', x: -9999, y: -9999 }, strategy: 'a11y',
})
ok(a11yMiss.includes('a11y_miss') || a11yMiss.includes('error'), 'a11y fail-closed 路径: ' + a11yMiss.slice(0, 60))

// [13] scroll 缺 target
const noTarget = await byName.scroll.execute({ scroll_direction: 'down' })
ok(noTarget.includes('bad_target'), 'scroll 无 target 拒绝')

// [14] targetless type / key
const tlType = await byName.type.execute({ text: 'x' })
ok(tlType.includes('targetless_refused'), 'targetless type 拒绝')
const tlKey = await byName.key.execute({ text: 'ctrl+c', app_ref: { pid: 999999 } })
ok(tlKey.includes('error'), 'key 未知 app_ref 拒绝: ' + tlKey.slice(0, 50))

// [15] displays / cursor / clipboard-read / wait
const disp = await byName.list_displays.execute({})
ok(disp.includes('index=1'), 'list_displays')
await byName.switch_display.execute({ index: 1 })
const cur = await byName.cursor_position.execute({})
ok(cur.includes('pointer=('), 'cursor_position → ' + cur)
const cb = await byName.read_clipboard.execute({})
ok(cb.startsWith('剪贴板'), 'read_clipboard → ' + cb.slice(0, 30))
const wt0 = await byName.wait.execute({ duration: 0.5 })
ok(wt0.includes('已等待 0.5s'), 'wait')

// [16] stop_computer_control 后全拒
const stopped = await byName.stop_computer_control.execute({ reason: 'v2-live-test-end' })
ok(stopped.includes('持久化'), 'stop_computer_control')
const after = await byName.list_apps.execute({})
ok(after.includes('gate_blocked'), 'stop 后 list_apps 拒绝')

for (const d of disposers) { try { d() } catch (_) {} }
console.log('[done] v2 只读全链路测试通过' + (childFrame ? '' : '') )
