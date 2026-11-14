/**
 * 依赖检查程序：把 `coupling.json` 中记录的接口依赖和人工登记的隐含依赖
 * 转换成可执行的检查，自身不包含具体插件的业务规则。
 *
 * 程序只读取调用方提供的数据，不直接决定某个插件应该依赖哪些接口。检查规格、
 * 隐含依赖和关联测试都由调用方（见 `tests/seam-verify.test.ts`）通过
 * `SeamSuite` 传入。其他 DSH 插件仓库可以复用 `tests/seam/`，只需自行提供
 * `tests/contracts/{implicit-seams,seam-runs}.ts` 和一个简单入口文件。
 *
 * 类型检查：根据 coupling.json 生成检查代码，用 TypeScript Compiler API
 * 编译一次，再将生成的插件挂载到真实的 `new Context()`。每个依赖项对应一个
 * `test()`，编译诊断按生成行映射回依赖项，因此错误信息能指出具体失败位置。
 * 可独立编译检查的部分由 `runContractSuite` 提供；`checkContract` 不注册测试，
 * 供独立检查 CLI 复用。上游包的 import 根据 rootType 和 packages 清单推导。
 *
 * 运行时检查：每条隐含依赖要么执行调用方提供的 `SeamRun`，要么关联到已有测试；
 * 对后者会检查对应测试标题是否仍然存在，避免关联失效后没有提示。
 *
 * 设计说明见 dsh-seam 仓 `docs/origin.md`（决策谱系）；消费仓侧的落地
 * 文档由各仓自持（试点 dsh-log-enhance 的历史设计文档随该仓保留）。
 */

import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
  /** One entry per source access site, each with the guards it runs under. */
  readonly accesses: readonly AccessRecord[]
}

/** 源码里这条读取实际所处的收窄（插件实际用法，由扫描器提取）。 */
export interface Guard {
  /** 插件源码里的访问链文本，如 `event.type`。 */
  readonly expr: string
  /** `eq`/`ne`：字面量比较；`defined`：链非 undefined；`falsy`：链为假值。 */
  readonly kind: 'eq' | 'ne' | 'defined' | 'falsy'
  readonly literal?: string
}

export interface AccessRecord {
  readonly site: string
  readonly guards: readonly Guard[]
  /** `for…of` 元素读取：被遍历表达式与循环变量名。 */
  readonly elementOf?: string
  readonly binding?: string
}

export interface AugmentationParam {
  readonly name: string
  readonly type: string
  readonly optional?: boolean
  readonly rest?: boolean
}

export interface AugmentationMember {
  readonly kind: 'method' | 'property'
  readonly params?: readonly AugmentationParam[]
  readonly type?: string
  readonly optional?: boolean
  readonly site: string
}

export interface Coupling {
  readonly srcHooks: readonly HookRecord[]
  readonly testHooks: readonly HookRecord[]
  readonly ctxAccesses: Readonly<Record<string, readonly string[]>>
  readonly fieldPaths: Readonly<Record<string, Readonly<Record<string, PathRecord>>>>
  readonly discriminants: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>
  readonly injectedServices: readonly string[]
  /** 扫描器记录的静态 import 清单（包名 → 声明位置/根）。检查代码的裸
   *  `import type {}`（声明合并副作用）从这里推导；旧清单没有该段也兼容。 */
  readonly packages?: Readonly<Record<string, unknown>>
  /** 源内 `.ts` 的 `declare module '@deepseek-ai/...'`（L2b 锚定增强）。 */
  readonly augmentations?: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, AugmentationMember>>>>>>
  /** 未锚定的 Context 属性访问（L3/L4 借用面），按首段服务名记录。 */
  readonly borrowed?: readonly string[]
}

/** 检查代码规格：一个**代码片段**而不是一段描述——片段在真实上游声明上编译通过，
 *  这条依赖项才算今天仍然成立。`rootType` 与 coupling.json 记录的一致性是
 *  自检项——清单漂移而规格没跟上时会直接报错，而不是悄悄验错东西。 */
