# PROTOTYPE-NOTES v4 — 与 zcode-cua 的逐层对照

2026-08-26 更新：**v4 完成 M-CUA-4 六项**——卡片嵌图、识图缓存与增量、RuntimeId+TextPattern
寻址加固、PrintWindow 真窗口截图、审计落盘、pid 白名单。本文记录对齐矩阵、有意偏离与后续路线。

## v3 新增层与 DSH 宿主接口对照

| 能力 | 用到的宿主接口 | 说明 |
|---|---|---|
| 对话卡片 | `ToolDefinition.presentCall/presentResult`（dsh-tools） | GenericCallView/GenericResultView；标题纯函数从 args 派生，replay 安全 |
| 操作审计流 | 自维护环形缓冲(200) + `tools.register(execute)` 包装 | 单一收口点记录每次调用的标题/结果摘要/耗时 |
| 侧栏面板/设置页 | `slots.inject('sidebar.footer.action'/'shell.overlay'/'settings.section')`（client 半边） | 面板常驻挂载内部自隐；轮询 `/api/dsh-cua-pre/*` |
| 画面展示 | `webServer.register({kind:'exact',path,handler})` + loopback 门 | frame-file 路由直接回 JPEG 字节 |
| 识图 | `ctx.attachments.saveImage` → ImageAttachmentRef；`ctx.subagents.start` 多图 prompt | 图片唯一合法通道=附件引用，绝不 base64 进文本 |
| 低分辨率适配 | planTiles 网格分块（tileMaxPx/overlap/maxTiles） | 每块小图独立成附件，躲开 provider 整图压缩 |

## v3 关键实现事实

- **ImageBlock 形状**：`{type:'image', attachment:{attachmentId, mediaType, bytes, width, height}}`
  （dsh-llm ContentBlock）；saveImage 入参 `{data:Uint8Array, mediaType:'image/jpeg', name}`。
- **subagents.start**：`{label, prompt:[ContentBlock...], signal, parent, agentOptions:{model}}`，
  结果 `run.result.output[]` 过滤 text 块。parent 必须是完整 agent 对象（session/ctx 缺失即拒绝）。
- **presentResult 必须纯**：不能在 presenter 里做 saveImage 等 IO；图片进卡片的正道是
  presentationMeta 纯投影——v3 卡片走纯文本摘要，画面展示交给侧栏帧墙（无 replay 风险）。
- **client 半边模式**：手写 `__ModuleLoader__.load` bundle；`exports.inject=['slots']`；
  slots 渲染回调非组件上下文→面板常驻挂载+组件内 hooks 自隐（auto-memory 同款）。

## 三层工具面对照

| 层 | zcode-cua | dsh-cua-pre v3 | 对齐度 |
|---|---|---|---|
| 工具面 | 30 个 MCP 工具 | 同名 30 个 + presentCall/Result 卡片 | 名称/schema 1:1；传输不同 |
| 目标形态 | element / coordinate 双目标 | 同 | 1:1 |
| strategy | auto/a11y/event fail-closed | 同（semantic_only 注入前预判） | 语义等价 |
| return_state | none/compact/full | 同 | 1:1 |
| 状态机 | AccessibilitySession LRU/superseded/refresh 锁 | cua-session-pre 同构（16 态 LRU） | 移植子集 |
| 帧注册表 | frame_id+TTL+generation+image_ref | 同结构+vision 元数据 | 软绑定偏离① |
| zoom | 从最近帧裁剪不重截 | crop op + 子帧注册 | 1:1 |
| action_sent | 三态 | 二态+timeout/crashed=ambiguous | 简化② |
| kill switch | stop_computer_control 强制拒后续 | 同名工具，持久化到配置文件 | 加严③ |
| 传输 | 命名管道+token+对端校验 broker | stdio spawn 直连 | 有意简化④ |
| OS 层 | ax_native.node(C++/无源码) | worker_cua_v2.py(uiautomation+ctypes+Pillow) | 重写 |
| 视觉 | 宿主模型原生多模态 | attachments+子代理 VLM+分块裁切 | 自建旁路⑤ |

## 有意偏离（及原因）

1. **帧软绑定**：过期帧坐标放行但标注 stale；硬绑定需 broker 级 occlusion 记录，收益低复杂度高。
2. **action_sent 二态**：stdio 单进程内只有 timeout/crashed 产生"可能已发生"歧义，已按此处理并禁重放提示。
3. **kill switch 持久化**：写入配置 stoppedByUser 跨重启生效——比 ZCode 会话级更保守，防循环失控自动复活。
4. **无 broker**：spawn 自己的 worker 免鉴权/对端校验/多客户端仲裁；协议帧已兼容未来迁移管道 broker。
5. **识图为子代理旁路**：zcode 的视觉是宿主模型原生多模态直出；DSH 主模型 vision 未证实，
   故走 attachments+VLM 子代理。主链路（无障碍元素定位）完全不依赖视觉——这正是 zcode
   accessibility-first 的红利：识图只是描述增强，不是操作前提。
