/**
 * 接触面验货器（Commit 3）：把 `coupling.json`（显性层）与
 * `tests/contracts/implicit-seams.ts`（隐性层）变成**可执行的断言**。
 *
 * 显性层：从 `coupling.json` 逐条生成探路代码片段，组装成一个探路插件，
 * 用 TypeScript Compiler API 编译一次，再用真实的 `new Context()` 挂载。
 * 每条接触面一个 `test()`，诊断按**生成行 → 接触面**的映射回填，所以失败信息
 * 直接指出是哪条接触面坏了，而不是"插件编译失败"。
 *
 * 隐性层：每条契约要么在下方跑真探针（版本三锁、上游工具 schema、未 inject
 * 的 `mcpManager` 抛错、自有记录 schema……），要么登记为 delegated 并断言
 * 覆盖它的测试标题仍然存在于对应文件里——引用腐烂会红，而不是静默失效。
 *
 * 设计说明见 `docs/commit-3-design.md`，契约语义见 `docs/upstream-audit.md`。
 */

import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { Context } from '@deepseek-ai/cordis'
import { IMPLICIT_SEAMS } from './contracts/implicit-seams.js'
import type { ImplicitSeam } from './contracts/implicit-seams.js'
import { observe, parseObservation } from '../src/records.js'

/* ------------------------------------------------------------------ *
 * 仓库根与清单
 * ------------------------------------------------------------------ */

/** 从编译产物（`dist-test/tests/…`）或源码（`tests/…`）都能找到仓库根。 */
function findRepositoryRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest) && existsSync(join(directory, 'coupling.json'))) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
      if (parsed.name === 'dsh-log-enhance') return directory
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error('repository root (package.json + coupling.json) not found')
    directory = parent
  }
}

const ROOT = findRepositoryRoot()
const readText = (relativePath: string): string => readFileSync(join(ROOT, relativePath), 'utf8')

interface HookRecord {
  readonly event: string
  readonly via: string
  readonly params: readonly string[]
}

interface PathRecord {
  readonly rootType: string
  readonly sites: readonly string[]
}

interface Coupling {
  readonly srcHooks: readonly HookRecord[]
  readonly testHooks: readonly HookRecord[]
  readonly ctxAccesses: Readonly<Record<string, readonly string[]>>
  readonly fieldPaths: Readonly<Record<string, Readonly<Record<string, PathRecord>>>>
  readonly discriminants: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>
}

const COUPLING = JSON.parse(readText('coupling.json')) as Coupling

/** 生成物落在 `dist-test/`（已被 .gitignore 忽略，且每次 `npm test` 会重建）。 */
const PROBE_TS = join(ROOT, 'dist-test', 'seam-probe.ts')
const PROBE_MJS = join(ROOT, 'dist-test', 'seam-probe.mjs')

/* ------------------------------------------------------------------ *
 * 探针规格
 *
 * 每条规格是一个**代码片段**而不是一段描述：片段在真实上游声明上编译通过，
 * 才算这条接触面今天仍然成立。`rootType` 与 `coupling.json` 记录的一致性是
 * 自检项——清单漂移而规格没跟上时会直接报错，而不是悄悄验错东西。
 * ------------------------------------------------------------------ */

interface ProbeSpec {
  /** `coupling.json` 记录的根类型；生成时逐字比对。 */
  readonly rootType: string
  /** 探针函数的参数声明；省略表示片段直接写在 `apply` 里（用 `ctx`）。 */
  readonly parameter?: string
  /** 取字段前必须做的收窄（判别式 / undefined / 联合分支）。 */
  readonly prelude?: readonly string[]
  /** `[]` 元素跳：遍历的数组表达式，以及循环内的可选收窄。 */
  readonly element?: { readonly of: string; readonly guard?: string }
  /** 被验证的字段访问表达式。 */
  readonly access: string
}

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

