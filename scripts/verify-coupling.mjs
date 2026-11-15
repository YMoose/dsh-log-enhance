#!/usr/bin/env node
/**
 * 独立检查插件的依赖清单：每份 coupling.json 都包含生成检查代码所需的信息。
 * 检查代码由 probeSpecsFromCoupling 自动生成，并在当前仓库已安装的
 * node_modules 上编译，不需要插件源码，也不挂载插件。无法通过编译确认的
 * 注入 ctx.* 服务和不透明 JsonValue 读取会按明确规则豁免；import 错误会
 * 映射回相应的 rootType。运行前需要执行 `npx tsc -p tsconfig.test.json`。
 *
 * @module dsh-seam/scripts/verify-coupling
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 参数：`[--types-root <dir>] <coupling.json> [...]`。--types-root（design.md 2.5）
 *  把 DSH 系列包（@deepseek-ai/dsh 与 dsh-*）的类型解析锚点重定向到显式类型
 *  目录（目录形态与 node_modules 同构：其下有 @deepseek-ai/<pkg>/…），用于
 *  升级前评估“升到目标版本会坏哪里”；cordis 等独立包仍解析本地安装。 */
const files = []
let typesRootArgument
{
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--types-root') {
      typesRootArgument = args[index + 1]
      if (typesRootArgument === undefined || typesRootArgument === '' || typesRootArgument.startsWith('--')) {
        console.error('--types-root requires a directory argument')
        process.exit(1)
      }
      index += 1
    } else if (argument.startsWith('--')) {
      console.error(`unknown option for verify-coupling: ${argument} (only --types-root is accepted here)`)
      process.exit(1)
    } else {
      files.push(argument)
    }
  }
}
if (files.length === 0) { console.error('usage: verify-coupling.mjs [--types-root <dir>] <coupling.json> [...]'); process.exit(1) }
const rootOverride = process.env.DSH_SEAM_ROOT ?? process.env.DSH_LOG_ENHANCE_ROOT
const typesRoot = typesRootArgument === undefined ? undefined : resolve(process.cwd(), typesRootArgument)
if (typesRoot !== undefined && !existsSync(join(typesRoot, '@deepseek-ai'))) {
  console.error(`types-root ${typesRoot} contains no @deepseek-ai packages — nothing to verify against`)
  process.exit(1)
}

/** types-root 里 DSH 系列包的 name@version 清单（报告标注用，版本即被测版本）。 */
function dshSeriesVersions(typesRootDir) {
  const scopeDir = join(typesRootDir, '@deepseek-ai')
  const listed = []
  for (const entry of readdirSync(scopeDir).sort()) {
    if (entry !== 'dsh' && !entry.startsWith('dsh-')) continue
    try {
      const version = JSON.parse(readFileSync(join(scopeDir, entry, 'package.json'), 'utf8')).version
      listed.push(`@deepseek-ai/${entry}@${String(version ?? 'unknown')}`)
    } catch {
      listed.push(`@deepseek-ai/${entry}@unreadable`)
    }
  }
  return listed.join(', ')
}

