import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Contract audit: `coupling.json` records which upstream surfaces this repo
 * touches, but a recording cannot notice that a surface stopped existing. The
 * audit resolves each entry against the checkout's declaration output and warns
 * — never fails, because the link must stay usable.
 *
 * These scenarios build throwaway checkouts so they assert the *audit*, not the
 * real Harness build: real `.d.ts` files change under us.
 *
 * Scenarios drive `--check`, which creates no symlinks.
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/link-harness.mjs', import.meta.url))

interface MockPackage {
  name: string
  /** Declaration files written under the package root, keyed by relative path. */
  declarations?: Record<string, string>
  /** Extra manifest fields merged over name/version. */
  manifest?: Record<string, unknown>
}

/** Build a checkout with the real walk shape: `vendor/` + `packages/<group>/<pkg>/`. */
function makeCheckout(packages: MockPackage[]): string {
  const harness = mkdtempSync(join(tmpdir(), 'dsh-link-contracts-'))
  writeFileSync(
    join(harness, 'package.json'),
    `${JSON.stringify({ name: '@deepseek-ai/dsh-root', version: '0.0.0' }, null, 2)}\n`,
  )
  mkdirSync(join(harness, 'vendor'), { recursive: true })
  for (const { name, declarations = {}, manifest = {} } of packages) {
    const directory = join(harness, 'packages', 'mock', name.replace('@deepseek-ai/', ''))
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, 'package.json'),
      `${JSON.stringify({ name, version: '0.0.0', types: 'lib/types/index.d.ts', ...manifest }, null, 2)}\n`,
    )
    for (const [relativePath, text] of Object.entries(declarations)) {
      const file = join(directory, relativePath)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, text)
    }
  }
  return harness
}

/** An empty devDeps train keeps the version audit quiet so assertions see contracts only. */
function makeManifest(directory: string): string {
  const manifest = join(directory, 'package.json')
  writeFileSync(manifest, `${JSON.stringify({ name: 'fixture', devDependencies: {} }, null, 2)}\n`)
  return manifest
}

interface RunResult { status: number | null, stdout: string, stderr: string }

function run(harness: string, manifest: string, coupling?: string, extra: string[] = []): RunResult {
  const environment: NodeJS.ProcessEnv = { ...process.env, DSH_LOG_ENHANCE_MANIFEST: manifest }
  if (coupling !== undefined) environment.DSH_LOG_ENHANCE_COUPLING = coupling
  const result = spawnSync(process.execPath, [SCRIPT, harness, '--check', ...extra], {
    encoding: 'utf8',
    env: environment,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** The declaration fixture: one payload type, one augmented Context/Events pair. */
const CORE_DTS = `
declare module '@deepseek-ai/cordis' {
    interface Context {
        mockService: { run(): void };
    }
    interface Events {
        'mock/event'(this: unknown, session: string, event: number): void;
        'mock/other'(this: unknown, payload: { turn: number }): void;
    }
}
export interface Payload {
    id: string;
    turn: number;
    source: { kind: string; sender?: string };
    /** Element hop recorded by the analyzer as items[].… */
    items: Array<{ id: string; source: { kind: string } }>;
    /** Opaque JSON: paths read through this cannot be verified. */
    meta: Record<string, unknown>;
}
export interface Envelope {
    seq: number;
    data: Payload;
}
export type Outcome = { isError: false; value: unknown } | { isError: true; error: { name: string } };
`

function couplingOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packages: { '@deepseek-ai/mock-core': { declaredIn: ['devDependencies'], roots: {} } },
    srcHooks: [],
    testHooks: [],
    ctxAccesses: {},
    fieldPaths: {},
    ...overrides,
  }
}

/** Materialise a scenario's temp dirs, run it, and clean up. */
function scenario(
  body: (context: { harness: string, manifest: string, coupling: string, directory: string }) => void,
  packages: MockPackage[] = [{
    name: '@deepseek-ai/mock-core',
    declarations: { 'lib/types/index.d.ts': CORE_DTS },
  }],
  coupling: Record<string, unknown> = couplingOf(),
): void {
  const harness = makeCheckout(packages)
  const directory = mkdtempSync(join(tmpdir(), 'dsh-link-contracts-fixture-'))
  try {
    const manifest = makeManifest(directory)
    const couplingFile = join(directory, 'coupling.json')
    writeFileSync(couplingFile, `${JSON.stringify(coupling, null, 2)}\n`)
    body({ harness, manifest, coupling: couplingFile, directory })
  } finally {
    rmSync(harness, { recursive: true, force: true })
    rmSync(directory, { recursive: true, force: true })
  }
}

test('contract audit stays quiet when every recorded surface still resolves', () => {
  scenario(({ harness, manifest, coupling }) => {
    const result = run(harness, manifest, coupling)
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /warning:/)
    assert.match(result.stdout, /API contracts: \d+ check\(s\)/)
  }, undefined, couplingOf({
    srcHooks: [{ event: 'mock/event', via: 'on', params: ['session', 'event'] }],
    testHooks: [{ event: 'mock/other', via: 'on', params: ['payload'] }],
    ctxAccesses: { mockService: ['src/index.ts'] },
    fieldPaths: {
      '@deepseek-ai/mock-core': ['turn', 'source.kind', 'source.sender', 'data.turn'],
    },
    packages: {
      '@deepseek-ai/mock-core': {
        declaredIn: ['devDependencies'],
        roots: {},
        types: ['Payload', 'Envelope'],
      },
    },
  }))
})

