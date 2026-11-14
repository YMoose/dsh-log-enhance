import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Regression cover for the train rewrite (`scripts/bump-upstream.mjs`).
 *
 * Single-line follow (docs/versioning.md §4) makes a train move ONE atomic
 * change: the devDependency pins AND `engines.dsh` move together, so the
 * canary's three-file artifact (package.json + lockfile + baseline.json) is a
 * complete revalidation commit. Before this cover existed, write mode rewrote
 * only the dependency fields and left `engines.dsh` behind, so
 * `probeVersionLockstep` failed on EVERY train move — a disciplinary red
 * indistinguishable from a real upstream break (review P1/P5).
 *
 * Scenarios drive the script through `DSH_LOG_ENHANCE_MANIFEST` /
 * `DSH_LOG_ENHANCE_BASELINE` / `DSH_LOG_ENHANCE_REGISTRY` against an offline
 * `file://` fixture registry; the real package.json and baseline.json are
 * never touched.
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/bump-upstream.mjs', import.meta.url))

interface Packument {
  'dist-tags': Record<string, string>
  time: Record<string, string>
  versions: Record<string, unknown>
}

/** A train member packument: no dist-tags of its own, publish times only. */
function member(times: Record<string, string>): Packument {
  return { 'dist-tags': {}, time: times, versions: {} }
}

const RC3_PUBLISHED = '2026-11-13T08:05:45.000Z'
const BASELINE_AT = '2026-11-13T12:00:00.000Z'

/** Materialize the packuments as a `file://` registry base URL. */
function fixtureRegistry(packages: Record<string, Packument>): { base: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-registry-'))
  for (const [name, packument] of Object.entries(packages)) {
    writeFileSync(join(dir, `${name.replaceAll('/', '%2F')}.json`), JSON.stringify(packument))
  }
  return { base: pathToFileURL(`${dir}/`).href, dir }
}

interface Fixture {
  readonly manifestPath: string
  readonly baselinePath: string
  readonly dir: string
}

/** Repo-like manifest pinned at the 0.2.2-rc.3 train, plus a baseline file. */
function fixture(baselineGeneratedAt: string = BASELINE_AT): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bump-'))
  const manifest = {
    name: 'fixture-plugin',
    version: '0.0.0',
    engines: { node: '>=24.9.0', dsh: '>=0.2.2-rc.3 <0.3.0-0' },
    devDependencies: {
      // Separate train (range + non-dsh name): must never be rewritten.
      '@deepseek-ai/cordis-plugin-loader': '1.1.0',
      '@deepseek-ai/dsh-agent': '0.2.2-rc.3',
      '@deepseek-ai/dsh-llm': '0.2.2-rc.3+build.7',
      '@deepseek-ai/dsh-subagent': '0.2.2-rc.3',
    },
  }
  const manifestPath = join(dir, 'package.json')
  const baselinePath = join(dir, 'baseline.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(baselinePath, `${JSON.stringify({ generatedAt: baselineGeneratedAt, packages: {} }, null, 2)}\n`)
  return { manifestPath, baselinePath, dir }
}

function runScript(args: string[], at: Fixture, registryBase: string) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      DSH_LOG_ENHANCE_MANIFEST: at.manifestPath,
      DSH_LOG_ENHANCE_REGISTRY: registryBase,
      DSH_LOG_ENHANCE_BASELINE: at.baselinePath,
    },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function readManifest(at: Fixture): {
  engines: { dsh: string }
  devDependencies: Record<string, string>
} {
  return JSON.parse(readFileSync(at.manifestPath, 'utf8')) as {
    engines: { dsh: string }
    devDependencies: Record<string, string>
  }
}

test('write mode moves the train AND engines.dsh together (same minor)', () => {
  const at = fixture()
  const registry = fixtureRegistry({
    '@deepseek-ai/dsh': {
      'dist-tags': { next: '0.2.2-rc.4' },
      time: { '0.2.2-rc.3': RC3_PUBLISHED, '0.2.2-rc.4': '2026-11-14T00:00:00.000Z' },
      versions: { '0.2.2-rc.4': {} },
    },
  })
  try {
    const { status, stdout, stderr } = runScript([], at, registry.base)
    assert.equal(status, 0, `${stdout}\n${stderr}`)
    assert.match(stdout, /engines\.dsh: >=0\.2\.2-rc\.3 <0\.3\.0-0 -> >=0\.2\.2-rc\.4 <0\.3\.0-0/)
    const manifest = readManifest(at)
    assert.equal(manifest.engines.dsh, '>=0.2.2-rc.4 <0.3.0-0')
    // Build-metadata specs are train members too (review P10): they move
    // to the resolved target rather than being skipped as unparseable.
    assert.equal(manifest.devDependencies['@deepseek-ai/dsh-llm'], '0.2.2-rc.4')
    assert.equal(manifest.devDependencies['@deepseek-ai/dsh-subagent'], '0.2.2-rc.4')
    // The separate cordis train stays untouched.
    assert.equal(manifest.devDependencies['@deepseek-ai/cordis-plugin-loader'], '1.1.0')
  } finally {
    rmSync(at.dir, { recursive: true, force: true })
    rmSync(registry.dir, { recursive: true, force: true })
  }
})

