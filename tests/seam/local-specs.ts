/**
 * 本仓规格库（非受管文件，2026-11-14 从共享载荷 standard-specs.ts 迁回）：
 *
 * 三类无法自动推导的内容按 L0–L4 模型属于消费仓署名的事实——豁免理由
 * 引用本仓登记的 `implicit/<id>`，片段按本仓隐含依赖 id 键控，反向自检
 * 场景对着本仓实际依赖的上游声明。共享载荷只保留 `standardSpecs()` 的
 * 注入机制（`library` 参数）；本文件由薄入口传入。
 */

import type { MockCheckoutScenario, TypeFragment } from './engine.js'
import type { SpecsLibrary } from './standard-specs.js'

const UNVERIFIABLE_LIBRARY: Readonly<Record<string, string>> = {
  '@deepseek-ai/cordis::mcpManager': 'service 由 @deepseek-ai/dsh-mcp-manager 提供，不在依赖里、也没有 merge 进 Context，'
    + '插件源码只能用 cast 读；运行时行为由 implicit/cordis-uninjected-mcp-throws 验证。',
  '@deepseek-ai/cordis::mcpManager.register': '同上：register 的签名只能对着 dsh-mcp-manager 的源码核对，'
    + '挂载路径由 implicit/cordis-uninjected-mcp-throws 与插件自身的集成测试覆盖。',
  '@deepseek-ai/dsh-tools::value.messageId': 'value 是 JsonValue，读取走索引签名，删掉字段也不会编译失败；'
    + '上游的 output schema 由 implicit/send-message-receipt-local 运行时验证。',
  '@deepseek-ai/dsh-tools::value.messageId.length': '同上，字符串长度建立在 JsonValue 索引访问之后，类型上不可证；由 implicit/send-message-receipt-local 运行时验证。',
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

/** 异常场景（本仓审计关注）：删掉 senderSessionId 后 mock checkout 必须编译失败。 */
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

/** 本仓库：经薄入口传给 `standardSpecs(coupling, implicitSeams, library)`。 */
export const LOCAL_SPECS_LIBRARY: SpecsLibrary = {
  unverifiable: UNVERIFIABLE_LIBRARY,
  implicitFragments: IMPLICIT_FRAGMENT_LIBRARY,
  abnormal: ABNORMAL_LIBRARY,
}
