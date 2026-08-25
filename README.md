# dsh-cua-pre — Computer Use plugin for DeepSeek Harness / DSH 电脑控制插件

**One command install / 一条命令安装（Windows PowerShell）：**

```powershell
irm https://raw.githubusercontent.com/Aik358/dsh-cua-pre/main/install.ps1 | iex
```

Manual install / 手动安装：

```powershell
cd ~\.dsh\profiles\web
pnpm add @a9i5k4/dsh-cua-pre
# append to dsh.profile.bundles in package.json / 在 package.json 的 dsh.profile.bundles 数组追加 "@a9i5k4/dsh-cua-pre"
# restart dsh web / 重启 dsh web（3080 由用户手动重启）
```

Enable / 启用（默认关闭，安全设计）：write `~/.dsh/cua-pre.json` / 写入 `~/.dsh/cua-pre.json`：

```json
{ "enabled": true, "pythonExecutable": "C:/path/to/python.exe" }
```

Optional vision / 可选识图：`"visionEnabled": true, "visionModel": "<your-vlm>"`，并安装 worker 依赖 /
并安装依赖：

```powershell
git clone https://github.com/Aik358/dsh-cua-pre && cd dsh-cua-pre
python -m venv .venv && .venv\Scripts\pip install -r python\requirements.txt   # uiautomation + pillow
```

---

## 这是什么（中文）

把 ZCode Computer Use 的完整电脑控制面移植到 DeepSeek Harness 的自研插件。与内置 MCP 连接器逐层对齐：

- **30 个同名工具**：`get_app_state` / `left_click` / `type` / `key` / `screenshot` / `zoom` / `clipboard` …
  元素目标 `{type:"element",state_id,index}` 优先，坐标 `{type:"coordinate",x,y}` 兜底；
  strategy 路由 `auto`(无障碍命中优先) / `a11y`(fail-closed) / `event`(强制裸输入)
- **安全语义**：写后旧观察作废(superseded)+refresh 锁；timeout=可能已发生禁重放；`stop_computer_control`
  持久 kill switch；UIA RuntimeId 漂移找回 + 矩形漂移校验防点错；TextPattern 精确选区
- **呈现端**：对话卡片（presentCall/presentResult，截图直接嵌卡片）；侧栏「桌面」面板（实况操作流 +
  画面帧墙 + vision 描述）；独立设置页
- **识图（vision）**：截图自动网格分块（≤768px/块），低分辨率模型（DeepSeek flash 类）也能读清屏幕；
  全帧/分块两级缓存，增量只送变化块；经 attachments 服务持久化，子代理 VLM 多图提问
- **治理**：审计 JSONL 落盘可回放；pid 白名单（strict/宽松两档）即时生效

架构四层：`client.js(浏览器半边) ← /api/dsh-cua-pre/* ← index.js(工具+状态机+路由) ← stdio sidecar → python/worker_cua_v2.py(UIA/SendInput/Pillow)`。

仅 Windows 10+。详细设计取舍见 [docs/PROTOTYPE-NOTES.md](docs/PROTOTYPE-NOTES.md)。

## What it is (English)

A self-built computer-use plugin for DeepSeek Harness that mirrors the built-in zcode-cua MCP connector:

- **30 same-named tools**, element targets first (`element`/`coordinate` dual forms), `auto`/`a11y`/`event` strategy routing
- **Safety semantics**: superseded observations after mutations, refresh locks, no-replay on timeout ("may have happened"), persistent kill switch, RuntimeId recovery + rect-drift checks, TextPattern selection
- **Presentation layer**: chat cards (screenshots embedded), sidebar panel (live op feed + frame wall + vision descriptions), dedicated settings page
- **Vision**: auto grid tiling (≤768px/tile) so low-res models read screens clearly; full-frame + per-tile caches with incremental describe; durable attachment refs; subagent VLM calls
- **Governance**: JSONL audit trail, pid allowlist (strict/relaxed) with instant effect

Windows only. See [docs/PROTOTYPE-NOTES.md](docs/PROTOTYPE-NOTES.md) for design trade-offs.

## Tests / 测试

```powershell
node scripts/test-v2-gate.mjs                          # unit: gate/session/frame/tiles
node scripts/test-v2-live.mjs .venv\Scripts\python.exe # live read-only chain, 22 asserts
node scripts/test-vision.mjs .venv\Scripts\python.exe  # vision pipeline w/ fake host services
node scripts/test-m4.mjs .venv\Scripts\python.exe      # card-image/cache/audit/allowlist, 17 asserts
```

All tests are strictly read-only on the desktop — no input injection is ever executed by tests.

License: MIT