const FIELD_SPECS: Readonly<Record<string, ProbeSpec>> = {
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
 * 并由下方隐性层探针补上运行时证据。
 */
const UNVERIFIABLE: Readonly<Record<string, string>> = {
  '@deepseek-ai/cordis::mcpManager': 'service 由 @deepseek-ai/dsh-mcp-manager 提供，不在依赖里、也没有 merge 进 Context，'
    + 'src/index.ts 只能用 cast 读；运行时行为由 implicit/cordis-uninjected-mcp-throws 验证。',
  '@deepseek-ai/cordis::mcpManager.register': '同上：register 的签名只能对着 dsh-mcp-manager 的源码核对，'
    + '挂载路径由 implicit/cordis-uninjected-mcp-throws 与 tests/integration/mcp-mount.test.ts 覆盖。',
  '@deepseek-ai/dsh-tools::value.messageId': 'value 是 JsonValue，读取走索引签名，删掉字段也不会编译失败；'
    + '上游的 output schema 由 implicit/send-message-receipt-local 运行时验证。',
  '@deepseek-ai/dsh-tools::value.messageId.length': '同上，字符串长度建立在 JsonValue 索引访问之后，类型上不可证。',
}

/** 判别字面量：同一个路径上的字面量集合要仍然是联合的成员。 */
interface DiscriminantSpec extends ProbeSpec {
  readonly literals: readonly string[]
}

const DISCRIMINANT_SPECS: Readonly<Record<string, DiscriminantSpec>> = {
  '@deepseek-ai/dsh-session::type': {
    rootType: 'SessionEvent',
    parameter: 'event: SessionEvent',
    access: 'event.type',
    literals: COUPLING.discriminants['@deepseek-ai/dsh-session']?.['type'] ?? [],
  },
  '@deepseek-ai/dsh-session::data.name': {
    rootType: 'SessionEvent',
    parameter: 'event: SessionEvent',
    prelude: ["if (event.type !== 'tool/call') return"],
    access: 'event.data.name',
    literals: COUPLING.discriminants['@deepseek-ai/dsh-session']?.['data.name'] ?? [],
  },
  '@deepseek-ai/dsh-session::data.source.kind': {
    rootType: 'SessionEvent',
    parameter: 'event: SessionEvent',
    prelude: ["if (event.type !== 'user/message') return"],
    access: 'event.data.source.kind',
    literals: COUPLING.discriminants['@deepseek-ai/dsh-session']?.['data.source.kind'] ?? [],
  },
  '@deepseek-ai/dsh-session::data.inserted[].source.kind': {
    rootType: 'SessionEvent',
    parameter: 'event: SessionEvent',
    prelude: ["if (event.type !== 'agent/inbox/spliced') return"],
    element: { of: 'event.data.inserted' },
    access: 'item.source.kind',
    literals: COUPLING.discriminants['@deepseek-ai/dsh-session']?.['data.inserted[].source.kind'] ?? [],
  },
  '@deepseek-ai/dsh-session::surfaceOp': {
    rootType: 'SessionEvent',
    parameter: 'event: SessionEvent',
    prelude: ["if (event.type !== 'user/message') return"],
    access: 'event.surfaceOp',
    literals: COUPLING.discriminants['@deepseek-ai/dsh-session']?.['surfaceOp'] ?? [],
  },
  '@deepseek-ai/dsh-tools::name': {
    rootType: 'Readonly<ToolExecution>|ToolExecution',
    parameter: 'exec: Readonly<ToolExecution>|ToolExecution',
    access: 'exec.name',
    literals: COUPLING.discriminants['@deepseek-ai/dsh-tools']?.['name'] ?? [],
  },
}

/* ------------------------------------------------------------------ *
 * 审计章节映射（docs/upstream-audit.md）
 * ------------------------------------------------------------------ */

const hookSection = (event: string): string => event.startsWith('agent/') ? '§3' : '§1'

function auditSection(pkg: string, path: string): string {
  if (pkg.startsWith('event:')) return '§3'
  if (pkg === '@deepseek-ai/cordis') return path.startsWith('mcpManager') ? '§8' : '§1'
  if (pkg === '@deepseek-ai/dsh-tools') return path.startsWith('value') ? '§2' : '§1'
  if (pkg === '@deepseek-ai/dsh-agent') return '§3'
  if (pkg === '@deepseek-ai/dsh-session') {
    return path.startsWith('data.inserted')
      || path.startsWith('data.source')
      || path === 'data.id'
      || path === 'surfaceOp'
      || path === 'type'
      ? '§3'
      : '§1'
  }
  return '§1'
}

/* ------------------------------------------------------------------ *
 * 隐性层的类型片段（无法用 coupling.json 描述、但必须是类型的）
 * ------------------------------------------------------------------ */

interface TypeFragment {
  /** 生成函数的参数声明。 */
  readonly parameter: string
  /** 函数体（逐行）。 */
  readonly body: readonly string[]
}

const IMPLICIT_FRAGMENTS: Readonly<Record<string, readonly TypeFragment[]>> = {
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

/* ------------------------------------------------------------------ *
 * 探路插件生成
 * ------------------------------------------------------------------ */

interface SeamMeta { readonly id: string, readonly title: string }

interface Generated {
  readonly source: string
  readonly segments: ReadonlyMap<string, SeamMeta>
  /** 每行（0 基）归属的接触面 id；null 表示脚架（imports、导出）。 */
  readonly lineOwners: readonly (string | null)[]
  /** 生成顺序的 hook 名，挂载后逐个核对。 */
  readonly hookNames: readonly string[]
  /** `coupling.json` 里有、但既没有探针也没有豁免的键。 */
  readonly unprobed: readonly string[]
  /** 规格里写了、但 `coupling.json` 已经不记录的键（清单过期）。 */
  readonly stale: readonly string[]
  /** 根类型与 `coupling.json` 不一致的规格。 */
  readonly mismatched: readonly string[]
}

const quote = (value: string): string => JSON.stringify(value)

/** 一个字段探针的函数体（不含签名）。异常场景测试复用同一渲染器。 */
function probeBodyLines(spec: ProbeSpec, indent: string): string[] {
  const out: string[] = []
  for (const line of spec.prelude ?? []) out.push(`${indent}${line}`)
  if (spec.element !== undefined) {
    out.push(`${indent}for (const item of ${spec.element.of}) {`)
    if (spec.element.guard !== undefined) out.push(`${indent}  ${spec.element.guard}`)
    out.push(`${indent}  const _probe = ${spec.access}`)
    out.push(`${indent}  void _probe`)
    out.push(`${indent}}`)
  } else {
    out.push(`${indent}const _probe = ${spec.access}`)
    out.push(`${indent}void _probe`)
  }
  return out
}

function generate(): Generated {
  const lines: string[] = []
  const owners: Array<string | null> = []
  const segments = new Map<string, SeamMeta>()
  const hookNames: string[] = []
  const covered = new Set<string>()
  const mismatched: string[] = []
  let counter = 0

  const emit = (text: string, seam: string | null = null): void => {
    lines.push(text)
    owners.push(seam)
  }
  const claim = (id: string, title: string): string => {
    if (segments.has(id)) throw new Error(`duplicate seam id in generated probe: ${id}`)
    segments.set(id, { id, title })
    return id
  }
  const siteOf = (pkg: string, path: string): string => COUPLING.fieldPaths[pkg]?.[path]?.sites[0] ?? 'unknown'

  const hookSite = (event: string, kind: 'src' | 'test'): string => {
    const candidates = kind === 'src'
      ? ['src/index.ts']
      : ['tests/integration/harness.test.ts', 'tests/integration/mcp-mount.test.ts']
    for (const file of candidates) {
      const index = readText(file).split('\n').findIndex(line => line.includes(`ctx.on('${event}'`))
      if (index >= 0) return `${file}:${index + 1}`
    }
    throw new Error(`no ctx.on('${event}') registration found in ${candidates.join(', ')}`)
  }

  const checkRoot = (key: string, spec: ProbeSpec, record: PathRecord): void => {
    if (spec.rootType !== record.rootType) {
      mismatched.push(`${key}: spec says '${spec.rootType}', coupling.json says '${record.rootType}'`)
    }
  }

  // ---- 文件头 -------------------------------------------------------
  emit('// Generated by tests/seam-verify.test.ts — do not edit.')
  emit('// One fragment per seam in coupling.json; compile failures are mapped back by line.')
  emit("import type { Context } from '@deepseek-ai/cordis'")
  emit("import type { Agent } from '@deepseek-ai/dsh-agent'")
  emit("import type { MessageSource } from '@deepseek-ai/dsh-llm'")
  emit("import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'")
  emit("import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'")
  // 声明合并：agent-message / subagent-settled 两个 source kind 不在 dsh-llm 里。
  emit("import type {} from '@deepseek-ai/dsh-subagent'")
  emit('')
  emit("export const name = 'seam-probe'")
  emit("export const inject = ['sessions', 'agents', 'tools']")
  emit('export const registered: string[] = []')
  emit('')

  // ---- 顶层字段探针 -------------------------------------------------
  for (const [pkg, paths] of Object.entries(COUPLING.fieldPaths)) {
    if (pkg.startsWith('event:') || pkg === '@deepseek-ai/cordis') continue
    for (const [path, record] of Object.entries(paths)) {
      const key = `${pkg}::${path}`
      // 类型上不可证的接触面在 UNVERIFIABLE 里写明理由，由隐性层探针补运行时证据。
      if (key in UNVERIFIABLE) { covered.add(key); continue }
      const spec = FIELD_SPECS[key]
      if (spec === undefined) continue
      checkRoot(key, spec, record)
      const seam = claim(
        `field:${key}`,
        `[auto/field] ${pkg} :: ${path} (at ${record.sites[0] ?? 'unknown'}) -> Audit ${auditSection(pkg, path)}`,
      )
      covered.add(key)
      emit(`// ${key}`, seam)
      emit(`function probe_${counter += 1}(${spec.parameter ?? ''}): void {`, seam)
      for (const line of probeBodyLines(spec, '  ')) emit(line, seam)
      emit('}', seam)
      emit('', seam)
    }
  }

  // ---- 顶层判别字面量探针 -------------------------------------------
  for (const [pkg, paths] of Object.entries(COUPLING.discriminants)) {
    if (pkg.startsWith('event:')) continue
    for (const [path, literals] of Object.entries(paths)) {
      const key = `${pkg}::${path}`
      const spec = DISCRIMINANT_SPECS[key]
      if (spec === undefined) continue
      const record = COUPLING.fieldPaths[pkg]?.[path]
      if (record !== undefined) checkRoot(key, spec, record)
      const seam = claim(
        `discriminant:${key}`,
        `[auto/discriminant] ${pkg} :: ${path} ∈ {${literals.join(', ')}} (at ${siteOf(pkg, path)})`
          + ` -> Audit ${auditSection(pkg, path)}`,
      )
      covered.add(key)
      const body: string[] = []
      for (const line of spec.prelude ?? []) body.push(`  ${line}`)
      if (spec.element !== undefined) {
        body.push(`  for (const item of ${spec.element.of}) {`)
        if (spec.element.guard !== undefined) body.push(`    ${spec.element.guard}`)
        for (const literal of literals) body.push(`    if (${spec.access} === ${quote(literal)}) { void ${spec.access} }`)
        body.push('  }')
      } else {
        for (const literal of literals) body.push(`  if (${spec.access} === ${quote(literal)}) { void ${spec.access} }`)
      }
      emit(`// ${key}`, seam)
      emit(`function probe_${counter += 1}(${spec.parameter ?? ''}): void {`, seam)
      for (const line of body) emit(line, seam)
      emit('}', seam)
      emit('', seam)
    }
  }

  // ---- 隐性层的类型片段 ---------------------------------------------
  for (const [id, fragments] of Object.entries(IMPLICIT_FRAGMENTS)) {
    const seal = IMPLICIT_SEAMS.find(seam => seam.id === id)
    if (seal === undefined) throw new Error(`implicit fragment for unknown seam: ${id}`)
    const seam = claim(
      `implicit:${id}`,
      `[implicit/type] ${id} ${seal.probe} (at ${seal.usedAt}) -> Audit ${seal.auditSection}`,
    )
    for (const fragment of fragments) {
      emit(`// implicit:${id}`, seam)
      emit(`function probe_${counter += 1}(${fragment.parameter}): void {`, seam)
      for (const line of fragment.body) emit(`  ${line}`, seam)
      emit('}', seam)
      emit('', seam)
    }
  }

  // ---- 组装插件 -----------------------------------------------------
  emit('export function apply(ctx: Context): void {')

  const emitHook = (hook: HookRecord, kind: 'src' | 'test'): void => {
    const site = hookSite(hook.event, kind)
    const seam = claim(
      `hook:${kind}:${hook.event}`,
      `[auto/${kind === 'src' ? 'hook' : 'test-hook'}] ${hook.event}(${hook.params.join(', ')})`
        + ` (at ${site}) -> Audit ${hookSection(hook.event)}`,
    )
    hookNames.push(hook.event)
    emit(`  registered.push(${quote(hook.event)})`, seam)
    const parameters = hook.params.map(parameter => parameter.startsWith('{') ? 'payload' : parameter)
    emit(`  ctx.on(${quote(hook.event)}, (${parameters.join(', ')}) => {`, seam)
    for (const name of new Set(parameters)) emit(`    void ${name}`, seam)

    // 事件载荷字段（coupling.json 的 `event:<name>` 段）在这里验证。
    const payloadKey = `event:${hook.event}`
    for (const [path, record] of Object.entries(COUPLING.fieldPaths[payloadKey] ?? {})) {
      const key = `${payloadKey}::${path}`
      const fieldSeam = claim(
        `field:${key}`,
        `[auto/field] ${payloadKey} :: ${path} (at ${record.sites[0] ?? 'unknown'}) -> Audit ${auditSection(payloadKey, path)}`,
      )
      covered.add(key)
      emit(`    void payload.${path}`, fieldSeam)
    }
    for (const [path, literals] of Object.entries(COUPLING.discriminants[payloadKey] ?? {})) {
      const key = `${payloadKey}::${path}`
      const discriminantSeam = claim(
        `discriminant:${key}`,
        `[auto/discriminant] ${payloadKey} :: ${path} ∈ {${literals.join(', ')}}`
          + ` (at ${siteOf(payloadKey, path)}) -> Audit ${auditSection(payloadKey, path)}`,
      )
      covered.add(key)
      for (const literal of literals) {
        emit(`    if (payload.${path} === ${quote(literal)}) { void payload.${path} }`, discriminantSeam)
      }
    }

    emit(`    return ${parameters.includes('next') ? 'next()' : 'undefined'}`, seam)
    emit('  })', seam)
  }

  for (const hook of COUPLING.srcHooks) emitHook(hook, 'src')
  for (const hook of COUPLING.testHooks) emitHook(hook, 'test')

  // ---- ctx 作用域的字段（只能在 apply 里验证） ----------------------
  for (const [path, record] of Object.entries(COUPLING.fieldPaths['@deepseek-ai/cordis'] ?? {})) {
    const key = `@deepseek-ai/cordis::${path}`
    if (key in UNVERIFIABLE) { covered.add(key); continue }
    const spec = FIELD_SPECS[key]
    if (spec === undefined) continue
    checkRoot(key, spec, record)
    const seam = claim(
      `field:${key}`,
      `[auto/field] @deepseek-ai/cordis :: ${path} (at ${record.sites[0] ?? 'unknown'}) -> Audit ${auditSection('@deepseek-ai/cordis', path)}`,
    )
    covered.add(key)
    emit('  {', seam)
    for (const line of probeBodyLines(spec, '    ')) emit(line, seam)
    emit('  }', seam)
  }

  emit('}')

  // ---- 清单完整性 ---------------------------------------------------
  const unprobed: string[] = []
  for (const [pkg, paths] of Object.entries(COUPLING.fieldPaths)) {
    for (const path of Object.keys(paths)) {
      const key = `${pkg}::${path}`
      if (!covered.has(key)) unprobed.push(key)
    }
  }
  for (const [pkg, paths] of Object.entries(COUPLING.discriminants)) {
    for (const path of Object.keys(paths)) {
      const key = `${pkg}::${path}`
      if (!covered.has(key)) unprobed.push(key)
    }
  }
  const stale: string[] = []
  for (const key of [...Object.keys(FIELD_SPECS), ...Object.keys(DISCRIMINANT_SPECS), ...Object.keys(UNVERIFIABLE)]) {
    const separator = key.lastIndexOf('::')
    const pkg = key.slice(0, separator)
    const path = key.slice(separator + 2)
    const known = COUPLING.fieldPaths[pkg]?.[path] !== undefined || COUPLING.discriminants[pkg]?.[path] !== undefined
    if (!known) stale.push(key)
  }
  return {
    source: `${lines.join('\n')}\n`,
    segments,
    lineOwners: owners,
    hookNames,
    unprobed,
    stale,
    mismatched,
  }
}

const GENERATED = generate()

/* ------------------------------------------------------------------ *
 * 编译验货
 * ------------------------------------------------------------------ */

interface DiagnosticRecord { readonly seam: string | null, readonly message: string }

const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
  // 探针不使用 Node 全局；不加载 @types/node 能让解析更接近"只有上游声明"。
  types: [],
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  verbatimModuleSyntax: true,
}

let compilation: { readonly diagnostics: readonly DiagnosticRecord[] } | undefined

function compile(): readonly DiagnosticRecord[] {
  if (compilation !== undefined) return compilation.diagnostics
  mkdirSync(dirname(PROBE_TS), { recursive: true })
  writeFileSync(PROBE_TS, GENERATED.source)
  const program = ts.createProgram([PROBE_TS], COMPILER_OPTIONS)
  const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic): DiagnosticRecord => {
    const text = `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`
    if (diagnostic.file === undefined || diagnostic.start === undefined) return { seam: null, message: text }
    if (diagnostic.file.fileName !== PROBE_TS) return { seam: null, message: `${text} (${diagnostic.file.fileName})` }
    const line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line
    return { seam: GENERATED.lineOwners[line] ?? null, message: `${text} (line ${line + 1})` }
  })
  compilation = { diagnostics }
  return diagnostics
}

