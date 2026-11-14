/**
 * 隐性契约清单（层 2 中"代码里在赌、但机器扫不出"的那一半）。
 *
 * `scripts/analyze-dsh-coupling.mjs` 的 AST 清单能回答"代码今天导入了什么、
 * 注册了哪些 hook、读了哪些注解类型上的字段"。它读不出来的是**语义押注**：
 * 一条日志文本的措辞、一个 JSON 记录里的字段名、一个对象的引用身份、一个
 * 只在宿主注入了服务之后才存在的属性。这些地方没有类型可依赖，改上游不会
 * 编译失败，只会悄悄给出错误结论。
 *
 * 于是本文件是"人工盖章"：扫描器把 src 里疑似押注的代码形状报出来，每一处
 * 要么绑定到下面某条契约的 `acknowledged`，要么在 `ignored` 里写明为什么它
 * 只是本项目内部逻辑。`--check` 只报备、不失败（阶段 B 才会接上真探针）。
 *
 * `acknowledged` / `ignored` 的条目语法（`—` 之后是给人看的理由，匹配时丢弃）：
 *
 *   src/foo.ts                 整个文件（少用，会让该文件里新增的嫌疑静默通过）
 *   src/foo.ts:123             单行
 *   src/foo.ts:110-133         行区间（嫌疑条目的行跨度与该区间相交即算覆盖）
 *   src/foo.ts:24,30           多行/多区间
 *   src/foo.ts:/^started /     该文件内嫌疑描述匹配正则（用于易漂移的行号）
 *
 * 校验方式：
 *   node scripts/analyze-dsh-coupling.mjs --check
 *
 * @module dsh-log-enhance/tests/contracts/implicit-seams
 */

export interface ImplicitSeam {
  /** 唯一标识，报备单与阶段 B 的探针都按它路由。 */
  id: string
  /** 人类可读：这条契约是什么，赌错会怎样。 */
  description: string
  /** 代码位置（`文件:行号`），只是索引，不参与匹配。 */
  usedAt: string
  /** 对应的审计文档章节（章节命名与文档路径由各仓自定）。 */
  auditSection: string
  /** 验货方式；阶段 B 会把它实现成可执行探针。 */
  probe: string
  /** 已盖章的代码位置（语法见文件头）。 */
  acknowledged: string[]
  /** 已排除的本项目内部逻辑（附原因，语法同 `acknowledged`）。 */
  ignored?: string[]
}

