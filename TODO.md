# TODO：记录部署代码版本

提出日期：2026-11-09。Harness 基线：
[`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`][harness]（源码包版本 `0.2.2-rc.1`）。

本文记录一个待补的事实缺口，不是已完成能力。事实按“已核查源码”标注；
方案部分尚未实现或验证。

## 问题

DSH 上游把“模型可见即已记录”作为硬约束，会话日志能重建每次 loop 请求的输入：
`request/header` 给出调用配置和工具 schema，surface 事件经 `deriveMessages()` 给出
消息历史，带图片的请求再通过附件 digest 解析字节。上游 Agent Note 的表述是，
持有“日志、被引用附件对象和**固定的代码版本**”者，可以逐字节重建每个 loop 请求。

最后一项不在日志里。核查基线（`fcc0ad46`）确认：

- 物理头行 `HeaderLine` 只含 `type`、`version`、`id`、`createdAt`、`cwd?`、
  `parentSession?`、`isSeeded`、`origin?`、`delegationDepth`、`agentPreset?`。
- 其中 `version` 是 **Session 日志格式版本**（当前 `SESSION_FORMAT_VERSION = 4`），
  说明这份 JSON 如何解析，不说明是哪个 harness 版本写出的。
- `agentPreset` 是组合标识（模块名或 preset 名），携带版本时也只覆盖 preset 本身。
- 全仓检索没有 `dshVersion` / `harnessVersion` / `buildId` / `codeVersion` 一类字段
  进入 Session 事件或头行。
- 遥测侧同样只有 `session.format_version`，与头行同源。

结果是：一份导出的会话日志，在脱离原始部署后无法确定应当用哪份代码去重建请求。
上游把“固定代码版本”当作复现的**前置假设**而非日志职责，这里记录的是我方观察到的
缺口，不据此认定上游缺陷。

## 与项目已有基线记录的关系

本项目目前以人工方式补这件事，属于同一问题的临时解：

- `README.md` 与 `docs/runtime.md` 手写记录 Harness 提交和包版本。
- `docs/upstream-audit.md` 的链接全部钉在同一提交上。
- `src/records.ts` 的 `PRODUCER` 记录的是**插件自身**版本（`dsh-log-enhance/${PACKAGE_VERSION}`，
  由 `src/version.ts` 在运行时从最近的 `package.json` 派生，仓库内无第二处版本字面量），
  不是被观测的宿主版本。

人工记录随文档更新漂移，且不进入补充日志，因此无法按记录粒度回答“这条观察是哪份
代码下产生的”。

## 已核查的可用素材

写方案前先分清哪些当前可得。

| 素材 | 可得性 | 覆盖范围 | 来源 |
|---|---|---|---|
| Session 格式版本 | 日志内，随 `SessionHeader.version` 出现 | 只说明解析规则 | `@deepseek-ai/dsh-session` |
| Harness 语义版本 | 运行时可读 | 部署自报的 semver | `getDshRuntimeVersion()`，公开导出自 `@deepseek-ai/dsh-app-boot` |
| Harness 提交 SHA | 日志与运行时接口都没有 | 打包安装后无从取得 | — |
| 插件包清单及版本 | 仅官方 DeepSeek 请求体 | 不进 Session 日志；失败即省略 | `@deepseek-ai/dsh-plugin-package-inventory-deepseek` |
| `agentPreset` | 日志内 | 只是组合名 | `SessionHeader` / `agent-preset/selected` |

两点需要强调。第一，**semver 不足以定位重建基线**：`docs/runtime.md` 已写明
“相同 semver 的不同源码提交也应重新验证”，所以记录必须能表达提交级身份。第二，
插件清单走的是请求侧扩展字段，只对官方 endpoint 生效，且明确“不阻塞模型请求”，
因此不能当作日志事实来源。

## 候选方案

按“先能做、后依赖上游”排序。任何方案都必须遵守本项目边界：不改变 Agent 工具行为
与模型输入，不写 DSH 主日志，只保存身份与证据引用。

### A. 显式配置部署身份（建议先做）

在插件 `Config` 增加部署身份字段，由 profile patch 填写，随每次激活写入补充日志。

- 优点：不依赖新上游接口；能表达任意身份（提交 SHA、镜像 digest、内部构建号）；
  与项目“配置必须可部署变更”的原则一致。
- 缺点：手工维护，漏填即失去证据；需要定义缺省时的行为——按本项目惯例应显式记录为
  未知，不静默留空。
- 待定：按记录粒度重复写会造成体积膨胀，倾向“每次激活写一条带身份的会话级记录，
  其余记录引用它”。

### B. 自动读取运行时版本（作为 A 的补充）

调用 `getDshRuntimeVersion()` 取 semver，与 A 的显式身份交叉校验；两者不一致时
报告冲突，不择一信任。

- 优点：可自动发现“配置里写的版本与实际加载的不一致”。
- 缺点：需要新增对 `@deepseek-ai/dsh-app-boot` 的依赖并重新验证 peer 基线；该函数
  在打包安装下按包清单读取，拿到的仍是 semver。
- 待定：是否值得为一个字符串引入该依赖，或改由部署脚本在启动时注入。

### C. 读取 checkout 的 `.git/HEAD`（不建议）

只在源码 checkout 下成立，打包安装无效，且依赖宿主文件布局。与项目“不假设部署形态”
的取向冲突。列为已排除项以免重复讨论。

### D. 上游提案：Session 头记录代码版本（长期）

向 DSH 提议在 `SessionHeader` 增加版本字段。真正解决问题，但属于上游扩展，按
`docs/design.md` 第 6 节同类问题（消息来源）的处理方式登记为提案，需先确认对方的
持久化兼容与 Reader 兼容判断，不在本项目内单方面假设。

## 验收标准

实现时按下列场景验证，并实际读回补充记录，不以“插件已加载”或“文件非空”作为证据。

| 场景 | 应证明的行为 |
|---|---|
| 未配置部署身份 | 记录显式标注未知，不编造版本，不阻塞任何工具调用 |
| 已配置完整身份 | 宿主语义版本与本项目插件版本可区分，并指向同一激活会话 |
| 配置与实际加载版本不符 | 报告冲突，供查询层输出；不静默采用其中之一 |
| 记录不含身份引用 | 查询层输出覆盖缺口，而非默认套用当前部署身份 |
| 插件禁用前后同一确定性任务 | 模型请求、工具结果与执行语义不变 |
| 提交流失或部署迁移 | 旧记录的部署身份保持原值，不随新部署被重新解释 |

## 开放问题

- 身份的边界到哪里：只记 harness 提交，还是同时记锁文件摘要与已启用插件集？后者
  更利于复现，但扩大了“最小证据”的范围，需要先确认是否越界。
- 跨恢复语义：部署升级后恢复旧 Session，新记录带新身份，查询是否应把同一个 Session
  判为跨多个身份？倾向如实分段，不合并。
- 与上游 `dsh_plugin_packages` 的关系：确认后者永远不进 Session 日志后，才能排除
  “无需自己记录”的可能性。
- 是否需要 CLI 输出展示该身份，以及展示的默认粒度。

## 关联

- 上游可重建性依据：[reconstructable-requests Agent Note][note]
- 本项目记录协议：[使用说明](docs/runtime.md)
- 本项目设计边界：[项目设计](docs/design.md)（第 2、5、6 节）
- 上游接口依据：[当前上游契约](docs/upstream-audit.md)

[harness]: https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159
[note]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md
