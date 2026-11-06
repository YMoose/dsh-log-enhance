# 迁入的研究与经验

整理日期：2026-11-06。本文筛选原 `dsh-genai-obs` 的有用资料，供新项目独立使用。
旧资料检查日期为 **2026-11-03**，Harness 基线为 [`ce7073d`][old-harness]。
社区版本、质量发现和维护统计均是历史快照，本次没有重新运行第三方测试或联网复验其最新状态。

## 1. 迁移清单与结论更新

| 原资料 | 迁入的内容 | 本次处理 |
|---|---|---|
| `docs/source-audit.md` | 运行时与日志边界、恢复、内容政策、持久化、身份与时间语义 | 核心接口按当前提交重核，见 [上游契约](upstream-audit.md)；其他项保留历史标签 |
| `docs/agent-team-observability.md` | 消息阶段、缺失来源、任务 owner/actor、并发验收场景 | 当前成员、消息和任务契约见上游核查；保留来源提议和行为边界 |
| `docs/loongsuite-maintenance.md` | 原型教训、观察器隔离、迟到事件、队列与关闭测试 | 转为本项目可复用要求；LoongSuite 专用贡献流程不作为新项目约束 |
| `docs/community-comparison.md` | 社区定位、固定提交、证据强度与讨论入口 | 保留对本方向有用的索引与历史发现，不发布新的插件排名 |
| `LICENSE` | MIT 许可与原版权署名 | 保存在项目根目录 |

旧运行时代码、构建配置、专用 span 树、ID hash 公式及 exporter 实现没有迁入。
旧目录的 Git 历史也没有复制；迁入内容来自其当前文档文件，包括尚未提交的研究笔记。
本文和其余新文档均不需要读取旧目录即可使用。

当前能力边界：

- `send_message` 执行返回 messageId，默认渲染与持久化未保留它。
- 插件可补充成功路径的消息来源；覆盖接受后失败/崩溃窗口仍需上游来源字段。
- OTel Span Links 可表达多来源关系；日志回放、完整持久化和后端展示需要分别验证。

## 2. 可直接复用的工程经验

| 经验 | 新项目应采用的约束或验证 |
|---|---|
| 上游 API 演进快，自建宽松结构类型掩盖漂移 | 使用目标 Harness 的真实类型和契约测试；不靠整段 unknown cast 声称兼容 |
| 观察器可能在失败、取消和提前停止流时出错 | 不替换原始异常、不重复调用 next、不重复结算；纯观察优先使用明确通知接口 |
| 工具结果可能晚于原 turn 边界 | 保留原始 invocation 身份，不能归给随后开始的新 turn |
| fork/restore/HMR 会重复出现历史 | 区分自有事件、继承前缀、恢复状态和现场观察；恢复元数据不等于新执行 |
| 大量不结算调用可能耗尽索引容量 | 对 pending join 与活跃状态设边界；淘汰可诊断，不能静默错配 |
| 在 session/flush 中等待远端 sender 会拖住持久化 | 补充存储、远端导出、原生日志 checkpoint 的职责与等待关系分别设计 |
| dispose 返回后仍有 in-flight 写入会访问已关闭存储 | drain/cancel 与关闭顺序明确，统一截止时间，覆盖失败收尾 |
| 队列淘汰可能误删正在发送的数据 | pending 与 in-flight 所有权分开，完成回调不能删除后续新记录 |
| 内容门控常遗漏名称、标题、路径与替代出口 | 所有输出走一致政策；首版关联记录只存所需 ID、状态与证据引用 |
| 稳定 ID 不等于 exactly-once | 验证实际去重、崩溃恢复与重放行为，声明其保证范围 |
| import、dump-config、非空输出证明力有限 | 用真实执行路径产生已知事实，并读回结果验证语义 |
| 安装了 redactor 不代表旁路数据已脱敏 | 核查每条采集、存储与导出路径的实际政策 |

首版消息专用验收矩阵见 [项目设计](design.md)。这些要求来自旧研究经验，不能写成新插件已通过的测试。

## 3. 后续能力候选：保留问题，逐项重核

以下部分来自 2026-11-03 的源码核查；除当前上游契约明确复核的条目外，实施前仍需重新验证。

- **模型身份与请求边界**：请求配置中的 model 不证明响应模型；provider-neutral 的 llm hook 不等于
  最终 HTTP body 或网络发送成功。辅助请求可能没有主 turn/step 的同样坐标。