test('contract audit reports a recorded field path the declaration no longer has', () => {
  scenario(({ harness, manifest, coupling }) => {
    const result = run(harness, manifest, coupling)
    assert.match(result.stderr, /warning: contract: @deepseek-ai\/mock-core: field path 'source\.senderId'/)
  }, undefined, couplingOf({
    fieldPaths: { '@deepseek-ai/mock-core': ['source.kind', 'source.senderId'] },
  }))
})

test('contract audit reports a field path that stops partway through the chain', () => {
  scenario(({ harness, manifest, coupling }) => {
    const result = run(harness, manifest, coupling)
    // `source` exists, its `kind` does too — `source.kind.length` is the break.
    assert.match(result.stderr, /field path 'source\.kind\.nope' does not resolve/)
  }, undefined, couplingOf({
    fieldPaths: { '@deepseek-ai/mock-core': ['source.kind.nope'] },
  }))
})

test('contract audit reads the object-shaped fieldPaths the analyzer writes', () => {
  scenario(({ harness, manifest, coupling }) => {
    const result = run(harness, manifest, coupling)
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /warning:/)
    // Both entries must be audited: the count is the check, not decoration.
    assert.match(result.stdout, /API contracts: 2 check\(s\)/)
  }, undefined, couplingOf({
    fieldPaths: {
      '@deepseek-ai/mock-core': {
        'source.kind': { rootType: 'Payload', sites: ['src/index.ts:126'] },
        'data.turn': { rootType: 'Envelope', sites: ['src/observer.ts:107'] },
      },
    },
  }))
})

test('contract audit still reports drift recorded in the object shape', () => {
  scenario(({ harness, manifest, coupling }) => {
    const result = run(harness, manifest, coupling)
    assert.match(result.stderr, /warning: contract: @deepseek-ai\/mock-core: field path 'source\.senderId'/)
  }, undefined, couplingOf({
    fieldPaths: {
      '@deepseek-ai/mock-core': {
        'source.senderId': { rootType: 'Payload', sites: ['src/index.ts:126'] },
      },
    },
  }))
})

test('contract audit resolves a for-of element hop on the array element type', () => {
  scenario(({ harness, manifest, coupling }) => {
    const result = run(harness, manifest, coupling)
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /warning:/)
    assert.match(result.stdout, /API contracts: 1 check\(s\)/)
  }, undefined, couplingOf({
    fieldPaths: {
      '@deepseek-ai/mock-core': {
        'items[].source.kind': { rootType: 'Payload', sites: ['src/observer.ts:112'] },
      },
    },
  }))
})

test('contract audit reports an element hop that the declaration no longer supports', () => {
  scenario(({ harness, manifest, coupling }) => {
    const result = run(harness, manifest, coupling)
    // `items[]` iterates objects: `source` stops resolving below `items[]`.
    assert.match(result.stderr, /field path 'items\[\]\.source\.nope' does not resolve/)
  }, undefined, couplingOf({
    fieldPaths: {
      '@deepseek-ai/mock-core': {
        'items[].source.nope': { rootType: 'Payload', sites: ['src/observer.ts:112'] },
      },
    },
  }))
})

test('contract audit refuses an element hop on a non-iterable field', () => {
  scenario(({ harness, manifest, coupling }) => {
    const result = run(harness, manifest, coupling)
    // `turn` is a number: `turn[]` is a shape drift, not an opaque payload.
    assert.match(result.stderr, /field path 'turn\[\]\.length' does not resolve/)
  }, undefined, couplingOf({
    fieldPaths: {
      '@deepseek-ai/mock-core': {
        'turn[].length': { rootType: 'Payload', sites: ['src/index.ts:1'] },
      },
    },
  }))
})

test('contract audit reports a removed exported type', () => {
  scenario(({ harness, manifest, coupling }) => {
    const result = run(harness, manifest, coupling)
    assert.match(result.stderr, /contract: @deepseek-ai\/mock-core: type RemovedType is no longer exported/)
    assert.doesNotMatch(result.stderr, /type Payload is no longer exported/)
  }, undefined, couplingOf({
    packages: {
      '@deepseek-ai/mock-core': {
        declaredIn: ['devDependencies'],
        roots: {},
        types: ['Payload', 'RemovedType'],
      },
    },
  }))
})

