# 使用说明与 v1 记录协议

版本：0.1.0。更新日期：2026-11-06。

## 已实现的范围

插件通过公开 hook 观察 Native `send_message`，保存调用回执与接收方消息的最小身份信息。
它不改写原生 Session 日志，不修改工具参数/结果，不向模型添加消息，不上传数据。
查询层按精确 ID 连接证据，输出来源、消息阶段和覆盖缺口。

已验证 Harness `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，其包版本为 `0.2.2-rc.1`。
peer dependencies 固定到这一 API 基线；相同 semver 的不同源码提交也应重新验证。

## 安装与配置

从已构建的 checkout 开发：

```sh
npm run link:harness -- /path/to/deepseek-harness
npm run check
npm pack
dsh plugin --profile headless add ./dsh-log-enhance-0.1.0.tgz
```

`link:harness` 只在本项目的 node_modules 内创建链接；不会执行 Harness 构建、修改其代码或配置。
Harness 的准备步骤以其自身文档为准。项目当前没有发布到 npm registry。

包内 `dsh.bundle.patch` 指向 `cordis.patch.yml`，包含 `dsh-log-enhance` 插件行。
在目标 profile 的 patch 中替换该行配置，例如：

```yaml
- id: dsh-log-enhance
  config:
    directory: /absolute/path/to/observations
    maxEntries: 4096
    indexTtlMs: 3600000
    maxPendingBytes: 4194304
    maxQueuedRecords: 4096
    shutdownTimeoutMs: 2000
