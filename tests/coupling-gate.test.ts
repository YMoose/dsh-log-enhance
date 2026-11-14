import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Regression cover for the implicit-contract suspect gate
 * (`scripts/analyze-dsh-coupling.mjs --check`).
 *
 * Phase B of docs/seam-driven-verification.md shipped with
 * `217929e` (the seam verifier), which was the plan's stated trigger for
 * turning the suspect report into a hard gate (review P4). Before, an
 * unacknowledged suspect — or an unloadable seam registry — printed an
 * advisory line and exited 0, so nothing guaranteed a human ever saw the
 * report.
 *
 * Fixtures redirect the repo root through DSH_SEAM_ROOT: the script
 * scans `src/` under the fixture, gates against the fixture's coupling.json
 * and loads the fixture's seam registry. The real repository is untouched.
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/analyze-dsh-coupling.mjs', import.meta.url))

/** An unambiguous layer-2 bet: a field read off JSON.parse output. */
const SUSPECT_SOURCE = `export function probe(text: string): void {
  const data = JSON.parse(text) as Record<string, unknown>
  void data['kind']
}
`

const EMPTY_REGISTRY = 'export const IMPLICIT_SEAMS = []\n'

const ACKNOWLEDGING_REGISTRY = `export const IMPLICIT_SEAMS = [
  {
    id: 'fixture-seam',
    description: 'fixture seam covering the suspect shape',
    usedAt: 'src/suspect.ts',
    auditSection: 'fixture',
    probe: 'fixture probe',
    acknowledged: ['src/suspect.ts'],
  },
]
`

function fixtureRoot(registrySource: string): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-coupling-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'tests/contracts'), { recursive: true })
  writeFileSync(join(root, 'src/suspect.ts'), SUSPECT_SOURCE)
  if (registrySource !== '') writeFileSync(join(root, 'tests/contracts/implicit-seams.ts'), registrySource)
  return root
}

