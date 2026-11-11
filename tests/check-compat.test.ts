import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Regression cover for the compatibility gate's boundary probes.
 *
 * The gate must never turn its own assertions into silent no-ops. Before this
 * test existed, a range the probes could not decompose (e.g. `^0.2.2-rc.1`,
 * which the official gate accepts) made both boundary assertions skip while
 * the script still exited 0 — a green gate over an unverified claim.
 *
 * Scenarios are driven through `DSH_LOG_ENHANCE_MANIFEST` so the real
 * package.json is never mutated.
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/check-compat.mjs', import.meta.url))

const baseManifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { engines: Record<string, string> }

function runWithRange(range: string): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-compat-'))
  try {
    const manifestPath = join(dir, 'package.json')
    const manifest = structuredClone(baseManifest)
    manifest.engines = { ...manifest.engines, dsh: range }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, DSH_LOG_ENHANCE_MANIFEST: manifestPath },
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the declared engines.dsh range passes and both probes actually run', () => {
  const { status, stdout } = runWithRange('>=0.2.2-rc.1 <0.3.0-0')
  assert.equal(status, 0, stdout)
  // The success line names both probed versions: proof they were derived.
  assert.match(stdout, /lower bound 0\.2\.2-rc\.1 admitted/)
  assert.match(stdout, /0\.3\.0-alpha\.1 rejected/)
})

test('an underivable lower bound fails instead of skipping the probe', () => {
  // `^0.2.2-rc.1` satisfies the official gate (runtime is 0.2.2-rc.1) but
  // carries no `>=` term, so the lower-bound probe used to skip silently.
  const { status, stdout, stderr } = runWithRange('^0.2.2-rc.1')
  assert.equal(status, 1, `${stdout}\n${stderr}`)
  assert.match(stderr, /cannot derive the engines\.dsh boundary probe/)
  assert.match(stderr, /probe wanted: lower bound/)
  assert.match(stderr, /\^0\.2\.2-rc\.1/)
  assert.doesNotMatch(stdout, /\bok:/)
})

test('an underivable upper bound fails instead of skipping the probe', () => {
  const { status, stdout, stderr } = runWithRange('>=0.2.2-rc.1 <0.3.0')
  assert.equal(status, 1, `${stdout}\n${stderr}`)
  assert.match(stderr, /cannot derive the engines\.dsh boundary probe/)
  assert.match(stderr, /first prerelease past the upper bound/)
  assert.match(stderr, /<0\.3\.0/)
  assert.doesNotMatch(stdout, /\bok:/)
})

test('a parseable range that admits its own past-upper prerelease still fails', () => {
  // Both probes derive here, yet the `||` alternative re-admits
  // `0.3.0-alpha.1`. This proves the boundary assertions still actually run
  // after the failure-path rewrite (not merely that parsing succeeds).
  const { status, stdout, stderr } = runWithRange('>=0.2.2-rc.1 || >0.3.0-alpha.0 <0.3.0-0')
  assert.equal(status, 1, `${stdout}\n${stderr}`)
  assert.match(stderr, /admits 0\.3\.0-alpha\.1/)
  assert.doesNotMatch(stdout, /\bok:/)
})