function assertSeamClean(id: string): void {
  const diagnostics = compile().filter(diagnostic => diagnostic.seam === id)
  assert.equal(
    diagnostics.length,
    0,
    `${id}\n${diagnostics.map(diagnostic => `  ${diagnostic.message}`).join('\n')}`,
  )
}

/* ------------------------------------------------------------------ *
 * 显性层：每条接触面一个 test
 * ------------------------------------------------------------------ */

for (const segment of GENERATED.segments.values()) {
  test(segment.title, () => {
    assertSeamClean(segment.id)
  })
}

/* ------------------------------------------------------------------ *
 * 挂载验货
 * ------------------------------------------------------------------ */

type StubProvide = (name: string, value?: unknown) => () => void

function provideStub(ctx: Context, name: string, value: unknown): void {
  const provide = ctx.provide as unknown as StubProvide
  provide(name, value)
}

type Plug = Parameters<Context['plugin']>[0]

interface ProbeModule {
  readonly name: string
  readonly inject: readonly string[]
  readonly registered: readonly string[]
  apply(ctx: Context): void
}

test('[auto/plugin] the probe plugin mounts on a real Context and registers every recorded hook', async () => {
  const diagnostics = compile()
  assert.equal(diagnostics.length, 0, 'mount verification requires a clean compile first')
  const { outputText } = ts.transpileModule(GENERATED.source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
  })
  writeFileSync(PROBE_MJS, outputText)
  const module = await import(pathToFileURL(PROBE_MJS).href) as unknown as ProbeModule
  assert.equal(module.name, 'seam-probe')
  assert.deepEqual([...module.inject], ['sessions', 'agents', 'tools'])

  const ctx = new Context()
  // 探路插件声明 inject 了这三个服务；挂载验货关心的是"声明与注册"，不是服务实现。
  provideStub(ctx, 'sessions', {})
  provideStub(ctx, 'agents', {})
  provideStub(ctx, 'tools', {})
  const fiber = await ctx.plugin(module as Plug)
  try {
    assert.deepEqual([...module.registered], [...GENERATED.hookNames])
  } finally {
    await fiber.dispose()
  }
})

