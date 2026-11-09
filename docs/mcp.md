# MCP 分析服务：只读的会话日志查询层

整理日期：2026-11-09。本文定义 dsh-log-enhance 的第二能力：基于原生日志的分析查询。
采集侧设计见 [项目设计](design.md)，运行方式见 [使用说明](runtime.md)。

## 1. 定位

采集增强（Observer + Journal）回答"运行时还知道什么"；分析增强回答
"已经落盘的日志怎么方便地问出来"。两者共用一个项目，因为输入同源、版本同轨、
且分析工具的正确性契约（不推断、保留未知）与采集侧一致。

分析层是一个**只读 MCP（Model Context Protocol）服务器**，直接读取 DSH 的
Session JSONL 持久化目录，把"哪些会话、发生了什么、token 花在哪、Agent 之间
怎么协作"组织成模型可以渐进获取的查询工具。不依赖运行中的 DSH 进程，
不回写任何会话数据，不依赖 Phoenix/OTLP 等外部系统。

设计参照 Phoenix MCP 的渐进式浏览（list → get → detail），但数据模型不同：
Phoenix 查询的是已投影入库的 span，本服务查询的是原始事件流，聚合视图
（摘要、账单、协作关系）在查询时现算。

## 2. 七个工具

第一版刻意克制：只做"发生了什么"的通用事实，不绑定任何评估理论
（上下文经济学等派生解释留给上层消费者自行计算）。

| 工具 | 输入（概要） | 输出 |
|---|---|---|
| `list-sessions` | `cwd?`、`after?`、`before?`、`min_events?`、`max_results?` | 会话列表：id、cwd、创建时间、格式版本、文件大小、最后修改时间 |
| `get-session-summary` | `session_id` | 单会话画像：事件/轮次/步/工具计数、token 分解、工具分布、时延统计 |
| `list-events` | `session_id`、`type?`、`turn?`、`step?`、`from_seq?`、`to_seq?`、`max_results?` | 事件行：seq、type、time、turn/step、预览文本；返回 `next_from_seq` 续读 |
| `get-event-detail` | `session_id`、`seq`、`max_chars?` | 单个事件的完整 JSON（超长截断并标记） |
| `list-collaborations` | `session_id` | 跨 Agent 交互行：subagent 派发/结算、send_message 调用 |
| `get-token-bill` | `session_id`、`group_by`（turn/step） | 按 turn 或 step 分组的 token 账单 |
| `query-events` | `session_id`、`filter`（点路径深相等）、`max_results?` | 通用过滤逃生门，行同 `list-events` |

工具通过 MCP 客户端接入后命名空间为 `mcp__<serverName>__<toolName>`。

约定：

- `session_id` 支持全 id 或唯一后缀；后缀歧义时报错并列出候选。
- 计费输入（billed input）= `inputTokens + cacheReadTokens + cacheWriteTokens`
  （三字段互斥相加，依据 TokenUsage 契约）。
- 事件行中的 `time` 为原始 Unix 毫秒；摘要中的人读时间用 ISO 8601。
- `v3` 与 `v4` 格式都支持（v3 的 tool/result 内容嵌套在 `tool-result` 块内，
  统一折算字符数）；同一会话目录存在多代文件时读取**最高版本**。

## 3. 存储布局与读取实现

依据上游持久化实现（核查版本 `fcc0ad46`，包 `dsh-session-persistence-jsonl`）：

```
<root>/<projectKey>/<encodeSegment(sessionId)>/session.v<N>.jsonl[.zstd]
```

- `projectKey`：会话 cwd 的可读化编码（分隔符折叠为 `-`，整体包裹 `--…--`）；
  无 cwd 的会话位于 `_no-cwd`。
- 文件是**拼接式 zstd 帧容器**：帧 0 是会话头行（`type: "session"` 的 JSON），
  之后每个持久化批次是一帧独立可解压的 zstd。末帧可能因写入中断而不完整（torn
  tail），读取时忽略并标记 `truncated`。
- 帧边界扫描按 RFC 8878 帧结构（magic、frame header descriptor、block header
  链、可选 checksum）自实现，不引入 zstd 库依赖：Node ≥ 24.9 的 `node:zlib`
  提供 `zstdDecompressSync`，但不接受拼接帧，需要先切分。