export interface ProbeSpec {
  /** `coupling.json` 记录的根类型；生成时逐字比对。 */
  readonly rootType: string
  /** 检查代码函数的参数声明；省略表示片段直接写在 `apply` 里（用 `ctx`）。 */
  readonly parameter?: string
  /** 取字段前必须做的收窄（判别式 / undefined / 联合分支）。 */
  readonly prelude?: readonly string[]
  /** `[]` 元素跳：遍历的数组表达式、循环变量名，以及循环内的收窄行。 */
  readonly element?: {
    readonly of: string
    readonly guard?: string
    readonly binding?: string
    readonly inner?: readonly string[]
  }
  /** 被验证的字段访问表达式。 */
  readonly access: string
  /** 自动生成时该规格对应的访问点（手写 override 没有）。 */
  readonly site?: string
  /** 该访问点的类型收窄条件，按源码顺序（用于标题摘要；prelude 只回放与检查代码参数同根的类型收窄条件）。 */
  readonly guards?: readonly Guard[]
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

/** 引擎在跑隐性检查代码时递给它的环境（检查代码不自己找仓库根）。 */
export interface SeamEnvironment {
  readonly root: string
  readonly readText: (relativePath: string) => string
  /** 生成器判定的"coupling.json 里有、但既没有检查代码也没有豁免"的键。 */
  readonly unprobed: readonly string[]
  /** 版本锁策略（来自 suite.versionLockstep；缺省 = single-line）。 */
  readonly versionLockstep?: 'single-line' | 'range'
}

export type SeamRun = (context: TestContext, environment: SeamEnvironment) => void | Promise<void>

/** 异常场景：用 mock 声明替换真实上游包，删掉一个字段后检查代码必须编译失败。 */
export interface MockCheckoutScenario {
  /** 完整的 test 标题。 */
  readonly title: string
  /** 在 `fieldSpecs` 里查检查代码规格的键（`pkg::path`）。 */
  readonly specKey: string
  /** 被模拟的上游包名（决定 node_modules 下的 mock 摆放位置）。 */
  readonly packageName: string
  /** 检查代码文件第一行的 type import（与 `packageName` 对应）。 */
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

export type UnverifiableExemption = string | { readonly reason: string; readonly seamId: string }

export interface SeamSuite {
  readonly root: string
  readonly coupling: Coupling
  /** 每条路径一个或多个规格（每个访问点一个）；`event:*` 载荷由挂载循环生成。 */
  readonly fieldSpecs: Readonly<Record<string, readonly ProbeSpec[]>>
  readonly discriminantSpecs: Readonly<Record<string, DiscriminantSpec>>
  /**
   * 人工覆盖机制：键为 `pkg::path@site`（只换该访问点的规格）或裸 `pkg::path`
   * （整条路径只留这一份），替换自动生成的规格——用于提取器暂不覆盖的
   * 形状。本仓今天应为空；非空即提取器缺口信号。
   */
  readonly overrides?: Readonly<Record<string, ProbeSpec>> | undefined
  /** 类型系统证明不了的依赖项：键是表面，值是"为什么不可能"的理由（须指向覆盖它的 implicit/<id>）。 */
  readonly unverifiable: Readonly<Record<string, UnverifiableExemption>>
  /** 键是隐含依赖 id（与 `implicitSeams` 对齐），不是上游表面。 */
  readonly implicitFragments: Readonly<Record<string, readonly TypeFragment[]>>
  readonly implicitSeams: readonly ImplicitSeam[]
  readonly implicitRuns: Readonly<Record<string, SeamRun>>
  readonly implicitDelegations?: Readonly<Record<string, readonly DelegationRef[]>>
  readonly abnormal?: MockCheckoutScenario | undefined
  readonly inventoryFloors?: InventoryFloors | undefined
  /**
   * 检查代码 import 的 suite 层补充：键是包名，值是该包需要 import 的类型名
   * （隐性片段引用、coupling.json 看不见的类型，如 dsh-llm 的
   * MessageSource）。空数组仍生成一行裸 `import type {} from '<pkg>'`
   * （声明合并副作用）。字段/判别检查代码所需的基础类型名从 rootType 自动
   * 推导——引擎不硬编码任何上游包。
   */
  readonly typeImports?: Readonly<Record<string, readonly string[]>> | undefined
  /**
   * 审计章节映射（章节命名与文档路径由各消费仓自定）：标题里的
   * `-> Audit §N` 后缀由调用方提供；缺省时标题不带章节后缀。钩子签名
   * 检查代码以 `hook:<event>` 为 pkg、空 path 调用。
   */
  readonly sectionFor?: ((pkg: string, path: string) => string) | undefined
  /**
   * 版本锁策略：'single-line'（默认——engines.dsh 下界 = devDependencies
   * 同版本依赖组 = baseline.json 指纹，三处同版本）；'range'（同版本依赖组只需落在
   * engines.dsh 区间内，上界仍必须带 `-0` 预发布版本边界）。本仓保持
   * single-line（docs/versioning.md §4）。
   */
  readonly versionLockstep?: 'single-line' | 'range' | undefined
}

/** cordis 插件对象（挂载验证用）。 */
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
export function findRepositoryRoot(packageName?: string, options?: { readonly requireCoupling?: boolean }): string {
  const requireCoupling = options?.requireCoupling ?? true
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const manifest = join(directory, 'package.json')
    const hasCoupling = existsSync(join(directory, 'coupling.json'))
    const hasNodeModules = existsSync(join(directory, 'node_modules'))
    if (existsSync(manifest) && (requireCoupling ? hasCoupling : (hasCoupling || hasNodeModules))) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
      if (packageName === undefined || parsed.name === packageName) return directory
    }
    const parent = dirname(directory)
    if (parent === directory) {
      throw new Error(
        requireCoupling
          ? 'repository root (package.json + coupling.json) not found'
          : 'repository root (package.json + node_modules) not found',
      )
    }
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
 * 自动规格生成：coupling.json 的访问记录 → ProbeSpec
 *
 * 检查代码的收窄 prelude 不再来自手写字典，而是来自插件自己源码里每次读取
 * 实际所处的类型收窄条件（插件实际用法）。跨根类型收窄条件（检查代码参数之外的变量）只进标题
 * 摘要、不回放进 prelude——回放需要第二个参数的根类型，而清单只记录
 * 路径级根类型；丢弃只会让检查代码更宽，编译失败即响亮暴露。
 * ------------------------------------------------------------------ */

/** 与手写字典同时代的参数命名，生成的检查代码读起来和从前一样。 */
const PARAMETER_NAMES: Readonly<Record<string, string>> = {
  Context: 'ctx',
  Agent: 'agent',
  Session: 'session',
  SessionEvent: 'event',
  ToolExecution: 'exec',
  'Readonly<ToolExecution>': 'exec',
  'Readonly<ToolExecution>|ToolExecution': 'exec',
  'Readonly<ToolExecutionResult>': 'result',
}

function splitTopLevelUnion(text: string): readonly string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const character of text) {
    if (character === '<' || character === '(') depth += 1
    if (character === '>' || character === ')') depth -= 1
    if (character === '|' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  parts.push(current.trim())
  return parts.filter(part => part !== '' && part !== 'undefined' && part !== 'null')
}

function unwrapReadonly(text: string): string {
  let core = text.trim()
  for (;;) {
    const wrapped = /^Readonly<(.*)>$/.exec(core)
    if (wrapped === null) break
    core = wrapped[1]!.trim()
  }
  return core
}

function parameterNameOf(rootType: string): string {
  const known = PARAMETER_NAMES[rootType]
  if (known !== undefined) return known
  const members = splitTopLevelUnion(rootType)
  const candidate = members.length === 1 ? members[0]! : rootType
  const core = unwrapReadonly(candidate)
  if (PARAMETER_NAMES[core] !== undefined) return PARAMETER_NAMES[core]!
  const identifier = /([A-Za-z_$][\w$]*)\s*$/.exec(core)?.[1] ?? 'value'
  return identifier.charAt(0).toLowerCase() + identifier.slice(1)
}

/** 类型收窄条件 → 检查代码里的收窄行（不含结尾的 `return`/`continue`）。 */
export function guardLine(guard: Guard): string {
  if (guard.kind === 'eq') return `if (${guard.expr} !== ${quote(guard.literal ?? '')})`
  if (guard.kind === 'ne') return `if (${guard.expr} === ${quote(guard.literal ?? '')})`
  if (guard.kind === 'defined') return `if (${guard.expr} === undefined)`
  return `if (${guard.expr})`
}

/** 标题里的类型收窄条件摘要：`event.type='tool/call' & exec.agent defined`。 */
export function guardSummary(guards: readonly Guard[]): string {
  return guards.map(guard => {
    if (guard.kind === 'eq') return `${guard.expr}='${guard.literal}'`
    if (guard.kind === 'ne') return `${guard.expr}!='${guard.literal}'`
    if (guard.kind === 'defined') return `${guard.expr} defined`
    return `!${guard.expr}`
  }).join(' & ')
}

const baseOf = (expr: string): string => /^([A-Za-z_$][\w$]*)/.exec(expr)?.[1] ?? expr

const rewriteGuardRoot = (guard: Guard, fromRoot: string, toRoot: string): Guard => {
  if (fromRoot === toRoot) return guard
  const escaped = fromRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const replaced = guard.expr.replace(new RegExp(`^${escaped}(?=\\.|$|\\?\\.)`), toRoot)
  return replaced === guard.expr ? guard : { ...guard, expr: replaced }
}

/** 只回放与 `root`（或别名根 `aliasRoot`）同根的类型收窄条件（其余只进标题）。 */
const replayable = (guards: readonly Guard[], root: string, aliasRoot?: string): readonly Guard[] =>
  guards.flatMap(guard => {
    const base = baseOf(guard.expr)
    if (base === root) return [guard]
    if (aliasRoot !== undefined && aliasRoot !== '' && base === aliasRoot) {
      return [rewriteGuardRoot(guard, aliasRoot, root)]
    }
    return []
  })

function buildProbeSpec(
  parameter: string,
  rootType: string,
  path: string,
  access: AccessRecord,
  includeParameter: boolean,
  explicitAlias?: string,
): ProbeSpec | null {
  if (access.elementOf !== undefined && access.binding !== undefined) {
    const rawRoot = baseOf(access.elementOf)
    const aliasRoot = rawRoot !== parameter && rawRoot !== access.binding ? rawRoot : explicitAlias
    const dot = access.elementOf.indexOf('.')
    const origin = dot === -1 ? '' : access.elementOf.slice(dot + 1)
    const expected = origin === '' ? '[]' : `${origin}[]`
    const rest = path === expected ? '' : path.startsWith(`${expected}.`) ? path.slice(expected.length + 1) : null
    if (rest === null) return null
    const outer = replayable(access.guards, parameter, aliasRoot).map(guard => `${guardLine(guard)} return`)
    const inner = access.guards
      .filter(guard => baseOf(guard.expr) === access.binding)
      .map(guard => `${guardLine(guard)} continue`)
    return {
      rootType,
      ...(includeParameter ? { parameter: `${parameter}: ${rootType}` } : {}),
      ...(outer.length === 0 ? {} : { prelude: outer }),
      element: {
        of: origin === '' ? parameter : `${parameter}.${origin}`,
        binding: access.binding,
        ...(inner.length === 0 ? {} : { inner }),
      },
      access: rest === '' ? access.binding : `${access.binding}.${rest}`,
      site: access.site,
      guards: access.guards,
    }
  }
  const prelude = replayable(access.guards, parameter, explicitAlias).map(guard => `${guardLine(guard)} return`)
  return {
    rootType,
    ...(includeParameter ? { parameter: `${parameter}: ${rootType}` } : {}),
    ...(prelude.length === 0 ? {} : { prelude }),
    access: path === '' ? parameter : `${parameter}.${path}`,
    site: access.site,
    guards: access.guards,
  }
}

/**
 * 把 coupling.json 的每一条访问记录变成一个 ProbeSpec：类型收窄条件按源码顺序回放
 * 成 prelude（元素读取拆成外层 `return` 行 + 循环内 `continue` 行）。
 * `event:*` 载荷路径跳过——它们由挂载循环自动覆盖。无法推导的形状
 * （例如嵌套循环元素链）返回 null：该路径会以 unprobed 响亮失败，由
 * `overrides` 兜底。
 */
export function probeSpecsFromCoupling(coupling: Coupling): {
  readonly fieldSpecs: Readonly<Record<string, readonly ProbeSpec[]>>
  readonly discriminantSpecs: Readonly<Record<string, DiscriminantSpec>>
} {
  const fieldSpecs: Record<string, readonly ProbeSpec[]> = {}
  const specFor = (path: string, record: PathRecord, access: AccessRecord): ProbeSpec | null => {
    const rootType = record.rootType
    if (rootType === 'Context') {
      return buildProbeSpec('ctx', rootType, path, access, false)
    }
    return buildProbeSpec(parameterNameOf(rootType), rootType, path, access, true)
  }

  for (const [pkg, paths] of Object.entries(coupling.fieldPaths)) {
    if (pkg.startsWith('event:')) continue
    for (const [path, record] of Object.entries(paths)) {
      if (path === '') continue
      const specs = record.accesses
        .map(access => specFor(path, record, access))
        .filter((spec): spec is ProbeSpec => spec !== null)
      if (specs.length > 0) fieldSpecs[`${pkg}::${path}`] = specs
    }
  }

  const discriminantSpecs: Record<string, DiscriminantSpec> = {}
  for (const [pkg, paths] of Object.entries(coupling.discriminants)) {
    if (pkg.startsWith('event:')) continue
    for (const [path, literals] of Object.entries(paths)) {
      const record = coupling.fieldPaths[pkg]?.[path]
      const access = record?.accesses[0]
      if (record === undefined || access === undefined) continue
      const spec = specFor(path, record, access)
      if (spec === null) continue
      discriminantSpecs[`${pkg}::${path}`] = { ...spec, literals }
    }
  }

  return { fieldSpecs, discriminantSpecs }
}

/** 应用人工覆盖机制：`pkg::path@site` 只换该访问点，裸 `pkg::path` 整条路径只留一份。 */
export function applyOverrides(
  fieldSpecs: Readonly<Record<string, readonly ProbeSpec[]>>,
  overrides: Readonly<Record<string, ProbeSpec>>,
): Readonly<Record<string, readonly ProbeSpec[]>> {
  const result: Record<string, readonly ProbeSpec[]> = { ...fieldSpecs }
  for (const [key, override] of Object.entries(overrides)) {
    const separator = key.lastIndexOf('::')
    const at = separator === -1 ? -1 : key.indexOf('@', separator + 2)
    const pathKey = at === -1 ? key : key.slice(0, at)
    const site = at === -1 ? undefined : key.slice(at + 1)
    const existing = result[pathKey]
    if (existing === undefined) throw new Error(`override '${key}' targets a surface with no generated spec`)
    if (site === undefined) {
      result[pathKey] = [override]
      continue
    }
    if (existing.every(spec => spec.site !== site)) {
      throw new Error(`override '${key}' matches no generated access site`)
    }
    result[pathKey] = existing.map(spec => spec.site === site ? override : spec)
  }
  return result
}

/* ------------------------------------------------------------------ *
 * 检查代码 import 的自动推导：rootType 文本 → 需要的 type import
 *
 * 引擎不硬编码任何上游包。字段/判别检查代码的基础类型名从 coupling.json 的
 * rootType 推导（剥 `Readonly<…>`、按顶层 `|` 拆联合）；隐性片段引用的、
 * 清单看不见的类型（如 dsh-llm 的 MessageSource）由 suite 的 typeImports
 * 补充。空名数组的包仍生成一行裸 `import type {} from '<pkg>'`——那行
 * import 的类型侧副作用（声明合并）正是某些片段需要的。
 * ------------------------------------------------------------------ */

const TS_TYPE_KEYWORDS = new Set([
  'undefined', 'null', 'never', 'unknown', 'any', 'void',
  'string', 'number', 'boolean', 'object', 'symbol', 'bigint',
])

/** rootType 文本 → 可 import 的基础类型名（去重）。只保留纯标识符——
 *  `Extract<…>` 之类复杂文本不是可 import 的名字，交给 typeImports。 */
export function baseTypeNames(rootType: string): readonly string[] {
  const names = new Set<string>()
  for (const piece of splitTopLevelUnion(rootType)) {
    const part = unwrapReadonly(piece)
    if (/^[A-Za-z_$][\w$]*$/.test(part) && !TS_TYPE_KEYWORDS.has(part)) names.add(part)
  }
  return [...names]
}

function needsCordisApply(coupling: Coupling): boolean {
  return coupling.srcHooks.length > 0
    || coupling.testHooks.length > 0
    || coupling.injectedServices.length > 0
    || Object.keys(coupling.ctxAccesses).length > 0
    || Object.keys(coupling.fieldPaths['@deepseek-ai/cordis'] ?? {}).length > 0
    || coupling.packages?.['@deepseek-ai/cordis'] !== undefined
    || coupling.augmentations?.['@deepseek-ai/cordis'] !== undefined
}

/** fieldPaths 的 rootType（跳过 `event:*` 载荷）+ suite 层补充 + packages/augmentations
 *  清单里没有任何字段读取的包（裸 import = 镜像插件自己的 import 环境，
 *  声明合并副作用随之生效）→ 包名 → 类型名集合。 */
export function derivedTypeImports(
  coupling: Coupling,
  typeImports: Readonly<Record<string, readonly string[]>> | undefined,
): ReadonlyMap<string, ReadonlySet<string>> {
  const merged = new Map<string, Set<string>>()
  for (const [pkg, names] of Object.entries(typeImports ?? {})) {
    merged.set(pkg, new Set(names))
  }
  if (needsCordisApply(coupling)) {
    const cordis = merged.get('@deepseek-ai/cordis') ?? new Set<string>()
    cordis.add('Context')
    merged.set('@deepseek-ai/cordis', cordis)
  }
  for (const [pkg, paths] of Object.entries(coupling.fieldPaths)) {
    if (pkg.startsWith('event:')) continue
    const bucket = merged.get(pkg) ?? new Set<string>()
    for (const record of Object.values(paths)) {
      for (const name of baseTypeNames(record.rootType)) bucket.add(name)
    }
    merged.set(pkg, bucket)
  }
  for (const pkg of Object.keys(coupling.packages ?? {})) {
    if (!merged.has(pkg)) merged.set(pkg, new Set<string>())
  }
  for (const pkg of Object.keys(coupling.augmentations ?? {})) {
    if (!merged.has(pkg)) merged.set(pkg, new Set<string>())
  }
  return merged
}

/* ------------------------------------------------------------------ *
 * 标准检查代码（与仓库无关，任何接入仓都能用）
 * ------------------------------------------------------------------ */

/**
 * 版本锁（single-line，默认）：`engines.dsh` 下界、devDependencies 的 dsh
 * 同版本依赖组、baseline.json 的指纹同版本依赖组必须是同一个版本（modulo build metadata：
 * 等式两边先剥 `+<build>` 再比——bump 写模式的产物 devDeps 钉完整版本而
 * engines 下界剥后缀，见下面 stripBuild 注释），workflow 不得自带版本号。
 * range 模式（`versionLockstep: 'range'`）：同版本依赖组只需落在 engines.dsh 区间
 * 内（下界 ≤ 同版本依赖组 < 上界，含 `-0` 预发布版本边界语义——用下面的 compareVersions，
 * 与 scripts/bump-upstream.mjs 同一套算法；引擎不能 import
 * @deepseek-ai/dsh-app-boot 去借官方 gate，那会把新包 import 记进
 * coupling.json 的 packages 清单，而清单必须统一由扫描器生成）；上界仍必须
 * 带 `-0` 墙，baseline 指纹跟随同版本依赖组。两种模式都只读 package.json /
 * baseline.json / `.github/workflows/ci.yml`，且全部经由 environment（root
 * 来自 suite）——临时目录夹具即可直接测试。
 */

/** 极简 semver 排序：core 三元组 → 预发布标识符逐段（数字段 < 字母段，
 *  短的前缀相等则更小），无预发布 > 有预发布；build metadata 解析但按
 *  semver 先序规则忽略（`0.2.2-rc.4+build.1` ≡ `0.2.2-rc.4`）。与
 *  bump-upstream.mjs 的 compareVersions 语义一致（tests/engine-contract
 *  的向量集钉住两边同步）；两边都不引入第三方 semver 依赖。
 *  导出仅供测试直接喂向量。 */
export function compareVersions(a: string, b: string): number {
  const parse = (text: string): { readonly core: readonly number[], readonly pre: readonly string[] } | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text)
    return match === null ? undefined : {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] === undefined ? [] : match[4].split('.'),
    }
  }
  const left = parse(a)
  const right = parse(b)
  if (left === undefined || right === undefined) return a.localeCompare(b)
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return (left.core[index] ?? 0) < (right.core[index] ?? 0) ? -1 : 1
    }
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1 // release sorts above any prerelease
  if (right.pre.length === 0) return -1
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const x = left.pre[index]
    const y = right.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const numericX = /^\d+$/.test(x)
    const numericY = /^\d+$/.test(y)
    if (numericX && numericY) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    } else if (numericX) return -1
    else if (numericY) return 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export async function probeVersionLockstep(context: TestContext, environment: SeamEnvironment): Promise<void> {
  void context
  const manifest = JSON.parse(environment.readText('package.json')) as {
    engines?: { dsh?: string }
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  const range = manifest.engines?.dsh
  assert.ok(range !== undefined, 'package.json must declare engines.dsh')
  // build metadata 不参与 semver 先序，也不参与 lockstep：bump 写模式对
  // +build target 的产物是 devDeps 钉完整版本、engines 下界剥掉后缀
  // （range 语法携带不了 build metadata）、baseline 指纹带完整串。每个
  // 等式两边都先剥再比——不变量是「同一版本 modulo build metadata」。
  const stripBuild = (version: string): string => version.replace(/\+[0-9A-Za-z.-]+$/, '')
  const floorOf = (): string => {
    const floor = /^>=\s*(\S+)/.exec(range)?.[1]
    assert.ok(floor !== undefined, `engines.dsh must open with >=<version>: ${range}`)
    return stripBuild(floor)
  }

  const isTrainPackage = (name: string): boolean =>
    name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
  const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
  const trainEntries = [
    ...Object.entries(manifest.dependencies ?? {}).filter(([name]) => isTrainPackage(name)),
    ...Object.entries(manifest.devDependencies ?? {}).filter(([name]) => isTrainPackage(name)),
    ...Object.entries(manifest.peerDependencies ?? {}).filter(([name, version]) => isTrainPackage(name) && exactVersion.test(version)),
  ]
  const train = new Set(trainEntries.map(([, version]) => stripBuild(version)))
  assert.equal(train.size, 1, `manifest must pin exactly one dsh train: ${[...train].join(', ')}`)
  const trainVersion = [...train][0] ?? ''

  if (environment.versionLockstep === 'range') {
    const bounds = /^>=\s*(\S+)\s+<\s*(\S+)\s*$/.exec(range)
    assert.ok(bounds !== null, `range mode needs an explicit interval (>=<floor> <upper>): ${range}`)
    const floor = bounds[1] ?? ''
    const upper = bounds[2] ?? ''
    assert.match(upper, /-0$/, `the upper bound must keep its -0 prerelease wall: ${range}`)
    assert.ok(
      compareVersions(floor, trainVersion) <= 0,
      `the train ${trainVersion} must not sit below the engines.dsh floor ${floor}`,
    )
    assert.ok(
      compareVersions(trainVersion, upper) < 0,
      `the train ${trainVersion} must stay below the -0 wall ${upper} (crossing the wall is a conscious decision)`,
    )
  } else {
    assert.equal(trainVersion, floorOf(), 'engines.dsh floor and the devDependency train must agree (same version modulo build metadata)')
  }

  // Workflows carry no version of their own (both modes): the manifest and
  // baseline.json are the ONLY version state, so a re-pinned dshVersion in a
  // workflow would be a silent extra copy of the truth drifting free.
  let ciWorkflow: string | undefined
  try {
    ciWorkflow = environment.readText('.github/workflows/ci.yml')
  } catch {
    ciWorkflow = undefined
  }
  if (ciWorkflow !== undefined) {
    assert.doesNotMatch(
      ciWorkflow,
      /dshVersion:\s*\S/,
      'ci.yml must not pin a dsh version — package.json + baseline.json are the only version state',
    )
  }

  const baseline = JSON.parse(environment.readText('baseline.json')) as { packages: Record<string, { version: string }> }
  const fingerprinted = new Set(
    Object.entries(baseline.packages)
      .filter(([name]) => name === 'dsh' || name.startsWith('dsh-'))
      .map(([, pkg]) => stripBuild(pkg.version)),
  )
  assert.equal(fingerprinted.size, 1, `baseline.json must fingerprint one dsh train: ${[...fingerprinted].join(', ')}`)
  if (environment.versionLockstep === 'range') {
    assert.equal([...fingerprinted][0], trainVersion, 'baseline.json train must equal the devDependency train (modulo build metadata)')
  } else {
    assert.equal([...fingerprinted][0], floorOf(), 'baseline.json train must equal the engines.dsh floor (modulo build metadata)')
  }
}

/** 引擎自带的可复用检查代码，按隐含依赖 id 键控；接入仓在简单入口文件里按自己登记的
 *  契约 id 挑选合并。 */
export const standardRuns: Readonly<Record<string, SeamRun>> = {
  'version-lockstep': probeVersionLockstep,
}

/* ------------------------------------------------------------------ *
 * 检查插件生成
 * ------------------------------------------------------------------ */

interface SeamMeta { readonly id: string, readonly title: string }

interface Generated {
  readonly source: string
  readonly segments: ReadonlyMap<string, SeamMeta>
  /** 每行（0 基）归属的依赖项 id；null 表示脚架（imports、导出）。 */
  readonly lineOwners: readonly (string | null)[]
  /** 生成顺序的 hook 名，挂载后逐个核对。 */
  readonly hookNames: readonly string[]
  /** `coupling.json` 里有、但既没有检查代码也没有豁免的键。 */
  readonly unprobed: readonly string[]
  /** 规格里写了、但 `coupling.json` 已经不记录的键（清单过期）。 */
  readonly stale: readonly string[]
  /** 根类型与 `coupling.json` 不一致的规格。 */
  readonly mismatched: readonly string[]
}

/** 一个字段检查代码的函数体（不含签名）。异常场景测试复用同一渲染器。 */
function probeBodyLines(spec: ProbeSpec, indent: string): string[] {
  const out: string[] = []
  for (const line of spec.prelude ?? []) out.push(`${indent}${line}`)
  if (spec.element !== undefined) {
    const binding = spec.element.binding ?? 'item'
    out.push(`${indent}for (const ${binding} of ${spec.element.of}) {`)
    if (spec.element.guard !== undefined) out.push(`${indent}  ${spec.element.guard}`)
    for (const line of spec.element.inner ?? []) out.push(`${indent}  ${line}`)
    out.push(`${indent}  const _probe = ${spec.access}`)
    out.push(`${indent}  void _probe`)
    out.push(`${indent}}`)
  } else {
    out.push(`${indent}const _probe = ${spec.access}`)
    out.push(`${indent}void _probe`)
  }
  return out
}

/** 一个判别字面量检查代码的函数体（不含签名）。顶层探针与 event:* 载荷检查共用。 */
function probeDiscriminantBodyLines(
  spec: ProbeSpec,
  literals: readonly string[],
  indent: string,
): string[] {
  const out: string[] = []
  for (const line of spec.prelude ?? []) out.push(`${indent}${line}`)
  if (spec.element !== undefined) {
    const binding = spec.element.binding ?? 'item'
    out.push(`${indent}for (const ${binding} of ${spec.element.of}) {`)
    if (spec.element.guard !== undefined) out.push(`${indent}  ${spec.element.guard}`)
    for (const line of spec.element.inner ?? []) out.push(`${indent}  ${line}`)
    for (const literal of literals) out.push(`${indent}  if (${spec.access} === ${quote(literal)}) { void ${spec.access} }`)
    out.push(`${indent}}`)
  } else {
    for (const literal of literals) out.push(`${indent}if (${spec.access} === ${quote(literal)}) { void ${spec.access} }`)
  }
  return out
}

/**
 * Generation-time syntax self-check (J2 diagnosability): a malformed probe
 * used to surface only as cryptic unattributed TS1005s by line number, with
 * the probe file deleted before anyone could read it. Parse the generated
 * source up front and fail loudly, naming the offending lines, so generation
 * bugs are unmistakable. `parseDiagnostics` is a TypeScript internal field
 * (stable since 2.x) — the only cheap way to get parse errors without a
 * full program.
 */
function assertGeneratedSyntax(source: string): void {
  const file = ts.createSourceFile('seam-probe.ts', source, ts.ScriptTarget.Latest, true)
  const parseErrors = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []
  if (parseErrors.length > 0) {
    const details = parseErrors
      .map(diagnostic => `${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')} (line ${diagnostic.start === undefined ? '?' : file.getLineAndCharacterOfPosition(diagnostic.start).line + 1})`)
      .join('; ')
    throw new Error(`probe generation produced invalid TypeScript (engine bug — please report): ${details}`)
  }
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
  /** L3 借用登记：运行时容错的查表（守卫引用这些名的探针块在 mount 时
   * 会被 cordis 的 "cannot get property without inject" 抛穿——编译层
   * 已裁决，运行时不裁决，只登记）。 */
  const borrowedNames = new Set(coupling.borrowed ?? [])

  const emit = (text: string, seam: string | null = null): void => {
    lines.push(text)
    owners.push(seam)
  }
  const claim = (id: string, title: string): string => {
    if (segments.has(id)) throw new Error(`duplicate seam id in generated probe: ${id}`)
    segments.set(id, { id, title })
    return id
  }
  const siteOf = (pkg: string, path: string): string =>
    coupling.fieldPaths[pkg]?.[path]?.accesses[0]?.site ?? 'unknown'

  /** 章节后缀由 suite 提供（`hook:<event>` 是钩子签名检查代码的约定键）；缺省省略。 */
  const sectionSuffix = (pkg: string, path: string): string => {
    const section = suite.sectionFor?.(pkg, path)
    return section === undefined ? '' : ` -> Audit ${section}`
  }

  /** 检查代码标题：带上访问点与类型收窄条件摘要，同一路径的多个访问点一眼可分。 */
  const fieldTitle = (pkg: string, path: string, spec: ProbeSpec, record: PathRecord): string => {
    const site = spec.site ?? record.accesses[0]?.site ?? 'unknown'
    const guards = spec.guards ?? []
    const under = guards.length === 0 ? '' : ` under ${guardSummary(guards)}`
    return `[auto/field] ${pkg} :: ${path} (at ${site}${under})${sectionSuffix(pkg, path)}`
  }

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

  // ---- 文件头（type import 由 rootType + typeImports 自动推导） ------
  const inject = [...coupling.injectedServices]
  const imports = derivedTypeImports(coupling, suite.typeImports)
  emit('// Generated by the seam-verification engine (tests/seam/engine.ts) — do not edit.')
  emit('// One fragment per seam in coupling.json; compile failures are mapped back by line.')
  for (const pkg of [...imports.keys()].sort()) {
    const names = [...(imports.get(pkg) ?? [])].sort()
    emit(names.length === 0
      ? `import type {} from '${pkg}'`
      : `import type { ${names.join(', ')} } from '${pkg}'`)
  }
  for (const pkg of Object.keys(coupling.augmentations ?? {}).sort()) {
    const ifaces = coupling.augmentations?.[pkg] ?? {}
    emit('')
    emit(`declare module ${quote(pkg)} {`)
    for (const ifaceName of Object.keys(ifaces).sort()) {
      const members = ifaces[ifaceName] ?? {}
      emit(`  interface ${ifaceName} {`)
      for (const memberName of Object.keys(members).sort()) {
        const spec = members[memberName]
        if (spec === undefined) continue
        const opt = spec.optional === true ? '?' : ''
        if (spec.kind === 'method') {
          const params = (spec.params ?? []).map(p =>
            `${p.rest === true ? '...' : ''}${p.name}${p.rest !== true && p.optional === true ? '?' : ''}: ${p.type}`,
          ).join(', ')
          emit(`    ${quote(memberName)}${opt}: (${params}) => any`)
        } else {
          emit(`    ${quote(memberName)}${opt}: ${spec.type ?? 'any'}`)
        }
      }
      emit('  }')
    }
    emit('}')
  }
  emit('')
  emit("export const name = 'seam-probe'")
  emit(`export const inject = ${JSON.stringify(inject)}`)
  emit('export const registered: string[] = []')
  emit('')

  // ---- 顶层字段检查代码（每个访问点一个） --------------------------------
  for (const [pkg, paths] of Object.entries(coupling.fieldPaths)) {
    if (pkg.startsWith('event:') || pkg === '@deepseek-ai/cordis') continue
    for (const [path, record] of Object.entries(paths)) {
      const key = `${pkg}::${path}`
      // 空路径仅作判别比较的位置/根类型锚点，不单独生成 [auto/field] 探针。
      if (path === '') { covered.add(key); continue }
      // 类型上不可证的依赖项在 unverifiable 里写明理由，由隐性层检查代码补运行时证据。
      if (key in unverifiable) { covered.add(key); continue }
      const specs = fieldSpecs[key] ?? []
      specs.forEach((spec, index) => {
        checkRoot(spec.site === undefined ? key : `${key}@${spec.site}`, spec, record)
        const seam = claim(`field:${key}@${spec.site ?? index}`, fieldTitle(pkg, path, spec, record))
        covered.add(key)
        emit(`// ${key} @ ${spec.site ?? index}`, seam)
        emit(`function probe_${counter += 1}(${spec.parameter ?? ''}): void {`, seam)
        for (const line of probeBodyLines(spec, '  ')) emit(line, seam)
        emit('}', seam)
        emit('', seam)
      })
    }
  }

  // ---- 顶层判别字面量检查代码 -------------------------------------------
  for (const [pkg, paths] of Object.entries(coupling.discriminants)) {
    if (pkg.startsWith('event:')) continue
    for (const [path, literals] of Object.entries(paths)) {
      const key = `${pkg}::${path}`
      const spec = discriminantSpecs[key]
      if (spec === undefined) continue
      const record = coupling.fieldPaths[pkg]?.[path]
      if (record !== undefined) checkRoot(key, spec, record)
      const displayPath = path === '' ? parameterNameOf(spec.rootType) : path
      const seam = claim(
        `discriminant:${key}`,
        `[auto/discriminant] ${pkg} :: ${displayPath} ∈ {${literals.join(', ')}} (at ${siteOf(pkg, path)})`
          + sectionSuffix(pkg, path),
      )
      covered.add(key)
      const body = probeDiscriminantBodyLines(spec, literals, '  ')
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
  const emitApply = needsCordisApply(coupling)
  if (emitApply) emit('export function apply(ctx: Context): void {')

  const emittedPayloadKeys = new Set<string>()

  const emitHook = (hook: HookRecord, kind: 'src' | 'test'): void => {
    const site = hook.sites[0] ?? hookSite(hook.event, kind)
    const baseHookId = `hook:${kind}:${hook.event}`
    const hookId = segments.has(baseHookId)
      ? `${baseHookId}@${site}(${hook.via}:${hook.params.join(',')})`
      : baseHookId
    const seam = claim(
      hookId,
      `[auto/${kind === 'src' ? 'hook' : 'test-hook'}] ${hook.event}(${hook.params.join(', ')})`
        + ` (at ${site})${sectionSuffix(`hook:${hook.event}`, '')}`,
    )
    hookNames.push(hook.event)
    emit(`  registered.push(${quote(hook.event)})`, seam)
    const parameters = hook.params.map((parameter, index) =>
      parameter.startsWith('{') ? (index === 0 ? 'payload' : `payload_${index}`) : parameter)
    emit(`  ctx.on(${quote(hook.event)}, (${parameters.join(', ')}) => {`, seam)
    for (const name of new Set(parameters)) emit(`    void ${name}`, seam)

    // 事件载荷字段（coupling.json 的 `event:<name>` 与 `event:<name>#<i>` 段）在这里按参数位置验证。
    if (kind === 'src' && hook.via === 'on' && parameters.length > 0) {
      for (let paramIndex = 0; paramIndex < parameters.length; paramIndex += 1) {
        const payloadKey = paramIndex === 0 ? `event:${hook.event}` : `event:${hook.event}#${paramIndex}`
        if (emittedPayloadKeys.has(payloadKey)) continue
        const payloadFields = coupling.fieldPaths[payloadKey] ?? {}
        const payloadDiscriminants = coupling.discriminants[payloadKey] ?? {}
        if (Object.keys(payloadFields).length === 0 && Object.keys(payloadDiscriminants).length === 0) continue
        emittedPayloadKeys.add(payloadKey)

        const canonicalName = paramIndex === 0 ? 'payload' : `payload_${paramIndex}`
        const actualParam = parameters[paramIndex]!
        const aliasParam = actualParam !== canonicalName ? actualParam : undefined

        for (const [path, record] of Object.entries(payloadFields)) {
          const key = `${payloadKey}::${path}`
          if (path === '') { covered.add(key); continue }
          for (const access of record.accesses) {
            const spec = buildProbeSpec(canonicalName, record.rootType, path, access, false, aliasParam)
            if (spec === null) continue
            const under = access.guards.length === 0 ? '' : ` under ${guardSummary(access.guards)}`
            const fieldSeam = claim(
              `field:${key}@${access.site}`,
              `[auto/field] ${payloadKey} :: ${path} (at ${access.site}${under})${sectionSuffix(payloadKey, path)}`,
            )
            covered.add(key)
            if ((spec.prelude?.length ?? 0) === 0 && spec.element === undefined) {
              emit(`    void ${actualParam}.${path}`, fieldSeam)
            } else {
              emit('    {', fieldSeam)
              emit(`      const _${canonicalName} = ${actualParam}`, fieldSeam)
              emit(`      ;((${canonicalName}: typeof _${canonicalName}) => {`, fieldSeam)
              for (const line of probeBodyLines(spec, '        ')) emit(line, fieldSeam)
              emit(`      })(_${canonicalName})`, fieldSeam)
              emit('    }', fieldSeam)
            }
          }
        }
        for (const [path, literals] of Object.entries(payloadDiscriminants)) {
          const key = `${payloadKey}::${path}`
          const payloadRecord = payloadFields[path]
          const access = payloadRecord?.accesses[0]
          const spec = access === undefined
            ? undefined
            : buildProbeSpec(canonicalName, payloadRecord!.rootType, path, access, false, aliasParam)
          if (spec === null) continue
          const displayPath = path === '' ? actualParam : path
          const discriminantSeam = claim(
            `discriminant:${key}`,
            `[auto/discriminant] ${payloadKey} :: ${displayPath} ∈ {${literals.join(', ')}}`
              + ` (at ${siteOf(payloadKey, path)})${sectionSuffix(payloadKey, path)}`,
          )
          covered.add(key)
          if (spec === undefined || ((spec.prelude?.length ?? 0) === 0 && spec.element === undefined)) {
            const targetExpr = path === '' ? actualParam : `${actualParam}.${path}`
            for (const literal of literals) {
              emit(`    if (${targetExpr} === ${quote(literal)}) { void ${targetExpr} }`, discriminantSeam)
            }
          } else {
            emit('    {', discriminantSeam)
            emit(`      const _${canonicalName} = ${actualParam}`, discriminantSeam)
            emit(`      ;((${canonicalName}: typeof _${canonicalName}) => {`, discriminantSeam)
            for (const line of probeDiscriminantBodyLines(spec, literals, '        ')) emit(line, discriminantSeam)
            emit(`      })(_${canonicalName})`, discriminantSeam)
            emit('    }', discriminantSeam)
          }
        }
      }
    }

    emit(`    return ${parameters.includes('next') ? 'next()' : 'undefined'}`, seam)
    emit('  })', seam)
  }

  for (const hook of coupling.srcHooks) emitHook(hook, 'src')
  for (const hook of coupling.testHooks) emitHook(hook, 'test')

  // ---- ctx 作用域的字段（只能在 apply 里验证，每个访问点一个） ------
  for (const [path, record] of Object.entries(coupling.fieldPaths['@deepseek-ai/cordis'] ?? {})) {
    const key = `@deepseek-ai/cordis::${path}`
    if (path === '') { covered.add(key); continue }
    if (key in unverifiable) { covered.add(key); continue }
    const specs = fieldSpecs[key] ?? []
    specs.forEach((spec, index) => {
      checkRoot(spec.site === undefined ? key : `${key}@${spec.site}`, spec, record)
      const seam = claim(`field:${key}@${spec.site ?? index}`, fieldTitle('@deepseek-ai/cordis', path, spec, record))
      covered.add(key)
      // 守卫回放里的 `return` 只能退出本探针块：裸块的 return 会中断
      // apply 的后续探针与 hook 注册（mount 验证要求全部 hook 注册）。
      // 块体包一层立即调用的局部函数，运行时守卫不成立时仅跳过本块。
      emit('  {', seam)
      emit('    const probeBlock = (): void => {', seam)
      for (const line of probeBodyLines(spec, '      ')) emit(line, seam)
      emit('    }', seam)
      // 守卫引用了已登记借用名（ctx.<borrowed>）的块：真实 Context 上未
      // inject 的属性读取会抛错（cordis 语义），编译层已裁决为借用面，
      // 运行时容错跳过；其余块保持直调，真异常仍然抛出。
      const guardBorrows = (spec.guards ?? []).some(guard => {
        const named = /^ctx(?:\?\.)?\.([A-Za-z_$][\w$]*)/.exec(guard.expr)?.[1]
        return named !== undefined && borrowedNames.has(named)
      })
      if (guardBorrows) {
        emit('    try { probeBlock() } catch { /* borrowed guard service absent at mount (L3, registered) */ }', seam)
      } else {
        emit('    probeBlock()', seam)
      }
      emit('  }', seam)
    })
  }

  if (emitApply) emit('}')

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
  assertGeneratedSyntax(`${lines.join('\n')}\n`)
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
 * 编译验证
 * ------------------------------------------------------------------ */

const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
  // 检查代码不使用 Node 全局；不加载 @types/node 能让解析更接近"只有上游声明"。
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
  srcHooks: 0,
  testHooks: 0,
  fieldPathPackages: 0,
  discriminantPackages: 0,
}

function unverifiableSeamIds(exemption: UnverifiableExemption): readonly string[] {
  if (typeof exemption === 'object') return [exemption.seamId]
  const ids: string[] = []
  for (const match of exemption.matchAll(/\bimplicit\/([A-Za-z0-9_-]+)/g)) {
    const id = match[1]
    if (id !== undefined) ids.push(id)
  }
  return ids
}

/** 契约层的检查结果：不注册任何测试，`runContractSuite`（测试发射）与
 *  `scripts/verify-coupling.mjs`（独立验证 CLI）共用同一份产物。 */
export interface ContractOutcome {
  /** 每条生成的依赖项（含标题）；problems 非空 = 该检查代码编译失败。
   * `borrowed` 非空 = 全部问题都是 TS2339-on-Context 且点名的属性均在
   * coupling.borrowed 登记中（L3 借用面：只登记，不裁决）。 */
  readonly segments: ReadonlyArray<{ readonly id: string, readonly title: string, readonly problems: readonly string[], readonly borrowed?: readonly string[] }>
  /** 未归属到任何依赖项的诊断（生成脚架自身坏了）。 */
  readonly unattributed: readonly string[]
  /** `coupling.json` 里有、但既没有检查代码也没有豁免的键。 */
  readonly unprobed: readonly string[]
  /** 规格里写了、但 `coupling.json` 已经不记录的键（清单过期）。 */
  readonly stale: readonly string[]
  /** 根类型与 `coupling.json` 不一致的规格。 */
  readonly mismatched: readonly string[]
}

/** checkContract 的完整产物（挂载验证还复用生成源码与 hook 名单）。 */
export interface ContractRun {
  readonly generated: Generated
  readonly outcome: ContractOutcome
}

/**
 * 契约层验证（只依赖 coupling.json + 规格 + 已安装的上游声明，不需要插件
 * 源码、不需要挂载）：生成检查插件 → 一次 tsc 编译 → 诊断按行归属到依赖项。
 * 不注册任何测试；一个独立的 coupling.json 就是自包含的消费者契约。
 *
 * 检查代码文件名带 pid：node --test 并发跑多个测试文件（乃至 CLI 子进程）时，
 * 各自的检查代码产物互不覆盖；`dist-test/` 是 gitignore 的一次性构建目录。
 */
let probeSequence = 0

function collectAmbientDtsFiles(root: string): readonly string[] {
  if (!existsSync(root)) return []
  const files: string[] = []
  try {
    for (const entry of readdirSync(root)) {
      if (!entry.endsWith('.d.ts')) continue
      const full = join(root, entry)
      if (!statSync(full).isDirectory()) files.push(full)
    }
  } catch {}
  const srcDir = join(root, 'src')
  if (existsSync(srcDir)) {
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else if (entry.endsWith('.d.ts')) files.push(full)
      }
    }
    try { walk(srcDir) } catch {}
  }
  return files.sort()
}

export function checkContract(suite: SeamSuite): ContractRun {
  /** 人工覆盖机制在此落地：overrides 替换自动生成的规格后再生效。 */
  const effective = suite.overrides === undefined
    ? suite
    : { ...suite, fieldSpecs: applyOverrides(suite.fieldSpecs, suite.overrides) }
  /** L3 借用登记（coupling.borrowed）：段级借用路由的查表。 */
  const borrowedSet = new Set(effective.coupling.borrowed ?? [])
  const generated = generate(effective)
  const bySeam = new Map<string, string[]>()
  const unattributed: string[] = []
  if (generated.segments.size === 0 && Object.keys(effective.implicitFragments).length === 0) {
    return {
      generated,
      outcome: {
        segments: [],
        unattributed,
        unprobed: generated.unprobed,
        stale: generated.stale,
        mismatched: generated.mismatched,
      },
    }
  }
  const ambientDts = collectAmbientDtsFiles(suite.root)
  const ambientSet = new Set(ambientDts.map(file => resolve(file)))
  const probeTs = join(suite.root, 'dist-test', `seam-probe-${process.pid}-${probeSequence += 1}.ts`)
  mkdirSync(dirname(probeTs), { recursive: true })
  writeFileSync(probeTs, generated.source)
  try {
    const program = ts.createProgram([...ambientDts, probeTs], COMPILER_OPTIONS)
    for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
      const text = `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`
      if (diagnostic.file === undefined || diagnostic.start === undefined) {
        unattributed.push(text)
        continue
      }
      const diagFile = resolve(diagnostic.file.fileName)
      if (ambientSet.has(diagFile)) continue
      if (diagFile !== resolve(probeTs)) {
        unattributed.push(`${text} (${diagnostic.file.fileName})`)
        continue
      }
      const line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line
      const message = `${text} (line ${line + 1})`
      const seam = generated.lineOwners[line] ?? null
      if (seam === null) {
        unattributed.push(message)
        continue
      }
      const bucket = bySeam.get(seam) ?? []
      bucket.push(message)
      bySeam.set(seam, bucket)
    }
    for (const [seam, messages] of bySeam) {
      if (messages.some(message => /^TS(?:2345|2769):/.test(message))) {
        const filtered = messages.filter(message => !/^TS7006:/.test(message))
        if (filtered.length > 0) bySeam.set(seam, filtered)
      }
    }
  } finally {
    rmSync(probeTs, { force: true })
  }
  return {
    generated,
    outcome: {
      segments: [...generated.segments.values()].map(segment => {
        const problems = bySeam.get(segment.id) ?? []
        /** L3 借用路由：问题全部是"Context 缺某属性"且该属性已登记借用
         *  （典型：探针回放的守卫表达式引用运行时注入服务）→ 标记借用，
         *  由消费方（verify-coupling / 套件）只登记不裁决。未登记的属性
         *  不标记——那是真回归，保持红。 */
        const missingContextProp = (problem: string): string | undefined =>
          /^TS2339: Property '([^']+)' does not exist on type 'Context'\./.exec(problem)?.[1]
        const named = problems.map(missingContextProp)
        const borrowed = named.length > 0 && named.every(prop => prop !== undefined && borrowedSet.has(prop))
          ? [...new Set(named.filter((prop): prop is string => prop !== undefined))]
          : []
        return {
          id: segment.id,
          title: segment.title,
          problems,
          ...(borrowed.length > 0 ? { borrowed } : {}),
        }
      }),
      unattributed,
      unprobed: generated.unprobed,
      stale: generated.stale,
      mismatched: generated.mismatched,
    },
  }
}