test('[intro] every diagnostic is attributed to a recorded seam', () => {
  const unattributed = compile().filter(diagnostic => diagnostic.seam === null)
  assert.equal(
    unattributed.length,
    0,
    `unattributed diagnostics mean the generated scaffold broke:\n${unattributed.map(row => `  ${row.message}`).join('\n')}`,
  )
})

test('[intro] the probe inventory covers coupling.json without stale specs', () => {
  const problems = [
    ...GENERATED.unprobed.map(key => `no probe spec and no documented exemption: ${key}`),
    ...GENERATED.stale.map(key => `spec no longer matches coupling.json: ${key}`),
    ...GENERATED.mismatched.map(problem => `root type drift: ${problem}`),
  ]
  assert.deepEqual(problems, [])
})

test('[intro] coupling.json still records the surfaces this verifier was built for', () => {
  assert.ok(COUPLING.srcHooks.length >= 6, 'srcHooks')
  assert.ok(COUPLING.testHooks.length >= 3, 'testHooks')
  assert.ok(Object.keys(COUPLING.fieldPaths).length >= 4, 'fieldPaths')
  assert.ok(Object.keys(COUPLING.discriminants).length >= 3, 'discriminants')
})

/* ------------------------------------------------------------------ *
 * 隐性层：探针
 * ------------------------------------------------------------------ */

