/**
 * 标准规格库（2026-11-13 拆分）：按**上游表面**（`pkg::path`，如
 * `'@deepseek-ai/dsh-session::data.callId'`）键控的探针规格集合。
 *
 * 这一层不属于任何一个插件仓库：只要上游包的类型/判别字面量长这样，
 * 任何 dsh 插件的 coupling.json 记录到同一个表面，就能复用同一条规格。
 * `standardSpecs(coupling, implicitSeams)` 把库与本仓 coupling.json 求交集：
 *
 * - 插件碰到哪些上游表面，就自动获得哪些标准覆盖；
 * - 库里未被本仓记录的条目被直接忽略——不会产生假的 "stale spec" 报警；
 * - 判别规格的字面量不写死在库里，而是从 coupling.json 的 `discriminants`
 *   段读取（清单是 AST 真相，库只描述"怎么探"）。
 *
 * 隐性类型片段（`IMPLICIT_FRAGMENT_LIBRARY`）例外：它们的键是**隐性契约 id**
 * （如 `'subagent-settled-surface'`），不是上游表面。别的仓库只要在自家的
 * `tests/contracts/implicit-seams.ts` 里登记同名 id，就能复用对应片段。
 *
 * 异常场景（`ABNORMAL_LIBRARY`）同样是标准内容：mock 一份上游声明、删掉
 * 一个字段，证明"删字段 → 探针编译失败"这条链路是真的。
 */

import type { Coupling, DiscriminantSpec, MockCheckoutScenario, ProbeSpec, TypeFragment } from './engine.js'
import type { ImplicitSeam } from '../contracts/implicit-seams.js'

/* ------------------------------------------------------------------ *
 * 规格工厂
 * ------------------------------------------------------------------ */

const SESSION_EVENT = (prelude: readonly string[], access: string): ProbeSpec => ({
  rootType: 'SessionEvent',
  parameter: 'event: SessionEvent',
  prelude,
  access,
})

/** `data.inserted[].…`：先按事件判别式收窄，再按 message.source.kind 收窄。 */
const INSERTED = (access: string, guard?: string): ProbeSpec => ({
  rootType: 'SessionEvent',
  parameter: 'event: SessionEvent',
  prelude: ["if (event.type !== 'agent/inbox/spliced') return"],
  element: { of: 'event.data.inserted', ...guard === undefined ? {} : { guard } },
  access,
})

/* ------------------------------------------------------------------ *
 * 库（全部按上游表面键控）
 * ------------------------------------------------------------------ */

