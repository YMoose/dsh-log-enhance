import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Full-chain cover for runSeamSuite() inside this repository.
 *
 * Provenance: external review P1 (2026-11-14) — `npm test` exercised only
 * the checkContract-level API; the mount / implicit-delegation / abnormal
 * paths of runSeamSuite were covered exclusively by the pilot consumer
 * (dsh-log-enhance). The engine payload is shared by every future consumer,
 * so this repository must be able to catch a broken mount path itself. The
 * fixture builds a minimal plugin repo — mock upstream, one hook, one
 * implicit seam with an executable run AND a delegated covering test, one
 * abnormal mock-checkout scenario — then registers the suite exactly the
 * way a consumer's tests/seam-verify.test.ts would (决策 6: the engine's
 * own mechanism is payload territory, so its regression cover ships with
 * the payload too).
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/analyze-dsh-coupling.mjs', import.meta.url))
const COVERING_TITLE = 'covering runtime test: session id is readable'

const UPSTREAM_DTS = `
export interface Events {
  'demo/event': (payload: { kind: 'a' }) => void
}
export class Context {
  on<K extends keyof Events>(event: K, callback: Events[K]): void
  logger?: { info(msg: string): void }
}
`

const DEMO_DTS = `
export type SessionEvent = {
  data: {
    id: string
  }
}
`

const PLUGIN_SOURCE = `
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-demo'

export function apply(app: Context): void {
  app.logger?.info('boot')
  app.on('demo/event', (ev) => {
    void ev.kind
  })
}

export function handleEvent(evt: SessionEvent): void {
  void evt.data.id
}
`

const REGISTRY_SOURCE = `
export const IMPLICIT_SEAMS = [
  {
    id: 'fixture-implicit-seam',
    description: 'fixture seam: the delegated runtime test must keep existing',
    usedAt: 'src/plugin.ts:6',
    auditSection: 'audit.md §1',
    probe: 'delegated covering test',
    acknowledged: ['src/plugin.ts'],
  },
]
`

const COVERING_SOURCE = `
import { test } from 'node:test'

test('${COVERING_TITLE}', () => {})
`

const root = mkdtempSync(join(tmpdir(), 'dsh-suite-'))
mkdirSync(join(root, 'src'), { recursive: true })
mkdirSync(join(root, 'tests/contracts'), { recursive: true })
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-plugin', version: '0.0.0', type: 'module' }))
const cordisDir = join(root, 'node_modules/@deepseek-ai/cordis')
const demoDir = join(root, 'node_modules/@deepseek-ai/dsh-demo')
mkdirSync(cordisDir, { recursive: true })
mkdirSync(demoDir, { recursive: true })
writeFileSync(join(cordisDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: '4.1.0', types: 'index.d.ts' }))
writeFileSync(join(cordisDir, 'index.d.ts'), UPSTREAM_DTS)
writeFileSync(join(demoDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-demo', version: '0.1.0', types: 'index.d.ts' }))
writeFileSync(join(demoDir, 'index.d.ts'), DEMO_DTS)
writeFileSync(join(root, 'src/plugin.ts'), PLUGIN_SOURCE)
writeFileSync(join(root, 'tests/contracts/implicit-seams.ts'), REGISTRY_SOURCE)
writeFileSync(join(root, 'tests/covering.test.ts'), COVERING_SOURCE)

const scanned = spawnSync(process.execPath, [SCRIPT, '--write'], {
  encoding: 'utf8', timeout: 60_000,
  env: { ...process.env, DSH_SEAM_ROOT: root },
})
if (scanned.status !== 0) throw new Error(`fixture scan failed:\n${scanned.stdout}\n${scanned.stderr}`)

interface EngineApi {
  probeSpecsFromCoupling(coupling: unknown): {
    fieldSpecs: Record<string, unknown>
    discriminantSpecs: Record<string, unknown>
  }
  runSeamSuite(suite: unknown): void
}

async function loadEngine(): Promise<EngineApi> {
  const candidates = [
    new URL('../seam/engine.js', import.meta.url),
    new URL('./seam/engine.js', import.meta.url),
  ]
  const resolved = candidates.find(url => existsSync(fileURLToPath(url)))
  assert.ok(resolved !== undefined, 'cannot locate compiled seam engine relative to seam-suite.test.js')
  return await import(resolved.href) as unknown as EngineApi
}

const engine = await loadEngine()
const registry = await import(pathToFileURL(join(root, 'tests/contracts/implicit-seams.ts')).href) as {
  IMPLICIT_SEAMS: readonly unknown[]
}
const coupling: unknown = JSON.parse(readFileSync(join(root, 'coupling.json'), 'utf8'))
const specs = engine.probeSpecsFromCoupling(coupling)

engine.runSeamSuite({
  root,
  coupling,
  fieldSpecs: specs.fieldSpecs,
  discriminantSpecs: specs.discriminantSpecs,
  unverifiable: {},
  implicitFragments: {},
  implicitSeams: registry.IMPLICIT_SEAMS,
  implicitRuns: {
    'fixture-implicit-seam': async (
      _context: unknown,
      environment: { root: string, readText: (relativePath: string) => string, unprobed: readonly string[] },
    ) => {
      assert.equal(environment.root, root, 'the run environment must point at the fixture repo')
      assert.match(environment.readText('tests/covering.test.ts'), new RegExp(COVERING_TITLE))
      assert.deepEqual(environment.unprobed, [], 'the generated inventory must be complete')
    },
  },
  implicitDelegations: {
    'fixture-implicit-seam': [{ file: 'tests/covering.test.ts', tests: [COVERING_TITLE] }],
  },
  abnormal: {
    title: '[abnormal] removing SessionEvent.data.id from a mock upstream must break the probe',
    specKey: '@deepseek-ai/dsh-demo::data.id',
    packageName: '@deepseek-ai/dsh-demo',
    typesImportLine: "import type { SessionEvent } from '@deepseek-ai/dsh-demo'",
    mockTypes: 'export type SessionEvent = {\n  data: {\n    id: string\n  }\n}\n',
    droppedLine: '    id: string',
    expectedField: 'id',
  },
})

test('fixture teardown removes the temporary repository', () => {
  rmSync(root, { recursive: true, force: true })
})
