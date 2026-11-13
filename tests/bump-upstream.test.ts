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