async function loadEngine(rootHint) {
  // 原生版 typescript@7（Go 实现）的根导出只有版本存根，没有经典 Compiler API；
  // 引擎自身 import 的 typescript 若解析到它，会在 checkContract 深处炸成天书
  // （ts.createProgram is not a function）。守卫必须先于 engine 候选加载：
  // 本仓可解析的 typescript 全部缺少经典 API 时，显式报错点名版本与路径。
  // （判定式与 analyze-dsh-coupling.mjs 的 hasClassicCompilerApi 同义：
  //  payload 各脚本独立可执行，不走跨文件 import。）
  const anchors = [
    import.meta.url,
    ...(rootHint !== undefined ? [pathToFileURL(join(rootHint, 'package.json')).href] : []),
    pathToFileURL(join(process.cwd(), 'package.json')).href,
  ]
  const nativeStubs = new Set()
  let classicFound = false
  for (const anchor of anchors) {
    try {
      const requireFrom = createRequire(anchor)
      const candidate = requireFrom('typescript')
      if (typeof candidate?.createProgram === 'function'
        && typeof candidate?.createSourceFile === 'function'
        && candidate?.SyntaxKind !== undefined) {
        classicFound = true
        break
      }
      nativeStubs.add(`typescript@${String(candidate?.version ?? 'unknown')} (${requireFrom.resolve('typescript')})`)
    } catch {}
  }
  if (!classicFound && nativeStubs.size > 0) {
    console.error(`${[...nativeStubs].join(', ')}: this typescript has no classic Compiler API`
      + ' (required by the seam engine) — the native 7.x build ships only a version stub.'
      + ' Install the JS-based typescript (5.x/6.x) in this repository.')
    process.exit(1)
  }
  const engineCandidates = [
    new URL('../dist-test/tests/seam/engine.js', import.meta.url),
    new URL('../tests/seam/engine.js', import.meta.url),
    new URL('../../dist-test/tests/seam/engine.js', import.meta.url),
    new URL('../tests/seam/engine.ts', import.meta.url),
  ]
  for (const candidate of engineCandidates) {
    if (!existsSync(fileURLToPath(candidate))) continue
    try {
      return await import(candidate.href)
    } catch {}
  }
  const engineTsUrl = new URL('../tests/seam/engine.ts', import.meta.url)
  if (!existsSync(fileURLToPath(engineTsUrl))) {
    console.error('cannot locate seam engine (tests/seam/engine.js or tests/seam/engine.ts)')
    process.exit(1)
  }
  let ts
  let tsUrl
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor)
      ts = req('typescript')
      tsUrl = pathToFileURL(req.resolve('typescript')).href
      break
    } catch {}
  }
  if (ts === undefined || tsUrl === undefined) {
    console.error('cannot locate package "typescript" to compile seam probes')
    process.exit(1)
  }
  const rawSource = readFileSync(fileURLToPath(engineTsUrl), 'utf8')
    .replace(/import\s+ts\s+from\s+['"]typescript['"]/g, `import ts from ${JSON.stringify(tsUrl)}`)
    .replace(/import\s+(?:type\s+)?\{[^}]*\}\s+from\s+['"]@deepseek-ai\/cordis['"]/g, 'class Context {}')
  for (const match of rawSource.matchAll(/^\s*import\s+(?!type\b)[^\n;]*?\bfrom\s+['"]([^'"]+)['"]/gm)) {
    const spec = match[1]
    if (!spec.startsWith('node:') && !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('file://')) {
      throw new Error(`loadEngine cannot bundle unhandled runtime import '${spec}' from tests/seam/engine.ts; update verify-coupling.mjs`)
    }
  }
  const { outputText } = ts.transpileModule(rawSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
  })
  const tempDir = mkdtempSync(join(tmpdir(), 'dsh-seam-engine-'))
  const tempMjs = join(tempDir, 'engine.mjs')
  writeFileSync(tempMjs, outputText)
  try {
    return await import(pathToFileURL(tempMjs).href)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

const resolvedRootHint = rootOverride !== undefined ? resolve(process.cwd(), rootOverride) : undefined
const { baseTypeNames, checkContract, findRepositoryRoot, probeSpecsFromCoupling } = await loadEngine(resolvedRootHint)
const root = resolvedRootHint ?? findRepositoryRoot(undefined, { requireCoupling: false })
const distTestDir = join(root, 'dist-test')
const hadDistTest = existsSync(distTestDir)
let failed = false
try {
for (const argument of files) {
  const displayLabel = files.length === 1 && process.env.DSH_SEAM_LABEL !== undefined
    ? process.env.DSH_SEAM_LABEL
    : argument
  // npm-workspaces 提升布局：@deepseek-ai/* 可能装在 monorepo 根的
  // node_modules（插件包自身没有），与 analyze 侧同规则向上查找。
  // --types-root 生效时类型由显式目录提供，不再要求本地安装 @deepseek-ai/*。
  const nodeModulesBase = typesRoot !== undefined ? typesRoot : (() => {
    let dir = resolve(root)
    for (;;) {
      if (existsSync(join(dir, 'node_modules', '@deepseek-ai'))) return join(dir, 'node_modules')
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  })()
  if (nodeModulesBase === null) {
    console.log(`${displayLabel}: 0/0 probes compile clean (skipped: no @deepseek-ai/* packages installed)`)
    continue
  }
  const coupling = JSON.parse(readFileSync(resolve(process.cwd(), argument), 'utf8'))
  if (coupling.schemaVersion !== undefined && coupling.schemaVersion !== 1) {
    console.error(`${displayLabel}: coupling.json schema version ${coupling.schemaVersion} 不受当前 dsh-seam 支持`
      + '（可识别版本 1）：用 dsh-seam scan --write 重新生成，或升级 dsh-seam')
    failed = true
    continue
  }
  const specs = probeSpecsFromCoupling(coupling)
  /** Display name of a segment id: `pkg::path`（去掉 site 后缀与类别前缀）。 */
  const surfaceName = id => {
    const surface = id.replace(/^(?:field|discriminant):/, '')
    const separator = surface.lastIndexOf('::')
    const bare = (surface.slice(separator + 2).split('@')[0] ?? '')
    return `${surface.slice(0, separator)}::${bare}`
  }
  const { outcome } = checkContract({
    root, coupling, fieldSpecs: specs.fieldSpecs, discriminantSpecs: specs.discriminantSpecs,
    unverifiable: {}, implicitFragments: {}, implicitSeams: [], implicitRuns: {},
    inventoryFloors: { srcHooks: 0, testHooks: 0, fieldPathPackages: 0, discriminantPackages: 0 },
    ...(typesRoot !== undefined ? { typesRoot } : {}),
  })
  const verdict = { pass: 0, borrowed: 0, exempt: 0 }
  const report = []
  const borrowedBySurface = new Map()
  const exemptedBySurface = new Map()
  const recordDiagnostic = (map, key, entry) => {
    const existing = map.get(key)
    if (existing === undefined) map.set(key, { ...entry, count: 1 })
    else existing.count += 1
  }
  for (const problem of outcome.unattributed) {
    // An import-line error means a rootType names a member the package does
    // not export; map it back to the surfaces whose rootType derived it.
    const hit = /^TS(?:2305|2724): .*'"([^"]+)"' has no exported member (?:named )?'([^']+)'/.exec(problem)
    if (hit === null) {
      report.push(`unattributed diagnostic: ${problem}`)
      continue
    }
    let matched = false
    for (const [path, record] of Object.entries(coupling.fieldPaths?.[hit[1]] ?? {})) {
      if (baseTypeNames(record.rootType).includes(hit[2])) {
        matched = true
        report.push(`broken root type: ${hit[1]}::${path} — rootType '${record.rootType}' names '${hit[2]}', which the package does not export`)
      }
    }
    if (!matched) report.push(`unattributed diagnostic: ${problem}`)
  }
  for (const segment of outcome.segments) {
    if (segment.problems.length === 0) verdict.pass += 1
    else {
      // 借用/退化/豁免的判定由引擎 checkContract 单一计算（SegmentDisposition）；
      // 本脚本只做展示与计数——规则不再有两份实现。
      const disposition = segment.disposition
      const name = surfaceName(segment.id)
      if (disposition?.kind === 'borrowed') {
        recordDiagnostic(borrowedBySurface, `${name}::${disposition.signed ? 'signed' : 'unsigned'}`,
          { name, ...disposition, reason: 'TS2339' })
      } else if (disposition?.kind === 'exempt') {
        recordDiagnostic(exemptedBySurface, name, { name, ...disposition })
      } else if (disposition?.kind === 'regression') {
        report.push(`[anchored -> borrowed] ${name} — '${disposition.prop}' was anchored in coupling.json but is now missing on Context\n    ${segment.problems.join('\n    ')}`)
      } else {
        report.push(`${segment.title}\n    ${segment.problems.join('\n    ')}`)
      }
    }
  }
  const borrowed = [...borrowedBySurface.values()]
  const exempted = [...exemptedBySurface.values()]
  verdict.borrowed = borrowed.length
  verdict.exempt = exempted.length
  for (const key of outcome.unprobed) report.push(`unprobed (no spec, no exemption): ${key}`)
  for (const key of outcome.stale) report.push(`stale (spec without a coupling record): ${key}`)
  for (const problem of outcome.mismatched) report.push(`root-type drift: ${problem}`)
  console.log(`${displayLabel}: ${verdict.pass}/${outcome.segments.length} probes compile clean`
    + (verdict.borrowed > 0 ? `, ${verdict.borrowed} borrowed surface(s)` : '')
    + (verdict.exempt > 0 ? `, ${verdict.exempt} runtime-contract surface(s) exempt` : '')
    + (typesRoot !== undefined ? ` [types-root: ${dshSeriesVersions(typesRoot)}]` : ''))
  for (const entry of borrowed) {
    const sites = entry.count > 1 ? ` (${entry.count} sites)` : ''
    const tag = entry.signed
      ? 'borrowed (signed via inject)'
      : 'borrowed (unsigned — add to inject, import provider, or exempt)'
    console.log(`  ~ ${tag}: ${entry.name} — ${entry.reason}${sites}`)
  }
  for (const entry of exempted) {
    const sites = entry.count > 1 ? ` (${entry.count} sites)` : ''
    console.log(`  ~ exempt: ${entry.name} — ${entry.reason}${sites}`)
  }
  for (const line of report) console.log(`  ✖ ${line}`)
  if (report.length > 0) failed = true
}
} finally {
  if (!hadDistTest && existsSync(distTestDir)) {
    try {
      if (readdirSync(distTestDir).length === 0) rmSync(distTestDir, { recursive: true, force: true })
    } catch {}
  }
}
process.exit(failed ? 1 : 0)