/**
 * 契约层测试（可独立于仓库跑）：每条依赖项编译干净 + 诊断归属 + 清单完整
 * （unprobed/stale/root 漂移）+ 记录下限。返回编译产物给全套件复用。
 */
export function runContractSuite(suite: SeamSuite): ContractRun {
  const { generated, outcome } = checkContract(suite)

  // ---- 显性层：每条依赖项一个 test ----------------------------------
  for (const segment of outcome.segments) {
    test(segment.title, t => {
      // L3 借用面（段级借用路由）：问题全部指向已登记借用的运行时服务
      // （守卫回放引用 ctx.<borrowed>）→ 只登记，不裁决。verify-coupling
      // 的独立通道会逐面输出借用清单；套件这里记 diagnostic 后通过。
      if ((segment.borrowed ?? []).length > 0) {
        t.diagnostic(`borrowed (registered, not adjudicated): ${[...(segment.borrowed ?? [])].join(', ')}`)
        return
      }
      assert.equal(
        segment.problems.length,
        0,
        `${segment.id}\n${segment.problems.map(problem => `  ${problem}`).join('\n')}`,
      )
    })
  }

  test('[intro] every diagnostic is attributed to a recorded seam', () => {
    assert.equal(
      outcome.unattributed.length,
      0,
      `unattributed diagnostics mean the generated scaffold broke:\n${outcome.unattributed.map(row => `  ${row}`).join('\n')}`,
    )
  })

  test('[intro] the probe inventory covers coupling.json without stale specs', () => {
    const problems = [
      ...outcome.unprobed.map(key => `no probe spec and no documented exemption: ${key}`),
      ...outcome.stale.map(key => `spec no longer matches coupling.json: ${key}`),
      ...outcome.mismatched.map(problem => `root type drift: ${problem}`),
    ]
    assert.deepEqual(problems, [])
  })

  const floors = suite.inventoryFloors ?? DEFAULT_INVENTORY_FLOORS

  test('[intro] coupling.json still records the surfaces this verifier was built for', () => {
    assert.ok(suite.coupling.srcHooks.length >= floors.srcHooks, 'srcHooks')
    assert.ok(suite.coupling.testHooks.length >= floors.testHooks, 'testHooks')
    assert.ok(Object.keys(suite.coupling.fieldPaths).length >= floors.fieldPathPackages, 'fieldPaths')
    assert.ok(Object.keys(suite.coupling.discriminants).length >= floors.discriminantPackages, 'discriminants')
  })

  return { generated, outcome }
}