const FIELD_SPEC_LIBRARY: Readonly<Record<string, ProbeSpec>> = {
  // --- @deepseek-ai/cordis：在 apply 里对 ctx 直接验证 -------------------
  '@deepseek-ai/cordis::effect': { rootType: 'Context', access: 'ctx.effect' },
  '@deepseek-ai/cordis::logger': { rootType: 'Context', access: 'ctx.logger' },
  '@deepseek-ai/cordis::logger.info': { rootType: 'Context', access: 'ctx.logger.info' },
  '@deepseek-ai/cordis::logger.warn': { rootType: 'Context', access: 'ctx.logger.warn' },
  '@deepseek-ai/cordis::on': { rootType: 'Context', access: 'ctx.on' },

  // --- @deepseek-ai/dsh-agent ------------------------------------------
  '@deepseek-ai/dsh-agent::id': { rootType: 'Agent', parameter: 'agent: Agent', access: 'agent.id' },
  '@deepseek-ai/dsh-agent::session': { rootType: 'Agent', parameter: 'agent: Agent', access: 'agent.session' },

  // --- @deepseek-ai/dsh-session：SessionEvent 判别联合 ----------------
  '@deepseek-ai/dsh-session::data': SESSION_EVENT([], 'event.data'),
  '@deepseek-ai/dsh-session::data.callId': SESSION_EVENT(["if (event.type !== 'tool/call') return"], 'event.data.callId'),
  '@deepseek-ai/dsh-session::data.id': SESSION_EVENT(["if (event.type !== 'user/message') return"], 'event.data.id'),
  '@deepseek-ai/dsh-session::data.inserted': SESSION_EVENT(
    ["if (event.type !== 'agent/inbox/spliced') return"],
    'event.data.inserted',
  ),
  '@deepseek-ai/dsh-session::data.inserted[].id': INSERTED('item.id'),
  '@deepseek-ai/dsh-session::data.inserted[].source': INSERTED('item.source'),
  '@deepseek-ai/dsh-session::data.inserted[].source.kind': INSERTED('item.source.kind'),
  '@deepseek-ai/dsh-session::data.inserted[].source.senderSessionId': INSERTED(
    'item.source.senderSessionId',
    "if (item.source.kind !== 'agent-message') continue",
  ),
  '@deepseek-ai/dsh-session::data.name': SESSION_EVENT(["if (event.type !== 'tool/call') return"], 'event.data.name'),
  '@deepseek-ai/dsh-session::data.source': SESSION_EVENT(["if (event.type !== 'user/message') return"], 'event.data.source'),
  '@deepseek-ai/dsh-session::data.source.kind': SESSION_EVENT(
    ["if (event.type !== 'user/message') return"],
    'event.data.source.kind',
  ),
  '@deepseek-ai/dsh-session::data.source.senderSessionId': SESSION_EVENT(
    ["if (event.type !== 'user/message') return", "if (event.data.source.kind !== 'agent-message') return"],
    'event.data.source.senderSessionId',
  ),
  '@deepseek-ai/dsh-session::data.step': SESSION_EVENT(["if (event.type !== 'step/start') return"], 'event.data.step'),
  '@deepseek-ai/dsh-session::data.turn': SESSION_EVENT(["if (event.type !== 'turn/start') return"], 'event.data.turn'),
  '@deepseek-ai/dsh-session::sourceEventSeqs': SESSION_EVENT(
    ["if (event.type !== 'user/message') return"],
    'event.sourceEventSeqs',
  ),
  '@deepseek-ai/dsh-session::surfaceOp': SESSION_EVENT(["if (event.type !== 'user/message') return"], 'event.surfaceOp'),
  '@deepseek-ai/dsh-session::type': SESSION_EVENT([], 'event.type'),
  '@deepseek-ai/dsh-session::seq': SESSION_EVENT([], 'event.seq'),

  // --- @deepseek-ai/dsh-session：Session 根 ---------------------------
  '@deepseek-ai/dsh-session::firstLiveSeq': {
    rootType: 'Session',
    parameter: 'session: Session',
    access: 'session.firstLiveSeq',
  },
  '@deepseek-ai/dsh-session::header': { rootType: 'Session', parameter: 'session: Session', access: 'session.header' },
  '@deepseek-ai/dsh-session::header.version': {
    rootType: 'Session',
    parameter: 'session: Session',
    access: 'session.header.version',
  },
  '@deepseek-ai/dsh-session::id': { rootType: 'Session', parameter: 'session: Session', access: 'session.id' },
  '@deepseek-ai/dsh-session::isOwnSeq': { rootType: 'Session', parameter: 'session: Session', access: 'session.isOwnSeq' },

  // --- @deepseek-ai/dsh-tools -----------------------------------------
  '@deepseek-ai/dsh-tools::agent': {
    rootType: 'Readonly<ToolExecution>|ToolExecution',
    parameter: 'exec: Readonly<ToolExecution>|ToolExecution',
    access: 'exec.agent',
  },
  '@deepseek-ai/dsh-tools::agent.id': {
    rootType: 'Readonly<ToolExecution>|ToolExecution',
    parameter: 'exec: Readonly<ToolExecution>|ToolExecution',
    prelude: ['if (exec.agent === undefined) return'],
    access: 'exec.agent.id',
  },
  '@deepseek-ai/dsh-tools::agent.session': {
    rootType: 'ToolExecution',
    parameter: 'exec: ToolExecution',
    prelude: ['if (exec.agent === undefined) return'],
    access: 'exec.agent.session',
  },
  '@deepseek-ai/dsh-tools::callId': { rootType: 'ToolExecution', parameter: 'exec: ToolExecution', access: 'exec.callId' },
  '@deepseek-ai/dsh-tools::name': {
    rootType: 'Readonly<ToolExecution>|ToolExecution',
    parameter: 'exec: Readonly<ToolExecution>|ToolExecution',
    access: 'exec.name',
  },
  '@deepseek-ai/dsh-tools::parent': {
    rootType: 'Readonly<ToolExecution>|ToolExecution',
    parameter: 'exec: Readonly<ToolExecution>|ToolExecution',
    access: 'exec.parent',
  },
  '@deepseek-ai/dsh-tools::isError': {
    rootType: 'Readonly<ToolExecutionResult>',
    parameter: 'result: Readonly<ToolExecutionResult>',
    access: 'result.isError',
  },
  '@deepseek-ai/dsh-tools::value': {
    rootType: 'Readonly<ToolExecutionResult>',
    parameter: 'result: Readonly<ToolExecutionResult>',
    prelude: ['if (result.isError) return'],
    access: 'result.value',
  },
}

