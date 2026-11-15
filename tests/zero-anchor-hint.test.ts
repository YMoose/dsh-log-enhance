import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 零类型锚定面的显式提示（design.md 2.7，诚实输出）：
 * 当仓库声明了 @deepseek-ai 依赖、但源码（纯 JS / manifest 注入形态）没有
 * 任何显式 import 或类型注解时，verify 生成不了任何类型探针，verdict 行
 * 输出 `0/0 probes compile clean`——它会被读者（连插件作者本人）误读成
 * “类型契约检查通过 ✅”，而实际含义是“类型契约不适用于这个仓”。
 *
 * 该形态在语料中真实存在（dsh-media-desk：devDeps 声明 1 个 dsh 包、
 * 源码纯 JS、探测输出 0/0）。本测试锁定：verdict 行必须携带不可误读的
 * 显式提示；正常类型锚定的仓不出现该提示。
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

function writePackage(dir: string, name: string, version: string, dts: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, version, types: './index.d.ts', main: './index.js' }, null, 2)}\n`)
  writeFileSync(join(dir, 'index.d.ts'), dts)
  writeFileSync(join(dir, 'index.js'), '')
}

/** 纯 JS 仓：devDependencies 声明 dsh-foo 并安装（nodeModulesBase 命中），
 *  源码零 import、零类型注解——manifest/纯 JS 注入形态的最小复刻。 */
function writePureJsRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-zeroanchor-'))
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: 'fixture-zero-anchor',
    private: true,
    type: 'module',
    devDependencies: { '@deepseek-ai/dsh-foo': '^2.0.0' },
  }, null, 2)}\n`)
  writePackage(join(root, 'node_modules', '@deepseek-ai', 'dsh-foo'), '@deepseek-ai/dsh-foo', '2.0.0',
    'export interface AgentHandle { id: string }\n')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.js'), 'export function render() { return 1 }\n')
  return root
}

test('verify names the empty type-anchor surface explicitly instead of a bare 0/0', () => {
  const root = writePureJsRepo()
  try {
    const scanned = spawnSync(process.execPath, [ANALYZE, '--write'], {
      encoding: 'utf8', timeout: 60_000, cwd: root, env: { ...process.env, DSH_SEAM_ROOT: root },
    })
    assert.equal(scanned.status, 0, `scanner failed:\n${scanned.stdout}\n${scanned.stderr}`)
    const verified = spawnSync(process.execPath, [VERIFY, 'coupling.json'], {
      encoding: 'utf8', timeout: 120_000, cwd: root, env: { ...process.env, DSH_SEAM_ROOT: root },
    })
    assert.equal(verified.status, 0, `a zero-anchor repo must stay green (advisory hint, not a failure):\n${verified.stdout}\n${verified.stderr}`)
    const output = `${verified.stdout}\n${verified.stderr}`
    assert.match(output, /0\/0 probes compile clean/, 'the verdict line keeps its familiar shape')
    assert.match(output, /no type-anchored surfaces/i, 'the hint names the empty anchor surface')
    assert.match(output, /does not apply/i, 'the hint states the type contract does not apply here')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('repos with real type anchors never show the zero-anchor hint', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-anchored-'))
  try {
    writePackage(join(root, 'node_modules', '@deepseek-ai', 'dsh-foo'), '@deepseek-ai/dsh-foo', '2.0.0',
      'export interface AgentHandle { id: string }\n')
    writeFileSync(join(root, 'package.json'), `${JSON.stringify({
      name: 'fixture-anchored',
      private: true,
      type: 'module',
      devDependencies: { '@deepseek-ai/dsh-foo': '^2.0.0' },
    }, null, 2)}\n`)
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'index.ts'),
      "import type { AgentHandle } from '@deepseek-ai/dsh-foo'\n"
      + 'export function render(handle: AgentHandle): string { return handle.id }\n')
    const scanned = spawnSync(process.execPath, [ANALYZE, '--write'], {
      encoding: 'utf8', timeout: 60_000, cwd: root, env: { ...process.env, DSH_SEAM_ROOT: root },
    })
    assert.equal(scanned.status, 0, scanned.stderr)
    const verified = spawnSync(process.execPath, [VERIFY, 'coupling.json'], {
      encoding: 'utf8', timeout: 120_000, cwd: root, env: { ...process.env, DSH_SEAM_ROOT: root },
    })
    assert.equal(verified.status, 0, verified.stdout)
    const output = `${verified.stdout}\n${verified.stderr}`
    assert.match(output, /1\/1 probes compile clean/, 'control: the anchored fixture verifies green')
    assert.doesNotMatch(output, /no type-anchored surfaces/i, 'the hint must not appear on anchored repos')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
