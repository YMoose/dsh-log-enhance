import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 判空守卫的忠实重放（AGENTS §3.1 / design 原则 8）。
 *
 * 历史缺陷（外部 review R1 家族，实测 rv-null fixture 4/9 探针假红）：源码里
 * 作者已做的空值处理没有被忠实继承到契约与探针回放——
 *   a `if (ctx.logger === null) return`  守卫白名单只认 undefined 系列 → 后续
 *     读取 pin=true（Exclude 假红 TS2322）+ 裸访问（TS18047）双报
 *   c `ctx.logger?.info()` / `!= null`    `?.` 与宽松不等被映射成 undefined 单态
 *     守卫 → 重放挡不住 null（TS18047）
 *   d `ctx.session!.id`                   `!` 只免 pin，断言本身没记 → 重放裸访问
 *   t `if (ctx.logger) …`                 真值守卫映射 undefined 单态 → 同 c
 *
 * 语义依据（TS 2.0 官方文档）：`===`/`!==` 只查指定的那个空值；`==`/`!=` 与
 * null 或 undefined 比较时两者都查。守卫 kind 因此三态化：
 * definedUndefined / definedNull / definedBoth，`?.` → definedBoth，`!` →
 * nonnull，真值 → truthy（重放 `if (!x) return`，精确 ToBoolean 语义）。
 *
 * 诚实性锚（防「修假红把真红也修没了」）：上游把字段加宽到守卫挡不住的空、
 * 或删除字段，verify 必须仍然红——探针颜色 ≡ 源码颜色，比源码宽 = 假绿（原则 8
 * 禁止），比源码严 = 假红（本测试要消灭的）。
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

function cordisDts(loggerType: string, sessionType: string): string {
  return [
    'export interface Logger { info(msg: string): void }',
    'export interface Session { id: string }',
    'export interface Context {',
    `  logger: ${loggerType}`,
    `  session: ${sessionType}`,
    '}',
    '',
  ].join('\n')
}

const SRC = [
  "import type { Context } from '@deepseek-ai/cordis'",
  '',
  'export function guardNull(ctx: Context): void {',
  '  if (ctx.logger === null) return',
  "  ctx.logger.info('x')",
  '}',
  '',
  'export function looseGuard(ctx: Context): void {',
  '  if (ctx.session != null) void ctx.session.id',
  '}',
  '',
  'export function optionalChain(ctx: Context): void {',
  "  ctx.logger?.info('x')",
  '}',
  '',
  'export function nonNullAssert(ctx: Context): void {',
  '  void ctx.session!.id',
  '}',
  '',
  'export function truthyGuard(ctx: Context): void {',
  "  if (ctx.logger) ctx.logger.info('x')",
  '}',
  '',
].join('\n')

function writeFixture(loggerType: string, sessionType: string, source: string = SRC): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-guard-null-'))
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: 'fixture-guard-null', private: true, type: 'module',
    devDependencies: { '@deepseek-ai/cordis': '^1.0.0' },
  }, null, 2)}\n`)
  const cordis = join(root, 'node_modules', '@deepseek-ai', 'cordis')
  mkdirSync(cordis, { recursive: true })
  writeFileSync(join(cordis, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/cordis', version: '1.0.0', types: './index.d.ts', main: './index.js' }, null, 2)}\n`)
  writeFileSync(join(cordis, 'index.d.ts'), cordisDts(loggerType, sessionType))
  writeFileSync(join(cordis, 'index.js'), '')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), source)
  return root
}

function run(script: string, root: string, args: readonly string[] = ['coupling.json']):
  { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', timeout: 120_000, cwd: root, env: { ...process.env, DSH_SEAM_ROOT: root },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const kindsOf = (root: string, path: string): readonly string[] => {
  const coupling = JSON.parse(readFileSync(join(root, 'coupling.json'), 'utf8')) as {
    fieldPaths: Record<string, Record<string, { accesses: Array<{ guards: Array<{ kind: string }> }> }>>
  }
  const entries = coupling.fieldPaths['@deepseek-ai/cordis']?.[path]?.accesses ?? []
  return entries.flatMap(access => access.guards.map(guard => guard.kind))
}

