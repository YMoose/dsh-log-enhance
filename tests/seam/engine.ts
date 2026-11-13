/**
 * 接触面验货引擎（闭环层，2026-11-13 拆分）：把 `coupling.json`（显性层）与
 * 隐性契约登记变成**可执行的断言**，自身不含任何插件知识。
 *
 * 引擎只认数据不认仓库：探针规格、隐性契约、探针与委派引用全部由调用方
 * （见 `tests/seam-verify.test.ts` 薄入口）通过 `SeamSuite` 注入。另一个
 * dsh 插件仓库可以原样复制 `tests/seam/`，自写
 * `tests/contracts/{implicit-seams,seam-runs}.ts` 与薄入口即可接入。
 *
 * 显性层：从 coupling.json 逐条生成探路代码片段，组装成一个探路插件，
 * 用 TypeScript Compiler API 编译一次，再用真实的 `new Context()` 挂载。
 * 每条接触面一个 `test()`，诊断按**生成行 → 接触面**的映射回填，所以失败信息
 * 直接指出是哪条接触面坏了，而不是"插件编译失败"。
 *
 * 隐性层：每条契约要么由调用方的探针真跑（`SeamRun`），要么登记为委派并
 * 断言覆盖它的测试标题仍然存在于对应文件里——引用腐烂会红，而不是静默失效。
 *
 * 设计说明见 `docs/seam-driven-verification.md` 与 `docs/commit-3-design.md`。
 */

import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { Context } from '@deepseek-ai/cordis'
import type { ImplicitSeam } from '../contracts/implicit-seams.js'

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

export interface HookRecord {
  readonly event: string
  readonly via: string
  readonly params: readonly string[]
  readonly sites: readonly string[]
}

export interface PathRecord {
  readonly rootType: string
  readonly sites: readonly string[]
}

export interface Coupling {
  readonly srcHooks: readonly HookRecord[]
  readonly testHooks: readonly HookRecord[]
  readonly ctxAccesses: Readonly<Record<string, readonly string[]>>
  readonly fieldPaths: Readonly<Record<string, Readonly<Record<string, PathRecord>>>>
  readonly discriminants: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>
  readonly injectedServices: readonly string[]
}

/** 探针规格：一个**代码片段**而不是一段描述——片段在真实上游声明上编译通过，
 *  这条接触面才算今天仍然成立。`rootType` 与 coupling.json 记录的一致性是
 *  自检项——清单漂移而规格没跟上时会直接报错，而不是悄悄验错东西。 */