- **时间语义**：整个 step 包含工具工作时，step 时长不能当纯 LLM 延迟；residency、turn 与任务状态区间
  分别计时。wall clock 与 monotonic 时钟的用途需要分清。
- **重试与 usage**：重试不一定经过某个内置 retry 插件通知；失败 attempt 的已报告 usage 仍属于该次请求；
  多次累计 usage 取最终有效值，不能逐条相加。旧核查中输入桶互斥，reasoning 已含在输出桶内；
  将来实现用量增强时重新检查目标版本和 provider 契约。
- **压缩**：旧契约以 compactionId 配对，turn 可以为空，压缩事务可能不调用 LLM；事务时长不代表模型延迟。
- **任务审计**：owner 不等于 actor；snapshot 差分不证明具体 action；一个成员多个任务时不能擅自分摊 token。
  当前 task mutation 已提交但 flush 未确认时可能报错，这一点已在上游契约中复核。
- **外部 Agent 产品**：Harness runId、外部 session/thread/artifact ID 是不同身份；需要提供方显式给出映射。
  工作目录指纹不能作为确定的来源关联。
- **宿主生命周期**：旧核查中的整树退出宽限为 5 秒，多个组件分别配置 5 秒并不满足总预算；新实现需重新核实宿主规则。

## 4. 社区参考：固定历史提交

以下版本是当时源码 manifest 的版本，不保证等于当前 npm 发布。

| 项目 | 2026-11-03 基线 | 对本项目有用的参考 |
|---|---|---|
| [LoongSuite dsh-plugin][loong] | 0.1.3 / f44ccfc | Session/LLM hook、逐 attempt 观察、内容政策；可作为未来语义数据消费者 |
| [dsh-observe][observe] | 0.2.26 / db17823 | spool/status、发送生命周期、安装验证；区分观测事实和启发式重试推断 |
| [dsh-plugin-langfuse][langfuse] | 0.9.0 / 5fc5f6b | sessionTelemetry backend、父上下文、反馈、delivery health |
| [dsh-agent-observability][reliability] | 0.1.0 / 1c32f3b | 事件证据定位、覆盖率与可读报告 |
| [dsh-plugin-agent-insights][insights] | 0.1.0 / 241f7bb | runtime 统计服务和工具计时 |
| [dsh-eval-control][eval] | 0.5.0 / 5c2eddd | observed/derived/inferred 分类，Team 与上下文分析 |
| [dsh-telemetry-redactor][redactor] | 0.1.0 / 811b0b1 | session-telemetry/record 的覆盖范围与旁路边界 |
| [dsh-context-provenance][provenance] | 0.1.2 / 601ceed | 内容来源审计；与执行因果、成功状态分别建模 |
| [dsh-observability][external] | 0.1.0 / f5bdac5 | 外部产品 artifact 归属需求及证据不足的风险 |

日志语义增强与来源审计、可靠性分析存在部分交集。新功能应列出新增了什么证据、谁可以消费，
不把“有结构化字段”“有确定性 ID”“支持 OTLP”本身当作独有能力。
当时检查的 LoongSuite、dsh-observe、dsh-eval-control 为 Apache-2.0，其余表中仓库为 MIT；
实际引入代码时仍以所选提交的 LICENSE 为准。

### 历史发现的证据强度

- 旧研究静态发现 LoongSuite 将请求模型写成 response model、自建 Harness 结构类型；
  当时并未执行其完整测试套件，不据此声称当前仍有同样问题。
- 旧笔记记录了对 dsh-observe `db17823` 的一次模拟 sink/spool 隔离复现：dispose 返回时发送仍 pending，
  随后失败路径尝试访问已关闭 spool。本次未重跑，亦未证明真实文件系统损失或新版仍受影响。
- 旧比较窗口 2026-10-04 至 2026-11-03：LoongSuite 返回 3 条可达提交；dsh-observe 返回 54 条，
  其中 12 条 Dependabot。统计含 merge/release，只说明当时可见活动，不预测维护质量或未来响应。
- HTTP 路径、content-type、非空 protobuf 或配置 row 是有限证据，不能代替解码后语义或完整执行验证。

## 5. 社区讨论入口

以下索引继承旧资料对正文和评论的核查；帖子中的提议、缺陷报告和旧版行为不能直接当作当前实现。

