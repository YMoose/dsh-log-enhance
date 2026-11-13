import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Regression cover for the link-harness version audit.
 *
 * An upstream rc can be republished in place with the same version string but
 * different content (docs/versioning.md §2). A checkout whose packages do not
 * match the pinned devDeps train links without complaint and then fails later
 * in a way that reads like a code bug. The audit must therefore surface the
 * mismatch — while staying a warning, because probing an older checkout is a
 * legitimate developer choice.
 *
 * Scenarios drive `--check`, which never creates symlinks, so the test can
 * point at throwaway checkouts and leave node_modules untouched.
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/link-harness.mjs', import.meta.url))

/** Build a minimal checkout with the real shape the script walks (vendor/ + packages/<group>/). */
function makeCheckout(rootVersion: string, packages: Record<string, string>): string {
  const harness = mkdtempSync(join(tmpdir(), 'dsh-link-harness-'))
  writeFileSync(join(harness, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh-root', version: rootVersion }, null, 2)}\n`)
  mkdirSync(join(harness, 'packages', 'core'), { recursive: true })
  mkdirSync(join(harness, 'vendor'), { recursive: true })
  for (const [name, version] of Object.entries(packages)) {
    const dir = join(harness, 'packages', 'core', name.replace('@deepseek-ai/', ''))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, version }, null, 2)}\n`)
  }
  return harness
}

function run(harness: string, manifest?: string): { status: number | null, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, harness, '--check'], {
    encoding: 'utf8',
    env: manifest === undefined ? process.env : { ...process.env, DSH_LOG_ENHANCE_MANIFEST: manifest },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const projectDevDeps = Object.entries(
  (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    devDependencies: Record<string, string>
  }).devDependencies,
).filter(([name]) => name.startsWith('@deepseek-ai/'))

test('link-harness stays quiet when the checkout matches the devDeps train', () => {
  const packages = Object.fromEntries(projectDevDeps)
  const harness = makeCheckout('0.2.2-rc.3', packages)
  try {
    const result = run(harness)
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /warning:/)
    assert.match(result.stdout, /0 warning\(s\)/)
  } finally {
    rmSync(harness, { recursive: true, force: true })
  }
})

test('link-harness warns, but does not fail, when a checkout package differs from devDeps', () => {
  const packages = Object.fromEntries(projectDevDeps)
  packages['@deepseek-ai/dsh-subagent'] = '0.2.1-rc.4' // an older train
  const harness = makeCheckout('0.2.2-rc.3', packages)
  try {
    const result = run(harness)
    assert.equal(result.status, 0, 'a version mismatch must not hard-fail the link')
    assert.match(result.stderr, /warning: @deepseek-ai\/dsh-subagent: checkout has 0\.2\.1-rc\.4/)
    // The warning must name both sides so the developer can act on it.
    assert.match(result.stderr, /0\.2\.2-rc\.3/)
  } finally {
    rmSync(harness, { recursive: true, force: true })
  }
})

test('link-harness warns when the checkout root release differs from the pinned train', () => {
  const packages = Object.fromEntries(projectDevDeps)
  const harness = makeCheckout('0.3.0-rc.1', packages)
  try {
    const result = run(harness)
    assert.equal(result.status, 0)
    assert.match(result.stderr, /harness root is 0\.3\.0-rc\.1 but the pinned train is 0\.2\.2-rc\.3/)
  } finally {
    rmSync(harness, { recursive: true, force: true })
  }
})

test('link-harness names a devDependency the checkout does not provide', () => {
  const packages = Object.fromEntries(projectDevDeps)
  delete packages['@deepseek-ai/dsh-tool-subagent-control']
  const harness = makeCheckout('0.2.2-rc.3', packages)
  try {
    const result = run(harness)
    assert.equal(result.status, 0)
    assert.match(result.stderr, /warning: @deepseek-ai\/dsh-tool-subagent-control: expected .* but the checkout does not provide it/)
  } finally {
    rmSync(harness, { recursive: true, force: true })
  }
})

test('link-harness ignores non-exact devDeps pins instead of inventing an expected version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-link-manifest-'))
  const harness = makeCheckout('0.2.2-rc.3', Object.fromEntries(projectDevDeps))
  try {
    const manifest = join(dir, 'package.json')
    writeFileSync(manifest, `${JSON.stringify({
      name: 'dsh-log-enhance',
      devDependencies: { '@deepseek-ai/dsh-subagent': '^0.2.2-rc.1' },
    }, null, 2)}\n`)
    const result = run(harness, manifest)
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /warning:/)
  } finally {
    rmSync(harness, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})