export interface ProbeSpec {
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

/** 判别字面量：同一个路径上的字面量集合要仍然是联合的成员。 */
export interface DiscriminantSpec extends ProbeSpec {
  readonly literals: readonly string[]
}

/** 隐性层的类型片段（无法用 coupling.json 描述、但必须是类型的）。 */
export interface TypeFragment {
  /** 生成函数的参数声明。 */
  readonly parameter: string
  /** 函数体（逐行）。 */
  readonly body: readonly string[]
}

/** 委派引用：契约已由专门测试真跑过；引擎校验测试标题仍然存在于文件里。 */
export interface DelegationRef {
  readonly file: string
  readonly tests: readonly string[]
}

/** 引擎在跑隐性探针时递给它的环境（探针不自己找仓库根）。 */
export interface SeamEnvironment {
  readonly root: string
  readonly readText: (relativePath: string) => string
  /** 生成器判定的"coupling.json 里有、但既没有探针也没有豁免"的键。 */
  readonly unprobed: readonly string[]
}

export type SeamRun = (context: TestContext, environment: SeamEnvironment) => void | Promise<void>

/** 异常场景：用 mock 声明替换真实上游包，删掉一个字段后探针必须编译失败。 */
export interface MockCheckoutScenario {
  /** 完整的 test 标题。 */
  readonly title: string
  /** 在 `fieldSpecs` 里查探针规格的键（`pkg::path`）。 */
  readonly specKey: string
  /** 被模拟的上游包名（决定 node_modules 下的 mock 摆放位置）。 */
  readonly packageName: string
  /** 探针文件第一行的 type import（与 `packageName` 对应）。 */
  readonly typesImportLine: string
  /** 字段齐全的 mock 声明（正例必须编译干净）。 */
  readonly mockTypes: string
  /** 从 `mockTypes` 里整行删掉的内容（删掉后必须产生缺失属性诊断）。 */
  readonly droppedLine: string
  /** 诊断必须点名的字段名。 */
  readonly expectedField: string
}

/** `[intro]` 清单完整性测试的下限；小仓库通过 suite 覆盖，不必改引擎。 */
export interface InventoryFloors {
  readonly srcHooks: number
  readonly testHooks: number
  readonly fieldPathPackages: number
  readonly discriminantPackages: number
}

export interface SeamSuite {
  readonly root: string
  readonly coupling: Coupling
  readonly fieldSpecs: Readonly<Record<string, ProbeSpec>>
  readonly discriminantSpecs: Readonly<Record<string, DiscriminantSpec>>
  /** 类型系统证明不了的接触面：键是表面，值是"为什么不可能"的理由。 */
  readonly unverifiable: Readonly<Record<string, string>>
  /** 键是隐性契约 id（与 `implicitSeams` 对齐），不是上游表面。 */
  readonly implicitFragments: Readonly<Record<string, readonly TypeFragment[]>>
  readonly implicitSeams: readonly ImplicitSeam[]
  readonly implicitRuns: Readonly<Record<string, SeamRun>>
  readonly implicitDelegations?: Readonly<Record<string, readonly DelegationRef[]>>
  readonly abnormal?: MockCheckoutScenario | undefined
  readonly inventoryFloors?: InventoryFloors | undefined
}

/** cordis 插件对象（挂载验货用）。 */
export type Plug = Parameters<Context['plugin']>[0]

/* ------------------------------------------------------------------ *
 * 仓库根与清单
 * ------------------------------------------------------------------ */

/**
 * 从编译产物（`dist-test/…`）或源码（`tests/…`）都能找到仓库根。
 * 给了 `packageName` 就要求 `package.json` 的名字吻合（防止单仓里停在
 * 邻居的根上）；不给则停在第一个同时有 `package.json` 与 `coupling.json`
 * 的目录——对任意 dsh 插件仓库都成立。
 */
export function findRepositoryRoot(packageName?: string): string {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest) && existsSync(join(directory, 'coupling.json'))) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
      if (packageName === undefined || parsed.name === packageName) return directory
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error('repository root (package.json + coupling.json) not found')
    directory = parent
  }
}

export const readText = (root: string, relativePath: string): string =>
  readFileSync(join(root, relativePath), 'utf8')

/** 解析 `{root}/coupling.json`（显性层清单）。 */
export function loadCoupling(root: string): Coupling {
  return JSON.parse(readText(root, 'coupling.json')) as Coupling
}

export const quote = (value: string): string => JSON.stringify(value)

/* ------------------------------------------------------------------ *
 * 标准探针（与仓库无关，任何接入仓都能用）
 * ------------------------------------------------------------------ */

/**
 * 版本三锁：`engines.dsh` 下界、devDependencies 的 dsh 列车、baseline.json
 * 的指纹列车必须是同一个版本，workflow 不得自带版本号。只读
 * package.json / baseline.json / `.github/workflows/ci.yml`，不含插件知识。
 */
async function probeVersionLockstep(context: TestContext, environment: SeamEnvironment): Promise<void> {
  void context
  const manifest = JSON.parse(environment.readText('package.json')) as {
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
    environment.readText('.github/workflows/ci.yml'),
    /dshVersion:\s*\S/,
    'ci.yml must not pin a dsh version — package.json + baseline.json are the only version state',
  )

  const baseline = JSON.parse(environment.readText('baseline.json')) as { packages: Record<string, { version: string }> }
  const fingerprinted = new Set(
    Object.entries(baseline.packages).filter(([name]) => name.startsWith('dsh-')).map(([, pkg]) => pkg.version),
  )
  assert.equal(fingerprinted.size, 1, `baseline.json must fingerprint one dsh train: ${[...fingerprinted].join(', ')}`)
  assert.equal([...fingerprinted][0], floor, 'baseline.json train must equal the engines.dsh floor')
}

/** 引擎自带的可复用探针，按隐性契约 id 键控；接入仓在薄入口里按自己登记的
 *  契约 id 挑选合并。 */