test('write mode recomputes the upper bound on a cross-minor move', () => {
  const at = fixture()
  const registry = fixtureRegistry({
    '@deepseek-ai/dsh': {
      'dist-tags': { next: '0.3.0-rc.1' },
      time: { '0.3.0-rc.1': '2026-11-14T00:00:00.000Z' },
      versions: { '0.3.0-rc.1': {} },
    },
  })
  try {
    const { status, stdout, stderr } = runScript([], at, registry.base)
    assert.equal(status, 0, `${stdout}\n${stderr}`)
    // The `-0` prerelease wall must follow the new minor (review P5).
    assert.equal(readManifest(at).engines.dsh, '>=0.3.0-rc.1 <0.4.0-0')
  } finally {
    rmSync(at.dir, { recursive: true, force: true })
    rmSync(registry.dir, { recursive: true, force: true })
  }
})

test('check mode reports no change when the train and publish times are unchanged', () => {
  const at = fixture()
  const registry = fixtureRegistry({
    '@deepseek-ai/dsh': {
      'dist-tags': { next: '0.2.2-rc.3' },
      time: { '0.2.2-rc.3': RC3_PUBLISHED },
      versions: { '0.2.2-rc.3': {} },
    },
    '@deepseek-ai/dsh-agent': member({ '0.2.2-rc.3': RC3_PUBLISHED }),
    '@deepseek-ai/dsh-llm': member({ '0.2.2-rc.3': RC3_PUBLISHED }),
    '@deepseek-ai/dsh-subagent': member({ '0.2.2-rc.3': RC3_PUBLISHED }),
  })
  try {
    const { status, stdout, stderr } = runScript(['--check'], at, registry.base)
    assert.equal(status, 0, `${stdout}\n${stderr}`)
    assert.match(stdout, /^UPSTREAM_CHANGED=no$/m)
  } finally {
    rmSync(at.dir, { recursive: true, force: true })
    rmSync(registry.dir, { recursive: true, force: true })
  }
})

test('a train member republished after the baseline trips the check', () => {
  const at = fixture()
  const registry = fixtureRegistry({
    // The bellwether is quiet: same tag, published before the baseline.
    '@deepseek-ai/dsh': {
      'dist-tags': { next: '0.2.2-rc.3' },
      time: { '0.2.2-rc.3': RC3_PUBLISHED },
      versions: { '0.2.2-rc.3': {} },
    },
    '@deepseek-ai/dsh-agent': member({ '0.2.2-rc.3': RC3_PUBLISHED }),
    '@deepseek-ai/dsh-llm': member({ '0.2.2-rc.3': RC3_PUBLISHED }),
    // ...but a member was republished under the SAME version string after
    // the baseline anchor — the 2026-11-09 incident shape (review P2).
    '@deepseek-ai/dsh-subagent': member({ '0.2.2-rc.3': '2026-11-13T18:00:00.000Z' }),
  })
  try {
    const { status, stdout, stderr } = runScript(['--check'], at, registry.base)
    assert.equal(status, 0, `${stdout}\n${stderr}`)
    assert.match(stdout, /^UPSTREAM_CHANGED=yes$/m)
    assert.match(stdout, /dsh-subagent/)
  } finally {
    rmSync(at.dir, { recursive: true, force: true })
    rmSync(registry.dir, { recursive: true, force: true })
  }
})