6. **bundle_id(AUMID) 不支持**；**select_text 键盘光标法**（start≤5000/length≤2000）。


## v4 六项实现要点

1. **卡片嵌图**：screenshot/get_app_state 截窗后经 `attachFrame` → attachments.saveImage 得持久附件
   ref → 返回文本带 `att=<sha256>|b=<bytes>|w=<w>|h=<h>` 标记 → output.presentationMeta 纯投影
   `{image:{attachmentId,...}}` → presentResult 把 `result.meta.image` 投影为 ImageBlock（UI-facing，
   模型侧仍只读 render() 纯文本，零上下文开销）。**必须纯**：presentationMeta/presentResult 不能做
   saveImage 等 IO（replay 会重复执行）。
2. **识图缓存与增量**：全帧 sha256 → 命中直接复用描述（0 次 VLM）；分块 sha256 各块命中缓存的行，
   只把变化块送 VLM 并合并（N 变 1 次小调用）。LruMap 有界（全帧 50/分块 200）。相同截屏内容
   （如 zoom 子帧）字节级命中。**注意**：真实桌面连续截屏像素必变（时钟/光标），全帧缓存按设计不命中。
3. **RuntimeId+矩形漂移**：observe 捕获 rid（特性探测，无 rid 静默降级）；resolve_element 三层校验
   rid（漂移 BFS 找回，≤300 节点）→(type,name)→矩形中心（容忍 25% 边长）。JS 侧 rid/rect 透传。
4. **TextPattern select_text**：MoveEndpointByUnit 字符级精确选区；失败回退键盘光标法（Home+Shift+Right）。
5. **PrintWindow**：PW_RENDERFULLCONTENT 真窗口内容（遮挡不穿帮）；失败回退全屏裁剪。
   **GDI 归属坑**：CreateCompatibleDC/Bitmap/SelectObject/DeleteObject/DeleteDC/GetDIBits 全在 gdi32，
   PrintWindow 在 user32——挂错 DLL 会 AttributeError。
6. **审计落盘**：recordOp 串行链 appendFile artifactsDir/audit/YYYY-MM-DD.jsonl，失败静默。
7. **pid 白名单**：allowedPids 配置；pidGate 作用域化（元素操作按 state 的 pid，app_ref 按解析 pid）；
   strict 下坐标类/剪贴板/全屏截图/open_application 默认拒绝（whitelistRelaxed 放开）。
   设置页 POST /config 走 runtime overrides **即时生效**（无需重启），文件同步持久化。

## M-CUA-5 候选

1. 卡片嵌图实测：tool-result 里 image 块的 UI 渲染与上下文成本（需 3080 上真实会话验证）。
2. 增量识图增强：只重描述像素差异超过阈值的块；连续截图去抖。
3. UIA RuntimeId 递归恢复用于 drag/down-up 全链路；comtypes 原生 TextPattern 提升选区精度。
4. 审计回放工具：audit/*.jsonl → 时间线 UI。
5. 白名单宽松模式的更细粒度：按工具类目（允许坐标滚动但禁剪贴板）而非全局开关。

## 实现要点备忘（踩坑记录）

- **64 位句柄必须显式 argtypes/restype**：clipboard GlobalLock/GetClipboardData 不声明原型
  会 `OverflowError: int too long to convert`（已全量声明）。
- **strategy=a11y 必须预判**：worker hit_click mode=semantic_only 在注入前返回 clicked=false，
  JS fail-closed 报 a11y_miss 且 action_sent=false；绝不能"点了再报告失败"。
- **markDispatched 时序**：进入原生调用前冻结 scope；除 unavailable/backpressure/disposed
  外一律视为已派发（worker-error 可能半执行，如 sendinput_blocked）。
- **EnumWindows vs UIA root**：窗口枚举 EnumWindows+DWM cloaked 过滤（window_id=hwnd），
  树观察 ControlFromHandle(hwnd)；UIA root 枚举仅 fallback。
- **cordis effect(setup) 语义**：立即执行 setup 并以返回值为清理函数（测试 fake 曾漏调内层致挂起）。
- **python-manager 转发器**：child.kill() 杀不死真实解释器，必须 taskkill /T /F +
  process.on('exit') spawnSync 兜底，否则孤儿握管道 Node 不退。
- **Git Bash 向 node 传 Windows 路径会吃反斜杠**：脚本内一律用正斜杠或 fileURLToPath。

## M-CUA-4 候选

1. TextPattern 精确 select_text；UIA RuntimeId 寻址替代子索引路径。
2. PrintWindow 真窗口截图（当前全屏裁剪，被遮挡会穿帮）；UWP/AUMID open_application。
3. 卡片嵌图：screenshot 时把整帧附件 ref 经 presentationMeta 持久化，presentResult 投影
   ImageBlock（需验证 tool-result 里 image 块的 UI 渲染与上下文成本）。
4. 识图缓存与增量：同帧去重、只重描述变化的块。
5. 审计落盘 artifactsDir/audit/*.jsonl 可回放追责；pid 白名单。
6. 把 30 工具原样挂 MCP server 形态供其他宿主复用（仅换传输层）。