/**
 * 类型系统证明不了的接触面。不是"暂时没写"，而是**在这里明确写下为什么不可能**，
 * 并由隐性层探针补上运行时证据。（理由文本里提到的 implicit 探针 id 与测试
 * 路径属于登记方的语义，库只保证按上游表面求交集。）
 */
const UNVERIFIABLE_LIBRARY: Readonly<Record<string, string>> = {
  '@deepseek-ai/cordis::mcpManager': 'service 由 @deepseek-ai/dsh-mcp-manager 提供，不在依赖里、也没有 merge 进 Context，'
    + 'src/index.ts 只能用 cast 读；运行时行为由 implicit/cordis-uninjected-mcp-throws 验证。',
  '@deepseek-ai/cordis::mcpManager.register': '同上：register 的签名只能对着 dsh-mcp-manager 的源码核对，'
    + '挂载路径由 implicit/cordis-uninjected-mcp-throws 与 tests/integration/mcp-mount.test.ts 覆盖。',
  '@deepseek-ai/dsh-tools::value.messageId': 'value 是 JsonValue，读取走索引签名，删掉字段也不会编译失败；'
    + '上游的 output schema 由 implicit/send-message-receipt-local 运行时验证。',
  '@deepseek-ai/dsh-tools::value.messageId.length': '同上，字符串长度建立在 JsonValue 索引访问之后，类型上不可证。',
}

/**
 * 判别探针的"怎么探"部分（字面量运行时从 coupling.json 的 `discriminants`
 * 段读取）。库覆盖的路径如果本仓 coupling.json 没记，条目被交集掉。
 */
const DISCRIMINANT_PROBES: Readonly<Record<string, ProbeSpec>> = {
  '@deepseek-ai/dsh-session::type': {
    rootType: 'SessionEvent',
    parameter: 'event: SessionEvent',
    access: 'event.type',
  },
  '@deepseek-ai/dsh-session::data.name': {
    rootType: 'SessionEvent',
    parameter: 'event: SessionEvent',
    prelude: ["if (event.type !== 'tool/call') return"],
    access: 'event.data.name',
  },
  '@deepseek-ai/dsh-session::data.source.kind': {
    rootType: 'SessionEvent',
    parameter: 'event: SessionEvent',
    prelude: ["if (event.type !== 'user/message') return"],
    access: 'event.data.source.kind',
  },
  '@deepseek-ai/dsh-session::data.inserted[].source.kind': {
    rootType: 'SessionEvent',
    parameter: 'event: SessionEvent',
    prelude: ["if (event.type !== 'agent/inbox/spliced') return"],
    element: { of: 'event.data.inserted' },
    access: 'item.source.kind',
  },
  '@deepseek-ai/dsh-session::surfaceOp': {
    rootType: 'SessionEvent',
    parameter: 'event: SessionEvent',
    prelude: ["if (event.type !== 'user/message') return"],
    access: 'event.surfaceOp',
  },
  '@deepseek-ai/dsh-tools::name': {
    rootType: 'Readonly<ToolExecution>|ToolExecution',
    parameter: 'exec: Readonly<ToolExecution>|ToolExecution',
    access: 'exec.name',
  },
}