export const standardRuns: Readonly<Record<string, SeamRun>> = {
  'version-lockstep': probeVersionLockstep,
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

function generate(suite: SeamSuite): Generated {
  const { coupling, fieldSpecs, discriminantSpecs, unverifiable, implicitFragments, implicitSeams } = suite
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
  const siteOf = (pkg: string, path: string): string => coupling.fieldPaths[pkg]?.[path]?.sites[0] ?? 'unknown'

  const hookSite = (event: string, kind: 'src' | 'test'): string => {
    // Read the site from coupling.json (the scanner's AST truth) instead of
    // re-grepping sources: quoting style, an extracted variable, or a moved
    // file must never break verification — a stale inventory should fail,
    // loudly, as a coupling drift instead.
    const site = (kind === 'src' ? coupling.srcHooks : coupling.testHooks)
      .find(hook => hook.event === event)?.sites[0]
    if (site === undefined) {
      throw new Error(`coupling.json has no ${kind} hook site for '${event}'; regenerate it with analyze-dsh-coupling.mjs --write`)
    }
    return site
  }

  const checkRoot = (key: string, spec: ProbeSpec, record: PathRecord): void => {
    if (spec.rootType !== record.rootType) {
      mismatched.push(`${key}: spec says '${spec.rootType}', coupling.json says '${record.rootType}'`)
    }
  }

  // ---- 文件头 -------------------------------------------------------
  const inject = [...coupling.injectedServices]
  emit('// Generated by the seam-verification engine (tests/seam/engine.ts) — do not edit.')
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
  emit(`export const inject = ${JSON.stringify(inject)}`)
  emit('export const registered: string[] = []')
  emit('')

  // ---- 顶层字段探针 -------------------------------------------------
  for (const [pkg, paths] of Object.entries(coupling.fieldPaths)) {
    if (pkg.startsWith('event:') || pkg === '@deepseek-ai/cordis') continue
    for (const [path, record] of Object.entries(paths)) {
      const key = `${pkg}::${path}`
      // 类型上不可证的接触面在 unverifiable 里写明理由，由隐性层探针补运行时证据。
      if (key in unverifiable) { covered.add(key); continue }
      const spec = fieldSpecs[key]
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
  for (const [pkg, paths] of Object.entries(coupling.discriminants)) {
    if (pkg.startsWith('event:')) continue
    for (const [path, literals] of Object.entries(paths)) {
      const key = `${pkg}::${path}`
      const spec = discriminantSpecs[key]
      if (spec === undefined) continue
      const record = coupling.fieldPaths[pkg]?.[path]
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
  for (const [id, fragments] of Object.entries(implicitFragments)) {
    const seal = implicitSeams.find(seam => seam.id === id)
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
    for (const [path, record] of Object.entries(coupling.fieldPaths[payloadKey] ?? {})) {
      const key = `${payloadKey}::${path}`
      const fieldSeam = claim(
        `field:${key}`,
        `[auto/field] ${payloadKey} :: ${path} (at ${record.sites[0] ?? 'unknown'}) -> Audit ${auditSection(payloadKey, path)}`,
      )
      covered.add(key)
      emit(`    void payload.${path}`, fieldSeam)
    }
    for (const [path, literals] of Object.entries(coupling.discriminants[payloadKey] ?? {})) {
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

  for (const hook of coupling.srcHooks) emitHook(hook, 'src')
  for (const hook of coupling.testHooks) emitHook(hook, 'test')

  // ---- ctx 作用域的字段（只能在 apply 里验证） ----------------------
  for (const [path, record] of Object.entries(coupling.fieldPaths['@deepseek-ai/cordis'] ?? {})) {
    const key = `@deepseek-ai/cordis::${path}`
    if (key in unverifiable) { covered.add(key); continue }
    const spec = fieldSpecs[key]
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
  for (const [pkg, paths] of Object.entries(coupling.fieldPaths)) {
    for (const path of Object.keys(paths)) {
      const key = `${pkg}::${path}`
      if (!covered.has(key)) unprobed.push(key)
    }
  }
  for (const [pkg, paths] of Object.entries(coupling.discriminants)) {
    for (const path of Object.keys(paths)) {
      const key = `${pkg}::${path}`
      if (!covered.has(key)) unprobed.push(key)
    }
  }
  const stale: string[] = []
  for (const key of [...Object.keys(fieldSpecs), ...Object.keys(discriminantSpecs), ...Object.keys(unverifiable)]) {
    const separator = key.lastIndexOf('::')
    const pkg = key.slice(0, separator)
    const path = key.slice(separator + 2)
    const known = coupling.fieldPaths[pkg]?.[path] !== undefined || coupling.discriminants[pkg]?.[path] !== undefined
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

/** 用同一套片段渲染器跑 mock 声明，证明"删字段 → 编译报错"这条链路是真的。 */
function compileAgainstMock(scenario: MockCheckoutScenario, spec: ProbeSpec, mockTypes: string): readonly string[] {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-seam-mock-'))
  try {
    const packageDirectory = join(directory, 'node_modules', ...scenario.packageName.split('/'))
    mkdirSync(packageDirectory, { recursive: true })
    writeFileSync(
      join(packageDirectory, 'package.json'),
      `${JSON.stringify({ name: scenario.packageName, version: '0.0.0', types: 'index.d.ts' }, null, 2)}\n`,
    )
    writeFileSync(join(packageDirectory, 'index.d.ts'), mockTypes)
    const probe = join(directory, 'probe.ts')
    writeFileSync(
      probe,
      `${scenario.typesImportLine}\n\n`
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

/* ------------------------------------------------------------------ *
 * 套件执行：发射本文件的全部测试
 * ------------------------------------------------------------------ */

type StubProvide = (name: string, value?: unknown) => () => void

function provideStub(ctx: Context, name: string, value: unknown): void {
  const provide = ctx.provide as unknown as StubProvide
  provide(name, value)
}

interface ProbeModule {
  readonly name: string
  readonly inject: readonly string[]
  readonly registered: readonly string[]
  apply(ctx: Context): void
}

const DEFAULT_INVENTORY_FLOORS: InventoryFloors = {
  srcHooks: 6,
  testHooks: 3,
  fieldPathPackages: 4,
  discriminantPackages: 3,
}

export function runSeamSuite(suite: SeamSuite): void {
  const { coupling, implicitSeams } = suite
  /** 生成物落在 `dist-test/`（已被 .gitignore 忽略，且每次 `npm test` 会重建）。 */
  const probeTs = join(suite.root, 'dist-test', 'seam-probe.ts')
  const probeMjs = join(suite.root, 'dist-test', 'seam-probe.mjs')
  const generated = generate(suite)

  let compilation: { readonly diagnostics: readonly DiagnosticRecord[] } | undefined

  const compile = (): readonly DiagnosticRecord[] => {
    if (compilation !== undefined) return compilation.diagnostics
    mkdirSync(dirname(probeTs), { recursive: true })
    writeFileSync(probeTs, generated.source)
    const program = ts.createProgram([probeTs], COMPILER_OPTIONS)
    const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic): DiagnosticRecord => {
      const text = `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`
      if (diagnostic.file === undefined || diagnostic.start === undefined) return { seam: null, message: text }
      if (diagnostic.file.fileName !== probeTs) return { seam: null, message: `${text} (${diagnostic.file.fileName})` }
      const line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line
      return { seam: generated.lineOwners[line] ?? null, message: `${text} (line ${line + 1})` }
    })
    compilation = { diagnostics }
    return diagnostics
  }

  const assertSeamClean = (id: string): void => {
    const diagnostics = compile().filter(diagnostic => diagnostic.seam === id)
    assert.equal(
      diagnostics.length,
      0,
      `${id}\n${diagnostics.map(diagnostic => `  ${diagnostic.message}`).join('\n')}`,
    )
  }

  // ---- 显性层：每条接触面一个 test ----------------------------------
  for (const segment of generated.segments.values()) {
    test(segment.title, () => {
      assertSeamClean(segment.id)
    })
  }

  // ---- 挂载验货 ------------------------------------------------------
  const inject = [...coupling.injectedServices]

  test('[auto/plugin] the probe plugin mounts on a real Context and registers every recorded hook', async () => {
    const diagnostics = compile()
    assert.equal(diagnostics.length, 0, 'mount verification requires a clean compile first')
    const { outputText } = ts.transpileModule(generated.source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
    })
    writeFileSync(probeMjs, outputText)
    const module = await import(pathToFileURL(probeMjs).href) as unknown as ProbeModule
    assert.equal(module.name, 'seam-probe')
    assert.deepEqual([...module.inject], inject)

    const ctx = new Context()
    // 探路插件声明 inject 了这些服务；挂载验货关心的是"声明与注册"，不是服务实现。
    for (const service of inject) provideStub(ctx, service, {})
    const fiber = await ctx.plugin(module as Plug)
    try {
      assert.deepEqual([...module.registered], [...generated.hookNames])
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
      ...generated.unprobed.map(key => `no probe spec and no documented exemption: ${key}`),
      ...generated.stale.map(key => `spec no longer matches coupling.json: ${key}`),
      ...generated.mismatched.map(problem => `root type drift: ${problem}`),
    ]
    assert.deepEqual(problems, [])
  })

  const floors = suite.inventoryFloors ?? DEFAULT_INVENTORY_FLOORS

  test('[intro] coupling.json still records the surfaces this verifier was built for', () => {
    assert.ok(coupling.srcHooks.length >= floors.srcHooks, 'srcHooks')
    assert.ok(coupling.testHooks.length >= floors.testHooks, 'testHooks')
    assert.ok(Object.keys(coupling.fieldPaths).length >= floors.fieldPathPackages, 'fieldPaths')
    assert.ok(Object.keys(coupling.discriminants).length >= floors.discriminantPackages, 'discriminants')
  })

  // ---- 隐性层：登记 --------------------------------------------------
  const environment: SeamEnvironment = {
    root: suite.root,
    readText: relativePath => readText(suite.root, relativePath),
    unprobed: generated.unprobed,
  }

  const implicitTitle = (seam: ImplicitSeam): string =>
    `[implicit/${seam.id}] ${seam.probe} (at ${seam.usedAt}) -> Audit ${seam.auditSection}`

  for (const seam of implicitSeams) {
    test(implicitTitle(seam), async (context) => {
      const run = suite.implicitRuns[seam.id]
      const fragment = generated.segments.has(`implicit:${seam.id}`)
      const delegations = suite.implicitDelegations?.[seam.id]
      assert.ok(
        run !== undefined || fragment || delegations !== undefined,
        `implicit seam '${seam.id}' has no probe, type fragment, or covering-test reference`,
      )
      if (run !== undefined) await run(context, environment)
      if (fragment) assertSeamClean(`implicit:${seam.id}`)
      for (const delegation of delegations ?? []) {
        const text = readText(suite.root, delegation.file)
        for (const title of delegation.tests) {
          assert.ok(text.includes(title), `${delegation.file} must still contain the covering test: ${title}`)
        }
      }
    })
  }

  test('[implicit/intro] every implicit seam is either probed, type-checked, or explicitly delegated', () => {
    const known = new Set(implicitSeams.map(seam => seam.id))
    const registered = new Set([
      ...Object.keys(suite.implicitRuns),
      ...Object.keys(suite.implicitDelegations ?? {}),
      ...Object.keys(suite.implicitFragments),
    ])
    const unregistered = [...known].filter(id => !registered.has(id))
    const stale = [...registered].filter(id => !known.has(id)).sort()
    assert.deepEqual(unregistered, [], 'seams without any verification path')
    assert.deepEqual(stale, [], 'verification paths for seams that no longer exist')
  })

  // ---- 异常场景：mock checkout 删掉一个字段，探路插件必须编译失败 ----
  const scenario = suite.abnormal
  if (scenario !== undefined && suite.fieldSpecs[scenario.specKey] !== undefined) {
    const spec = suite.fieldSpecs[scenario.specKey] as ProbeSpec
    test(scenario.title, () => {
      const control = compileAgainstMock(scenario, spec, scenario.mockTypes)
      assert.deepEqual(control, [], 'the mock with the field present must compile cleanly')

      const dropped = compileAgainstMock(scenario, spec, scenario.mockTypes.replace(`${scenario.droppedLine}\n`, ''))
      assert.ok(dropped.length > 0, `removing ${scenario.expectedField} must produce a compile error`)
      assert.ok(
        dropped.some(message => message.includes(scenario.expectedField)),
        `the error must name the removed field: ${dropped.join(' | ')}`,
      )
      assert.ok(
        dropped.some(message => message.startsWith('TS2339')),
        `the error must be a missing-property diagnostic: ${dropped.join(' | ')}`,
      )
    })
  }
}
