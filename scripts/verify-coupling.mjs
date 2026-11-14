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
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const files = process.argv.slice(2)
if (files.length === 0) { console.error('usage: verify-coupling.mjs <coupling.json> [...]'); process.exit(1) }
const rootOverride = process.env.DSH_SEAM_ROOT ?? process.env.DSH_LOG_ENHANCE_ROOT

async function loadEngine(rootHint) {
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
  const anchors = [
    import.meta.url,
    ...(rootHint !== undefined ? [pathToFileURL(join(rootHint, 'package.json')).href] : []),
    pathToFileURL(join(process.cwd(), 'package.json')).href,
  ]
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
  if (!existsSync(join(root, 'node_modules/@deepseek-ai'))) {
    console.log(`${displayLabel}: 0/0 probes compile clean (skipped: no @deepseek-ai/* packages installed)`)
    continue
  }
  const coupling = JSON.parse(readFileSync(resolve(process.cwd(), argument), 'utf8'))
  const specs = probeSpecsFromCoupling(coupling)
  const ctxHosts = new Set(Object.entries(coupling.fieldPaths ?? {}).filter(([, p]) => Object.values(p ?? {}).some(r => r?.rootType === 'Context')).map(([pkg]) => pkg))
  const borrowedSet = new Set(coupling.borrowed ?? [])
  const injected = new Set(coupling.injectedServices ?? [])
  const isContextMissingProp = problem => /^TS2339: Property '[^']+' does not exist on type 'Context'\./.test(problem)
  /** The property a TS2339-on-Context diagnostic actually names, if any. */
  const missingContextProp = problem => /^TS2339: Property '([^']+)' does not exist on type 'Context'\./.exec(problem)?.[1]
  const classifyFailure = (id, problems) => {
    const surface = id.replace(/^(?:field|discriminant):/, '')
    const separator = surface.lastIndexOf('::')
    const bare = (surface.slice(separator + 2).split('@')[0] ?? '')
    const firstSegment = bare.split('.')[0] ?? ''
    const serviceName = firstSegment.replace(/\[\]$/, '')
    const name = `${surface.slice(0, separator)}::${bare}`
    if (ctxHosts.has(surface.slice(0, separator)) && serviceName.length > 0
      && problems.length > 0 && problems.every(isContextMissingProp)) {
      // The property named inside the diagnostic is authoritative. A probe
      // may replay a guard over a BORROWED runtime service (e.g.
      // `if (ctx.mcpManager === undefined) return` ahead of an anchored
      // access that flow-analysis proved conditional on it); its TS2339
      // names the borrowed property, not the surface. Route by the named
      // properties: all borrowed -> borrowed; any unregistered name ->
      // genuine anchored->borrowed regression, reported against that name.
      const namedProps = problems.map(missingContextProp).filter(prop => prop !== undefined)
      const suspects = namedProps.length > 0 ? namedProps : [serviceName]
      if (suspects.every(prop => borrowedSet.has(prop))) {
        return { kind: 'borrowed', name, signed: suspects.some(prop => injected.has(prop)), reason: 'TS2339' }
      }
      return { kind: 'regression', name, serviceName: suspects.find(prop => !borrowedSet.has(prop)) ?? serviceName }
    }
    // Opaque JsonValue reads are the ONLY tolerated TS18047s: the TS18047
    // text ("'x' is possibly 'null'") never names the type, so a bare
    // TS18047 is tolerated only when the SAME surface also carries
    // TS2339-on-JsonValue evidence. A nullable read anywhere else — e.g. an
    // upstream making a member `T | null` — must FAIL, not exempt.
    const jsonEvidence = problem => /^TS2339:.*JsonValue/.test(problem)
    if (problems.some(jsonEvidence)
      && problems.every(problem => /^TS18047:/.test(problem) || jsonEvidence(problem)))
      return { kind: 'exempt', name, reason: 'opaque JsonValue read (TS18047/TS2339)' }
    return undefined
  }
  const { outcome } = checkContract({
    root, coupling, fieldSpecs: specs.fieldSpecs, discriminantSpecs: specs.discriminantSpecs,
    unverifiable: {}, implicitFragments: {}, implicitSeams: [], implicitRuns: {},
    inventoryFloors: { srcHooks: 0, testHooks: 0, fieldPathPackages: 0, discriminantPackages: 0 },
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
      const classified = classifyFailure(segment.id, segment.problems)
      if (classified?.kind === 'borrowed') {
        const key = `${classified.name}::${classified.signed ? 'signed' : 'unsigned'}`
        recordDiagnostic(borrowedBySurface, key, classified)
      } else if (classified?.kind === 'exempt') {
        recordDiagnostic(exemptedBySurface, classified.name, classified)
      } else if (classified?.kind === 'regression') {
        report.push(`[anchored -> borrowed] ${classified.name} — '${classified.serviceName}' was anchored in coupling.json but is now missing on Context\n    ${segment.problems.join('\n    ')}`)
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
    + (verdict.exempt > 0 ? `, ${verdict.exempt} runtime-contract surface(s) exempt` : ''))
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