/**
 * 全套件 = 契约层（`runContractSuite`，先跑）+ 仓库耦合层：真实 Context
 * 挂载验证、隐含依赖真跑/类型片段/委派核对、mock checkout 异常自检。
 * 标题与拆分前逐字一致——拆分只开放契约层的独立调用，不改行为。
 */
export function runSeamSuite(suite: SeamSuite): void {
  const { coupling, implicitSeams } = suite
  const { generated, outcome } = runContractSuite(suite)
  /** 契约层结果按依赖项 id 查询（隐性片段的二次断言用）。 */
  const problemsOf = (id: string): readonly string[] =>
    outcome.segments.find(segment => segment.id === id)?.problems ?? []

  // ---- 挂载验证 ------------------------------------------------------
  const inject = [...coupling.injectedServices]
  const probeMjs = join(suite.root, 'dist-test', `seam-probe-${process.pid}-${probeSequence += 1}.mjs`)

  test('[auto/plugin] the probe plugin mounts on a real Context and registers every recorded hook', async () => {
    const clean = outcome.unattributed.length === 0
      && outcome.segments.every(segment => segment.problems.length === 0
        || (segment.borrowed ?? []).length > 0)
    assert.ok(clean, 'mount verification requires a clean compile first')
    const { outputText } = ts.transpileModule(generated.source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
    })
    mkdirSync(dirname(probeMjs), { recursive: true })
    writeFileSync(probeMjs, outputText)
    try {
      const module = await import(pathToFileURL(probeMjs).href) as unknown as ProbeModule
      assert.equal(module.name, 'seam-probe')
      assert.deepEqual([...module.inject], inject)

      const ctx = new Context()
      // 检查插件声明 inject 了这些服务；挂载验证关心的是"声明与注册"，不是服务实现。
      for (const service of inject) provideStub(ctx, service, {})
      const fiber = await ctx.plugin(module as Plug)
      try {
        assert.deepEqual([...module.registered], [...generated.hookNames])
      } finally {
        await fiber.dispose()
      }
    } finally {
      rmSync(probeMjs, { force: true })
    }
  })

  // ---- 隐性层：登记 --------------------------------------------------
  const environment: SeamEnvironment = {
    root: suite.root,
    readText: relativePath => readText(suite.root, relativePath),
    unprobed: outcome.unprobed,
    versionLockstep: suite.versionLockstep ?? 'single-line',
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
      if (fragment) {
        const problems = problemsOf(`implicit:${seam.id}`)
        assert.equal(
          problems.length,
          0,
          `implicit:${seam.id}\n${problems.map(problem => `  ${problem}`).join('\n')}`,
        )
      }
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

    for (const [surface, exemption] of Object.entries(suite.unverifiable)) {
      const ids = unverifiableSeamIds(exemption)
      assert.ok(ids.length > 0, `unverifiable surface '${surface}' must reference a covering implicit/<id> seam`)
      for (const id of ids) {
        assert.ok(known.has(id), `unverifiable surface '${surface}' references unknown implicit seam '${id}'`)
        const hasRuntime = suite.implicitRuns[id] !== undefined || (suite.implicitDelegations?.[id]?.length ?? 0) > 0
        assert.ok(hasRuntime, `unverifiable surface '${surface}' must be backed by a runtime probe or delegation on implicit seam '${id}'`)
      }
    }
  })

  // ---- 异常场景：mock checkout 删掉一个字段，检查插件必须编译失败 ----
  const scenario = suite.abnormal
  const effectiveFieldSpecs = suite.overrides === undefined
    ? suite.fieldSpecs
    : applyOverrides(suite.fieldSpecs, suite.overrides)
  const abnormalSpec = scenario === undefined ? undefined : effectiveFieldSpecs[scenario.specKey]?.[0]
  if (scenario !== undefined && abnormalSpec !== undefined) {
    const spec = abnormalSpec
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
