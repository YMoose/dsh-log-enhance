#!/usr/bin/env node
/**
 * Standalone consumer-contract verification: a coupling.json is self-contained.
 * Probes are derived mechanically (probeSpecsFromCoupling — engine only) and
 * compiled against THIS repo's installed node_modules: no plugin sources, no
 * mount. Surfaces a compile cannot prove are exempt (injected ctx.* services,
 * opaque JsonValue reads); import-line errors map back to their rootType.
 * Needs `npx tsc -p tsconfig.test.json` first. @module dsh-log-enhance/scripts/verify-coupling
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { baseTypeNames, checkContract, findRepositoryRoot, probeSpecsFromCoupling } from '../dist-test/tests/seam/engine.js'
const files = process.argv.slice(2)
if (files.length === 0) { console.error('usage: verify-coupling.mjs <coupling.json> [...]'); process.exit(1) }
const root = findRepositoryRoot()
let failed = false
for (const argument of files) {
  const coupling = JSON.parse(readFileSync(resolve(process.cwd(), argument), 'utf8'))
  const specs = probeSpecsFromCoupling(coupling)
  const ctxHosts = new Set(Object.entries(coupling.fieldPaths ?? {}).filter(([, p]) => Object.values(p ?? {}).some(r => r?.rootType === 'Context')).map(([pkg]) => pkg))
  const services = new Set(Object.keys(coupling.ctxAccesses ?? {}))
  const exempt = (id, problems) => {
    const surface = id.replace(/^(?:field|discriminant):/, '')
    const separator = surface.lastIndexOf('::')
    const bare = (surface.slice(separator + 2).split('@')[0] ?? '')
    const firstSegment = bare.split('.')[0] ?? ''
    const name = `${surface.slice(0, separator)}::${bare}`
    if (ctxHosts.has(surface.slice(0, separator)) && services.has(firstSegment)
      && problems.every(problem => problem.startsWith('TS2339')))
      return { name, reason: 'injected ctx service (TS2339)' }
    // Opaque JsonValue reads are the ONLY tolerated TS18047s: the TS18047
    // text ("'x' is possibly 'null'") never names the type, so a bare
    // TS18047 is tolerated only when the SAME surface also carries
    // TS2339-on-JsonValue evidence. A nullable read anywhere else — e.g. an
    // upstream making a member `T | null` — must FAIL, not exempt.
    const jsonEvidence = problem => /^TS2339:.*JsonValue/.test(problem)
    if (problems.some(jsonEvidence)
      && problems.every(problem => /^TS18047:/.test(problem) || jsonEvidence(problem)))
      return { name, reason: 'opaque JsonValue read (TS18047/TS2339)' }
    return undefined
  }
  const { outcome } = checkContract({
    root, coupling, fieldSpecs: specs.fieldSpecs, discriminantSpecs: specs.discriminantSpecs,
    unverifiable: {}, implicitFragments: {}, implicitSeams: [], implicitRuns: {},
    inventoryFloors: { srcHooks: 0, testHooks: 0, fieldPathPackages: 0, discriminantPackages: 0 },
  })
  const verdict = { pass: 0, exempt: 0 }
  const report = []
  const exempted = []
  for (const problem of outcome.unattributed) {
    // An import-line error means a rootType names a member the package does
    // not export; map it back to the surfaces whose rootType derived it.
    const hit = /^TS2724: '"([^"]+)"' has no exported member named '([^']+)'/.exec(problem)
    if (hit === null) report.push(`unattributed diagnostic: ${problem}`)
    else for (const [path, record] of Object.entries(coupling.fieldPaths?.[hit[1]] ?? {}))
      if (baseTypeNames(record.rootType).includes(hit[2]))
        report.push(`broken root type: ${hit[1]}::${path} — rootType '${record.rootType}' names '${hit[2]}', which the package does not export`)
  }
  for (const segment of outcome.segments) {
    if (segment.problems.length === 0) verdict.pass += 1
    else {
      const reason = exempt(segment.id, segment.problems)
      if (reason !== undefined) {
        verdict.exempt += 1
        exempted.push(reason)
      } else report.push(`${segment.title}\n    ${segment.problems.join('\n    ')}`)
    }
  }
  for (const key of outcome.unprobed) report.push(`unprobed (no spec, no exemption): ${key}`)
  for (const key of outcome.stale) report.push(`stale (spec without a coupling record): ${key}`)
  for (const problem of outcome.mismatched) report.push(`root-type drift: ${problem}`)
  console.log(`${argument}: ${verdict.pass}/${outcome.segments.length} probes compile clean`
    + (verdict.exempt > 0 ? `, ${verdict.exempt} runtime-contract surface(s) exempt` : ''))
  for (const entry of exempted) console.log(`  ~ exempt: ${entry.name} — ${entry.reason}`)
  for (const line of report) console.log(`  ✖ ${line}`)
  if (report.length > 0) failed = true
}
process.exit(failed ? 1 : 0)
