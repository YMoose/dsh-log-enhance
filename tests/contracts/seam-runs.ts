/**
 * 本仓隐性契约的探针与委派（插件层，2026-11-13 拆分）。
 *
 * 与 `tests/seam/` 的标准内容相反，这里全是**本仓知识**：读我们自己的
 * `src/` 文件、断言我们自己的正则与记录 schema、引用我们自己的测试标题。
 * 引擎（`tests/seam/engine.ts`）不含这些；别的仓库写自己的同名文件。
 *
 * `IMPLICIT_RUNS` 不含 `version-lockstep`——那是引擎 `standardRuns` 里的
 * 标准探针（只读 package.json / baseline.json / ci.yml，与仓库无关），由
 * 薄入口按本仓登记的契约 id 挑选合并。
 */

import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { observe, parseObservation } from '../../src/records.js'
import { IMPLICIT_SEAMS } from './implicit-seams.js'
import { quote } from '../seam/engine.js'
import type { DelegationRef, Plug, SeamEnvironment, SeamRun } from '../seam/engine.js'

type StubProvide = (name: string, value?: unknown) => () => void

function provideStub(ctx: Context, name: string, value: unknown): void {
  const provide = ctx.provide as unknown as StubProvide
  provide(name, value)
}

/**
 * spawn 的模型可见回执就是 `started subagent <id>`。这里从**已安装的上游构建**里
 * 取出模板字面量，再用本项目的正则去匹配它：措辞一改，两边就对不上。
 */
async function probeSubagentSpawnText(context: TestContext, environment: SeamEnvironment): Promise<void> {
  const require = createRequire(import.meta.url)
  let manifestPath: string
  try {
    manifestPath = require.resolve('@deepseek-ai/dsh-tool-subagent/package.json')
  } catch {
    context.skip('@deepseek-ai/dsh-tool-subagent is not installed in this dependency set')
    return
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { main?: string }
  const build = readFileSync(join(dirname(manifestPath), manifest.main ?? 'lib/index.js'), 'utf8')
  const template = /`started subagent \$\{[^}]+\}`/.exec(build)?.[0]
  assert.ok(template !== undefined, 'the spawn tool must still render `started subagent ${…}`')
  const rendered = template.slice(1, -1).replace(/\$\{[^}]+\}/g, 'child-1')

  const analysis = environment.readText('src/mcp/analysis.ts')
  const pattern = /const STARTED_SUBAGENT = \/(.+)\//.exec(analysis)?.[1]
  assert.ok(pattern !== undefined, 'src/mcp/analysis.ts must still declare STARTED_SUBAGENT')
  const match = new RegExp(pattern).exec(rendered)
  assert.notEqual(match, null, `upstream renders ${quote(rendered)}, which our /${pattern}/ no longer matches`)
  assert.equal(match?.[1], 'child-1', 'the first capture group must be the child session id')
}

interface CapturedTool {
  readonly name: string
  /** `defineTool` 把作者侧声明编译成原始 JSON Schema：对象根 + properties/required。 */
  readonly parameters?: { readonly properties?: Readonly<Record<string, unknown>> }
  readonly output?: {
    readonly schema?: {
      readonly properties?: Readonly<Record<string, unknown>>
      readonly required?: readonly string[]
    }
  }
}

/**
 * 上游 `send_message` 的真实定义：把 control 插件挂到一个只有桩服务的 Context 上，
 * 从 `tools.register` 里把它捞出来。比读 .d.ts 靠谱，因为工具参数是运行时 schema。
 */
async function captureControlTools(): Promise<ReadonlyMap<string, CapturedTool>> {
  const ctx = new Context()
  const tools = new Map<string, CapturedTool>()
  provideStub(ctx, 'tools', {
    register(tool: CapturedTool): void { tools.set(tool.name, tool) },
  })
  provideStub(ctx, 'subagents', {})
  provideStub(ctx, 'agents', {})
  provideStub(ctx, 'systemPrompt', { context(): void {}, getContextOrder(): number { return 0 } })
  const control = await import('@deepseek-ai/dsh-tool-subagent-control')
  const fiber = await ctx.plugin(control as unknown as Plug)
  await fiber.dispose()
  return tools
}