- 未压缩 `.jsonl` 直接按行解析，首行为头行。

会话根目录解析优先级：`--root` 参数 > `DSH_SESSIONS_ROOT` 环境变量 >
`~/.dsh/sessions`（DSH 默认位置）。

解析结果按文件路径做有限缓存（stat 的 mtime+size 变化即失效），
`list-sessions` 只解压帧 0 读头行，不全量解析。

## 4. 崩溃隔离原则

MCP 服务崩溃不得影响插件本体，这是硬性要求，实现上分四层：

1. **进程隔离**：分析服务始终是独立 stdio 子进程。插件模式下通过
   `ctx.mcpManager.register()` 贡献一条 stdio 注册（command 为当前
   Node 可执行文件，脚本指向本包构建产物）；连接生命周期归 dsh-mcp-client
   所有，子进程崩溃只影响该 MCP 实例，宿主与插件进程不受影响。
2. **注册失败非致命**：插件在 try/catch 中注册；服务缺席、产物缺失、
   名称冲突都只记 warn 并跳过，Observer/Journal 照常工作。
3. **协议逐消息隔离**：服务器主循环对每条消息独立 try/catch；坏行返回
   JSON-RPC 错误，单次工具执行失败返回 `isError: true` 的结果，进程不退出。
4. **工具只读**：任何查询错误最坏是"该次查询失败"，不存在破坏日志的路径。

## 5. 接入方式

### 独立运行（任何 MCP 客户端）

```bash
# 构建
npm run build
# 直接启动（stdio MCP）
npx dsh-log-enhance-mcp --root ~/.dsh/sessions
# 或在客户端配置中登记：
#   command: node
#   args: [/path/to/dsh-log-enhance/dist/mcp/standalone.js, --root, ~/.dsh/sessions]
```

### 插件内嵌注册

```yaml
# 宿主 profile 中启用
dsh-log-enhance:
  mcp:
    enabled: true
    serverName: dsh-log-enhance   # 工具命名空间 mcp__dsh-log-enhance__*
    sessionRoot: ~/.dsh/sessions  # 宿主使用了非默认会话根时配置
```

注册在插件加载时尝试一次，失败仅告警。宿主也可以完全不经插件，按上面的
独立方式在 mcp-manager 的 `servers` 配置中手工登记。

## 6. 协作识别的数据依据（不推断原则）

- `subagent` 派发：原生 `tool/call`（name=subagent）的 `arguments` 含完整
  prompt；配对 `tool/result` 的正文是 `started subagent <childSessionId>`，
  这是原生日志中唯一的派发→子会话关联点，按正则提取并原样呈现。
- 结算：`user/message` 且 `source.kind === 'subagent-settled'`，以
  `source.senderSessionId` 与派发的 childSessionId 精确连接；正文长度作为
  报告规模，`stopReason` 缺失时为 `null`（不猜）。
- `send_message`：原生 `tool/call` + 配对 `tool/result`，给出目标、时长与
  成败。**入箱方的精确消息关联不在本层**——那是采集侧 Journal 的
  `message.receipt`/`message.accepted` 证据链（见 [项目设计](design.md)），
  v1 不跨层拼接，避免双源不一致时产生错误关系。
- 孤立结算通知（本会话无对应派发，如团队拉起的后台代理）单独成行，
  派发字段为 null，不做归属推测。

## 7. 限制与后续方向

- 工具级 token 归因不可推导：usage 挂在模型调用（assistant/message）上，
  一步内的多次工具调用共享该步账单，`get-token-bill` 只提供 turn/step 分组。
- 尚未实现（候选后续）：`get-context-snapshot`（surface 投影重建，"模型当时
  看到什么"）、异常模式检测（空返回、失败后内联爆发、轮询）、Journal 证据
  JOIN（`get-log-enhance`）、多会话对比。
- 快照脱敏文件（无 `seq`/`time`）能容忍解析，但过滤与排序退化为数组序。

## 8. 验证记录

- 2026-11-09：帧扫描与多帧解压在本机真实会话文件验证
  （842 帧 / 1555 行，`~/.dsh/sessions`）；目录布局、事件形状、usage 字段、
  subagent 派发-结算链路均对照真实数据确认。基线 `fcc0ad46`。
