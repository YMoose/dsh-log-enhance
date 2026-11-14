import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * MECHANISM cover for `scripts/write-baseline.mjs` (travels in the dsh-seam
 * payload; consumer-reality cover — "installed integrity matches the
 * committed baseline" — stays in each consumer's own tests/baseline.test.ts).
 *
 * Review P6: nested lockfile keys such as
 * `node_modules/@deepseek-ai/dsh-agent/node_modules/@deepseek-ai/dsh-llm`
 * are resolution overrides, not train members, and must not enter the
 * fingerprint — a nested slice like `dsh-agent/node_modules/@deepseek-ai/dsh-llm`
 * would pollute the one-train lockstep assertion with a version the train
 * never declared. Driven entirely through env fixtures; the real repository
 * is untouched.
 */

const WRITE_BASELINE_SCRIPT = fileURLToPath(new URL('../../scripts/write-baseline.mjs', import.meta.url))

test('the baseline fingerprint ignores nested node_modules overrides', () => {
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