/** 本项目的目标参数名清单从源码里读，避免测试自带一份会漂移的副本。 */
function acceptedMessageTargetKeys(environment: SeamEnvironment): string[] {
  const loop = /for \(const key of \[([^\]]*)\]\)/.exec(environment.readText('src/mcp/analysis.ts'))?.[1]
  assert.ok(loop !== undefined, 'src/mcp/analysis.ts must still iterate message target keys')
  return [...loop.matchAll(/'([^']+)'/g)].flatMap(match => match[1] === undefined ? [] : [match[1]])
}

async function probeSendMessageArguments(_context: TestContext, environment: SeamEnvironment): Promise<void> {
  const tool = (await captureControlTools()).get('send_message')
  assert.ok(tool !== undefined, 'upstream must still register the send_message tool')
  const accepted = acceptedMessageTargetKeys(environment)
  assert.ok(accepted.length > 0, 'the accepted target key list must not be empty')
  const declared = Object.keys(tool.parameters?.properties ?? {})
  assert.ok(declared.includes('message'), `send_message must still take the body as 'message': ${declared.join(', ')}`)
  const targets = declared.filter(name => name !== 'message')
  assert.ok(targets.length > 0, `send_message must declare a target parameter: ${declared.join(', ')}`)
  for (const target of targets) {
    assert.ok(
      accepted.includes(target),
      `upstream declares send_message target '${target}', which src/mcp/analysis.ts does not read `
        + `(accepted: ${accepted.join(', ')})`,
    )
  }
}

/** 回执只在 execution-local 的 output.value 里；上游的 output schema 必须仍然声明它。 */
async function probeSendMessageReceipt(): Promise<void> {
  const tool = (await captureControlTools()).get('send_message')
  assert.ok(tool !== undefined, 'upstream must still register the send_message tool')
  const properties = tool.output?.schema?.properties
  assert.ok(properties !== undefined, 'send_message must declare an output schema')
  assert.ok(
    Object.hasOwn(properties, 'messageId'),
    `send_message output schema must still expose messageId: ${Object.keys(properties).join(', ')}`,
  )
  assert.ok(
    (tool.output?.schema?.required ?? []).includes('messageId'),
    'messageId must stay required on the execution-local result, not an optional extra',
  )
}

/**
 * cordis 在**未 inject** 的 fiber 上读服务是抛错而不是 undefined；src/index.ts 的
 * 挂载逻辑正是靠这一点在 try/catch 里降级。根 Context 返回 undefined 是第二道防线。
 */
async function probeUninjectedMcpManager(): Promise<void> {
  const ctx = new Context()
  let observed: 'threw' | 'undefined' | 'value' = 'value'
  let message = ''
  const plugin = {
    name: 'seam-inject-guard',
    apply(inner: Context): void {
      try {
        const manager = (inner as Context & { mcpManager?: unknown }).mcpManager
        observed = manager === undefined ? 'undefined' : 'value'
      } catch (error) {
        observed = 'threw'
        message = String(error)
      }
    },
  }
  const fiber = await ctx.plugin(plugin as unknown as Plug)
  await fiber.dispose()
  assert.equal(observed, 'threw', 'reading ctx.mcpManager without inject must throw, not return undefined')
  assert.match(message, /inject/, `the refusal must name the missing inject: ${message}`)
  assert.equal(
    (ctx as Context & { mcpManager?: unknown }).mcpManager,
    undefined,
    'the root Context stays undefined so the second guard in src/index.ts is still reachable',
  )
}

/** mcp 盘上字段的语义面由显性层覆盖；这里断言"没有一条 dsh-session 字段被悄悄漏掉"。 */
function probeDiskSchemaParity(_context: TestContext, environment: SeamEnvironment): void {
  const missing = environment.unprobed.filter(key => key.startsWith('@deepseek-ai/dsh-session::'))
  assert.deepEqual(missing, [], 'every recorded dsh-session field path must be type-probed or exempted with a reason')
}

/** 自有记录 schema 不随上游变化，但绝不能悄悄改：版本与身份校验都要成立。 */
function probeObservationSchema(): void {
  const record = observe({ type: 'coverage.gap', reason: 'observer-error' }, 1_700_000_000_000)
  assert.equal(record.schemaVersion, 1)
  assert.deepEqual(parseObservation(record), record)
  assert.throws(() => parseObservation({ ...record, schemaVersion: 99 }), /Unsupported observation schema/)
}