test('check mode fails loudly when the republish anchor is unreadable', () => {
  const at = fixture('/tmp/does-not-matter')
  const registry = fixtureRegistry({
    '@deepseek-ai/dsh': {
      'dist-tags': { next: '0.2.2-rc.3' },
      time: { '0.2.2-rc.3': RC3_PUBLISHED },
      versions: { '0.2.2-rc.3': {} },
    },
  })
  try {
    rmSync(at.baselinePath, { force: true }) // disarm the anchor
    const { status, stdout, stderr } = runScript(['--check'], at, registry.base)
    // An unreadable baseline must never degrade into a silent "no change".
    assert.equal(status, 1, `${stdout}\n${stderr}`)
    assert.match(stderr, /cannot read .* to anchor republish detection/)
  } finally {
    rmSync(at.dir, { recursive: true, force: true })
    rmSync(registry.dir, { recursive: true, force: true })
  }
})

test('--keep-floor moves the train and leaves engines.dsh untouched (print-only honors it too)', () => {
  const at = fixture()
  const registry = fixtureRegistry({
    '@deepseek-ai/dsh': {
      'dist-tags': { next: '0.2.2-rc.4' },
      time: { '0.2.2-rc.3': RC3_PUBLISHED, '0.2.2-rc.4': '2026-11-14T00:00:00.000Z' },
      versions: { '0.2.2-rc.4': {} },
    },
  })
  try {
    // Plan first: --print-only honors the flag — no engines move in the plan.
    const plan = runScript(['--print-only', '--keep-floor'], at, registry.base)
    assert.equal(plan.status, 0, `${plan.stdout}\n${plan.stderr}`)
    assert.doesNotMatch(plan.stdout, /engines\.dsh:.*->/)
    assert.match(plan.stdout, /engines\.dsh: >=0\.2\.2-rc\.3 <0\.3\.0-0 \(kept/)
    // Write mode: the train moves, the floor and the wall stay exactly put.
    const { status, stdout, stderr } = runScript(['--keep-floor'], at, registry.base)
    assert.equal(status, 0, `${stdout}\n${stderr}`)
    const manifest = readManifest(at)
    assert.equal(manifest.devDependencies['@deepseek-ai/dsh-agent'], '0.2.2-rc.4')
    assert.equal(manifest.devDependencies['@deepseek-ai/dsh-llm'], '0.2.2-rc.4')
    assert.equal(manifest.engines.dsh, '>=0.2.2-rc.3 <0.3.0-0', 'the floor must stay at rc.3')
  } finally {
    rmSync(at.dir, { recursive: true, force: true })
    rmSync(registry.dir, { recursive: true, force: true })
  }
})

test('--keep-floor refuses a target the existing wall does not admit, writing nothing', () => {
  const at = fixture()
  const registry = fixtureRegistry({
    '@deepseek-ai/dsh': {
      'dist-tags': { next: '0.3.0-rc.1' },
      time: { '0.3.0-rc.1': '2026-11-14T00:00:00.000Z' },
      versions: { '0.3.0-rc.1': {} },
    },
  })
  try {
    const before = readFileSync(at.manifestPath, 'utf8')
    const { status, stdout, stderr } = runScript(['--keep-floor'], at, registry.base)
    assert.equal(status, 1, `expected a refusal, got: ${stdout}\n${stderr}`)
    assert.match(stderr, /does not admit the target 0\.3\.0-rc\.1/)
    assert.match(stderr, /conscious decision/)
    // Crossing the wall writes NOTHING — the manifest is byte-identical.
    assert.equal(readFileSync(at.manifestPath, 'utf8'), before)
  } finally {
    rmSync(at.dir, { recursive: true, force: true })
    rmSync(registry.dir, { recursive: true, force: true })
  }
})

test('--keep-floor refuses a BELOW-FLOOR target carrying build metadata, writing nothing (R2)', () => {
  // '0.2.9+build.1' sorts below the '>=0.2.10' floor by semver precedence; the
  // old comparator's localeCompare fallback admitted it silently.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bump-'))
  const manifestPath = join(dir, 'package.json')
  writeFileSync(manifestPath, `${JSON.stringify({
    name: 'fixture-plugin',
    version: '0.0.0',
    engines: { dsh: '>=0.2.10 <0.3.0-0' },
    devDependencies: { '@deepseek-ai/dsh-agent': '0.2.10' },
  }, null, 2)}\n`)
  const baselinePath = join(dir, 'baseline.json')
  writeFileSync(baselinePath, `${JSON.stringify({ generatedAt: BASELINE_AT, packages: {} }, null, 2)}\n`)
  const registry = fixtureRegistry({
    '@deepseek-ai/dsh': {
      'dist-tags': { next: '0.2.9+build.1' },
      time: { '0.2.10': RC3_PUBLISHED, '0.2.9+build.1': '2026-11-14T00:00:00.000Z' },
      versions: { '0.2.9+build.1': {} },
    },
  })
  const at = { manifestPath, baselinePath, dir }
  try {
    const before = readFileSync(manifestPath, 'utf8')
    const { status, stdout, stderr } = runScript(['--keep-floor'], at, registry.base)
    assert.equal(status, 1, `a below-floor target must be refused even with build metadata:\n${stdout}\n${stderr}`)
    assert.match(stderr, /does not admit the target 0\.2\.9\+build\.1/)
    assert.equal(readFileSync(manifestPath, 'utf8'), before, 'a refusal writes NOTHING')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(registry.dir, { recursive: true, force: true })
  }
})

test('fallback resolution orders build-metadata versions by semver precedence (R2)', () => {
  // No dist-tags: the target falls back to the newest `versions` entry by
  // compareVersions. 0.2.10 outranks 0.2.2-rc.4+build.1; the old comparator
  // shunted the +build version into localeCompare and picked it instead.
  const at = fixture()
  const registry = fixtureRegistry({
    '@deepseek-ai/dsh': {
      'dist-tags': {},
      time: { '0.2.2-rc.4+build.1': '2026-11-14T00:00:00.000Z', '0.2.10': '2026-11-14T01:00:00.000Z' },
      versions: { '0.2.2-rc.4+build.1': {}, '0.2.10': {} },
    },
  })
  try {
    const { status, stdout, stderr } = runScript([], at, registry.base)
    assert.equal(status, 0, `${stdout}\n${stderr}`)
    assert.equal(readManifest(at).devDependencies['@deepseek-ai/dsh-agent'], '0.2.10')
  } finally {
    rmSync(at.dir, { recursive: true, force: true })
    rmSync(registry.dir, { recursive: true, force: true })
  }
})

test('write mode with a +build target pins the full version and strips the floor (R1 coverage pin)', () => {
  // The exact artifact combo the lockstep probe must accept (see
  // tests/engine-contract.test.ts): devDeps carry the full target (that is
  // what installs), engines.dsh carries the stripped floor (semver ranges
  // cannot carry build metadata).
  const at = fixture()
  const registry = fixtureRegistry({
    '@deepseek-ai/dsh': {
      'dist-tags': { next: '0.2.2-rc.4+build.1' },
      time: { '0.2.2-rc.3': RC3_PUBLISHED, '0.2.2-rc.4+build.1': '2026-11-14T00:00:00.000Z' },
      versions: { '0.2.2-rc.4+build.1': {} },
    },
  })
  try {
    const { status, stdout, stderr } = runScript([], at, registry.base)
    assert.equal(status, 0, `${stdout}\n${stderr}`)
    const manifest = readManifest(at)
    assert.equal(manifest.devDependencies['@deepseek-ai/dsh-agent'], '0.2.2-rc.4+build.1')
    assert.equal(manifest.devDependencies['@deepseek-ai/dsh-llm'], '0.2.2-rc.4+build.1')
    assert.equal(manifest.engines.dsh, '>=0.2.2-rc.4 <0.3.0-0', 'the engines floor must be stripped')
  } finally {
    rmSync(at.dir, { recursive: true, force: true })
    rmSync(registry.dir, { recursive: true, force: true })
  }
})

test('--keep-floor admits a target equal to the floor modulo build metadata (R2 vector)', () => {
  const at = fixture()
  const registry = fixtureRegistry({
    '@deepseek-ai/dsh': {
      'dist-tags': { next: '0.2.2-rc.3+build.7' },
      time: { '0.2.2-rc.3': RC3_PUBLISHED, '0.2.2-rc.3+build.7': '2026-11-14T00:00:00.000Z' },
      versions: { '0.2.2-rc.3+build.7': {} },
    },
  })
  try {
    const { status, stdout, stderr } = runScript(['--keep-floor'], at, registry.base)
    assert.equal(status, 0, `${stdout}\n${stderr}`)
    const manifest = readManifest(at)
    assert.equal(manifest.devDependencies['@deepseek-ai/dsh-agent'], '0.2.2-rc.3+build.7')
    assert.equal(manifest.engines.dsh, '>=0.2.2-rc.3 <0.3.0-0', 'same-precedence target keeps the floor')
  } finally {
    rmSync(at.dir, { recursive: true, force: true })
    rmSync(registry.dir, { recursive: true, force: true })
  }
})
