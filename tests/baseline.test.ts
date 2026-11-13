import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Dependency verification baseline: the installed `@deepseek-ai/*` packages
 * must match the committed integrity snapshot in `baseline.json`. A mismatch
 * means the dependency CONTENT drifted while versions may look unchanged —
 * the rc same-version republish failure mode — and must be re-verified, not
 * silently accepted.
 *
 * The hidden-lockfile reader here mirrors `scripts/write-baseline.mjs`
 * exactly, including the nested-key exclusion: lockfile keys like
 * `node_modules/@deepseek-ai/dsh-agent/node_modules/@deepseek-ai/dsh-llm`
 * are resolution overrides, not train members, and must not enter the
 * fingerprint on either side (a nested slice such as
 * `dsh-agent/node_modules/@deepseek-ai/dsh-llm` would corrupt the one-train
 * lockstep assertion with a version the train never declared).
 */

const SCOPE = 'node_modules/@deepseek-ai/'
const DRIFT_MESSAGE = '依赖内容与验证基线漂移（可能是 rc 同版本重发布或无意重钉），' +
  '走 docs/versioning.md §5 重验流程，不要直接重写 baseline.json'

function readScopedPackages(url: URL): Record<string, { integrity: string | null; version: string | null }> {
  const lock = JSON.parse(readFileSync(url, 'utf8')) as {
    packages?: Record<string, { integrity?: string; version?: string }>
  }
  const packages: Record<string, { integrity: string | null; version: string | null }> = {}
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith(SCOPE)) continue
    const name = key.slice(SCOPE.length)
    if (name.includes('/node_modules/')) continue // resolution override, not a train member
    packages[name] = {
      integrity: entry.integrity ?? null,
      version: entry.version ?? null,
    }
  }
  return packages
}

test('installed @deepseek-ai integrity matches the committed baseline', () => {
  const baselineUrl = new URL('../../baseline.json', import.meta.url)
  const lockUrl = new URL('../../node_modules/.package-lock.json', import.meta.url)
  const baseline = JSON.parse(readFileSync(baselineUrl, 'utf8')) as {
    packages: Record<string, { integrity: string | null; version: string | null }>
  }
  const installed = readScopedPackages(lockUrl)
  const drift: string[] = []
  for (const name of new Set([...Object.keys(baseline.packages), ...Object.keys(installed)]).keys()) {
    const expected = baseline.packages[name]
    const actual = installed[name]
    if (expected === undefined || actual === undefined ||
      expected.integrity !== actual.integrity || expected.version !== actual.version) {
      drift.push(`${name}: baseline ${JSON.stringify(expected ?? null)} vs installed ${JSON.stringify(actual ?? null)}`)
    }
  }
  assert.deepEqual(drift, [], `${DRIFT_MESSAGE}\n漂移明细:\n${drift.join('\n')}`)
})

const WRITE_BASELINE_SCRIPT = fileURLToPath(new URL('../../scripts/write-baseline.mjs', import.meta.url))

test('the baseline fingerprint ignores nested node_modules overrides', () => {
  // Review P6: nested lockfile keys used to be sliced into
  // `dsh-agent/node_modules/@deepseek-ai/dsh-llm` and recorded as if they
  // were scoped packages, polluting the one-train fingerprint.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-baseline-'))
  try {
    const hiddenLock = {
      packages: {
        'node_modules/@deepseek-ai/cordis': { version: '4.1.2', integrity: 'sha512-cordis' },
        'node_modules/@deepseek-ai/dsh-agent': { version: '0.2.2-rc.3', integrity: 'sha512-agent' },
        'node_modules/@deepseek-ai/dsh-agent/node_modules/@deepseek-ai/dsh-llm': {
          version: '0.0.1-rc.1',
          integrity: 'sha512-nested',
        },
      },
    }
    const hiddenLockPath = join(dir, '.package-lock.json')
    const baselinePath = join(dir, 'baseline.json')
    writeFileSync(hiddenLockPath, JSON.stringify(hiddenLock))
    const result = spawnSync(process.execPath, [WRITE_BASELINE_SCRIPT], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        DSH_LOG_ENHANCE_HIDDEN_LOCK: hiddenLockPath,
        DSH_LOG_ENHANCE_BASELINE_OUT: baselinePath,
      },
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      packages: Record<string, unknown>
    }
    assert.deepEqual(Object.keys(baseline.packages).sort(), ['cordis', 'dsh-agent'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
