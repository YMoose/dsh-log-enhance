/**
 * 标准规格库（2026-11-13 起收缩为"不可推导"的部分）：
 *
 * - 字段/判别探针的收窄 prelude 曾经是这里的手写字典，已死——它漂移于
 *   插件的真实用法（`sourceEventSeqs` 在 `tool/result` 里被读、字典却按
 *   `user/message` 探）。如今 `tests/seam/engine.ts` 的
 *   `probeSpecsFromCoupling()` 从 coupling.json 的访问记录（含扫描器提取
 *   的守卫上下文，即消费者真相）机械生成每一条规格。
 * - 这里保留的是**推导不出来**的三块：
 *   1. `UNVERIFIABLE_LIBRARY`——类型系统证明不了的接触面 + 为什么；
 *   2. `IMPLICIT_FRAGMENT_LIBRARY`——键为隐性契约 id 的类型片段（别的
 *      仓库登记同名 id 即复用）；
 *   3. `ABNORMAL_LIBRARY`——自检场景：mock 上游声明、删一个字段，证明
 *      "删字段 → 探针编译失败"这条链路是真的。
 *
 * `standardSpecs(coupling, implicitSeams)` 把三者与耦合面求交集，并合并
 * 机械生成的 fieldSpecs / discriminantSpecs。
 */

import { probeSpecsFromCoupling } from './engine.js'
import type { Coupling, DiscriminantSpec, MockCheckoutScenario, ProbeSpec, TypeFragment } from './engine.js'
import type { ImplicitSeam } from '../contracts/implicit-seams.js'

/* ------------------------------------------------------------------ *
 * 库（不可推导的标准内容）
 * ------------------------------------------------------------------ */

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
 * 交集：库 ∩ 本仓 coupling.json + 机械生成的规格
 * ------------------------------------------------------------------ */

export interface StandardSpecs {
  readonly fieldSpecs: Readonly<Record<string, readonly ProbeSpec[]>>
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
 * 标准库 ∩ 本仓耦合面：不可证豁免按 coupling.json 记录的上游表面求交，
 * 隐性类型片段按本仓登记的隐性契约 id 求交；fieldSpecs /
 * discriminantSpecs 来自引擎的机械生成（守卫即消费者真相）。
 */
export function standardSpecs(coupling: Coupling, implicitSeams: readonly ImplicitSeam[]): StandardSpecs {
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
  const generated = probeSpecsFromCoupling(coupling)
  return {
    fieldSpecs: generated.fieldSpecs,
    discriminantSpecs: generated.discriminantSpecs,
    unverifiable,
    implicitFragments,
    ...(generated.fieldSpecs[ABNORMAL_LIBRARY.specKey] !== undefined ? { abnormal: ABNORMAL_LIBRARY } : {}),
  }
}
