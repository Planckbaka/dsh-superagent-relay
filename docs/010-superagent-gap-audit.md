# Superagent Relay — 设计对照与实现差距审计

审计日期：2026-11-15（Asia/Shanghai）。结论：已证明一个受限的真实 Discord→Worker→Discord 闭环，尚不能称为完整实现上游 Superagent 的生产部署。

## 1. 审计范围与版本

- 官方设计：DeepSeek `dsh-superagent-prototype` 的 `docs/000` 至 `docs/008`。审计时官方 main 为 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`，提交时间为 2026-10-31。
- 本地基线：Relay `d8b5e0a5ee441c88fb981ed627c9b35a669ef16a`，加未发布的 Discord 适配、健康状态及启动器修改。
- GitHub main：`9d1fc0f04eb4134d978a81d3ee5338331820006a`。本机测试代码、公开 main、`v0.1.0-preview.1` 发行包是三个不同交付物。本报告的本地能力不代表现有发行包已经包含这些能力。
- 不把继承自上游的能力写成“没有实现”；分别检查代码是否存在、当前配置是否启用、真实环境是否验收。
- 本文是审计与后续验收要求，不构成新增能力已交付的声明。

## 2. 对照的官方设计

1. [000 Philosophy](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/000-philosophy.md)：明确授权、减少打扰、一次具体确认、结构化提问。
2. [001 Domain](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/001-domain.md)：Source、Thread、Eval、Mandate、Ticket、Assignment、Subscription 的职责。
3. [002 Authorization](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/002-authorization.md)：确定性准入、规则判断、观察模式与版本化策略。
4. [003 Execution](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/003-execution.md)：输入交付、恢复、暂停、持久化工作与独立的频道失败处理。
5. [004 Prompts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/004-prompts.md)、[005 Panel](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/005-panel.md)、[006 Deployment](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/006-deployment.md)：可版本化提示、人工处理面板、账号隔离及独立健康检查。
6. [007 Architecture](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/007-architecture.md)、[008 Cookbook](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/008-cookbook.md)：实现索引与使用方式。

## 3. 当前实现矩阵

| 能力 | 代码与配置状态 | 验收边界 |
| --- | --- | --- |
| Engine、工单、Assignment、独立 Worker、SQLite 持久化 | 继承并使用上游实现 | 已有真实 Worker 工单与保存结果；不是只有聊天转发 |
| Prompt 版本、Eval/Policy、Thread/Subscription、面板与统一 Outbox | 核心代码存在 | Discord 当前并未完整使用这些端口；不能因核心存在就宣称该渠道已兼容 |
| Discord 明确提及、owner/channel 白名单、机器人及 webhook 过滤 | 本机双向适配已实现 | 对正确提及做过真实接入；角色提及纠正有测试 |
| Discord 接收确认、完成报告、原消息引用 | 本机已实现 | 重放一条真实用户消息，新 Worker 得到 59，官方 API 读回确认和完成回复；不是新用户现场重新发送的验收 |
| 回复续接、/help、/status、/stop、长文本拆分 | 本机代码与自动测试存在 | 尚未逐项完成真实频道验收，尤其运行中取消与澄清后恢复 |
| Discord cursor、绑定、待发队列和稳定 nonce | 本机 journal 已实现 | 单元测试覆盖持久化恢复与限流重试；不承诺跨任意停机时长的 exactly-once 发送 |
| 后台运行、健康状态、本地结果摘要 | 本机启动器实现 | 已验证命令退出后仍运行；尚无 OS 登录启动、崩溃自动拉起或独立 watchdog 部署 |
| GitHub/Feishu 原生 Sources | 上游代码保留 | 当前 fixture 关闭，未完成专用机器人创建真实 PR 的完整验收 |
| QQ/WeChat | 工作区有归一化调研/辅助代码 | 未接入此插件的真实双向 Source，不属于可交付渠道 |
| 公开可安装 Discord 版本 | 交付缺口 | 本机新代码未随已有发布包交付；新用户安装旧包不能复现本机能力 |

## 4. 主要差距与风险

### P0 — Discord 尚未成为正式 Source

证据：`src/app/runtime.ts` 的 Discord 分支用 `localTrigger` 构造 `lab` 事件，使用合成 `operator` 身份，直接接受新任务；fixture 还会将 Eval 设为 off、替换本地 Source/Policy 配置。`src/discord-chat.ts` 自己保存消费和发送状态。

这是单 owner 本地试验的明确限制，不适合作为多用户授权体系。正式实现应注册 Discord Source，保留 Discord actor、线程及来源引用，接入 SourceContext、版本化 Policy、Eval 与原生 Channel/Outbox。社区成员加入服务器不会自动获得执行权限。

验收：陌生用户、其他频道、机器人和角色提及不能新建工单；明确授权的请求经过正式决策并可追溯真实身份；调整策略后的旧工单恢复符合 Mandate 规则。

### P0 — 结构化人工问题没有完整送达 Discord

证据：Executor `orchestrator_report` 把 `human_action` 存为 report 的 `question`。Discord host 的 status 只取 `report.summary`，不会把该问题原文交给适配器；attention 也只退化为通用说明。

影响：Worker 可能已提出具体问题，Discord 用户仍只看到普通摘要或“需要说明”，无法完成澄清闭环。

验收：构造一个问题只在 `human_action` 中的 blocked/progress 报告；Discord 原消息收到该问题且仅一次；用户回复后同一工单继续，停止的工单不会被恢复。

### P0 — 全局暂停与自建发送队列尚未对齐

证据：Discord 的 request/轮询/queue flush 不接收全局 pause 状态，发送不经过检查暂停的原生 Outbox。上游设计要求暂停停止新 Eval、交付和回复，同时仍记录来源事件。

验收：暂停后来源事件仍被持久化，频道不发送确认/进展/结果；恢复后有序交付，不丢消息、不重复开工。

### P1 — 入口异常可能被当作永久拒绝并跳过

证据：适配器捕获 `host.submit` 的所有异常，排入“任务不可用”回复后推进 cursor；当前没有区分领域拒绝与暂时的存储/运行时故障。

验收：模拟临时 intake 失败，事件保留并重试；只有可明确解释的永久拒绝推进游标。Engine 幂等应防止崩溃窗口重复开工。

### P1 — 发送隔离、生命周期和长文本恢复

证据：所有回复使用一个 journal 队列；第一条失败会阻塞后续发送。401/403/404 会终止整个 listener。长文本循环逐段保存绑定，但没有持久化“下一段”的进度。稳定 nonce 仅用于近期重试去重，不能代替无限期交付保证。绑定与 reply 索引没有保留期/压缩策略。

验收：一个失效目标不阻塞其他工单；有序交付按工单/会话隔离；中途断网与重启后长文本不丢段；过期 nonce 风险被明确记录；索引可安全清理。优先复用现有 Outbox，避免维护第二套同等复杂度的交付系统。

### P1 — 对话噪声与上游原则不一致

证据：适配器在 report revision 变化时直接排队状态回复，可能包含普通 progress；同一工单的每次后续请求也会产生新的接收确认。

验收：只发送有用结果、具体问题、失败/阻塞，以及必要的一次确认；普通执行进展留在面板。用户主动 `/status` 仍可查询。

### P1 — GitHub 写入、自维护与权限隔离未验收

当前专用机器人账号的仓库有效权限核实为 read。已存在写入试点文档和默认分支保护，不代表该账号可创建分支/PR，或已完成真实写入闭环。owner 的发布凭据不应被交给 Worker。

验收：专用身份仅对目标仓库获授权；可推自己的分支并创建 PR；默认分支直接推送被拒；无授权事件不写入；人为审批保留。跨渠道身份不能因用户名相似而合并。

### P1 — 真实故障恢复覆盖不足

已完成的求和及完成后记录保留，不证明运行中断电、交付中崩溃、晚到报告、双任务隔离、人工停止跨重启等场景已通过真实验收。部分上游/适配器测试已覆盖状态逻辑，但必须单独记录真实试验结果。

验收：两个并发任务上下文隔离；模型运行中重启；发送响应丢失；问题回复后恢复；取消后的晚到结果不覆盖 stopped；重复事件不重复执行。

### P1 — 发布与运维交付

公开发行包、未提交源码、仓库外本机启动脚本目前不能作为一个可复现的版本安装。后台运行不是崩溃自动恢复，也不等于上游建议的独立健康检查。Discord Gateway、附件、审批按钮、斜杠命令注册和 token streaming 尚未实现；这些属于扩展能力，不应误列为上游 Superagent 核心必选项。

验收：干净环境安装新发布包即可运行；缺凭据有可读诊断；所有必需脚本和步骤可分发；有版本、校验和及兼容性说明；完整检查通过后再扩大部署。当前相关 14 项适配器测试通过，但扩展检查有 2 项默认权限提示断言与现行设计不一致，不能宣称全套检查通过。

## 5. 推荐交付顺序

1. **发布一致性**：提交并审查当前 Discord 实现、补齐过时测试及安装说明，生成新的预发布包；用干净 profile 验证。
2. **核心语义**：正式 Discord Source、统一 Outbox、结构化问题与全局暂停；保留 owner allowlist 直到多用户策略验收。
3. **可靠性**：暂时性 intake 错误分类、队列隔离、长输出分段恢复和索引保留策略；完成真实故障测试。
4. **贡献者试点**：在单独授权配置中验证机器人分支/PR 流程；Discord 社区讨论与任务授权保持分离。
5. **扩展渠道**：只有存在明确需求时再做 QQ/WeChat、附件、Gateway 和交互审批。

## 6. 社区与发现

仓库 Topics 仅帮助发现，不代表 DSH Market 的人工目录已经收录。
社区邀请指向 Superagent Relay 的 general 频道。加入社区不会授予机器人执行权限，也不会改变私密测试频道的权限。
真实令牌、运行目录、会话正文和本机验收证据文件不属于公开发布内容。
