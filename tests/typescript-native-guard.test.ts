import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Regression cover for the native typescript (Go build) guard.
 *
 * Provenance: the first corpus CI run (43701139585) crashed inside three
 * third-party plugin repositories that pin `typescript ^7.0.2`. The 7.x npm
 * package is the native build: its root export is a four-line version stub
 * (`lib/version.cjs`) without the classic Compiler API, so the scanner died
 * on `ts.SyntaxKind.EqualsEqualsToken` and verify on `ts.ModuleKind.ESNext`.
 * The CI runner now self-heals by installing dsh-seam's own typescript, but
 * a Level 2 consumer that upgrades its repository to the native build hits
 * the same wall through the synced payload: the resolution anchors prefer
 * the script's own location, i.e. the consumer's node_modules.
 *
 * Fixtures reproduce that topology: copies of the payload scripts live
 * INSIDE a fixture repository whose node_modules holds a faithful stub of
 * the native package. Both entry points must fail with an explicit message
 * naming the resolved native package — not a cryptic TypeError. For verify
 * the guard must fire before the engine loads: the engine imports
 * `typescript` itself, and a stub would otherwise crash deep inside it.
 */

function locate(candidates: string[]): string {
  for (const candidate of candidates) {
    const path = fileURLToPath(new URL(candidate, import.meta.url))
    if (existsSync(path)) return path
  }
  assert.fail(`cannot locate payload file (tried ${candidates.join(', ')})`)
}

/** Works in every layout that runs mechanism tests: dsh-seam's source tree
 *  (payload/tests/mechanism → payload/tests/seam), dsh-seam's compiled tree
 *  (dist-test/tests/mechanism → the payload source tree) and consumer
 *  repositories, which compile mechanism tests flat into dist-test/tests/
 *  and keep engine.ts in the source tests/seam/. */
const ANALYZE = locate(['../../scripts/analyze-dsh-coupling.mjs'])
const VERIFY = locate(['../../scripts/verify-coupling.mjs'])
const ENGINE_TS = locate([
  '../seam/engine.ts',
  '../../../payload/tests/seam/engine.ts',
  '../../tests/seam/engine.ts',
])

/** Faithful stub of the native typescript@7 package (root export only). */
function writeConsumerFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ts7-'))
  const tsDir = join(root, 'node_modules', 'typescript')
  mkdirSync(join(tsDir, 'lib'), { recursive: true })
  writeFileSync(join(tsDir, 'package.json'), `${JSON.stringify({
    name: 'typescript',
    version: '7.0.2',
    type: 'module',
    exports: { '.': './lib/version.cjs', './package.json': './package.json' },
  }, null, 2)}\n`)
  writeFileSync(join(tsDir, 'lib', 'version.cjs'),
    'const { version } = require("../package.json");\nexports.version = version;\nexports.versionMajorMinor = "7.0";\n')

  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(ANALYZE, join(root, 'scripts', 'analyze-dsh-coupling.mjs'))
  copyFileSync(VERIFY, join(root, 'scripts', 'verify-coupling.mjs'))
  mkdirSync(join(root, 'tests', 'seam'), { recursive: true })
  copyFileSync(ENGINE_TS, join(root, 'tests', 'seam', 'engine.ts'))

  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'),
    "import { agent } from '@deepseek-ai/dsh-foo'\nexport const value = agent.id\n")
  const fooDir = join(root, 'node_modules', '@deepseek-ai', 'dsh-foo')
  mkdirSync(fooDir, { recursive: true })
  writeFileSync(join(fooDir, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh-foo', version: '1.0.0', types: './index.d.ts', main: './index.js',
  }, null, 2)}\n`)
  writeFileSync(join(fooDir, 'index.d.ts'), 'export declare const agent: { id: string; name: string }\n')
  return root
}

function runScript(script: string, args: string[], cwd: string): string {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60_000, cwd })
  return `exit=${String(result.status)}\n${result.stdout}\n${result.stderr}`
}

test('scanner names the native typescript build instead of crashing on ts.SyntaxKind', () => {
  const root = writeConsumerFixture()
  try {
    const output = runScript(join(root, 'scripts', 'analyze-dsh-coupling.mjs'), [], root)
    assert.match(output, /^exit=[1-9]/m, 'the native stub must fail the scan')
    assert.match(output, /typescript@7\.0\.2/, 'names the resolved native package')
    assert.match(output, /classic Compiler API/, 'explains the missing API surface')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('verify names the native typescript build before loading the engine', () => {
  const root = writeConsumerFixture()
  try {
    const output = runScript(join(root, 'scripts', 'verify-coupling.mjs'), ['coupling.json'], root)
    assert.match(output, /^exit=[1-9]/m, 'the native stub must fail verification')
    assert.match(output, /typescript@7\.0\.2/, 'names the resolved native package')
    assert.match(output, /classic Compiler API/, 'explains the missing API surface')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