test('contract audit checks explicit typed fields and names the type in the warning', () => {
  scenario(({ harness, manifest, coupling }) => {
    const result = run(harness, manifest, coupling)
    assert.match(result.stderr, /contract: @deepseek-ai\/mock-core: Envelope\.data\.missing does not resolve \(stopped at data\.missing\)/)
    assert.doesNotMatch(result.stderr, /Envelope\.data\.turn/)
  }, undefined, couplingOf({
    packages: {
      '@deepseek-ai/mock-core': {
        declaredIn: ['devDependencies'],
        roots: {},
        fields: [
          { type: 'Envelope', path: 'data.turn' },
          { type: 'Envelope', path: 'data.missing' },
        ],
      },
    },
  }))
})

test('contract audit reports a removed ctx service on the merged Context interface', () => {
  scenario(({ harness, manifest, coupling }) => {
    const result = run(harness, manifest, coupling)
    assert.match(result.stderr, /contract: ctx\.goneService is not declared on merged Context/)
    assert.doesNotMatch(result.stderr, /ctx\.mockService/)
  }, undefined, couplingOf({
    ctxAccesses: { mockService: ['src/index.ts'], goneService: ['src/index.ts'] },
  }))
})

test('contract audit reports a removed event on the merged Events interface', () => {
  scenario(({ harness, manifest, coupling }) => {
    const result = run(harness, manifest, coupling)
    assert.match(result.stderr, /contract: hook 'mock\/renamed' is not declared on merged Events/)
    assert.doesNotMatch(result.stderr, /hook 'mock\/event'/)
  }, undefined, couplingOf({
    srcHooks: [{ event: 'mock/event', via: 'on', params: ['session', 'event'] }],
    testHooks: [{ event: 'mock/renamed', via: 'on', params: ['session', 'event'] }],
  }))
})

test('contract audit reports a handler that declares more parameters than the event provides', () => {
  scenario(({ harness, manifest, coupling }) => {
    const result = run(harness, manifest, coupling)
    assert.match(result.stderr, /hook 'mock\/event' handler declares 3 parameter\(s\) but the event provides 2/)
  }, undefined, couplingOf({
    srcHooks: [{ event: 'mock/event', via: 'on', params: ['session', 'event', 'extra'] }],
  }))
})

test('contract audit tolerates paths read through an opaque JSON payload', () => {
  // `meta` is Record<string, unknown>: nothing below it is verifiable, and
  // guessing that `anything` is missing would be a false alarm.
  scenario(({ harness, manifest, coupling }) => {
    const result = run(harness, manifest, coupling)
    assert.doesNotMatch(result.stderr, /warning:/)
  }, undefined, couplingOf({
    fieldPaths: { '@deepseek-ai/mock-core': ['meta.anything.at.all'] },
  }))
})

test('contract audit warns, without failing, when the checkout is built but a coupled package is not', () => {
  scenario(({ harness, manifest, coupling }) => {
    const result = run(harness, manifest, coupling)
    assert.equal(result.status, 0, 'an unbuilt checkout must stay linkable')
    assert.match(result.stderr, /contract: @deepseek-ai\/mock-core: no declaration file found/)
  }, [
    { name: '@deepseek-ai/mock-core' },
    { name: '@deepseek-ai/mock-built', declarations: { 'lib/types/index.d.ts': 'export interface Built { id: string }\n' } },
  ], couplingOf())
})

test('contract audit is skipped entirely when the checkout has no build output at all', () => {
  scenario(({ harness, manifest, coupling }) => {
    const result = run(harness, manifest, coupling)
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /warning:/)
    assert.match(result.stdout, /no declaration output/)
  }, [{ name: '@deepseek-ai/mock-core' }], couplingOf())
})

test('contract audit is skipped with a note when coupling.json is absent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-link-contracts-fixture-'))
  const harness = makeCheckout([{ name: '@deepseek-ai/mock-core', declarations: { 'lib/types/index.d.ts': CORE_DTS } }])
  try {
    const manifest = makeManifest(directory)
    const result = run(harness, manifest, join(directory, 'absent-coupling.json'))
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /warning:/)
    assert.match(result.stdout, /coupling\.json not found/)
  } finally {
    rmSync(harness, { recursive: true, force: true })
    rmSync(directory, { recursive: true, force: true })
  }
})

test('--skip-contracts keeps the version audit and skips declaration parsing', () => {
  scenario(({ harness, manifest, coupling }) => {
    const result = run(harness, manifest, coupling, ['--skip-contracts'])
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stdout, /checking API contracts/)
    assert.doesNotMatch(result.stderr, /contract:/)
    assert.match(result.stdout, /Checked \d+ Harness packages/)
  }, undefined, couplingOf({ ctxAccesses: { goneService: ['src/index.ts'] } }))
})

test('the committed coupling.json resolves against the real checkout when one is present', () => {
  // Opt-in: points at the developer's Harness checkout. Skips cleanly elsewhere
  // so CI never depends on a local path.
  const harness = process.env.DSH_LOG_ENHANCE_HARNESS
  if (harness === undefined) return
  const result = spawnSync(process.execPath, [SCRIPT, harness, '--check'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /API contracts: \d+ check\(s\)/)
  assert.doesNotMatch(result.stderr, /warning: contract:/, result.stderr)
})

