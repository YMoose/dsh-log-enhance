import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
 * Fixtures redirect the repo root through DSH_LOG_ENHANCE_ROOT: the script
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
    env: { ...process.env, DSH_LOG_ENHANCE_ROOT: root },
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