const IMPLICIT_FRAGMENT_LIBRARY: Readonly<Record<string, readonly TypeFragment[]>> = {
  'subagent-settled-surface': [
    {
      parameter: "source: Extract<MessageSource, { kind: 'subagent-settled' }>",
      body: [
        'const _summary: string = source.summary',
        'const _sender = source.senderSessionId',
        'const _stop = source.stopReason',
        'void _summary',
        'void _sender',
        'void _stop',
      ],
    },
    {
      parameter: "source: Extract<MessageSource, { kind: 'agent-message' }>",
      body: [
        "const _form: 'relay' = source.form",
        'const _sender = source.senderSessionId',
        'void _form',
        'void _sender',
      ],
    },
  ],
}

/** 异常场景（标准内容）：删掉 senderSessionId 后 mock checkout 必须编译失败。 */
const ABNORMAL_LIBRARY: MockCheckoutScenario = {
  title: '[abnormal] dropping senderSessionId from a mock checkout breaks the generated probe',
  specKey: '@deepseek-ai/dsh-session::data.inserted[].source.senderSessionId',
  packageName: '@deepseek-ai/dsh-session',
  typesImportLine: "import type { SessionEvent } from '@deepseek-ai/dsh-session'",
  mockTypes: `
export interface AgentMessageSource {
    kind: 'agent-message'
    form: 'relay'
    senderSessionId: string
}
export interface UserSource {
    kind: 'user'
}
export type MessageSource = AgentMessageSource | UserSource
export interface UserMessage {
    id: string
    content: readonly unknown[]
    source: MessageSource
}
export type SessionEvent = {
    type: 'agent/inbox/spliced'
    seq: number
    data: { inserted: UserMessage[] }
}
`,
  droppedLine: '    senderSessionId: string',
  expectedField: 'senderSessionId',
}

/* ------------------------------------------------------------------ *
 * 交集：库 ∩ 本仓 coupling.json
 * ------------------------------------------------------------------ */

export interface StandardSpecs {
  readonly fieldSpecs: Readonly<Record<string, ProbeSpec>>
  readonly discriminantSpecs: Readonly<Record<string, DiscriminantSpec>>
  readonly unverifiable: Readonly<Record<string, string>>
  readonly implicitFragments: Readonly<Record<string, readonly TypeFragment[]>>
  readonly abnormal?: MockCheckoutScenario | undefined
}

const splitKey = (key: string): { readonly pkg: string, readonly path: string } => {
  const separator = key.lastIndexOf('::')
  return { pkg: key.slice(0, separator), path: key.slice(separator + 2) }
}

/**
 * 标准库 ∩ 本仓耦合面。字段/判别/豁免按 `coupling.json` 记录的上游表面求交，
 * 隐性类型片段按本仓登记的隐性契约 id 求交；本仓新增的规格在薄入口里展开
 * 合并即可（suite 的 stale 检查仍然兜底）。
 */
export function standardSpecs(coupling: Coupling, implicitSeams: readonly ImplicitSeam[]): StandardSpecs {
  const fieldSpecs = Object.fromEntries(
    Object.entries(FIELD_SPEC_LIBRARY).filter(([key]) => {
      const { pkg, path } = splitKey(key)
      return coupling.fieldPaths[pkg]?.[path] !== undefined
    }),
  )
  const discriminantSpecs = Object.fromEntries(
    Object.entries(DISCRIMINANT_PROBES).flatMap(([key, probe]): [string, DiscriminantSpec][] => {
      const { pkg, path } = splitKey(key)
      const literals = coupling.discriminants[pkg]?.[path]
      return literals === undefined ? [] : [[key, { ...probe, literals }]]
    }),
  )
  const unverifiable = Object.fromEntries(
    Object.entries(UNVERIFIABLE_LIBRARY).filter(([key]) => {
      const { pkg, path } = splitKey(key)
      return coupling.fieldPaths[pkg]?.[path] !== undefined
    }),
  )
  const registeredSeams = new Set(implicitSeams.map(seam => seam.id))
  const implicitFragments = Object.fromEntries(
    Object.entries(IMPLICIT_FRAGMENT_LIBRARY).filter(([id]) => registeredSeams.has(id)),
  )
  return {
    fieldSpecs,
    discriminantSpecs,
    unverifiable,
    implicitFragments,
    ...(fieldSpecs[ABNORMAL_LIBRARY.specKey] !== undefined ? { abnormal: ABNORMAL_LIBRARY } : {}),
  }
}