export const IMPLICIT_SEAMS: ImplicitSeam[] = [
  {
    id: 'version-lockstep',
    description: 'engines.dsh 下界、devDependencies 列车、baseline.json 的 train 指同一个验证基线；'
      + 'workflow 不携带版本号——版本状态只存在于 package.json 与 baseline.json'
      + '（bump-upstream.mjs 写模式会连同 engines.dsh 一起推进）。任一处先行，'
      + '验证列车就不再是被验证过的那一版。',
    usedAt: 'package.json:engines.dsh',
    auditSection: 'versioning.md §2',
    probe: 'assert engines.dsh floor === devDeps train === baseline train; assert workflows carry no version pin',
    acknowledged: ['package.json', 'baseline.json'],
  },
  {
    id: 'session-file-layout',
    description: '盘上布局契约：`<root>/<projectKey>/<encodeSegment(sessionId)>/session.v<N>.jsonl[.zstd]`，'
      + '文件名只认这个形状，头行必须是 `type: "session"` 且带 `id`。上游换命名或编码，'
      + '本插件会静默看不到会话（不是报错，是列表为空）。',
    usedAt: 'src/mcp/session-store.ts:24,179',
    auditSection: 'mcp.md §3 / §0-L2',
    probe: '用上游 persistence 包真实落一个 session，断言我们的 LOG_FILENAME 与头行判定都命中',
    acknowledged: ['src/mcp/session-store.ts:24', 'src/mcp/session-store.ts:179'],
  },
  {
    id: 'session-format-version',
    description: '事件载荷的嵌套深度随头行 `version` 变化（代码注释记录 v3 把 tool-result 的 content '
      + '又嵌了一层）。本插件没有 SESSION_FORMAT_VERSION 常量，版本是数据：读到新版本不会报错，'
      + '只会把嵌套读浅一层。',
    usedAt: 'src/mcp/analysis.ts:145',
    auditSection: 'mcp.md §3 / §0-L2',
    probe: '按 v3 与 v4 各造一条 assistant/message，断言 textChars 统计一致',
    acknowledged: ['src/mcp/analysis.ts:142-145'],
  },
  {
    id: 'mcp-disk-schema-parity',
    description: '读盘事件载荷的字段名（`turn`/`step`/`callId`/`name`/`arguments`/`usage.*`/'
      + '`message.*`/`content.*`）与 dsh-session 的持久化类型一致。这些读取走 `asRecord(...)`，'
      + '没有类型保护：上游重命名字段，本插件的统计会安静地变成 0/unknown。',
    usedAt: 'src/mcp/analysis.ts:162-205,276-289,591-610,636-637',
    auditSection: '§0-L2 / §5',
    probe: '把 coupling.json 的字段路径 satisfies 到 dsh-session 的 .d.ts 上，缺失即告警',
    acknowledged: [
      'src/mcp/analysis.ts:162-170',
      'src/mcp/analysis.ts:183-189',
      'src/mcp/analysis.ts:195-205',
      'src/mcp/analysis.ts:276-289',
      'src/mcp/analysis.ts:403-405',
      'src/mcp/analysis.ts:591-592',
      'src/mcp/analysis.ts:598-604',
      'src/mcp/analysis.ts:608-610',
      'src/mcp/analysis.ts:636-637',
    ],
  },
  {
    id: 'tool-exec-reference-identity',
    description: 'observer 用 `WeakMap` 的键身份把两次回调绑到同一个对象：`exec` 在 tools/pre-execute '
      + '与 tools/result 里必须是同一个引用（否则拿不到 CallRef），`session` 对象在多次事件通知间'
      + '必须是同一个引用（否则 scope 编号漂移，回执会对错会话）。',
    usedAt: 'src/observer.ts:52-53,147,153',
    auditSection: '§1',
    probe: 'WeakMap<exec, …> 跨 pre-execute/result 取值；同 session 多次事件 scope 编号稳定',
    acknowledged: ['src/observer.ts:52-53'],
  },
  {
    id: 'send-message-receipt-local',
    description: 'send_message 的成功回执只在 `result.value.messageId` 里（execution-local，默认不落盘），'
      + '原生 tool/result 记录里没有它。所以回执必须从运行时结果抓，不能事后从日志补。',
    usedAt: 'src/observer.ts:152-160',
    auditSection: '§1/§2',
    probe: 'assert result.value.messageId 存在，且持久化 tool/result 不含该字段',
    acknowledged: ['src/observer.ts:157-159'],
  },
  {
    id: 'inbox-to-surface-lifecycle',
    description: '入箱到会话可见的生命周期顺序：`agent/inbox/spliced`（accepted）→ claimed → '
      + '`user/message` 且 `surfaceOp === "append"`（admitted），四处的 `message.id` 必须一致。'
      + '顺序或 surfaceOp 语义变了，关联会退化成 coverage.gap 而不是错误答案。',
    usedAt: 'src/observer.ts:110-133',
    auditSection: '§2/§3',
    probe: '按 spliced → claimed → user/message 造事件流，断言 message.id 一致且顺序被强制',
    acknowledged: ['src/observer.ts:110-133'],
  },
  {
    id: 'subagent-settled-surface',
    description: 'subagent 结算通知是 `user/message`，其 `source.kind === "subagent-settled"`，'
      + '并带 `senderSessionId`、可选 `stopReason`，正文在 `data.content`。上游换 kind 字面量或'
      + '把结算挪到别的事件，协作表里的 subagent-settled 行会静默消失。',
    usedAt: 'src/mcp/analysis.ts:304,556-561',
    auditSection: '§2/§3',
    probe: '造一条 subagent-settled 的 user/message，断言 collaborations 产出 settlement 行',
    acknowledged: ['src/mcp/analysis.ts:304', 'src/mcp/analysis.ts:556-561'],
  },
  {
    id: 'subagent-spawn-text',
    description: 'spawn 工具的结果文本就是 `started subagent <id>`（正则 `/^started subagent (\\S+)$/`），'
      + 'id 只能从这段文本里取；改措辞或换结构，子会话 id 就永远对不上。',
    usedAt: 'src/mcp/analysis.ts:426,475-482',
    auditSection: '§0-L2',
    probe: 'assert spawn 结果首行匹配该正则，且非首行/额外说明不会误命中',
    acknowledged: ['src/mcp/analysis.ts:426', 'src/mcp/analysis.ts:475-482'],
  },
  {
    id: 'send-message-arg-schema',
    description: 'send_message 的目标参数在 0.2.2-rc.1 的几次重发布之间从 `target` 变成 `agent_id`，'
      + '有些构建发 `agent`；三者同义，按顺序取第一个字符串。参数名再次改名时，'
      + '目标会变成 unknown 而不是报错。',
    usedAt: 'src/mcp/analysis.ts:464-472',
    auditSection: '§2',
    probe: '读 dsh-tool-subagent-control 的 .d.ts，断言参数名仍在 {target, agent_id, agent} 中',
    acknowledged: ['src/mcp/analysis.ts:464-472'],
  },
  {
    id: 'mcp-jsonrpc-wire',
    description: 'MCP 客户端发来的 JSON-RPC 请求面：`method`/`jsonrpc`/`params` 与 `initialize` 的 '
      + '`protocolVersion` 协商、`tools/call` 的 `name`/`arguments`。本服务自己实现协议层、'
      + '按字符串读这些字段；协议修订换字段名时这里先破。',
    usedAt: 'src/mcp/protocol.ts:82,91,94,117,139,143',
    auditSection: 'mcp.md §1/§2',
    probe: '用官方 MCP 客户端握手并调用一个工具，断言 protocolVersion 协商与参数读取都成功',
    acknowledged: [
      'src/mcp/protocol.ts:82',
      'src/mcp/protocol.ts:91',
      'src/mcp/protocol.ts:94',
      'src/mcp/protocol.ts:117',
      'src/mcp/protocol.ts:139',
      'src/mcp/protocol.ts:143',
    ],
  },
  {
    id: 'cordis-uninjected-mcp-throws',
    description: '在未 inject `mcpManager` 的 fiber 上读 `ctx.mcpManager` 是**抛错**而不是 undefined，'
      + '所以挂载逻辑必须 try/catch 降级（`manager === undefined` 只是根上下文的第二道防线）。'
      + 'cordis 若改成返回 undefined，catch 分支就再也不会走到，但行为仍正确——反之则会炸掉 observation。',
    usedAt: 'src/index.ts:84-86',
    auditSection: '§8',
    probe: 'new Context() 不声明 inject，断言读取 ctx.mcpManager 抛错且被 catch 住',
    acknowledged: ['src/index.ts:84-86'],
  },
  {
    id: 'observation-record-schema',
    description: '本项目自有补充记录的 schema（`observedAt`/`schemaVersion`/`type` 判别式、'
      + 'sha256 身份），只与自己写的 JSONL 对齐，不随上游变化。列在这里是为了让扫描器区分'
      + '"押注上游"和"自己的格式"。',
    usedAt: 'src/records.ts:104',
    auditSection: 'runtime.md',
    probe: '自有记录的硬编码 schema 版本与字段清单',
    acknowledged: [],
    ignored: [
      'src/records.ts:104 — 自有观察记录 id 的 sha256 形状，不是上游协议',
      'src/records.ts:76 — typeof 收窄之后的 length 读取，不是上游字段',
    ],
  },
  {
    id: 'internal-guards',
    description: '内部守卫与错误渲染：`catch (error)` 上的 `.message`/`.name`、本模块自己抛的 '
      + 'SessionLookupError.candidates、`Array.isArray` 收窄后的 `length`、本仓库 package.json 的 manifest 读取。'
      + '这些都对着本项目自己的形状，不是上游契约。',
    usedAt: 'src/mcp/protocol.ts:104-107 / src/mcp/tools.ts:74-77 / src/mcp/analysis.ts:667',
    auditSection: '—',
    probe: '无需探针：形状由本仓库代码定义',
    acknowledged: [],
    ignored: [
      'src/mcp/analysis.ts:667 — jsonEqual 在 Array.isArray 收窄后比较 length',
      'src/mcp/protocol.ts:104-107 — 渲染本服务自己抛出的错误',
      'src/mcp/tools.ts:74-77 — 自有 SessionLookupError/SessionReadError 的 name 与 candidates',
      'src/version.ts:23-24 — 读本仓库 package.json 的 name/version',
    ],
  },
]
