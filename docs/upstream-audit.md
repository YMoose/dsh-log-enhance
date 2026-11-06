# 当前上游契约与缺口

检查日期：2026-11-06。Harness 基线：[`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`][harness]。
证据等级：**静态源码与官方仓库文档核查**。尚未编写或执行本项目插件测试。
链接固定到该提交；后续升级应重新核查，而非把这些行为假定为永久契约。

## 1. 日志、运行时通知与工具结果

| 接口或记录 | 已核实的含义 | 对本项目的影响 |
|---|---|---|
| [`session/event`][session] | append 后通知，观察者失败隔离；构造 seed 不作为 live feed 重发 | 可采集已提交事实，不能把通知当作磁盘持久化确认 |
| [`tool/call`][batch] | 包含 turn、step、callId、name、arguments | Native 来源用该事件身份定位 |
| [`tools/result`][tool-events] | 运行时最终结果通知，包含 exec 与成功 value；观察者错误受隔离 | 可以捕获默认日志未保存的 messageId |
| [`ToolExecutionSuccess.value`][contracts] | 明确标记为 execution-local，默认不进入 durable events | 运行时结果和持久化结果必须分别处理 |
| [`tool/result`][batch] | 保存渲染后的消息、可选 error 和 meta；sourceEventSeqs 引用 call | 不自动保存完整返回对象，不能把 value 当作日志里已有的数据 |
| [`createSuccessResult`][pipeline] | 只有声明 presentationMeta 才把对应投影写入 meta | 当前 send_message 未声明该投影 |

`tools/result` 通知在工具 pipeline 完成处发出，batch 随后才提交原生 `tool/result`。
exec 包含 `callId`、`rootCallId`、agent 及嵌套执行身份；并不直接提供完整的持久化事件坐标。
关联器需要从实际原生记录取得坐标，不能采样“此刻所在 step”替代原始调用身份。

## 2. send_message 的完整证据链

| 位置 | 当前事实 |
|---|---|
| [`tool-subagent-control`][send-tool] | 解析目标名称为 Session ID；执行返回 `{ messageId }`；模型可见文本仅为投递确认，未包含 ID |
| [`SubagentSendMessageOptions`][subagent-types] | 当前只有 signal，没有调用 origin 字段 |
| [`SubagentManager.sendMessage` / `deliverToMember`][manager] | 返回实际接收方入箱消息 ID；在目标入箱处创建最终消息 |
| [`AgentMessageSource`][message-source] | 当前有 kind、form、senderSessionId；没有 sender turn/step/callId |
| [`agent/inbox/spliced`][agent-types] | 接收 Session 自己的事件包含 inserted UserMessage，提供最终消息 ID/source |

manager 内部用于组装内容的临时消息 ID 不应当作接收 ID。使用返回值或实际入箱记录中的 ID。
插件可在成功路径将回执与入箱记录按明确身份连接；只读历史原生日志无法保证补回此关系。
最终结果取消、失败、观察器漏收或崩溃窗口，都可能导致有接受事实而没有可用的成功 value。

## 3. Inbox、surface 与请求

[`inbox.ts`][inbox] 在 splice 提交后发 inserted/discarded 通知；claim 先移除 pending input，
再以消息和 turn 发 `agent/inbox/claimed`。移除数量本身不携带被移除消息 ID，恢复需要前置状态。

[`agent.ts`][loop] 先 claim，再执行 pre-step；获准进入的消息随后以 append-form `user/message`
进入 surface，再构建请求。`user/message` 不自带完整 turn/step 坐标，需结合明确的执行边界。
pre-step 可以拒绝或改写消息；compaction、替换和请求变换也需要区分。
已入箱、已领取、已进入 surface、某次请求携带了消息、模型处理完成不是同一状态。

## 4. Team 任务与成员模型

当前代码位于 [`packages/team/agent-team`][team] 和 `packages/team/tool-agent-team`。

- Team 是现有 subagent tree 上的共享任务板；成员发现、通信、恢复由 subagent service 负责。
- 任务分配权限来自当前 subagent tree：root 可分配给自身或可达的 continuable 后代。
- Team 模式与普通 subagent 树存在是两回事，不能把所有 root 都当成已启用任务板。
- [`team/task`][team-journal] 在 root Session 保存 `{ version: 2, teamId, task }` 的 revision snapshot。
  当前 [`TeamTaskSnapshot`][team-types] 有 owner 等状态，不提供完整的变更 actor/action/call origin。
