import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * L2a 声明文件的目录覆盖（design 原则 8 构成门 / 决策 19 同族）。
 *
 * 历史缺陷（外部 review R1-e，rv-ambient 实测）：引擎的 ambient 收集
 * （collectAmbientDtsFiles）与扫描器的 listDtsFiles 同构，都只扫「仓库根
 * `*.d.ts` + `src/` 递归」——声明文件放在 `types/`（tsconfig include 的常见
 * 布局）时两边都看不到。扫描器仍能从 import 注解记录 rootType（Widget），
 * 但 verify 的探针程序里没有这份声明 → `import { Widget }` TS2305 → 被映射成
 * `broken root type` 假红——上游健康态就红。实测把同一文件挪进 `src/` 即全绿。
 *
 * 修复：两侧收集范围同步拓宽为「根 `*.d.ts` + `src/` 递归 + `types/` 递归」，
 * 构建产物目录（lib/ 等）不入。语料里两个 L2a 仓（image-pathify、
 * skills-manager）的声明文件都在 `src/` 下，本缺陷属潜在布局缺口而非语料现行
 * 缺陷。
 */

function locate(candidates: string[]): string {
  for (const candidate of candidates) {
    const path = fileURLToPath(new URL(candidate, import.meta.url))
    if (existsSync(path)) return path
  }
  assert.fail(`cannot locate payload file (tried ${candidates.join(', ')})`)
}

const ANALYZE = locate(['../../scripts/analyze-dsh-coupling.mjs'])
const VERIFY = locate(['../../scripts/verify-coupling.mjs'])

const VENDOR_DTS = [
  "declare module '@deepseek-ai/dsh-foo' {",
  '  export interface Widget { render(cfg: { theme: string }): void }',
  '}',
  '',
].join('\n')

const SRC = [
  "import type { Widget } from '@deepseek-ai/dsh-foo'",
  '',
  'export function mount(w: Widget): void {',
  "  w.render({ theme: 'dark' })",
  '}',
  '',
].join('\n')

function writeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ambient-types-'))
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: 'fixture-ambient-types', private: true, type: 'module',
    devDependencies: { '@deepseek-ai/dsh-foo': '^1.0.0' },
  }, null, 2)}\n`)
  const foo = join(root, 'node_modules', '@deepseek-ai', 'dsh-foo')
  mkdirSync(foo, { recursive: true })
  writeFileSync(join(foo, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh-foo', version: '1.0.0', types: './index.d.ts', main: './index.js' }, null, 2)}\n`)
  writeFileSync(join(foo, 'index.d.ts'), "export interface Other { ok: boolean }\n")
  writeFileSync(join(foo, 'index.js'), '')
  mkdirSync(join(root, 'types'), { recursive: true })
  writeFileSync(join(root, 'types', 'vendor.d.ts'), VENDOR_DTS)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), SRC)
  return root
}

test('a L2a declaration under types/ must join the probe program: no broken root type on a healthy upstream', () => {
  const root = writeFixture()
  try {
    for (const script of [ANALYZE, VERIFY]) {
      const result = spawnSync(process.execPath, script === ANALYZE ? [script, '--write'] : [script, 'coupling.json'], {
        encoding: 'utf8', timeout: 120_000, cwd: root, env: { ...process.env, DSH_SEAM_ROOT: root },
      })
      assert.equal(result.status, 0,
        `${script.endsWith('analyze-dsh-coupling.mjs') ? 'scan' : 'verify'} failed:\n${result.stdout}\n${result.stderr}`)
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /broken root type/,
        'Widget is exported via the ambient module declaration in types/ — the probe program must see it')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