```

| 配置 | 默认值 | 含义 |
|---|---|---|
| directory | `.dsh-log-enhance` | 相对宿主启动目录解析；推荐显式持久路径 |
| maxEntries | 4096 | 每个在线身份索引的条目上限 |
| indexTtlMs | 3600000 | 在线索引保留时间，过期报告覆盖缺口 |
| maxPendingBytes | 4194304 | 尚未完成写入的序列化数据预算，包含 in-flight 数据 |
| maxQueuedRecords | 4096 | 等待写入的记录数上限，不含当前正在写的一条 |
| shutdownTimeoutMs | 2000 | 插件关闭等待预算 |

数值配置必须为正安全整数且不超过 2147483647。每条 JSONL 记录最大 64 KiB。
记录包含身份和状态，不复制提示词、消息正文、工具参数/输出或完整错误对象。
官方遥测的禁用/反馈设置不控制这个独立本地插件；停止采集应禁用该插件行或移除 bundle。

## 记录

每条记录包含 `schemaVersion: 1`、`producer`、`id`、`observedAt`、`type` 和相应字段。
`observedAt` 是插件观察时间，不作为跨 Session 因果或执行耗时依据。

| type | 字段 | 证据 |
|---|---|---|
| message.accepted | target、senderSessionId | 当前 Session 自有的 live inbox 插入事件 |
| message.receipt | source、messageId | Native 执行上下文对应的 tools/result 成功 value |
| message.claimed | target、turn | agent/inbox/claimed 通知与已知 pending occurrence |
| message.admitted | target、event、turn、step | 已领取消息的 append-form user/message |
| message.canceled | target | agent/inbox/discarded 与已知 pending occurrence |
| coverage.gap | reason、可选 sessionId | 来源、阶段或缓存覆盖不足；不表示业务执行失败 |

`source` 是 `{ sessionId, formatVersion, seq, turn, step, callId }`，seq 指向原生 `tool/call`。
`target` 是 `{ sessionId, formatVersion, seq, messageId }`，seq 指向原生入箱插入事件。
`message.admitted.event` 引用原生 `user/message`。同一 messageId 再次入箱由不同 seq 区分。

`id` 是固定字段顺序的事实身份 SHA-256，重放时稳定；不同观测时间不改变同一事实身份。
coverage.gap 使用单独身份以保留每次缺口报告。哈希用于去重，不构成真实性签名或原生日志落盘证明。

## 查询

```sh
node dist/cli.js query /absolute/path/to/observations
node dist/cli.js query /absolute/path/to/observations --max-records 200000
```

安装包后也可使用 `dsh-log-enhance query <directory>`。
查询读入目录中所有普通 `.jsonl` 文件，以 ID 去重，按 sender Session + messageId 连接回执与接受事实。
只有唯一调用和唯一入箱 occurrence 才输出 `linked` 及 source；没有回执为 `unknown`，多个候选为 `ambiguous`。
一次调用可以有多个不同消息的回执。来源事件坐标冲突时查询失败，避免输出确定但错误的来源。

输出还包含阶段数组、`evidenceIds`、覆盖缺口计数、未匹配回执数、缺少接受证据的阶段记录数、去重计数和读取诊断。
阶段是分别观察到的事实，不是强制线性状态机；`admitted` 表示进入 surface，不证明已发送给 provider
或任务处理完成。完整证据保存在原始补充记录，查询摘要不会自动显示全部生命周期坐标。

默认最多处理 100000 条唯一记录，超限失败，不静默截断关系。读取行长度受限；坏行、未知 schema
和未完成尾行会跳过并报告。CLI 正常退出为 0，有读取诊断为 2，查询失败为 1。
正在写入的文件可以被查询，但一次查询不是所有文件的原子快照。

## 持久化和恢复边界

- 每次插件激活创建独立文件，目录默认权限 0700，新文件 0600；不改已有目录的权限。
- 单写入队列保持该文件顺序；写入失败后停止使用该文件，避免把新记录追加到可能损坏的尾部。
- 普通 enqueue 与 append 完成不等于 fsync。正常关闭会等待写入并同步文件；测试/库调用可显式 flush。
- 关闭超时丢弃尚未开始的记录，当前写入仍由原 owner 等待后再关闭 handle，避免写入访问已关闭文件。
- 接受与回执分别保存；保存成功的证据在下一次离线查询中可重新关联。只保存一侧时维持未知。
- 插件重载和 fork 不读取历史 seed 重新制造 live 事件。启动前或重载窗口内发生的运行时事实不会被补造。
- 队列拒收、存储错误和关闭超时通过插件诊断日志报告；存储本身不可用时不承诺能把诊断也写进它。
- 文件不会自动轮转删除。长时间运行需要按自己的保留策略管理目录；当前没有自动归档、加密或远端同步。

DSH 主日志与补充文件之间没有原子提交。B 已接受后、回执观察或补充写入前进程退出，仍可能没有来源证据。
原生 append 也不证明其持久化完成，因此 `linked` 表示插件保存了相应观察，而非跨日志事务保证。

## 当前覆盖限制

- PTC 嵌套 send_message 会报告 `nested-call-unsupported`，不绑定到外层 run_code。
- service 直接发送、工具回执缺失、执行绑定错过或含糊时，接收事实仍可记录，来源保持未知。
- 未完成调用/消息的在线索引不会跨插件重载恢复；已保存的证据由离线查询重放。
- 任务 actor/action、任务成本、外部产品会话身份与 OTel 导出尚未实现。
- schema v1 未提供跨 Harness 持久化格式迁移的引用重写；记录保留原始 formatVersion。

## 验证

`npm run check` 执行 TypeScript 检查、组件测试、真实 Cordis Loader/AgentLoop 集成测试和构建。
集成测试使用实际 subagent service 和 send_message 工具，以及确定性 LLM adapter，无网络模型调用。

已覆盖：精确 ID 关联、重复回放、歧义和缺失来源、记录校验、查询容量、坏行与不完整尾部、
慢写入、写失败、关闭超时、checkpoint 与关闭交错；实际并发发送者使用相同 callId 和正文、
接收方拒绝 pre-step、投递后工具失败、Loader 重载、实际 fork，以及相同 ID 的 pending 替换和索引淘汰。
另比较启用/禁用插件的模型可见消息内容与工具结果。

进程强制终止的全链路落盘保证、网络模型调用、所有 PTC 路径和任意 Harness 版本兼容性未验证。