test('null-handling idioms replay faithfully: strict/loose null guards, optional chain, non-null assertion, truthiness all stay green', () => {
  const root = writeFixture('Logger | null', 'Session | null')
  try {
    const scanned = run(ANALYZE, root, ['--write'])
    assert.equal(scanned.status, 0, `scanner failed:\n${scanned.stdout}\n${scanned.stderr}`)

    // 契约记录精确的三态 kind（而非笼统的 defined / 无守卫）。
    assert.ok(kindsOf(root, 'logger.info').includes('definedNull'),
      '`=== null` guard must be recorded as definedNull (was: unrecognized → pin bare read)')
    assert.ok(kindsOf(root, 'logger.info').includes('definedBoth'),
      '`?.` chain must be recorded as definedBoth (loose semantics: skips both null and undefined)')
    assert.ok(kindsOf(root, 'logger.info').includes('truthy'),
      'truthiness guard must be recorded as truthy (ToBoolean excludes all falsy)')
    assert.ok(kindsOf(root, 'session.id').includes('definedBoth'),
      '`!= null` guard must be recorded as definedBoth (loose equality checks both)')
    assert.ok(kindsOf(root, 'session.id').includes('nonnull'),
      'the `!` assertion must be recorded as a nonnull guard (author asserted non-null)')

    // 回归锚：健康上游必须全绿（历史缺陷：上列五形态 4/9 探针假红）。
    const verified = run(VERIFY, root)
    assert.equal(verified.status, 0,
      `healthy upstream must verify green (faithful replay):\n${verified.stdout}\n${verified.stderr}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('honesty anchor: widening past a definedNull guard (adding undefined) must fail verify', () => {
  const root = writeFixture('Logger | null', 'Session | null')
  try {
    assert.equal(run(ANALYZE, root, ['--write']).status, 0)
    assert.equal(run(VERIFY, root).status, 0, 'baseline must be green first')
    // 上游把 logger 加宽到 Logger | null | undefined：`=== null` 守卫挡不住
    // undefined，源码本身也已编译不过（TS18047/TS2322）——探针必须同样红。
    writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'cordis', 'index.d.ts'),
      cordisDts('Logger | null | undefined', 'Session | null'))
    const widened = run(VERIFY, root)
    assert.notEqual(widened.status, 0,
      'widening beyond the recorded guard is real drift; verify must stay red (no false green)')
    assert.match(`${widened.stdout}${widened.stderr}`, /logger/, 'the failure names the widened surface')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('honesty anchor: deleting the guarded field must fail verify', () => {
  const root = writeFixture('Logger | null', 'Session | null')
  try {
    assert.equal(run(ANALYZE, root, ['--write']).status, 0)
    writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'cordis', 'index.d.ts'), [
      'export interface Logger { info(msg: string): void }',
      'export interface Session { id: string }',
      'export interface Context {',
      '  logger: Logger | null',
      '}',
      '',
    ].join('\n'))
    const deleted = run(VERIFY, root)
    assert.notEqual(deleted.status, 0, 'field deletion must fail verify (TS2339)')
    assert.match(`${deleted.stdout}${deleted.stderr}`, /session/, 'the failure names the deleted surface')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('tradeoff-1 lock: a strict undefined guard is replayed strictly (never loosened to both)', () => {
  // 取舍①的锁定测试：源码写 `!== undefined`、上游 T | undefined 时源码绿、
  // 探针绿；上游加宽到 T | null | undefined 后源码本身红（守卫不够），探针
  // 必须跟着红——忠实重放不替源码「补严」也不「放宽」。
  const source = [
    "import type { Context } from '@deepseek-ai/cordis'",
    '',
    'export function strictUndefined(ctx: Context): void {',
    '  if (ctx.logger !== undefined) ctx.logger.info("x")',
    '}',
    '',
  ].join('\n')
  const root = writeFixture('Logger | undefined', 'Session | null', source)
  try {
    assert.equal(run(ANALYZE, root, ['--write']).status, 0)
    const baseline = run(VERIFY, root)
    assert.equal(baseline.status, 0, `baseline must be green:\n${baseline.stdout}\n${baseline.stderr}`)
    assert.ok(kindsOf(root, 'logger.info').includes('definedUndefined'),
      'strict `!== undefined` must be recorded as definedUndefined (exact strength)')

    writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'cordis', 'index.d.ts'),
      cordisDts('Logger | null | undefined', 'Session | null'))
    const widened = run(VERIFY, root)
    assert.notEqual(widened.status, 0,
      'the source itself no longer compiles after widening; faithful replay must be red too — '
      + 'loosening definedUndefined to definedBoth here would be a false green')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
