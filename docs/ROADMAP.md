# ROADMAP — dsh-cua-pre 进化路线

> 2026-09 · 基于 v0.5.0 现状（Better Sidebar 集成 / 首次引导 / i18n / 环境自检 / 审计 / 白名单）
> 的下一步方向。分近期（可落地）/ 中期（需设计）/ 创新（差异化）三档。

## 近期 · 补全与打磨

| 方向 | 说明 |
|---|---|
| **vision 闭环实测** | DeepSeek 官方已放量 vision-exp 模型：打通 `native` 模式（截图经 attachments 以图片块直接进当前对话），与现有 tile+子代理 describe 并存为三种观察模式（ax / native / vision），按 AX 树是否为空自动降级 |
| **危险操作审批门** | click/key 到达浏览器地址栏、付款按钮、删除确认前弹 `ctx.approval` 审批（对齐 988hj/dsh-computer-use 的 dangerous-action approval），白名单+审批双保险 |
| **密码框保护** | UIA `IsPassword` 属性探测：密码输入框拒绝 type/set_value，返回明确错误——安全叙事的关键一块 |
| **审计回放 UI** | 侧边栏加「审计」页签：读 audit/*.jsonl 时间线，可按 app/ok 过滤；为"操作可追责"闭环 |
| **host 工具输出双语** | 工具响应文案目前仅中文；en 模式下按 t() 同源输出英文（模型是 DeepSeek 双语无碍，用户可见性一致） |
| **快照 TTL 恢复 UX** | 断路器/kill switch 状态在面板顶部给"恢复按钮"（写配置+重启 sidecar），不再要求用户手改 JSON |

## 中期 · 架构增强

| 方向 | 说明 |
|---|---|
| **硬帧绑定** | 帧注册表记录 occlusion/owner；过期帧坐标直接拒绝（对齐 zcode-cua 的 stale-frame refusal），消灭软绑定的最后模糊地带 |
| **RuntimeId 全链路** | drag / mouse_down-up / scroll 也走 rid 校验；UIA TextPattern 补全 select_text 的全选/光标语义 |
| **语义重定位** | stale_tree 后不只要求重观察：用 (type,name,rect) 相似度在新树里**自动找回目标**，重观察一次即可继续（减少 agent 往返） |
| **UIA 增量观察** | 缓存上次树 hash，observe 只返回变化子树——长会话省上下文 |
| **多显示器工作流** | switch_display 联动坐标空间（帧记录 display id，坐标按帧归属换算） |
| **宏录制（操作宏）** | 成功动作序列一键存为 macro（JSONL 已有审计基础），agent 可 `play_macro` 复用——从"单步工具"进化为"工作流" |

## 创新 · 差异化方向

1. **可访问性快照 diff**：两次 observe 之间做树 diff，把"变了什么"结构化喂给 agent——比截图 diff 省 token、比全量树准。配合增量识图形成"变化感知"闭环。
2. **虚拟桌面沙箱**：高危任务（安装/支付流程测试）在独立 Windows 虚拟桌面/沙箱账号里执行，主桌面零风险——与企业自动化需求对齐。
3. **远程遥控**：借 dsh-mcp-tunnel 模式把 cua 面板/工具暴露到手机（remote-web-ui 生态），人在外面也能让 agent 操作家里电脑。
4. **跨插件工作流编排**：与 better-sidebar 生态联动——sentinel 唤醒 → cua 执行 → doctor 体检 的组合 recipe 市场。
5. **模型自适应策略**：vision 模型强 → 默认 native 直读；纯文本模型 → 默认 ax+分块 describe；按会话模型自动选路（现在手动选）。

## 已知技术债

- `client.js` 手写 bundle 已 ~1300 行：若功能继续膨胀，考虑迁移到 better-sidebar 的构建链或拆模块打包
- CuaPanel（overlay 版死代码）待删
- select_text 键盘回退在 start>5000 时仍受限（TextPattern 主路径已覆盖大多数场景）
