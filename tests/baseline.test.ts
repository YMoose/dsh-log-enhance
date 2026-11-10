import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Dependency verification baseline: the installed `@deepseek-ai/*` packages
 * must match the committed integrity snapshot in `baseline.json`. A mismatch
 * means the dependency CONTENT drifted while versions may look unchanged —
 * the rc same-version republish failure mode — and must be re-verified, not
 * silently accepted.
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
    packages[key.slice(SCOPE.length)] = {
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