function runScript(args: string[], root: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, DSH_SEAM_ROOT: root },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('an unacknowledged implicit-contract suspect fails --check', () => {
  const root = fixtureRoot(EMPTY_REGISTRY)
  try {
    // Pin coupling.json to the fixture's own scan so the drift gate is green
    // and ONLY the suspect rule can produce the failure.
    const written = runScript(['--write'], root)
    assert.equal(written.status, 0, `${written.stdout}\n${written.stderr}`)
    const { status, stdout, stderr } = runScript(['--check'], root)
    assert.equal(status, 1, `${stdout}\n${stderr}`)
    assert.match(stdout + stderr, /unacknowledged implicit-contract suspect/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a seam registry that cannot be loaded fails --check even without drift', () => {
  const root = fixtureRoot('') // no tests/contracts/implicit-seams.ts at all
  try {
    const written = runScript(['--write'], root)
    assert.equal(written.status, 0, `${written.stdout}\n${written.stderr}`)
    const { status, stdout, stderr } = runScript(['--check'], root)
    assert.equal(status, 1, `${stdout}\n${stderr}`)
    assert.match(stdout + stderr, /cannot verify implicit-contract suspects/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an acknowledged suspect passes --check', () => {
  const root = fixtureRoot(ACKNOWLEDGING_REGISTRY)
  try {
    const written = runScript(['--write'], root)
    assert.equal(written.status, 0, `${written.stdout}\n${written.stderr}`)
    const { status, stdout, stderr } = runScript(['--check'], root)
    assert.equal(status, 0, `${stdout}\n${stderr}`)
    assert.match(stdout, /all implicit suspects acknowledged/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

interface EngineApi {
  compareVersions(a: string, b: string): number
  probeSpecsFromCoupling(coupling: unknown): {
    fieldSpecs: Record<string, unknown>
    discriminantSpecs: Record<string, unknown>
  }
  checkContract(suite: unknown): {
    generated: {
      source: string
      segments: ReadonlyMap<string, { readonly id: string; readonly title: string }>
    }
    outcome: {
      segments: ReadonlyArray<{ id: string; title: string; problems: readonly string[]; borrowed?: readonly string[] }>
      unattributed: readonly string[]
      unprobed: readonly string[]
      stale: readonly string[]
      mismatched: readonly string[]
    }
  }
  probeVersionLockstep(
    context: unknown,
    environment: {
      root: string
      readText: (relativePath: string) => string
      unprobed: readonly string[]
      versionLockstep?: 'single-line' | 'range'
    },
  ): Promise<void>
}

async function loadEngine(): Promise<EngineApi> {
  const candidates = [
    new URL('../seam/engine.js', import.meta.url),
    new URL('./seam/engine.js', import.meta.url),
  ]
  const resolved = candidates.find(url => existsSync(fileURLToPath(url)))
  assert.ok(resolved !== undefined, 'cannot locate compiled seam engine relative to coupling-gate.test.js')
  return await import(resolved.href) as unknown as EngineApi
}

async function loadStandardSpecs(): Promise<{
  standardSpecs(coupling: unknown, implicitSeams: unknown): {
    fieldSpecs: Record<string, unknown>
    discriminantSpecs: Record<string, unknown>
    unverifiable: Record<string, string>
    implicitFragments: Record<string, unknown>
    abnormal?: unknown
  }
}> {
  const candidates = [
    new URL('../seam/standard-specs.js', import.meta.url),
    new URL('./seam/standard-specs.js', import.meta.url),
  ]
  const resolved = candidates.find(url => existsSync(fileURLToPath(url)))
  assert.ok(resolved !== undefined, 'cannot locate compiled standard-specs relative to coupling-gate.test.js')
  return await import(resolved.href) as unknown as {
    standardSpecs(coupling: unknown, implicitSeams: unknown): {
      fieldSpecs: Record<string, unknown>
      discriminantSpecs: Record<string, unknown>
      unverifiable: Record<string, string>
      implicitFragments: Record<string, unknown>
      abnormal?: unknown
    }
  }
}

function writeMockUpstream(root: string, includeValueField: boolean): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-plugin', version: '0.0.0', type: 'module' }))
  const cordisDir = join(root, 'node_modules/@deepseek-ai/cordis')
  const demoDir = join(root, 'node_modules/@deepseek-ai/dsh-demo')
  mkdirSync(cordisDir, { recursive: true })
  mkdirSync(demoDir, { recursive: true })
  writeFileSync(join(cordisDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: '4.1.0', types: 'index.d.ts' }))
  writeFileSync(join(cordisDir, 'index.d.ts'), `
export interface Events {
  'demo/event': (payload: { kind: 'a'; ${includeValueField ? 'value: string' : 'renamed: string'} } | { kind: 'b'; count: number }) => void
}
export class Context {
  on<K extends keyof Events>(event: K, callback: Events[K]): void
  logger?: { info(msg: string): void }
}
`)
  writeFileSync(join(demoDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-demo', version: '0.1.0', types: 'index.d.ts' }))
  writeFileSync(join(demoDir, 'index.d.ts'), `
export type SessionEvent =
  | {
      type: 'call'
      data: {
        inserted: Array<{
          source: { kind: 'agent'; senderId: string } | { kind: 'user' }
        }>
      }
    }
  | { type: 'ping' }
`)
}

test('custom parameter names (: Context, evt: SessionEvent, destructured, and unannotated hook payload) replay guards cleanly', async () => {
  const engine = await loadEngine()
  const root = mkdtempSync(join(tmpdir(), 'dsh-custom-params-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'tests/contracts'), { recursive: true })
    writeMockUpstream(root, true)
    writeFileSync(join(root, 'tests/contracts/implicit-seams.ts'), EMPTY_REGISTRY)
    writeFileSync(join(root, 'src/plugin.ts'), `
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-demo'

export function apply(app: Context): void {
  app.logger?.info('boot')
  app.on('demo/event', (ev) => {
    if (ev.kind === 'a') {
      void ev.value
    }
  })
}

export function handleEvent(evt: SessionEvent): void {
  if (evt.type !== 'call') return
  for (const item of evt.data.inserted) {
    if (item.source.kind === 'agent') {
      void item.source.senderId
    }
  }
}

export function handleDestructured({ type, data }: SessionEvent): void {
  if (type === 'call') {
    void data.inserted
  }
}
`)

    const written = runScript(['--write'], root)
    assert.equal(written.status, 0, `${written.stdout}\n${written.stderr}`)

    const coupling = JSON.parse(readFileSync(join(root, 'coupling.json'), 'utf8')) as {
      srcHooks: Array<{ event: string; params: string[] }>
      ctxAccesses: Record<string, string[]>
      fieldPaths: Record<string, Record<string, {
        rootType: string
        accesses: Array<{ site: string; guards: Array<{ expr: string; kind: string; literal?: string }>; elementOf?: string; binding?: string }>
      }>>
    }

    assert.equal(coupling.srcHooks.length, 1)
    assert.equal(coupling.srcHooks[0]?.event, 'demo/event')
    assert.deepEqual(coupling.srcHooks[0]?.params, ['ev'])
    assert.ok('logger' in coupling.ctxAccesses)

    const senderAccess = coupling.fieldPaths['@deepseek-ai/dsh-demo']?.['data.inserted[].source.senderId']?.accesses[0]
    assert.ok(senderAccess !== undefined, 'expected senderId access')
    assert.equal(senderAccess.elementOf, 'event.data.inserted')
    assert.equal(senderAccess.binding, 'item')
    assert.ok(senderAccess.guards.some(g => g.expr === 'event.type' && g.kind === 'eq' && g.literal === 'call'))
    assert.ok(senderAccess.guards.some(g => g.expr === 'item.source.kind' && g.kind === 'eq' && g.literal === 'agent'))

    const payloadAccess = coupling.fieldPaths['event:demo/event']?.['value']?.accesses[0]
    assert.ok(payloadAccess !== undefined, 'expected event:demo/event value access')
    assert.ok(payloadAccess.guards.some(g => g.expr === 'payload.kind' && g.kind === 'eq' && g.literal === 'a'))

    const destructuredAccess = coupling.fieldPaths['@deepseek-ai/dsh-demo']?.['data.inserted']?.accesses
      .find(access => access.site.endsWith(':25'))
    assert.ok(destructuredAccess !== undefined, 'expected destructured data.inserted access')
    assert.ok(destructuredAccess.guards.some(g => g.expr === 'event.type' && g.kind === 'eq' && g.literal === 'call'))

    const specs = engine.probeSpecsFromCoupling(coupling)
    const run = engine.checkContract({
      root,
      coupling,
      fieldSpecs: specs.fieldSpecs,
      discriminantSpecs: specs.discriminantSpecs,
      unverifiable: {},
      implicitFragments: {},
      implicitSeams: [],
      implicitRuns: {},
    })

    assert.deepEqual(run.outcome.unattributed, [])
    assert.deepEqual(run.outcome.unprobed, [])
    assert.deepEqual(run.outcome.mismatched, [])
    for (const seg of run.outcome.segments) {
      assert.deepEqual(seg.problems, [], `segment ${seg.title} failed: ${seg.problems.join('; ')}`)
    }

    // Breaking the event payload field in upstream must fail the exact event:demo/event::value seam.
    writeMockUpstream(root, false)
    const broken = engine.checkContract({
      root,
      coupling,
      fieldSpecs: specs.fieldSpecs,
      discriminantSpecs: specs.discriminantSpecs,
      unverifiable: {},
      implicitFragments: {},
      implicitSeams: [],
      implicitRuns: {},
    })
    assert.deepEqual(broken.outcome.unattributed, [])
    const valueSeg = broken.outcome.segments.find(seg => seg.id.startsWith('field:event:demo/event::value@'))
    assert.ok(valueSeg !== undefined && valueSeg.problems.length > 0, 'broken payload field must fail its probe')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('engine handles unnormalized legacy coupling.json aliases in elementOf and event hooks', async () => {
  const engine = await loadEngine()
  const root = mkdtempSync(join(tmpdir(), 'dsh-legacy-alias-'))
  try {
    writeMockUpstream(root, true)
    const coupling = {
      packages: {
        '@deepseek-ai/cordis': { declaredIn: ['devDependencies'], roots: { src: { type: ['src/plugin.ts'], value: [] } } },
        '@deepseek-ai/dsh-demo': { declaredIn: ['devDependencies'], roots: { src: { type: ['src/plugin.ts'], value: [] } } },
      },
      injectedServices: [],
      srcHooks: [{ event: 'demo/event', via: 'on', params: ['ev'], sites: ['src/plugin.ts:5'] }],
      testHooks: [],
      ctxAccesses: {},
      fieldPaths: {
        '@deepseek-ai/dsh-demo': {
          'data.inserted[].source.senderId': {
            rootType: 'SessionEvent',
            accesses: [{
              site: 'src/plugin.ts:12',
              guards: [
                { expr: 'evt.type', kind: 'eq', literal: 'call' },
                { expr: 'item.source.kind', kind: 'eq', literal: 'agent' },
              ],
              elementOf: 'evt.data.inserted',
              binding: 'item',
            }],
          },
        },
        'event:demo/event': {
          value: {
            rootType: 'unknown',
            accesses: [{
              site: 'src/plugin.ts:7',
              guards: [{ expr: 'ev.kind', kind: 'eq', literal: 'a' }],
            }],
          },
        },
      },
      discriminants: {},
    }
    const specs = engine.probeSpecsFromCoupling(coupling)
    const run = engine.checkContract({
      root,
      coupling,
      fieldSpecs: specs.fieldSpecs,
      discriminantSpecs: specs.discriminantSpecs,
      unverifiable: {},
      implicitFragments: {},
      implicitSeams: [],
      implicitRuns: {},
      typeImports: { '@deepseek-ai/cordis': ['Context'] },
    })
    assert.deepEqual(run.outcome.unattributed, [])
    assert.deepEqual(run.outcome.unprobed, [])
    for (const seg of run.outcome.segments) {
      assert.deepEqual(seg.problems, [], `segment ${seg.title} failed: ${seg.problems.join('; ')}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scanner records re-exports and type-position import() expressions', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-reexport-importtype-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'tests/contracts'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture-plugin',
      version: '0.0.0',
      type: 'module',
      devDependencies: {
        '@deepseek-ai/dsh-demo': '0.1.0',
        '@deepseek-ai/cordis': '4.1.0',
      },
    }))
    writeFileSync(join(root, 'tests/contracts/implicit-seams.ts'), EMPTY_REGISTRY)
    writeFileSync(join(root, 'src/plugin.ts'), `
export type { SessionEvent } from '@deepseek-ai/dsh-demo'
export { Context } from '@deepseek-ai/cordis'

export function inspect(ev: import('@deepseek-ai/dsh-session').SessionEvent): void {
  void ev.seq
}
`)
    const conflicting = runScript(['--write', '--check'], root)
    assert.equal(conflicting.status, 1, 'passing --write and --check together must fail')
    assert.match(conflicting.stderr, /mutually exclusive/)

    const written = runScript(['--write'], root)
    assert.equal(written.status, 0, `${written.stdout}\n${written.stderr}`)

    const coupling = JSON.parse(readFileSync(join(root, 'coupling.json'), 'utf8')) as {
      packages: Record<string, { declaredIn: string[]; roots: Record<string, { type: string[]; value: string[] }> }>
      fieldPaths: Record<string, Record<string, { rootType: string; accesses: Array<{ site: string }> }>>
    }

    assert.deepEqual(coupling.packages['@deepseek-ai/dsh-demo']?.declaredIn, ['devDependencies'])
    assert.deepEqual(coupling.packages['@deepseek-ai/dsh-demo']?.roots.src?.type, ['src/plugin.ts'])
    assert.deepEqual(coupling.packages['@deepseek-ai/cordis']?.roots.src?.value, ['src/plugin.ts'])
    assert.deepEqual(coupling.packages['@deepseek-ai/dsh-session']?.roots.src?.type, ['src/plugin.ts'])

    const seqRecord = coupling.fieldPaths['@deepseek-ai/dsh-session']?.['seq']
    assert.ok(seqRecord !== undefined, 'expected seq field path for inline import() annotation')
    assert.equal(seqRecord.rootType, "import('@deepseek-ai/dsh-session').SessionEvent")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('engine handles duplicate hook events (different params/via) without seam ID collision', async () => {
  const engine = await loadEngine()
  const root = mkdtempSync(join(tmpdir(), 'dsh-dup-hooks-'))
  try {
    writeMockUpstream(root, true)
    const coupling = {
      packages: {
        '@deepseek-ai/cordis': { declaredIn: ['devDependencies'], roots: { src: { type: ['src/a.ts'], value: [] } } },
      },
      injectedServices: [],
      srcHooks: [
        { event: 'demo/event', via: 'on', params: [], sites: ['src/a.ts:1'] },
        { event: 'demo/event', via: 'on', params: ['ev'], sites: ['src/b.ts:2'] },
      ],
      testHooks: [
        { event: 'demo/event', via: 'emit', params: [], sites: ['tests/a.test.ts:1'] },
      ],
      ctxAccesses: {},
      fieldPaths: {
        'event:demo/event': {
          value: {
            rootType: 'unknown',
            accesses: [{
              site: 'src/b.ts:4',
              guards: [{ expr: 'payload.kind', kind: 'eq', literal: 'a' }],
            }],
          },
        },
      },
      discriminants: {},
    }
    const specs = engine.probeSpecsFromCoupling(coupling)
    const run = engine.checkContract({
      root,
      coupling,
      fieldSpecs: specs.fieldSpecs,
      discriminantSpecs: specs.discriminantSpecs,
      unverifiable: {},
      implicitFragments: {},
      implicitSeams: [],
      implicitRuns: {},
      typeImports: { '@deepseek-ai/cordis': ['Context'] },
    })
    assert.deepEqual(run.outcome.unattributed, [])
    assert.deepEqual(run.outcome.unprobed, [])
    const segmentIds = run.outcome.segments.map(seg => seg.id)
    assert.equal(new Set(segmentIds).size, segmentIds.length, 'segment IDs must be distinct')
    for (const seg of run.outcome.segments) {
      assert.deepEqual(seg.problems, [], `segment ${seg.title} failed: ${seg.problems.join('; ')}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('probeVersionLockstep catches @deepseek-ai/dsh bellwether version mismatch', async (context) => {
  const engine = await loadEngine()

  const envWithFiles = (files: Record<string, string>) => ({
    root: '/fixture',
    readText: (relativePath: string): string => {
      const content = files[relativePath]
      if (content === undefined) throw new Error(`missing fixture file: ${relativePath}`)
      return content
    },
    unprobed: [] as const,
  })

  await assert.rejects(
    () => engine.probeVersionLockstep(
      context,
      envWithFiles({
        'package.json': JSON.stringify({
          engines: { dsh: '>=0.2.2-rc.3 <0.3.0-0' },
          devDependencies: {
            '@deepseek-ai/dsh': '0.2.2-rc.1',
            '@deepseek-ai/dsh-agent': '0.2.2-rc.3',
          },
        }),
        '.github/workflows/ci.yml': 'name: ci\n',
        'baseline.json': JSON.stringify({
          packages: {
            dsh: { version: '0.2.2-rc.3' },
            'dsh-agent': { version: '0.2.2-rc.3' },
          },
        }),
      }),
    ),
    /manifest must pin exactly one dsh train/,
  )

  await assert.rejects(
    () => engine.probeVersionLockstep(
      context,
      envWithFiles({
        'package.json': JSON.stringify({
          engines: { dsh: '>=0.2.2-rc.3 <0.3.0-0' },
          devDependencies: {
            '@deepseek-ai/dsh': '0.2.2-rc.3',
            '@deepseek-ai/dsh-agent': '0.2.2-rc.3',
          },
        }),
        '.github/workflows/ci.yml': 'name: ci\n',
        'baseline.json': JSON.stringify({
          packages: {
            dsh: { version: '0.2.2-rc.1' },
            'dsh-agent': { version: '0.2.2-rc.3' },
          },
        }),
      }),
    ),
    /baseline\.json must fingerprint one dsh train/,
  )
})

test('cli.mjs enforces path containment, pre-deletion hash verification, and atomic preflight sync', () => {
  const CLI = fileURLToPath(new URL('../../../cli.mjs', import.meta.url))
  if (!existsSync(CLI)) return

  const runCli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  })

  // Case A: Atomic preflight on update conflict (1st file missing, 2nd file locally modified).
  const dirA = mkdtempSync(join(tmpdir(), 'dsh-cli-preflight-'))
  try {
    const initial = runCli(['sync', '--into', dirA])
    assert.equal(initial.status, 0, `${initial.stdout}\n${initial.stderr}`)

    const firstFile = join(dirA, 'scripts/analyze-dsh-coupling.mjs')
    const secondFile = join(dirA, 'scripts/bump-upstream.mjs')
    rmSync(firstFile)
    writeFileSync(secondFile, `${readFileSync(secondFile, 'utf8')}\n// local edit\n`)

    const conflicted = runCli(['sync', '--into', dirA])
    assert.equal(conflicted.status, 1, `${conflicted.stdout}\n${conflicted.stderr}`)
    assert.match(conflicted.stderr, /REFUSED:.*bump-upstream\.mjs/)
    assert.equal(existsSync(firstFile), false, 'preflight must reject before writing earlier files')
  } finally {
    rmSync(dirA, { recursive: true, force: true })
  }

  // Case B: Pre-deletion hash check for de-managed file.
  const dirB = mkdtempSync(join(tmpdir(), 'dsh-cli-delete-'))
  try {
    const initial = runCli(['sync', '--into', dirB])
    assert.equal(initial.status, 0, `${initial.stdout}\n${initial.stderr}`)

    const manifestPath = join(dirB, '.dsh-seam.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      source: unknown
      files: Record<string, string>
    }
    manifest.files['scripts/obsolete.mjs'] = '0'.repeat(64)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const obsoletePath = join(dirB, 'scripts/obsolete.mjs')
    writeFileSync(obsoletePath, 'locally modified content\n')

    const refused = runCli(['sync', '--into', dirB])
    assert.equal(refused.status, 1, `${refused.stdout}\n${refused.stderr}`)
    assert.match(refused.stderr, /REFUSED:.*obsolete\.mjs.*no longer managed/)
    assert.equal(readFileSync(obsoletePath, 'utf8'), 'locally modified content\n')
  } finally {
    rmSync(dirB, { recursive: true, force: true })
  }

  // Case C: Path traversal rejection in both check and sync.
  const dirC = mkdtempSync(join(tmpdir(), 'dsh-cli-escape-'))
  try {
    const initial = runCli(['sync', '--into', dirC])
    assert.equal(initial.status, 0, `${initial.stdout}\n${initial.stderr}`)

    const manifestPath = join(dirC, '.dsh-seam.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      source: unknown
      files: Record<string, string>
    }
    manifest.files['../escape.txt'] = '0'.repeat(64)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const checked = runCli(['check', '--into', dirC])
    assert.equal(checked.status, 1, `${checked.stdout}\n${checked.stderr}`)
    assert.match(checked.stderr, /REFUSED: managed path escapes consumer root/)

    const synced = runCli(['sync', '--into', dirC])
    assert.equal(synced.status, 1, `${synced.stdout}\n${synced.stderr}`)
    assert.match(synced.stderr, /REFUSED: managed path escapes consumer root/)
  } finally {
    rmSync(dirC, { recursive: true, force: true })
  }

  // Case D: Corrupt .dsh-seam.json fails closed instead of triggering fresh install (H4).
  const dirD = mkdtempSync(join(tmpdir(), 'dsh-cli-corrupt-'))
  try {
    writeFileSync(join(dirD, '.dsh-seam.json'), '{corrupt')

    const checked = runCli(['check', '--into', dirD])
    assert.equal(checked.status, 1, `${checked.stdout}\n${checked.stderr}`)
    assert.match(checked.stderr, /REFUSED: corrupt \.dsh-seam\.json/)

    const synced = runCli(['sync', '--into', dirD])
    assert.equal(synced.status, 1, `${synced.stdout}\n${synced.stderr}`)
    assert.match(synced.stderr, /REFUSED: corrupt \.dsh-seam\.json/)
  } finally {
    rmSync(dirD, { recursive: true, force: true })
  }

  // Case E: Empty files map and stale payload hashes fail check (H1).
  const dirE = mkdtempSync(join(tmpdir(), 'dsh-cli-stale-'))
  try {
    writeFileSync(join(dirE, '.dsh-seam.json'), JSON.stringify({ source: {}, files: {} }))
    const emptyChecked = runCli(['check', '--into', dirE])
    assert.equal(emptyChecked.status, 1, `${emptyChecked.stdout}\n${emptyChecked.stderr}`)
    assert.match(emptyChecked.stderr, /empty \.dsh-seam\.json/)

    rmSync(join(dirE, '.dsh-seam.json'))
    const initial = runCli(['sync', '--into', dirE])
    assert.equal(initial.status, 0, `${initial.stdout}\n${initial.stderr}`)

    const staleTarget = join(dirE, 'scripts/check-compat.mjs')
    const oldContent = '// old synced version\n'
    writeFileSync(staleTarget, oldContent)
    const oldHash = createHash('sha256').update(oldContent).digest('hex')
    const manifestPath = join(dirE, '.dsh-seam.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      source: unknown
      files: Record<string, string>
    }
    manifest.files['scripts/check-compat.mjs'] = oldHash
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const staleChecked = runCli(['check', '--into', dirE])
    assert.equal(staleChecked.status, 1, `${staleChecked.stdout}\n${staleChecked.stderr}`)
    assert.match(staleChecked.stderr, /stale managed file/)
  } finally {
    rmSync(dirE, { recursive: true, force: true })
  }
})

test('engine compareVersions vectors and standardSpecs intersection maintain contract parity (H5)', async () => {
  const engine = await loadEngine()
  const { standardSpecs } = await loadStandardSpecs()

  assert.equal(engine.compareVersions('0.2.2-rc.4+build.1', '0.2.2-rc.4'), 0)
  assert.ok(engine.compareVersions('0.2.9+build.1', '0.2.10') < 0)
  assert.ok(engine.compareVersions('0.2.2-rc.1', '0.2.2') < 0)
  assert.ok(engine.compareVersions('0.2.2-1', '0.2.2-alpha') < 0)
  assert.ok(engine.compareVersions('0.2.2-rc.2', '0.2.2-rc.10') < 0)

  const coupling = {
    srcHooks: [],
    testHooks: [],
    ctxAccesses: {},
    injectedServices: [],
    fieldPaths: {
      '@deepseek-ai/dsh-tools': {
        'value.messageId': {
          rootType: 'JsonValue',
          accesses: [{ site: 'src/a.ts:1', guards: [] }],
        },
      },
      '@deepseek-ai/dsh-session': {
        'data.inserted[].source.senderSessionId': {
          rootType: 'SessionEvent',
          accesses: [{ site: 'src/a.ts:2', guards: [] }],
        },
      },
    },
    discriminants: {},
  }
  const specs = standardSpecs(coupling, [
    {
      id: 'subagent-settled-surface',
      description: 'test',
      usedAt: 'src/a.ts:1',
      auditSection: 'test',
      probe: 'test',
      acknowledged: [],
    },
  ])
  assert.ok('@deepseek-ai/dsh-tools::value.messageId' in specs.unverifiable)
  assert.ok('subagent-settled-surface' in specs.implicitFragments)
  assert.ok(specs.abnormal !== undefined)
})

test('verify-coupling.mjs runs standalone without a repo coupling.json and reports missing exports (M6/M8)', () => {
  const VERIFY_SCRIPT = fileURLToPath(new URL('../../scripts/verify-coupling.mjs', import.meta.url))
  const root = mkdtempSync(join(tmpdir(), 'dsh-verify-root-'))
  const externalDir = mkdtempSync(join(tmpdir(), 'dsh-verify-ext-'))
  try {
    writeMockUpstream(root, true)
    const couplingPath = join(externalDir, 'external-coupling.json')
    writeFileSync(couplingPath, JSON.stringify({
      packages: {
        '@deepseek-ai/cordis': { declaredIn: ['devDependencies'], roots: { src: { type: ['src/a.ts'], value: [] } } },
        '@deepseek-ai/dsh-demo': { declaredIn: ['devDependencies'], roots: { src: { type: ['src/a.ts'], value: [] } } },
      },
      injectedServices: [],
      srcHooks: [],
      testHooks: [],
      ctxAccesses: {},
      fieldPaths: {
        '@deepseek-ai/dsh-demo': {
          'data.inserted': {
            rootType: 'SessionEvent',
            accesses: [{
              site: 'src/a.ts:10',
              guards: [{ expr: 'event.type', kind: 'eq', literal: 'call' }],
            }],
          },
        },
      },
      discriminants: {},
    }))

    const pass = spawnSync(process.execPath, [VERIFY_SCRIPT, couplingPath], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, DSH_SEAM_ROOT: root },
    })
    assert.equal(pass.status, 0, `${pass.stdout}\n${pass.stderr}`)
    assert.match(pass.stdout, /probes compile clean/)

    writeFileSync(join(root, 'node_modules/@deepseek-ai/dsh-demo/index.d.ts'), 'export interface Other {}\n')
    const fail = spawnSync(process.execPath, [VERIFY_SCRIPT, couplingPath], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, DSH_SEAM_ROOT: root },
    })
    assert.equal(fail.status, 1, `${fail.stdout}\n${fail.stderr}`)
    assert.match(fail.stdout, /broken root type: @deepseek-ai\/dsh-demo::data\.inserted/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(externalDir, { recursive: true, force: true })
  }
})

test('check-compat.mjs enforces lower bound and -0 prerelease upper wall (M8)', () => {
  const CHECK_COMPAT_SCRIPT = fileURLToPath(new URL('../../scripts/check-compat.mjs', import.meta.url))
  const root = mkdtempSync(join(tmpdir(), 'dsh-compat-'))
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true })
    const scriptCopy = join(root, 'scripts/check-compat.mjs')
    copyFileSync(CHECK_COMPAT_SCRIPT, scriptCopy)

    const bootDir = join(root, 'node_modules/@deepseek-ai/dsh-app-boot')
    mkdirSync(bootDir, { recursive: true })
    writeFileSync(join(bootDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-app-boot',
      version: '0.2.2-rc.3',
      type: 'module',
      exports: './index.js',
    }))
    writeFileSync(join(bootDir, 'index.js'), `
export function getDshRuntimeVersion() { return '0.2.2-rc.3' }
export function pluginCompatibilityWarning(issue) { return String(issue?.message ?? 'incompatible') }
export function evaluatePluginCompatibility(manifest, _peers = {}, version = getDshRuntimeVersion()) {
  const range = manifest?.engines?.dsh
  if (typeof range !== 'string') return { message: 'missing engines.dsh' }
  const hasUpperZero = /<\\s*0\\.3\\.0-0\\s*$/.test(range)
  if (version === '0.3.0-alpha.1') {
    return hasUpperZero ? { message: version + ' is outside ' + range } : null
  }
  return null
}
`)

    const validManifest = join(root, 'valid.json')
    writeFileSync(validManifest, JSON.stringify({
      name: 'fixture-plugin',
      version: '0.1.0',
      engines: { dsh: '>=0.2.2-rc.1 <0.3.0-0' },
    }))
    const valid = spawnSync(process.execPath, [scriptCopy], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, DSH_SEAM_MANIFEST: validManifest },
    })
    assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`)

    const invalidManifest = join(root, 'invalid.json')
    writeFileSync(invalidManifest, JSON.stringify({
      name: 'fixture-plugin',
      version: '0.1.0',
      engines: { dsh: '>=0.2.2-rc.1 <0.3.0' },
    }))
    const invalid = spawnSync(process.execPath, [scriptCopy], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, DSH_SEAM_MANIFEST: invalidManifest },
    })
    assert.equal(invalid.status, 1, `${invalid.stdout}\n${invalid.stderr}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cli.mjs supports bare npx-style self-bootstrapping, default --into, and Level 0 zero-write verify', () => {
  const repoCli = fileURLToPath(new URL('../../../cli.mjs', import.meta.url))
  const repoPayload = fileURLToPath(new URL('../../../payload', import.meta.url))
  if (!existsSync(repoCli) || !existsSync(repoPayload)) return

  const bareNpxDir = mkdtempSync(join(tmpdir(), 'dsh-bare-npx-'))
  const pluginDir = mkdtempSync(join(tmpdir(), 'dsh-level0-plugin-'))
  const syncedConsumerDir = mkdtempSync(join(tmpdir(), 'dsh-default-into-'))
  try {
    // 1. Simulate a bare npx tarball checkout: cli.mjs + payload/ + package.json with _resolved, no .git, no node_modules, no dist-test.
    const bareCli = join(bareNpxDir, 'cli.mjs')
    copyFileSync(repoCli, bareCli)
    cpSync(repoPayload, join(bareNpxDir, 'payload'), { recursive: true })
    writeFileSync(join(bareNpxDir, 'package.json'), JSON.stringify({
      name: 'dsh-seam',
      version: '0.0.0',
      type: 'module',
      _resolved: 'https://codeload.github.com/YMoose/dsh-seam/tar.gz/deadbeef1234567890abcdef1234567890abcdef',
    }))

    // 2. Test default --into (cwd) and cross-machine manifest.source.path fallback in check.
    const syncDefault = spawnSync(process.execPath, [bareCli, 'sync'], {
      cwd: syncedConsumerDir,
      encoding: 'utf8',
      timeout: 30_000,
    })
    assert.equal(syncDefault.status, 0, `${syncDefault.stdout}\n${syncDefault.stderr}`)
    const manifestPath = join(syncedConsumerDir, '.dsh-seam.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      source: { path: string; commit: string }
      files: Record<string, string>
    }
    assert.equal(manifest.source.commit, 'deadbeef1234567890abcdef1234567890abcdef')

    // Simulate checking on another machine where manifest.source.path does not exist.
    manifest.source.path = join(syncedConsumerDir, 'nonexistent-machine-path')
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const checkDefault = spawnSync(process.execPath, [bareCli, 'check'], {
      cwd: syncedConsumerDir,
      encoding: 'utf8',
      timeout: 30_000,
    })
    assert.equal(checkDefault.status, 0, `${checkDefault.stdout}\n${checkDefault.stderr}`)

    // 3. Level 0 zero-write verification on a fresh plugin repo (no coupling.json, no implicit-seams.ts).
    mkdirSync(join(pluginDir, 'src'), { recursive: true })
    writeMockUpstream(pluginDir, true)
    writeFileSync(join(pluginDir, 'src/index.ts'), `
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-demo'

export function apply(ctx: Context): void {
  ctx.on('demo/event', (payload) => {
    if (payload.kind === 'a') void payload.value
  })
}

export function onSession(event: SessionEvent): void {
  if (event.type === 'call') {
    for (const item of event.data.inserted) {
      if (item.source.kind === 'agent') void item.source.senderId
    }
  }
}
`)
    const beforeEntries = readdirSync(pluginDir).sort()
    const level0Pass = spawnSync(process.execPath, [bareCli, 'verify', '--repo', pluginDir], {
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert.equal(level0Pass.status, 0, `${level0Pass.stdout}\n${level0Pass.stderr}`)
    assert.match(level0Pass.stdout, /scanned .* \(ephemeral, 0 files written\)/)
    assert.match(level0Pass.stdout, /probes compile clean/)
    assert.deepEqual(readdirSync(pluginDir).sort(), beforeEntries, 'Level 0 verify must leave 0 new files or directories in plugin repo')

    // Breaking upstream types must fail Level 0 verify without writing files.
    writeMockUpstream(pluginDir, false)
    const level0Fail = spawnSync(process.execPath, [bareCli, 'verify', '--repo', pluginDir], {
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert.equal(level0Fail.status, 1, `${level0Fail.stdout}\n${level0Fail.stderr}`)
    assert.deepEqual(readdirSync(pluginDir).sort(), beforeEntries, 'Level 0 failed verify must still leave 0 new files in plugin repo')

    // 4. Level 1 scan --write materializes coupling.json and subsequent verify uses it.
    writeMockUpstream(pluginDir, true)
    const scanWrite = spawnSync(process.execPath, [bareCli, 'scan', '--root', pluginDir, '--write'], {
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert.equal(scanWrite.status, 0, `${scanWrite.stdout}\n${scanWrite.stderr}`)
    assert.equal(existsSync(join(pluginDir, 'coupling.json')), true)

    const level1Pass = spawnSync(process.execPath, [bareCli, 'verify', '--repo', pluginDir], {
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert.equal(level1Pass.status, 0, `${level1Pass.stdout}\n${level1Pass.stderr}`)
    assert.doesNotMatch(level1Pass.stdout, /ephemeral/)
    assert.match(level1Pass.stdout, /probes compile clean/)
  } finally {
    rmSync(bareNpxDir, { recursive: true, force: true })
    rmSync(pluginDir, { recursive: true, force: true })
    rmSync(syncedConsumerDir, { recursive: true, force: true })
  }
})

test('real-world plugin patterns (G1 multi-param hook, G2 cast/widening, G3 zero-dep repo, G4 ambient d.ts, G5 explicit any callback, P3-2 exempt dedup)', async () => {
  const VERIFY_SCRIPT = fileURLToPath(new URL('../../scripts/verify-coupling.mjs', import.meta.url))
  const engine = await loadEngine()

  // Part 1: G1 + G2 + G4 + P3-2 in a realistic plugin fixture.
  const pluginDir = mkdtempSync(join(tmpdir(), 'dsh-real-patterns-'))
  try {
    mkdirSync(join(pluginDir, 'src'), { recursive: true })
    mkdirSync(join(pluginDir, 'tests/contracts'), { recursive: true })
    writeMockUpstream(pluginDir, true)
    // Extend mock @deepseek-ai/cordis Events with a multi-parameter hook.
    writeFileSync(join(pluginDir, 'node_modules/@deepseek-ai/cordis/index.d.ts'), `
export interface Events {
  'demo/event': (payload: { kind: 'a'; value: string } | { kind: 'b'; count: number }) => void
  'session/event': (session: { id: string }, event: import('@deepseek-ai/dsh-demo').SessionEvent) => void
}
export class Context {
  on<K extends keyof Events>(event: K, callback: Events[K]): void
  logger?: { info(msg: string): void }
}
`)
    writeFileSync(join(pluginDir, 'tests/contracts/implicit-seams.ts'), EMPTY_REGISTRY)
    // G4: ambient module declaration for a host-provided virtual package.
    writeFileSync(join(pluginDir, 'src/ambient.d.ts'), `
declare module '@deepseek-ai/dsh-virtual-ui' {
  export interface WidgetProps {
    title: string
  }
}
`)
    writeFileSync(join(pluginDir, 'src/plugin.ts'), `
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-demo'
import type { WidgetProps } from '@deepseek-ai/dsh-virtual-ui'

export function apply(app: Context): void {
  // G1: second callback parameter is the SessionEvent payload.
  app.on('session/event', (session, event) => {
    void session.id
    if (event.type === 'call') {
      void event.data.inserted
    }
  })

  // P3-2: two accesses to the same unmerged injected ctx service.
  ;(app as unknown as { customSvc: { ping(): void } }).customSvc.ping()
  ;(app as unknown as { customSvc: { ping(): void } }).customSvc.ping()
}

export function onSession(event: SessionEvent): void {
  // G2: deliberate widening to string + cast escape hatch for private events.
  const eventType: string = event.type
  if (eventType === 'private/untyped-event') {
    void (event as unknown as { data: { toolName: string } }).data.toolName
    return
  }
  if ((event as unknown as { type: string }).type === 'another/private-event') return
  if (event.type === 'call') {
    const extraData = event.data as unknown as { custom?: string }
    void extraData.custom
    void event.data.inserted
  }
}

export function renderWidget(widget: WidgetProps): string {
  return widget.title
}
`)

    const scanned = runScript(['--write'], pluginDir)
    assert.equal(scanned.status, 0, `${scanned.stdout}\n${scanned.stderr}`)

    const coupling = JSON.parse(readFileSync(join(pluginDir, 'coupling.json'), 'utf8')) as {
      fieldPaths: Record<string, Record<string, unknown>>
      discriminants: Record<string, Record<string, string[]>>
    }
    assert.ok(
      coupling.fieldPaths['event:session/event#1']?.['data.inserted'] !== undefined,
      'G1: 2nd hook parameter access must be stored under event:session/event#1',
    )
    const demoDiscriminants = coupling.discriminants['@deepseek-ai/dsh-demo']?.['type'] ?? []
    assert.ok(!demoDiscriminants.includes('private/untyped-event'), 'G2: widened string comparison must not enter discriminants')
    assert.ok(!demoDiscriminants.includes('another/private-event'), 'G2: cast comparison must not enter discriminants')

    const verified = spawnSync(process.execPath, [VERIFY_SCRIPT, join(pluginDir, 'coupling.json')], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, DSH_SEAM_ROOT: pluginDir },
    })
    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`)
    assert.match(verified.stdout, /2 borrowed surface\(s\)/)
    const borrowedLines = verified.stdout.split(/\r?\n/).filter(line => line.includes('~ borrowed (unsigned') && line.includes('@deepseek-ai/cordis::customSvc.ping'))
    assert.equal(borrowedLines.length, 1, `P3-2: duplicate surface should only print once:\n${verified.stdout}`)
    assert.match(verified.stdout, /~ borrowed \(unsigned[^)]*\): @deepseek-ai\/cordis::customSvc\.ping — TS2339 \(2 sites\)/)

    // H4': L0 casts and widened `: string` discriminant must route to Port C (implicit suspects) on scan --check.
    const checkWithCasts = runScript(['--check'], pluginDir)
    assert.equal(checkWithCasts.status, 1, `${checkWithCasts.stdout}\n${checkWithCasts.stderr}`)
    assert.match(checkWithCasts.stdout + checkWithCasts.stderr, /unacknowledged implicit-contract suspect/)
    assert.match(checkWithCasts.stdout, /private\/untyped-event/)
    assert.match(checkWithCasts.stdout, /extraData\.custom/)
  } finally {
    rmSync(pluginDir, { recursive: true, force: true })
  }

  // Part 2: G5 explicit `: any` callback on an unknown hook suppresses cascading TS7006 noise.
  const g5Dir = mkdtempSync(join(tmpdir(), 'dsh-g5-any-hook-'))
  try {
    mkdirSync(join(g5Dir, 'src'), { recursive: true })
    mkdirSync(join(g5Dir, 'tests/contracts'), { recursive: true })
    writeMockUpstream(g5Dir, true)
    writeFileSync(join(g5Dir, 'tests/contracts/implicit-seams.ts'), EMPTY_REGISTRY)
    writeFileSync(join(g5Dir, 'src/plugin.ts'), `
import type { Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context): void {
  ctx.on('agent/unknown-error', (payload: any) => {
    void payload.foo
  })
}
`)
    const scanned = runScript(['--write'], g5Dir)
    assert.equal(scanned.status, 0, `${scanned.stdout}\n${scanned.stderr}`)
    const coupling = JSON.parse(readFileSync(join(g5Dir, 'coupling.json'), 'utf8')) as {
      fieldPaths: Record<string, unknown>
    }
    assert.equal(coupling.fieldPaths['event:agent/unknown-error'], undefined, 'G5: explicit any callback must not generate event field probes')

    const verified = spawnSync(process.execPath, [VERIFY_SCRIPT, join(g5Dir, 'coupling.json')], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, DSH_SEAM_ROOT: g5Dir },
    })
    assert.equal(verified.status, 1, `${verified.stdout}\n${verified.stderr}`)
    assert.match(verified.stdout, /TS2345:/)
    assert.doesNotMatch(verified.stdout, /TS7006:/)
  } finally {
    rmSync(g5Dir, { recursive: true, force: true })
  }

  // Part 3: G3 zero-@deepseek-ai repo passes cleanly without TS2307 noise.
  const emptyDir = mkdtempSync(join(tmpdir(), 'dsh-g3-empty-'))
  try {
    mkdirSync(join(emptyDir, 'src'), { recursive: true })
    writeFileSync(join(emptyDir, 'package.json'), JSON.stringify({ name: 'mcp-only-plugin', version: '0.0.0' }))
    writeFileSync(join(emptyDir, 'src/index.ts'), 'export function run(): string { return "ok" }\n')

    const scanned = runScript(['--json'], emptyDir)
    assert.equal(scanned.status, 0, `${scanned.stdout}\n${scanned.stderr}`)
    const emptyCoupling = JSON.parse(scanned.stdout) as {
      srcHooks: unknown[]
      testHooks: unknown[]
      fieldPaths: Record<string, unknown>
    }

    // Both standalone engine contract check (no @deepseek-ai/cordis installed) and verify-coupling CLI must succeed.
    const directRun = engine.checkContract({
      root: emptyDir,
      coupling: emptyCoupling,
      fieldSpecs: {},
      discriminantSpecs: {},
      unverifiable: {},
      implicitFragments: {},
      implicitSeams: [],
      implicitRuns: {},
    })
    assert.deepEqual(directRun.outcome.unattributed, [])
    assert.equal(directRun.outcome.segments.length, 0)
    assert.doesNotMatch(directRun.generated.source, /@deepseek-ai\/cordis/)

    const repoCli = fileURLToPath(new URL('../../../cli.mjs', import.meta.url))
    if (existsSync(repoCli)) {
      const cliVerified = spawnSync(process.execPath, [repoCli, 'verify', '--repo', emptyDir], {
        encoding: 'utf8',
        timeout: 60_000,
      })
      assert.equal(cliVerified.status, 0, `${cliVerified.stdout}\n${cliVerified.stderr}`)
      assert.match(cliVerified.stdout, /0\/0 probes compile clean/)
    }
  } finally {
    rmSync(emptyDir, { recursive: true, force: true })
  }
})

test('H2: bare parameter discriminant on multi-param hook compiles clean without TS1003', async () => {
  const VERIFY_SCRIPT = fileURLToPath(new URL('../../scripts/verify-coupling.mjs', import.meta.url))
  const engine = await loadEngine()
  const pluginDir = mkdtempSync(join(tmpdir(), 'dsh-h2-bare-param-'))
  try {
    mkdirSync(join(pluginDir, 'src'), { recursive: true })
    mkdirSync(join(pluginDir, 'tests/contracts'), { recursive: true })
    writeMockUpstream(pluginDir, true)
    writeFileSync(join(pluginDir, 'node_modules/@deepseek-ai/cordis/index.d.ts'), `
export interface Events {
  'internal/get': (session: { id: string }, kind: 'tools' | 'prompts') => unknown
}
export class Context {
  on<K extends keyof Events>(event: K, callback: Events[K]): void
  logger?: { info(msg: string): void }
}
`)
    writeFileSync(join(pluginDir, 'tests/contracts/implicit-seams.ts'), EMPTY_REGISTRY)
    writeFileSync(join(pluginDir, 'src/plugin.ts'), `
import type { Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context): void {
  ctx.on('internal/get', (session, kind) => {
    void session.id
    if (kind === 'tools') return ['a']
    switch (kind) {
      case 'prompts':
        return ['b']
      default:
        return []
    }
  })
}
`)

    const scanned = runScript(['--write'], pluginDir)
    assert.equal(scanned.status, 0, `${scanned.stdout}\n${scanned.stderr}`)

    const coupling = JSON.parse(readFileSync(join(pluginDir, 'coupling.json'), 'utf8')) as {
      srcHooks: unknown[]
      testHooks: unknown[]
      fieldPaths: Record<string, Record<string, { accesses: Array<{ site: string }> }>>
      discriminants: Record<string, Record<string, string[]>>
    }

    const verified = spawnSync(process.execPath, [VERIFY_SCRIPT, join(pluginDir, 'coupling.json')], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, DSH_SEAM_ROOT: pluginDir },
    })
    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`)
    assert.doesNotMatch(verified.stdout, /TS1003/)
    assert.doesNotMatch(verified.stdout, /\(at unknown\)/)
    assert.match(verified.stdout, /probes compile clean/)

    const bareAccesses = coupling.fieldPaths['event:internal/get#1']?.['']?.accesses ?? []
    assert.ok(bareAccesses.length >= 2, 'H2: bare parameter discriminant must record source sites')
    assert.ok(bareAccesses.every(access => /^src\/plugin\.ts:\d+$/.test(access.site)))

    const specs = engine.probeSpecsFromCoupling(coupling)
    const run = engine.checkContract({
      root: pluginDir,
      coupling,
      fieldSpecs: specs.fieldSpecs,
      discriminantSpecs: specs.discriminantSpecs,
      unverifiable: {},
      implicitFragments: {},
      implicitSeams: [],
      implicitRuns: {},
    })
    assert.deepEqual(run.outcome.unprobed, [])
    assert.deepEqual(run.outcome.unattributed, [])
    const discSeg = run.outcome.segments.find(segment => segment.id === 'discriminant:event:internal/get#1::')
    assert.ok(discSeg !== undefined, 'discriminant seam segment must exist')
    assert.match(discSeg.title, /^\[auto\/discriminant\] event:internal\/get#1 :: kind ∈ \{prompts, tools\} \(at src\/plugin\.ts:\d+\)$/)
    assert.deepEqual(discSeg.problems, [])
    assert.ok(run.generated.source.includes('if (kind === "tools") { void kind }'))
    assert.ok(run.generated.source.includes('if (kind === "prompts") { void kind }'))
  } finally {
    rmSync(pluginDir, { recursive: true, force: true })
  }
})

test('H1-prime / H3-prime / H4-prime: L2b in-source declare module augmentation, signed vs unsigned borrows, anchored-to-borrowed regression, and L0 cast/widening routing to implicit suspects', async () => {
  const VERIFY_SCRIPT = fileURLToPath(new URL('../../scripts/verify-coupling.mjs', import.meta.url))
  const engine = await loadEngine()
  const pluginDir = mkdtempSync(join(tmpdir(), 'dsh-h134-arch-'))
  try {
    mkdirSync(join(pluginDir, 'src'), { recursive: true })
    mkdirSync(join(pluginDir, 'tests/contracts'), { recursive: true })
    writeMockUpstream(pluginDir, true)
    writeFileSync(join(pluginDir, 'node_modules/@deepseek-ai/dsh-demo/index.d.ts'), `
export interface Session {
  id: string
}
export type SessionEvent =
  | {
      type: 'call'
      data: {
        inserted: Array<{
          source: { kind: 'agent'; senderId: string } | { kind: 'user' }
        }>
      }
    }
  | { type: 'ping' }
`)
    writeFileSync(join(pluginDir, 'tests/contracts/implicit-seams.ts'), EMPTY_REGISTRY)
    writeFileSync(join(pluginDir, 'src/stepIdentity.ts'), `
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-demo'

interface LocalStepInfo {
  name: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/pre-step'(session: Session, localStep: LocalStepInfo): void
  }
}

export const inject = ['signedSvc']

interface BorrowedSvc {
  run(): void
}

export function apply(ctx: Context): void {
  ctx.logger?.info('ok')
  ;(ctx as unknown as { signedSvc: BorrowedSvc }).signedSvc.run()
  ;(ctx as unknown as { unsignedSvc: BorrowedSvc }).unsignedSvc.run()
  ctx.on('agent/pre-step', (session, step) => {
    void session.id
    void step.name
  })
}

export function onSession(event: SessionEvent): void {
  const extra = (event as unknown as { privateField: string }).privateField
  void extra
  const eventType: string = event.type
  if (eventType === 'tool/ptc-dispatch') return
}
`)
    writeFileSync(join(pluginDir, 'tests/stepIdentity.spec.ts'), `
import type { Context } from '@deepseek-ai/cordis'

export function registerTestHook(ctx: Context): void {
  ctx.on('agent/pre-step', (_session, _step) => {})
}
`)

    // 1. Scan --write: verify H1' augmentations & H3' borrowed list in coupling.json.
    const scanned = runScript(['--write'], pluginDir)
    assert.equal(scanned.status, 0, `${scanned.stdout}\n${scanned.stderr}`)
    const coupling = JSON.parse(readFileSync(join(pluginDir, 'coupling.json'), 'utf8')) as {
      srcHooks: unknown[]
      testHooks: unknown[]
      fieldPaths: Record<string, Record<string, unknown>>
      discriminants: Record<string, Record<string, string[]>>
      injectedServices: string[]
      borrowed?: string[]
      augmentations?: Record<string, Record<string, Record<string, { kind: string; params?: Array<{ name: string; type: string }> }>>>
    }
    const preStepAug = coupling.augmentations?.['@deepseek-ai/cordis']?.['Events']?.['agent/pre-step']
    assert.ok(preStepAug !== undefined, 'H1-prime: L2b in-source declare module augmentation must be serialized')
    assert.equal(preStepAug.kind, 'method')
    assert.match(preStepAug.params?.[0]?.type ?? '', /@deepseek-ai\/dsh-demo.*Session/)
    assert.equal(preStepAug.params?.[1]?.type, 'any', 'H1-prime: file-local type must sanitize to any')

    assert.deepEqual(coupling.borrowed, ['signedSvc', 'unsignedSvc'], 'H3-prime: unanchored ctx accesses (excluding anchored logger) must enter borrowed')

    // 2. Verify-coupling standalone against coupling.json: L2b compiles clean, signed vs unsigned borrows both reported, exit 0.
    const specs = engine.probeSpecsFromCoupling(coupling)
    const directRun = engine.checkContract({
      root: pluginDir,
      coupling,
      fieldSpecs: specs.fieldSpecs,
      discriminantSpecs: specs.discriminantSpecs,
      unverifiable: {},
      implicitFragments: {},
      implicitSeams: [],
      implicitRuns: {},
    })
    assert.match(directRun.generated.source, /declare module "@deepseek-ai\/cordis"/)
    const preStepHookSeg = directRun.outcome.segments.find(segment => segment.id === 'hook:src:agent/pre-step')
    assert.ok(preStepHookSeg !== undefined)
    assert.deepEqual(preStepHookSeg.problems, [], 'H1-prime: augmented hook must not fail TS2345')
    const preStepFieldSeg = directRun.outcome.segments.find(segment => segment.id.startsWith('field:event:agent/pre-step::id@'))
    assert.ok(preStepFieldSeg !== undefined)
    assert.deepEqual(preStepFieldSeg.problems, [], 'H1-prime: imported Session parameter field must still compile clean')

    const verified = spawnSync(process.execPath, [VERIFY_SCRIPT, join(pluginDir, 'coupling.json')], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, DSH_SEAM_ROOT: pluginDir },
    })
    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`)
    assert.match(verified.stdout, /~ borrowed \(signed via inject\): @deepseek-ai\/cordis::signedSvc\.run/)
    assert.match(verified.stdout, /~ borrowed \(unsigned — add to inject, import provider, or exempt\): @deepseek-ai\/cordis::unsignedSvc\.run/)

    // 3. Verify H1-prime still type-checks upstream Session inside augmented event callback (removing Session.id breaks verify).
    writeFileSync(join(pluginDir, 'node_modules/@deepseek-ai/dsh-demo/index.d.ts'), `
export interface Session {
  renamedId: string
}
export type SessionEvent = { type: 'ping' }
`)
    const sessionBroken = spawnSync(process.execPath, [VERIFY_SCRIPT, join(pluginDir, 'coupling.json')], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, DSH_SEAM_ROOT: pluginDir },
    })
    assert.equal(sessionBroken.status, 1, `${sessionBroken.stdout}\n${sessionBroken.stderr}`)
    assert.match(sessionBroken.stdout, /TS2339:/)

    // 4. H3-prime anchored -> borrowed regression: restore dsh-demo, remove `logger` from Context without re-scanning coupling.json -> exit 1!
    writeFileSync(join(pluginDir, 'node_modules/@deepseek-ai/dsh-demo/index.d.ts'), `
export interface Session {
  id: string
}
export type SessionEvent =
  | { type: 'call'; data: { inserted: Array<{ source: { kind: 'agent'; senderId: string } | { kind: 'user' } }> } }
  | { type: 'ping' }
`)
    writeFileSync(join(pluginDir, 'node_modules/@deepseek-ai/cordis/index.d.ts'), `
export interface Events {
  'demo/event': (payload: { kind: 'a'; value: string } | { kind: 'b'; count: number }) => void
}
export class Context {
  on<K extends keyof Events>(event: K, callback: Events[K]): void
}
`)
    const anchoredRegression = spawnSync(process.execPath, [VERIFY_SCRIPT, join(pluginDir, 'coupling.json')], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, DSH_SEAM_ROOT: pluginDir },
    })
    assert.equal(anchoredRegression.status, 1, `${anchoredRegression.stdout}\n${anchoredRegression.stderr}`)
    assert.match(anchoredRegression.stdout, /✖ \[anchored -> borrowed\] @deepseek-ai\/cordis::logger\.info/)

    // 5. H4-prime: cast & widened `: string` discriminant must fail scan --check when unacknowledged, and pass once acknowledged.
    writeMockUpstream(pluginDir, true)
    writeFileSync(join(pluginDir, 'node_modules/@deepseek-ai/dsh-demo/index.d.ts'), `
export interface Session {
  id: string
}
export type SessionEvent =
  | { type: 'call'; data: { inserted: Array<{ source: { kind: 'agent'; senderId: string } | { kind: 'user' } }> } }
  | { type: 'ping' }
`)
    // Re-write coupling.json cleanly first so only Port C implicit suspects are under test.
    assert.equal(runScript(['--write'], pluginDir).status, 0)
    const unackCheck = runScript(['--check'], pluginDir)
    assert.equal(unackCheck.status, 1, `${unackCheck.stdout}\n${unackCheck.stderr}`)
    assert.match(unackCheck.stdout + unackCheck.stderr, /unacknowledged implicit-contract suspect/)
    assert.match(unackCheck.stdout, /privateField/)
    assert.match(unackCheck.stdout, /tool\/ptc-dispatch/)

    writeFileSync(join(pluginDir, 'tests/contracts/implicit-seams.ts'), `export const IMPLICIT_SEAMS = [
  {
    id: 'step-identity-casts',
    description: 'acknowledged L0 cast and widened discriminant',
    usedAt: 'src/stepIdentity.ts',
    auditSection: 'test',
    probe: 'covered by test',
    acknowledged: ['src/stepIdentity.ts'],
  },
]\n`)
    const ackCheck = runScript(['--check'], pluginDir)
    assert.equal(ackCheck.status, 0, `${ackCheck.stdout}\n${ackCheck.stderr}`)
    assert.match(ackCheck.stdout, /all implicit suspects acknowledged/)
  } finally {
    rmSync(pluginDir, { recursive: true, force: true })
  }
})

test('J2: multiline object type literals in in-source augmentations keep member separators and compile clean', async () => {
  const VERIFY_SCRIPT = fileURLToPath(new URL('../../scripts/verify-coupling.mjs', import.meta.url))
  const engine = await loadEngine()
  const pluginDir = mkdtempSync(join(tmpdir(), 'dsh-j2-literals-'))
  try {
    mkdirSync(join(pluginDir, 'src'), { recursive: true })
    mkdirSync(join(pluginDir, 'tests/contracts'), { recursive: true })
    writeMockUpstream(pluginDir, true)
    // A second upstream package exporting a named type, so the fixture's object
    // literal also exercises the identifier rewrite inside structural members.
    const eventsDir = join(pluginDir, 'node_modules/@deepseek-ai/dsh-events')
    mkdirSync(eventsDir, { recursive: true })
    writeFileSync(join(eventsDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-events', version: '0.1.0', types: 'index.d.ts' }))
    writeFileSync(join(eventsDir, 'index.d.ts'), `
export type EffortLevel = 'low' | 'high'
export interface SelectionEventMap {
  'demo/ping': unknown
}
`)
    writeFileSync(join(pluginDir, 'tests/contracts/implicit-seams.ts'), EMPTY_REGISTRY)
    // Mirrors DSH-better-sidebar src/sidechat-routes.ts:104-108 and
    // dsh-ops src/prompt-injection/types.ts:47-53 — members separated only by
    // newlines, one member typed by an imported identifier, readonly modifiers.
    writeFileSync(join(pluginDir, 'src/plugin.ts'), `
import type { Context } from '@deepseek-ai/cordis'
import type { EffortLevel } from '@deepseek-ai/dsh-events'

declare module '@deepseek-ai/dsh-events' {
  interface SelectionEventMap {
    'model/selection': {
      provider: string
      model: string
      reasoningEffort?: EffortLevel
    }
    'step-tail': {
      readonly kind: 'step-tail'
      readonly contributor: string
    }
  }
}

export function apply(ctx: Context): void {
  ctx.on('demo/event', payload => {
    const selection: { provider: string; model: string; reasoningEffort?: EffortLevel } = {
      provider: 'p',
      model: 'm',
      reasoningEffort: 'low',
    }
    void payload
    void selection
  })
}
`)

    // 1. Scan --write: the augmentation type must carry explicit '; ' member
    //    separators (the whitespace collapse used to erase them — J2).
    const scanned = runScript(['--write'], pluginDir)
    assert.equal(scanned.status, 0, `${scanned.stdout}\n${scanned.stderr}`)
    const coupling = JSON.parse(readFileSync(join(pluginDir, 'coupling.json'), 'utf8')) as {
      augmentations?: Record<string, Record<string, Record<string, { kind: string; type?: string }>>>
    }
    const selectionType = coupling.augmentations?.['@deepseek-ai/dsh-events']?.['SelectionEventMap']?.['model/selection']?.type ?? ''
    assert.match(selectionType, /provider: string; model: string/, 'J2: members must be separated by "; "')
    assert.match(selectionType, /import\('@deepseek-ai\/dsh-events'\)\.EffortLevel/, 'J2: identifier rewrite must survive structural serialization')

    // 2. Direct engine run: no unattributed diagnostics (the TS1005 family lived here).
    const specs = engine.probeSpecsFromCoupling(coupling)
    const directRun = engine.checkContract({
      root: pluginDir,
      coupling,
      fieldSpecs: specs.fieldSpecs,
      discriminantSpecs: specs.discriminantSpecs,
      unverifiable: {},
      implicitFragments: {},
      implicitSeams: [],
      implicitRuns: {},
    })
    assert.deepEqual(directRun.outcome.unattributed, [], 'J2: probe with re-emitted literals must parse')
    assert.match(directRun.generated.source, /provider: string; model: string/)

    // 3. Standalone verify: exit 0 (both field-test repos regressed 0 -> 1 here).
    const verified = spawnSync(process.execPath, [VERIFY_SCRIPT, join(pluginDir, 'coupling.json')], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, DSH_SEAM_ROOT: pluginDir },
    })
    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`)
  } finally {
    rmSync(pluginDir, { recursive: true, force: true })
  }
})

test('borrowed guard expressions on anchored accesses classify as borrowed, not anchored->borrowed regressions', async () => {
  const VERIFY_SCRIPT = fileURLToPath(new URL('../../scripts/verify-coupling.mjs', import.meta.url))
  const pluginDir = mkdtempSync(join(tmpdir(), 'dsh-borrowed-guard-'))
  try {
    mkdirSync(join(pluginDir, 'src'), { recursive: true })
    mkdirSync(join(pluginDir, 'tests/contracts'), { recursive: true })
    writeMockUpstream(pluginDir, true)
    writeFileSync(join(pluginDir, 'tests/contracts/implicit-seams.ts'), EMPTY_REGISTRY)
    // Mirrors dsh-log-enhance src/index.ts:84-98 — a runtime-injected service
    // reached through a cast, a throw-guard on it, then an ANCHORED access
    // that flow analysis proves conditional on the guard. The probe replays
    // the guard verbatim, so its TS2339 names the borrowed property while
    // the failing segment belongs to the anchored surface.
    writeFileSync(join(pluginDir, 'src/plugin.ts'), `
import type { Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context): void {
  const manager = (ctx as Context & {
    mcpLike?: { register(name: string): () => void }
  }).mcpLike
  if (manager === undefined) throw new Error('mcpLike service is not available in this host')
  const dispose = manager.register('x')
  ctx.on('demo/event', payload => {
    void payload
    void dispose
  })
  ctx.logger?.info('mounted')
}
`)

    const scanned = runScript(['--write'], pluginDir)
    assert.equal(scanned.status, 0, `${scanned.stdout}\n${scanned.stderr}`)
    const coupling = JSON.parse(readFileSync(join(pluginDir, 'coupling.json'), 'utf8')) as {
      borrowed?: string[]
      fieldPaths: Record<string, Record<string, { accesses: Array<{ site: string; guards: Array<{ expr: string; kind: string }> }> }>>
    }
    assert.ok(coupling.borrowed?.includes('mcpLike'), 'cast-reached runtime service must enter borrowed')
    const loggerInfo = coupling.fieldPaths['@deepseek-ai/cordis']?.['logger.info']
    assert.ok(loggerInfo !== undefined, 'guarded anchored access must stay a field path')
    assert.ok(loggerInfo.accesses.some(access => access.guards.some(guard => guard.expr === 'ctx.mcpLike' && guard.kind === 'defined')),
      'flow guard over the borrowed service must be recorded on the anchored access')

    const verified = spawnSync(process.execPath, [VERIFY_SCRIPT, join(pluginDir, 'coupling.json')], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, DSH_SEAM_ROOT: pluginDir },
    })
    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`)
    assert.doesNotMatch(verified.stdout, /anchored -> borrowed/, 'a borrowed guard must not read as an anchored surface regression')
    assert.match(verified.stdout, /~ borrowed \(unsigned — add to inject, import provider, or exempt\): @deepseek-ai\/cordis::logger\.info/)

    // Engine suite path: the guarded segment must carry the borrowed marker so
    // runContractSuite's per-segment tests and the mount precondition tolerate
    // it (L3 registered borrows are never adjudicated anywhere).
    const engine = await loadEngine()
    const specs = engine.probeSpecsFromCoupling(coupling)
    const directRun = engine.checkContract({
      root: pluginDir,
      coupling,
      fieldSpecs: specs.fieldSpecs,
      discriminantSpecs: specs.discriminantSpecs,
      unverifiable: {},
      implicitFragments: {},
      implicitSeams: [],
      implicitRuns: {},
    })
    const guardedSegment = directRun.outcome.segments.find(segment => segment.id.startsWith('field:@deepseek-ai/cordis::logger.info'))
    assert.ok(guardedSegment !== undefined)
    assert.deepEqual(guardedSegment.borrowed, ['mcpLike'], 'engine must mark guard-borrowed segments, not fail them')
    const anchoredRed = directRun.outcome.segments.find(segment => segment.id.startsWith('field:@deepseek-ai/cordis::mcpLike'))
    assert.ok(anchoredRed !== undefined)
    assert.deepEqual(anchoredRed.borrowed, ['mcpLike'], 'the cast-reached surface itself must also be borrowed-marked')
  } finally {
    rmSync(pluginDir, { recursive: true, force: true })
  }
})