| 讨论 | 可参考的问题 |
|---|---|
| [#1699](https://github.com/deepseek-ai/deepseek-harness/discussions/1699) | LoongSuite、GenAI 表达与跨系统上下文 |
| [#1007](https://github.com/deepseek-ai/deepseek-harness/discussions/1007) | Langfuse、invocation correlation、反馈与 delivery health |
| [#2542](https://github.com/deepseek-ai/deepseek-harness/discussions/2542) | dsh-observe、非阻塞 flush、spool/status |
| [#8754](https://github.com/deepseek-ai/deepseek-harness/discussions/8754) | 事件证据、覆盖率与安装验证 |
| [#6662](https://github.com/deepseek-ai/deepseek-harness/discussions/6662) | Session 级统计服务 |
| [#10365](https://github.com/deepseek-ai/deepseek-harness/discussions/10365) | Team/上下文分析，事实与推测的区分 |
| [#1365](https://github.com/deepseek-ai/deepseek-harness/discussions/1365) | Trust Layer、脱敏与来源审计 |
| [#933](https://github.com/deepseek-ai/deepseek-harness/discussions/933) | 官方日志与社区观测能力的边界 |
| [#5110](https://github.com/deepseek-ai/deepseek-harness/discussions/5110) | 历史 token/费用账本与实时 best-effort 指标的区别 |
| [#10022](https://github.com/deepseek-ai/deepseek-harness/discussions/10022) | 退出、激活、自身诊断与截止时间 |
| [#9543](https://github.com/deepseek-ai/deepseek-harness/discussions/9543) | 插件配置和错误的可见性 |
| [#10604](https://github.com/deepseek-ai/deepseek-harness/discussions/10604) | 配置展示与实际开关行为 |
| [#4100](https://github.com/deepseek-ai/deepseek-harness/discussions/4100) | 历史 FULL 模式报告与内容采集政策 |
| [#4313](https://github.com/deepseek-ai/deepseek-harness/discussions/4313) | session.export 属独立出口，需单独核查 |
| [#952](https://github.com/deepseek-ai/deepseek-harness/discussions/952) | 标识字段的传播与披露 |
| [#1493](https://github.com/deepseek-ai/deepseek-harness/discussions/1493) | 外部产品 Session/run/artifact 的明确引用契约 |
| [#506](https://github.com/deepseek-ai/deepseek-harness/discussions/506) | 观察生命周期与控制 hook 的区别 |
| [#1300](https://github.com/deepseek-ai/deepseek-harness/discussions/1300) | MCP 连接健康与具体工具执行结果 |
| [#11256](https://github.com/deepseek-ai/deepseek-harness/discussions/11256) | Session 路由 header 与 tracing context 的区别 |
| [#7057](https://github.com/deepseek-ai/deepseek-harness/discussions/7057) | invocation carrier 的并发隔离、重试与清理 |

[old-harness]: https://github.com/deepseek-ai/deepseek-harness/tree/ce7073d51254c26cd63b22a60835b8f948deb447
[loong]: https://github.com/loongsuite/dsh-plugin/tree/f44ccfcd2255186bfcfe1c9f8c7db047204865b7
[observe]: https://github.com/PerryLink/dsh-observe/tree/db178232276facadd9991d44d2733a5a734b3a09
[langfuse]: https://github.com/linyp/dsh-plugin-langfuse/tree/5fc5f6bd93834123545d5006a5e2344ca3b8cc03
[reliability]: https://github.com/beibeihk/dsh-agent-observability/tree/1c32f3bd01d3e259bb685e1c24b4978af838c140
[insights]: https://github.com/Claven07/dsh-plugin-agent-insights/tree/241f7bb4a028fb3c30db7f0ccecab23719abffc6
[eval]: https://github.com/xyrrrrr-r/dsh-eval-control/tree/5c2edddea0dd221215cfd11c2fc69e791651a385
[redactor]: https://github.com/030611/dsh-telemetry-redactor/tree/811b0b1abf424e57045ab5a5eaa203660ca43908
[provenance]: https://github.com/030611/dsh-context-provenance/tree/601ceed5a8bc3c8d40cbab0211086efa5729400b
[external]: https://github.com/jeremy9682/dsh-observability/tree/f5bdac556c0f4e6b61bd89201ec0e2401fb45c8e