async function probeVersionLockstep(): Promise<void> {
  const manifest = JSON.parse(readText('package.json')) as {
    engines?: { dsh?: string }
    devDependencies?: Record<string, string>
  }
  const range = manifest.engines?.dsh
  assert.ok(range !== undefined, 'package.json must declare engines.dsh')
  const floor = /^>=\s*(\S+)/.exec(range)?.[1]
  assert.ok(floor !== undefined, `engines.dsh must open with >=<version>: ${range}`)

  const train = new Set(
    Object.entries(manifest.devDependencies ?? {})
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
      .map(([, version]) => version),
  )
  assert.equal(train.size, 1, `devDependencies must pin exactly one dsh train: ${[...train].join(', ')}`)
  assert.equal([...train][0], floor, 'engines.dsh floor and the devDependency train must agree')

  // Workflows carry no version of their own (single-line follow): the manifest
  // and baseline.json are the ONLY version state, so a re-pinned dshVersion
  // in a workflow would be a silent extra copy of the truth drifting free.
  assert.doesNotMatch(
    readText('.github/workflows/ci.yml'),
    /dshVersion:\s*\S/,
    'ci.yml must not pin a dsh version — package.json + baseline.json are the only version state',
  )

  const baseline = JSON.parse(readText('baseline.json')) as { packages: Record<string, { version: string }> }
  const fingerprinted = new Set(
    Object.entries(baseline.packages).filter(([name]) => name.startsWith('dsh-')).map(([, pkg]) => pkg.version),
  )
  assert.equal(fingerprinted.size, 1, `baseline.json must fingerprint one dsh train: ${[...fingerprinted].join(', ')}`)
  assert.equal([...fingerprinted][0], floor, 'baseline.json train must equal the engines.dsh floor')
}

