import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * L2a ambient `.d.ts` 内诊断的 A0 处置（design.md 决策 19，诚实输出）：
 * 历史实现把落在 ambient 声明文件里的编译诊断静默丢弃（engine 侧
 * `ambientSet.has(diagFile) → continue`，连 unattributed 都不进）——上游
 * 改名致 L2a 声明断裂时 verify 输出逐字节无差异（假绿），与 L2b（源码内
 * declare module，断裂可见）不一致且无文档。
 *
 * A0 = 消灭静默：诊断在 verify 输出中列出（可见、透明），但不影响退出码
 * （不阻断）；是否升级 A1（阻断）等真实语料噪音数据再议。本测试锁定：
 * 1. L2a 断裂可见——输出点名 ambient 诊断及其所在文件；
 * 2. 不阻断——exit code 保持 0，探针 verdict 不受 ambient 诊断影响；
 * 3. 健康仓零噪音——ambient 声明完好时不出现 ambient 诊断行。
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

/**
 * L2a fixture：`ambient.d.ts`（根目录，两侧收集范围均覆盖）引用上游
 * `AgentHandle`；`src/index.ts` 显式 import 完好的 `Other`（L1 锚定，
 * 探针有活干且绿）。`upstreamExtra` 控制上游是否导出 `AgentHandle`：
 * 缺失 → ambient 内引用断裂（TS2305），且断裂只落在 ambient 文件里。
 */
function writeL2aRepo(upstreamExtra: string): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ambient-a0-'))
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: 'fixture-ambient-a0',
    private: true,
    type: 'module',
    devDependencies: { '@deepseek-ai/dsh-foo': '^2.0.0' },
  }, null, 2)}\n`)
  writePackage(join(root, 'node_modules', '@deepseek-ai', 'dsh-foo'), '@deepseek-ai/dsh-foo', '2.0.0',
    `export interface Other { ok: string }\n${upstreamExtra}`)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'),
    "import type { Other } from '@deepseek-ai/dsh-foo'\n"
    + 'export function render(value: Other): string { return value.ok }\n')
  writeFileSync(join(root, 'ambient.d.ts'),
    "import type { AgentHandle } from '@deepseek-ai/dsh-foo'\n"
    + "declare module 'fixture-ambient' {\n"
    + '  export interface Handle extends AgentHandle { extra: string }\n'
    + '}\n')
  return root
}

test('verify lists a broken ambient .d.ts reference instead of silently dropping it (A0)', () => {
  const root = writeL2aRepo('') // 上游不导出 AgentHandle → ambient 内断裂
  try {
    const scanned = spawnSync(process.execPath, [ANALYZE, '--write'], {
      encoding: 'utf8', timeout: 60_000, cwd: root, env: { ...process.env, DSH_SEAM_ROOT: root },
    })
    assert.equal(scanned.status, 0, `scanner failed:\n${scanned.stdout}\n${scanned.stderr}`)
    const verified = spawnSync(process.execPath, [VERIFY, 'coupling.json'], {
      encoding: 'utf8', timeout: 120_000, cwd: root, env: { ...process.env, DSH_SEAM_ROOT: root },
    })
    // A0 不阻断：ambient 断裂不改变退出码（升级为 A1 是另一个决策）。
    assert.equal(verified.status, 0, `ambient diagnostics are listed, not gating (decision 19 A0):\n${verified.stdout}\n${verified.stderr}`)
    const output = `${verified.stdout}\n${verified.stderr}`
    // 消灭静默：断裂必须可见——点名 ambient 诊断、可定位到声明文件与断裂符号。
    assert.match(output, /ambient/i, 'the output must name the ambient surface explicitly')
    assert.match(output, /diagnostic/i, 'the output must call them diagnostics')
    assert.match(output, /ambient\.d\.ts/, 'the listing must locate the ambient file')
    assert.match(output, /AgentHandle/, 'the listing must show the broken symbol')
    // 探针本身不受影响：L1 锚定面照常全绿。
    assert.match(output, /1\/1 probes compile clean/, 'probe verdict stays green regardless of ambient diagnostics')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('healthy ambient declarations stay silent (zero noise, control)', () => {
  const root = writeL2aRepo('export interface AgentHandle { id: string }\n')
  try {
    const scanned = spawnSync(process.execPath, [ANALYZE, '--write'], {
      encoding: 'utf8', timeout: 60_000, cwd: root, env: { ...process.env, DSH_SEAM_ROOT: root },
    })
    assert.equal(scanned.status, 0, `scanner failed:\n${scanned.stdout}\n${scanned.stderr}`)
    const verified = spawnSync(process.execPath, [VERIFY, 'coupling.json'], {
      encoding: 'utf8', timeout: 120_000, cwd: root, env: { ...process.env, DSH_SEAM_ROOT: root },
    })
    assert.equal(verified.status, 0, verified.stderr)
    const output = `${verified.stdout}\n${verified.stderr}`
    assert.match(output, /1\/1 probes compile clean/, 'control: the healthy fixture verifies green')
    assert.doesNotMatch(output, /ambient.*diagnostic|diagnostic.*ambient/i,
      'no ambient diagnostic lines without actual ambient breakage')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