/** 登记为 internal 的契约应当一条 acknowledged 都没有——否则它就不该被标成内部逻辑。 */
function probeInternalGuards(): void {
  const seam = IMPLICIT_SEAMS.find(entry => entry.id === 'internal-guards')
  assert.ok(seam !== undefined, 'the internal-guards registry entry must exist')
  assert.deepEqual([...seam.acknowledged], [])
  assert.ok((seam.ignored?.length ?? 0) > 0, 'internal-guards must list the shapes it excludes')
}

/**
 * 本仓探针，按隐性契约 id 键控。`version-lockstep` 由引擎的 `standardRuns`
 * 提供，不在这里重复。
 */
export const IMPLICIT_RUNS: Readonly<Record<string, SeamRun>> = {
  'session-format-version': async (_context, environment): Promise<void> => {
    // 事件载荷的嵌套深度随头行 version 变化：v3 把 tool-result 的 content 又嵌了一层。
    // 上游抬版本时这个 tripwire 会红，提醒回来重核 textChars 的嵌套读取。
    assert.match(environment.readText('src/mcp/analysis.ts'), /v3 nests result content one level deeper/)
    const session = await import('@deepseek-ai/dsh-session')
    assert.equal(
      session.SESSION_FORMAT_VERSION,
      4,
      'the session format version moved; re-verify the payload nesting that src/mcp/analysis.ts reads',
    )
  },
  'mcp-disk-schema-parity': probeDiskSchemaParity,
  'send-message-receipt-local': probeSendMessageReceipt,
  'subagent-spawn-text': probeSubagentSpawnText,
  'send-message-arg-schema': probeSendMessageArguments,
  'cordis-uninjected-mcp-throws': probeUninjectedMcpManager,
  'observation-record-schema': probeObservationSchema,
  'internal-guards': probeInternalGuards,
}

/** 这些契约已由专门测试真跑过；引擎校验引用仍然存在，避免"覆盖"腐烂成一句空话。 */
export const IMPLICIT_DELEGATIONS: Readonly<Record<string, readonly DelegationRef[]>> = {
  'session-file-layout': [{
    file: 'tests/mcp-store.test.ts',
    tests: [
      'store discovers sessions across projects and parses zstd v4 artifacts',
      'the newest generation file wins when a directory holds several',
    ],
  }],
  'mcp-disk-schema-parity': [{
    file: 'tests/mcp-analysis.test.ts',
    tests: [
      'summary counts activity, tokens, tools, and latency from native facts',
      'collaborations join dispatch, child session, and settlement by native identities',
    ],
  }],
  'tool-exec-reference-identity': [{
    file: 'tests/integration/harness.test.ts',
    tests: [
      'real AgentLoop and subagent send_message produce a verifiable sidecar relation',
      'concurrent real senders with identical call ids and payloads keep distinct provenance',
    ],
  }],
  'send-message-receipt-local': [{
    file: 'tests/integration/harness.test.ts',
    tests: ['real AgentLoop and subagent send_message produce a verifiable sidecar relation'],
  }],
  'inbox-to-surface-lifecycle': [{
    file: 'tests/integration/harness.test.ts',
    tests: [
      'real AgentLoop and subagent send_message produce a verifiable sidecar relation',
      'receiver rejecting pre-step is claimed but never marked admitted',
    ],
  }],
  'subagent-settled-surface': [{
    file: 'tests/mcp-analysis.test.ts',
    tests: [
      'collaborations join dispatch, child session, and settlement by native identities',
      'a settled notice without a local dispatch stays unattributed',
    ],
  }],
  'send-message-arg-schema': [{
    file: 'tests/mcp-analysis.test.ts',
    tests: ['send_message targets are recognized across upstream schema variants'],
  }],
  'cordis-uninjected-mcp-throws': [{
    file: 'tests/integration/mcp-mount.test.ts',
    tests: ['a host without mcpManager applies with a warning while observation continues'],
  }],
  'mcp-jsonrpc-wire': [{
    file: 'tests/mcp-protocol.test.ts',
    tests: [
      'initialize negotiates the client version or falls back to newest',
      'standalone server speaks MCP end to end over real stdio',
    ],
  }],
}
