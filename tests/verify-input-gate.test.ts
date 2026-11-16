import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * verify 的输入门（design.md 原则 8，批 3 G5）：契约文件「存在、可解析」
 * 的检查缺位——`JSON.parse(readFileSync(...))` 裸读，文件缺失或 JSON 损坏
 * 时以未捕获异常的调用栈天书崩溃，而非原则 8 要求的就地报错（点名哪个
 * 文件、什么问题、怎么办）；多目标场景下一个坏文件会炸掉整轮运行，
 * 好目标根本不跑——违反「按目标隔离失败、汇总退出」。
 *
 * 本测试锁定输入门三查的前两查（schema 查已有既有测试覆盖）：
 * 1. 不存在的路径 → exit 1 + 干净报错（无调用栈）；
 * 2. 损坏的 JSON → exit 1 + 干净报错；
 * 3. 多目标隔离：坏文件报错归档，好文件照常验证，汇总 exit 1。
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

/** 健康仓 fixture：mock 上游 + L1 显式 import，scan 后 verify 全绿。 */
function writeHealthyRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-input-gate-'))
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: 'fixture-input-gate',
    private: true,
    type: 'module',
    devDependencies: { '@deepseek-ai/dsh-foo': '^2.0.0' },
  }, null, 2)}\n`)
  writePackage(join(root, 'node_modules', '@deepseek-ai', 'dsh-foo'), '@deepseek-ai/dsh-foo', '2.0.0',
    'export interface AgentHandle { id: string }\n')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'),
    "import type { AgentHandle } from '@deepseek-ai/dsh-foo'\n"
    + 'export function render(handle: AgentHandle): string { return handle.id }\n')
  return root
}

function runVerify(root: string, targets: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [VERIFY, ...targets], {
    encoding: 'utf8', timeout: 120_000, cwd: root, env: { ...process.env, DSH_SEAM_ROOT: root },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('verify fails cleanly (no stack trace) on a missing coupling.json path', () => {
  const root = writeHealthyRepo()
  try {
    const verified = runVerify(root, ['missing-coupling.json'])
    assert.equal(verified.status, 1, 'a missing contract file must fail the input gate')
    assert.match(verified.stderr, /missing-coupling\.json/, 'the error must name the offending file')
    assert.match(verified.stderr, /not found|不存在/i, 'the error must say what is wrong')
    assert.doesNotMatch(verified.stderr, /\n\s+at\s/, 'an uncaught-exception stack trace is not a gate message (principle 8: report in place)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('verify fails cleanly on a coupling.json that is not valid JSON', () => {
  const root = writeHealthyRepo()
  try {
    writeFileSync(join(root, 'broken.json'), '{"packages": ')
    const verified = runVerify(root, ['broken.json'])
    assert.equal(verified.status, 1, 'an unparseable contract file must fail the input gate')
    assert.match(verified.stderr, /broken\.json/, 'the error must name the offending file')
    assert.match(verified.stderr, /JSON/i, 'the error must say what is wrong')
    assert.doesNotMatch(verified.stderr, /\n\s+at\s/, 'no stack traces in gate messages')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('input-gate failures are isolated per target: a bad file does not stop good ones', () => {
  const root = writeHealthyRepo()
  try {
    const scanned = spawnSync(process.execPath, [ANALYZE, '--write'], {
      encoding: 'utf8', timeout: 60_000, cwd: root, env: { ...process.env, DSH_SEAM_ROOT: root },
    })
    assert.equal(scanned.status, 0, `scanner failed:\n${scanned.stdout}\n${scanned.stderr}`)
    const verified = runVerify(root, ['missing-coupling.json', 'coupling.json'])
    assert.equal(verified.status, 1, 'the aggregate exit reflects the failed target')
    assert.match(verified.stderr, /missing-coupling\.json/, 'the bad target is reported')
    assert.match(verified.stdout, /1\/1 probes compile clean/, 'the good target still runs to completion (per-target isolation)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---- L5：verify 的 root 锚定 coupling.json 所属包（决策 15：目标单位=包根） ----

test('a missing coupling.json fails even when no @deepseek-ai packages are installed (input gate precedes the skip branch)', () => {
  // review 原始形态（G5）：依赖探测曾排在文件读取之前——「无依赖 + 契约
  // 路径写错」走 skip 分支 exit 0，CI 依赖未安装/路径笔误/schema 不受支持
  // 都可能被静默跳过。输入门必须先行。
  const root = mkdtempSync(join(tmpdir(), 'dsh-input-gate-bare-'))
  try {
    writeFileSync(join(root, 'package.json'), `${JSON.stringify({
      name: 'fixture-input-gate-bare', private: true, type: 'module',
    }, null, 2)}\n`)
    mkdirSync(join(root, 'src'), { recursive: true })
    const verified = runVerify(root, ['definitely-does-not-exist.json'])
    assert.equal(verified.status, 1,
      `the input gate must reject a missing contract before the no-dependencies skip:\n${verified.stdout}\n${verified.stderr}`)
    assert.match(verified.stderr, /definitely-does-not-exist\.json/)
    assert.doesNotMatch(verified.stdout, /skipped/, 'a missing file must never read as a clean skip')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('verify anchors each target to its own package root, not the process cwd (L5)', () => {
  const monorepo = mkdtempSync(join(tmpdir(), 'dsh-l5-mono-'))
  try {
    // workspaces 提升布局：上游装在仓根 node_modules；子包带 L1 锚定与一个
    // 断裂的 ambient 声明（上游不导出 AgentHandle）。
    writeFileSync(join(monorepo, 'package.json'), `${JSON.stringify({
      name: 'mono-root', private: true, workspaces: ['packages/*'],
    }, null, 2)}\n`)
    writePackage(join(monorepo, 'node_modules', '@deepseek-ai', 'dsh-foo'), '@deepseek-ai/dsh-foo', '2.0.0',
      'export interface Other { ok: string }\n')
    const pkg = join(monorepo, 'packages', 'foo')
    mkdirSync(join(pkg, 'src'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), `${JSON.stringify({
      name: '@scope/foo', version: '0.0.0', type: 'module',
      devDependencies: { '@deepseek-ai/dsh-foo': '^2.0.0' },
    }, null, 2)}\n`)
    writeFileSync(join(pkg, 'src', 'index.ts'),
      "import type { Other } from '@deepseek-ai/dsh-foo'\n"
      + 'export function render(value: Other): string { return value.ok }\n')
    writeFileSync(join(pkg, 'ambient.d.ts'),
      "import type { AgentHandle } from '@deepseek-ai/dsh-foo'\n"
      + "declare module 'fixture-l5' {\n"
      + '  export interface Handle extends AgentHandle { extra: string }\n'
      + '}\n')
    const scanned = spawnSync(process.execPath, [ANALYZE, '--write'], {
      encoding: 'utf8', timeout: 60_000, cwd: pkg, env: { ...process.env, DSH_SEAM_ROOT: pkg },
    })
    assert.equal(scanned.status, 0, `scanner failed:\n${scanned.stdout}\n${scanned.stderr}`)
    // 从仓根跑子包契约：cwd ≠ 包根。root 语义必须锚定 coupling.json 所属包
    // （决策 15），否则 ambient 收集范围错位到仓根（断裂不可见）且探针以
    // 错误的模块语义编译（TS1287 假红）。
    const verified = runVerify(monorepo, ['packages/foo/coupling.json'])
    assert.equal(verified.status, 0,
      `the exit code must not depend on the process cwd (L5 root anchoring):\n${verified.stdout}\n${verified.stderr}`)
    const output = `${verified.stdout}\n${verified.stderr}`
    assert.match(output, /1\/1 probes compile clean/, 'the probe verdict stays green from any cwd')
    assert.match(output, /ambient\.d\.ts/, 'ambient collection stays anchored to the package (A0 visibility survives cwd changes)')
    assert.match(output, /AgentHandle/, 'the ambient breakage is still listed')
    assert.doesNotMatch(output, /TS1287/, 'no module-semantics false red from a misanchored root')
  } finally {
    rmSync(monorepo, { recursive: true, force: true })
  }
})