/**
 * spawn 的模型可见回执就是 `started subagent <id>`。这里从**已安装的上游构建**里
 * 取出模板字面量，再用本项目的正则去匹配它：措辞一改，两边就对不上。
 */
async function probeSubagentSpawnText(context: TestContext): Promise<void> {
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

  const analysis = readText('src/mcp/analysis.ts')
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
function acceptedMessageTargetKeys(): string[] {
  const loop = /for \(const key of \[([^\]]*)\]\)/.exec(readText('src/mcp/analysis.ts'))?.[1]
  assert.ok(loop !== undefined, 'src/mcp/analysis.ts must still iterate message target keys')
  return [...loop.matchAll(/'([^']+)'/g)].flatMap(match => match[1] === undefined ? [] : [match[1]])
}

async function probeSendMessageArguments(): Promise<void> {
  const tool = (await captureControlTools()).get('send_message')
  assert.ok(tool !== undefined, 'upstream must still register the send_message tool')
  const accepted = acceptedMessageTargetKeys()
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
function probeDiskSchemaParity(): void {
  const missing = GENERATED.unprobed.filter(key => key.startsWith('@deepseek-ai/dsh-session::'))
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

/* ------------------------------------------------------------------ *
 * 隐性层：登记
 * ------------------------------------------------------------------ */

const IMPLICIT_RUNS: Readonly<Record<string, (context: TestContext) => void | Promise<void>>> = {
  'version-lockstep': probeVersionLockstep,
  'session-format-version': async (): Promise<void> => {
    // 事件载荷的嵌套深度随头行 version 变化：v3 把 tool-result 的 content 又嵌了一层。
    // 上游抬版本时这个 tripwire 会红，提醒回来重核 textChars 的嵌套读取。
    assert.match(readText('src/mcp/analysis.ts'), /v3 nests result content one level deeper/)
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

/** 这些契约已由专门测试真跑过；这里校验引用仍然存在，避免"覆盖"腐烂成一句空话。 */
const IMPLICIT_DELEGATIONS: Readonly<Record<string, readonly { file: string, tests: readonly string[] }[]>> = {
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

const implicitTitle = (seam: ImplicitSeam): string =>
  `[implicit/${seam.id}] ${seam.probe} (at ${seam.usedAt}) -> Audit ${seam.auditSection}`

for (const seam of IMPLICIT_SEAMS) {
  test(implicitTitle(seam), async (context) => {
    const run = IMPLICIT_RUNS[seam.id]
    const fragment = GENERATED.segments.has(`implicit:${seam.id}`)
    const delegations = IMPLICIT_DELEGATIONS[seam.id]
    assert.ok(
      run !== undefined || fragment || delegations !== undefined,
      `implicit seam '${seam.id}' has no probe, type fragment, or covering-test reference`,
    )
    if (run !== undefined) await run(context)
    if (fragment) assertSeamClean(`implicit:${seam.id}`)
    for (const delegation of delegations ?? []) {
      const text = readText(delegation.file)
      for (const title of delegation.tests) {
        assert.ok(text.includes(title), `${delegation.file} must still contain the covering test: ${title}`)
      }
    }
  })
}

test('[implicit/intro] every implicit seam is either probed, type-checked, or explicitly delegated', () => {
  const known = new Set(IMPLICIT_SEAMS.map(seam => seam.id))
  const registered = new Set([
    ...Object.keys(IMPLICIT_RUNS),
    ...Object.keys(IMPLICIT_DELEGATIONS),
    ...Object.keys(IMPLICIT_FRAGMENTS),
  ])
  const unregistered = [...known].filter(id => !registered.has(id))
  const stale = [...registered].filter(id => !known.has(id)).sort()
  assert.deepEqual(unregistered, [], 'seams without any verification path')
  assert.deepEqual(stale, [], 'verification paths for seams that no longer exist')
})

/* ------------------------------------------------------------------ *
 * 异常场景：mock checkout 删掉一个字段，探路插件必须编译失败
 * ------------------------------------------------------------------ */

const MOCK_TYPES = `
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
`

const MOCK_WITHOUT_SENDER = MOCK_TYPES.replace('    senderSessionId: string\n', '')

/** 用同一套片段的渲染器跑 mock 声明，证明"删字段 → 编译报错"这条链路是真的。 */
function compileAgainstMock(mockTypes: string, spec: ProbeSpec): readonly string[] {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-seam-mock-'))
  try {
    const packageDirectory = join(directory, 'node_modules', '@deepseek-ai', 'dsh-session')
    mkdirSync(packageDirectory, { recursive: true })
    writeFileSync(
      join(packageDirectory, 'package.json'),
      `${JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '0.0.0', types: 'index.d.ts' }, null, 2)}\n`,
    )
    writeFileSync(join(packageDirectory, 'index.d.ts'), mockTypes)
    const probe = join(directory, 'probe.ts')
    writeFileSync(
      probe,
      `import type { SessionEvent } from '@deepseek-ai/dsh-session'\n\n`
        + [`function probe(${spec.parameter ?? ''}): void {`, ...probeBodyLines(spec, '  '), '}', ''].join('\n'),
    )
    const program = ts.createProgram([probe], COMPILER_OPTIONS)
    return ts.getPreEmitDiagnostics(program).map(diagnostic =>
      `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('[abnormal] dropping senderSessionId from a mock checkout breaks the generated probe', () => {
  const spec = FIELD_SPECS['@deepseek-ai/dsh-session::data.inserted[].source.senderSessionId']
  assert.ok(spec !== undefined, 'the senderSessionId probe spec must exist')

  const control = compileAgainstMock(MOCK_TYPES, spec)
  assert.deepEqual(control, [], 'the mock with the field present must compile cleanly')

  const dropped = compileAgainstMock(MOCK_WITHOUT_SENDER, spec)
  assert.ok(dropped.length > 0, 'removing senderSessionId must produce a compile error')
  assert.ok(
    dropped.some(message => message.includes('senderSessionId')),
    `the error must name the removed field: ${dropped.join(' | ')}`,
  )
  assert.ok(
    dropped.some(message => message.startsWith('TS2339')),
    `the error must be a missing-property diagnostic: ${dropped.join(' | ')}`,
  )
})
