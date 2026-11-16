import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 事件载荷（`event:<name>` 字段面）的 pin 保真（AGENTS §3.1 / design 原则 8
 * 构成门）：无类型注解的 hook 回调参数，其字段读取记录在 `event:<事件>` 下，
 * 无守卫直读记 `pin: true`——探针必须为它生成 `Exclude<..., null | undefined>`
 * 非空检查。历史缺陷：engine 的无守卫快捷分支只生成 `void payload.x`，条件
 * 不看 `spec.pin`，绕过 probeBodyLines 的 Exclude 行——契约里 pin=true、上游
 * 把非空字段改成可空后 verify 仍全绿 exit 0（实测：string → string | undefined
 * 后 3/3 compile clean）。
 *
 * fixture 形态（语料实证的最小复刻）：fake cordis（最小 Events + Context）+
 * fake dsh-foo 以 `declare module` 向 Events 合并事件签名 + 源码 `ctx.on`
 * 无注解 payload 直读字段——payload 类型由 Events 推导，字段面归 `event:`。
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

const CORDIS_DTS = [
  'export interface Events {}',
  'export interface Context {',
  '  on<K extends keyof Events>(event: K, listener: Events[K]): void',
  '}',
  '',
].join('\n')

function dshFooDts(valueType: string): string {
  return [
    "declare module '@deepseek-ai/cordis' {",
    "  interface Events { 'session/update': (payload: SessionEvent) => void }",
    '}',
    `export interface SessionEvent { value: ${valueType} }`,
    '',
  ].join('\n')
}

const SRC = [
  "import type { Context } from '@deepseek-ai/cordis'",
  "import type {} from '@deepseek-ai/dsh-foo'",
  '',
  'export function register(ctx: Context): void {',
  "  ctx.on('session/update', payload => { void payload.value })",
  '}',
  '',
].join('\n')

function writePackage(dir: string, name: string, dts: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, version: '1.0.0', types: './index.d.ts', main: './index.js' }, null, 2)}\n`)
  writeFileSync(join(dir, 'index.d.ts'), dts)
  writeFileSync(join(dir, 'index.js'), '')
}

/** 事件载荷 pin 形态的最小仓。valueType 参数化上游载荷字段类型。 */
function writeFixture(valueType: string): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-payload-pin-'))
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: 'fixture-payload-pin', private: true, type: 'module',
    devDependencies: { '@deepseek-ai/cordis': '^1.0.0', '@deepseek-ai/dsh-foo': '^1.0.0' },
  }, null, 2)}\n`)
  writePackage(join(root, 'node_modules', '@deepseek-ai', 'cordis'), '@deepseek-ai/cordis', CORDIS_DTS)
  writePackage(join(root, 'node_modules', '@deepseek-ai', 'dsh-foo'), '@deepseek-ai/dsh-foo', dshFooDts(valueType))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), SRC)
  return root
}

test('event payload pin survives probe generation: nullable widening must fail verify', () => {
  const root = writeFixture('string')
  try {
    const scanned = spawnSync(process.execPath, [ANALYZE, '--write'], {
      encoding: 'utf8', timeout: 60_000, cwd: root, env: { ...process.env, DSH_SEAM_ROOT: root },
    })
    assert.equal(scanned.status, 0, `scanner failed:\n${scanned.stdout}\n${scanned.stderr}`)
    const coupling = JSON.parse(readFileSync(join(root, 'coupling.json'), 'utf8')) as {
      fieldPaths: Record<string, Record<string, { accesses: Array<{ pin?: boolean }> }>>
    }
    const eventEntry = Object.entries(coupling.fieldPaths).find(([key]) => key.startsWith('event:'))
    assert.ok(eventEntry !== undefined, 'the unannotated payload read must be recorded under event:')
    assert.equal(eventEntry[0], 'event:session/update')
    assert.equal(eventEntry[1].value?.accesses?.[0]?.pin, true,
      'an unguarded payload field read is pinned in the contract')

    // 基准：上游字段非空时全绿。
    const baseline = spawnSync(process.execPath, [VERIFY, 'coupling.json'], {
      encoding: 'utf8', timeout: 120_000, cwd: root, env: { ...process.env, DSH_SEAM_ROOT: root },
    })
    assert.equal(baseline.status, 0, `baseline must be green:\n${baseline.stdout}\n${baseline.stderr}`)

    // 上游把非空字段改成可空：契约 pin=true，verify 必须红（Exclude 检查生效）。
    writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-foo', 'index.d.ts'), dshFooDts('string | undefined'))
    const widened = spawnSync(process.execPath, [VERIFY, 'coupling.json'], {
      encoding: 'utf8', timeout: 120_000, cwd: root, env: { ...process.env, DSH_SEAM_ROOT: root },
    })
    assert.notEqual(widened.status, 0,
      'nullable widening on a pinned event payload field MUST fail verify (probe must keep the Exclude check)')
    assert.match(`${widened.stdout}\n${widened.stderr}`, /event:session\/update/, 'the failure names the event payload surface')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