- task append 后服务等待 flush；持久化未确认可能报错，但已经可见的 revision 不会被撤回。
  因此不能仅凭工具成功与否判断 mutation 是否提交。

任务 owner、修改者、执行者及创建调用应分别建模。服务收到 caller 不等于 caller 已保存进日志。
要审计任务变更来源，需要额外明确契约；不能从 snapshot 差分猜出具体命令。

## 5. 第三方持久化扩展边界

[`Session README`][session-readme] 明确说明：

> Plugins outside this repository must not call it either, although no repository check can inspect them.

这里的 `it` 是 `appendPluginRecord()`，其生产使用仅限仓库内 `packages/experimental/`。
这是上游接口约束，不是本项目增加的审批流程。独立插件首版使用自己的补充存储。

虽然 `SessionEventMap` 支持声明合并，但 [`KNOWN_SESSION_EVENT_TYPES`][known-events] 由上游构建生成。
持久化读取对未知且未标记 ignorable 的事件拒绝恢复；普通 `session.append()` 不提供给外部插件
随意添加该标记的公开选项。声明一个类型与提供可升级、可恢复的外部写入协议不是一回事。
未来若希望补充记录进入主日志，应先解决上游公开接口与恢复兼容，而非调用私有入口。

Session append 是内存提交与通知边界，持久化插件异步工作；需要磁盘保证的生产者显式等待
`ctx.sessions.flush(session)`。补充存储的写入成功不代表原生日志已 flush，反之亦然。

## 6. Fork、恢复与遥测通道

- [`firstLiveSeq`、`firstLifecycleSeq`、`inheritedEventCount`][session] 的语义不同；seed 事件不走
  live append 通知。子 Session 的继承前缀不能当作子方新发生的消息或工具执行。
- 同一 Session 内 seq 表示顺序，不定义跨 Session 的全局先后或因果。
- [`ctx.otel`][otel] 提供 event/session logs reporter 工厂；这里没有现成的 GenAI trace 模型。
- [`session-telemetry`][session-telemetry] 对 canonical 事件按 ledger 记录交付，传输 best-effort；
  handoff 不等于接收成功，重复与丢失均需考虑。
- [`session-telemetry-otel`][session-otel] 默认 FEEDBACK_ONLY，拒绝 FULL，DISABLED 不创建传输；
  直接 emit 不能绕过其授权。补充日志不会自动被该通道采集或获得同样的策略保护。
- `session-telemetry/record` 只处理导出副本；旁路 hook、自有文件和其他 exporter 的内容边界需另行落实。

## 7. 可选 OTel 消费层的核查记录

2026-11-06 对照 GenAI 独立仓库 [`e713f345`][genai]：工具执行有 `execute_tool` 和
`gen_ai.tool.call.id`，Agent transfer 与 A2A 有各自适用条件；不能把普通 DSH 邮箱投递直接
认定为 A2A 或控制权转交。相关 GenAI 约定仍标记为 Development。

OTel [Span Link][span-link] 可关联同一或不同 trace 的 span，支持多个来源；GenAI 约定不自动补出
DSH 缺失的调用来源。原生事件身份仍应保留，OTel span 身份由适配层映射。
后端是否实际保留、查询和展示 Links，需要独立验证。

[harness]: https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159
[session]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/index.ts
[batch]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/batch.ts
[tool-events]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/events.ts
[contracts]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/contracts.ts
[pipeline]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/pipeline.ts
[send-tool]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/tool-subagent-control/src/index.ts
[subagent-types]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/src/types.ts
[manager]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/src/manager.ts
[message-source]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/src/continuation-messages.ts
[agent-types]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent/src/types.ts
[inbox]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/inbox.ts
[loop]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/agent.ts
[team]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/team/agent-team/README.md
[team-journal]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/team/agent-team/src/journal.ts
[team-types]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/team/agent-team/src/types.ts
[session-readme]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/README.md#write-experimental-plugin-records
[known-events]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/known-event-types.ts
[otel]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/telemetry/otel/src/index.ts
[session-telemetry]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/session-telemetry.md
[session-otel]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-telemetry-otel/README.md
[genai]: https://github.com/open-telemetry/semantic-conventions-genai/tree/e713f345c1d5f6d888b2f3bbddf1a863395b784c/docs/gen-ai
[span-link]: https://opentelemetry.io/docs/specs/otel/trace/api/#link
