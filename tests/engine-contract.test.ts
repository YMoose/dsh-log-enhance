import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkContract, compareVersions, findRepositoryRoot, loadCoupling, probeSpecsFromCoupling, probeVersionLockstep } from './seam/engine.js'
import type { Coupling, PathRecord, SeamEnvironment } from './seam/engine.js'
import { standardSpecs } from './seam/standard-specs.js'
import { IMPLICIT_SEAMS } from './contracts/implicit-seams.js'

/**
 * 契约工件回归（2026-11-14）：一个独立的 coupling.json 就是自包含的消费者
 * 契约。三件事在这里钉住：
 *
 * 1. 引擎对上游包零硬编码——探针的 type import 由 rootType 机械推导 +
 *    suite 的 typeImports 补充；一个引擎从未见过的 rootType（本仓没有任何
 *    dsh-subagent fieldPaths 记录）也必须自动获得正确的 import。
 * 2. `scripts/verify-coupling.mjs` 拿真实 coupling.json 独立验货（exit 0），
 *    对改坏的 rootType 响亮失败（exit 1 且点名探针）。
 * 3. 版本锁的 range 模式与 single-line（默认）是两种可区分的策略：同一份
 *    区间夹具，range 绿、single-line 红。
 */

const ROOT = findRepositoryRoot('dsh-log-enhance')
const REAL = loadCoupling(ROOT)
const VERIFY_SCRIPT = fileURLToPath(new URL('../../scripts/verify-coupling.mjs', import.meta.url))
const UNVERIFIABLE = standardSpecs(REAL, IMPLICIT_SEAMS).unverifiable

/** 不可变 Coupling 上的"加一条 fieldPaths 记录"。 */
const withFieldPath = (coupling: Coupling, pkg: string, path: string, record: PathRecord): Coupling => ({
  ...coupling,
  fieldPaths: { ...coupling.fieldPaths, [pkg]: { ...(coupling.fieldPaths[pkg] ?? {}), [path]: record } },
})

test('a rootType the engine has never seen gets its probe import derived from coupling.json', () => {
  // SubagentActivationSpec is a real exported type of the installed
  // @deepseek-ai/dsh-subagent (lib/types/types.d.ts) and this repo has NO
  // fieldPaths entry for that package — the engine cannot hardcode it.
  const coupling = withFieldPath(REAL, '@deepseek-ai/dsh-subagent', 'provider', {
    rootType: 'SubagentActivationSpec',
    accesses: [{ site: 'src/index.ts:200', guards: [] }],
  })
  const specs = probeSpecsFromCoupling(coupling)
  const { outcome } = checkContract({
    root: ROOT,
    coupling,
    fieldSpecs: specs.fieldSpecs,
    discriminantSpecs: specs.discriminantSpecs,
    unverifiable: UNVERIFIABLE,
    implicitFragments: {},
    implicitSeams: [],
    implicitRuns: {},
  })
  const segment = outcome.segments.find(
    candidate => candidate.id === 'field:@deepseek-ai/dsh-subagent::provider@src/index.ts:200',
  )
  assert.ok(segment !== undefined, `the fixture surface must generate a probe; got: ${outcome.segments.map(s => s.id).join(', ')}`)
  assert.deepEqual(
    segment.problems,
    [],
    `the derived import must make the unseen rootType's probe compile:\n  ${segment.problems.join('\n  ')}`,
  )
  assert.deepEqual(outcome.unattributed, [], 'no scaffold diagnostics')
  assert.deepEqual(outcome.unprobed, [], 'the fixture surface must not be unprobed')
})

test('verify-coupling.mjs compiles the real coupling.json standalone (exit 0)', () => {
  const result = spawnSync(process.execPath, [VERIFY_SCRIPT, 'coupling.json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /probes compile clean/)
})

test('verify-coupling.mjs fails loudly and names the broken probe on a mutated rootType', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-coupling-'))
  try {
    const sessionPaths = { ...REAL.fieldPaths['@deepseek-ai/dsh-session']! }
    sessionPaths['data.turn'] = { ...sessionPaths['data.turn']!, rootType: 'SessionEventGone' }
    const mutated: Coupling = {
      ...REAL,
      fieldPaths: { ...REAL.fieldPaths, '@deepseek-ai/dsh-session': sessionPaths },
    }
    const file = join(dir, 'coupling.json')
    writeFileSync(file, JSON.stringify(mutated, null, 2))
    const result = spawnSync(process.execPath, [VERIFY_SCRIPT, file], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    })
    assert.equal(result.status, 1, `expected a loud failure, got: ${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /data\.turn/, 'the verdict must name the broken probe')
    assert.match(result.stdout, /SessionEventGone/, 'the verdict must name the bogus root type')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 版本锁夹具：区间 >=0.2.2-rc.1 <0.3.0-0，列车与 baseline 指纹在 rc.3。 */
function rangeFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lockstep-'))
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: 'range-fixture',
    version: '0.0.0',
    engines: { dsh: '>=0.2.2-rc.1 <0.3.0-0' },
    devDependencies: { '@deepseek-ai/dsh-session': '0.2.2-rc.3' },
  }, null, 2)}\n`)
  writeFileSync(join(dir, 'baseline.json'), `${JSON.stringify({
    generatedAt: '2026-11-14T00:00:00.000Z',
    packages: { 'dsh-session': { version: '0.2.2-rc.3' } },
  }, null, 2)}\n`)
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), '')
  return dir
}

const environmentAt = (dir: string, mode?: 'single-line' | 'range'): SeamEnvironment => ({
  root: dir,
  readText: relativePath => readFileSync(join(dir, relativePath), 'utf8'),
  unprobed: [],
  ...(mode === undefined ? {} : { versionLockstep: mode }),
})

test("range mode accepts a train inside the engines interval (floor may trail the train)", async () => {
  const dir = rangeFixtureDir()
  try {
    await probeVersionLockstep(undefined as unknown as TestContext, environmentAt(dir, 'range'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('single-line mode (the default) rejects the same fixture — the modes are distinct policies', async () => {
  const dir = rangeFixtureDir()
  try {
    await assert.rejects(
      probeVersionLockstep(undefined as unknown as TestContext, environmentAt(dir)),
      /floor and the devDependency train must agree/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * 复审修复回归（2026-11-14，docs/upgrade-detection-review.md R1/R2/R4）：
 * build-metadata 先序、lockstep 归一化、verify-coupling 豁免限定。
 * ------------------------------------------------------------------ */

/** 引擎与 bump-upstream.mjs 两份 compareVersions 必须一致的先序向量
 *  （bump 侧行为向量在 tests/bump-upstream.test.ts 钉住）。 */
const SEMVER_VECTORS: ReadonlyArray<readonly [string, string, number]> = [
  // R2: build metadata 解析后忽略——这三条在旧比较器上落 localeCompare 兜底，
  // 方向可错（'0.2.2-rc.4+build.1'.localeCompare('0.2.10') 实测为 1，真值为 -1）。
  ['0.2.2-rc.4+build.1', '0.2.10', -1],
  ['0.2.2-rc.4+build.1', '0.2.2-rc.4', 0],
  ['0.2.10', '0.2.9+build.1', 1],
  // 先序基线：core、预发布段、跨 minor、`-0` 墙。
  ['0.2.2-rc.1', '0.2.2-rc.3', -1],
  ['0.2.2-rc.3', '0.2.2', -1],
  ['0.2.9', '0.3.0-0', -1],
  ['0.3.0', '0.3.0-0', 1],
  ['0.2.2-rc.3+build.7', '0.2.2-rc.3', 0],
]

test('compareVersions orders by semver precedence, ignoring build metadata (R2)', () => {
  for (const [left, right, expected] of SEMVER_VECTORS) {
    const sign = Math.sign(compareVersions(left, right))
    assert.equal(
      sign,
      expected,
      `compareVersions('${left}', '${right}') must be ${expected < 0 ? '<' : expected > 0 ? '>' : '='} 0`,
    )
  }
})

/** 可参数化的版本锁夹具：package.json + baseline.json + 空 ci.yml。 */
function lockstepDir(options: {
  readonly engines: string
  readonly train: string
  readonly baselineTrain: string
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lockstep-'))
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: 'lockstep-fixture',
    version: '0.0.0',
    engines: { dsh: options.engines },
    devDependencies: { '@deepseek-ai/dsh-session': options.train },
  }, null, 2)}\n`)
  writeFileSync(join(dir, 'baseline.json'), `${JSON.stringify({
    generatedAt: '2026-11-14T00:00:00.000Z',
    packages: { 'dsh-session': { version: options.baselineTrain } },
  }, null, 2)}\n`)
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), '')
  return dir
}

test("single-line accepts the exact combo bump write mode produces for a +build target (R1)", async () => {
  // bump 写模式对 build-metadata target 的产物：devDeps 钉完整 target、
  // engines 下界剥掉后缀（semver range 不能携带 build metadata）、baseline
  // 指纹携带完整版本串。先序同版本，lockstep 必须接受。
  const dir = lockstepDir({ engines: '>=0.2.2-rc.4 <0.3.0-0', train: '0.2.2-rc.4+build.1', baselineTrain: '0.2.2-rc.4+build.1' })
  try {
    await probeVersionLockstep(undefined as unknown as TestContext, environmentAt(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('normalization must not weaken the invariant: a genuinely different train stays red in BOTH modes (R1)', async () => {
  // single-line vector (the review's example): rc.4 train over an rc.3 floor.
  const drift = lockstepDir({ engines: '>=0.2.2-rc.3 <0.3.0-0', train: '0.2.2-rc.4', baselineTrain: '0.2.2-rc.4' })
  // range vector: the train sits BELOW the floor (the R2 provenance pair —
  // the old comparator admitted this silently via localeCompare).
  const belowFloor = lockstepDir({ engines: '>=0.2.10 <0.3.0-0', train: '0.2.9+build.1', baselineTrain: '0.2.9+build.1' })
  try {
    await assert.rejects(
      probeVersionLockstep(undefined as unknown as TestContext, environmentAt(drift)),
      /floor and the devDependency train must agree/,
      'single-line: rc.4 train over an rc.3 floor is a real drift',
    )
    await assert.rejects(
      probeVersionLockstep(undefined as unknown as TestContext, environmentAt(belowFloor, 'range')),
      /must not sit below the engines.dsh floor/,
      'range: a below-floor train must be rejected even with build metadata',
    )
  } finally {
    rmSync(drift, { recursive: true, force: true })
    rmSync(belowFloor, { recursive: true, force: true })
  }
})

test("verify-coupling fails (not exempts) a TS18047 probe outside JsonValue surfaces (R4)", () => {
  // ModelSelectionProjectionState.lastUsed is `ModelSelection | null` (real,
  // exported by @deepseek-ai/dsh-agent); reading lastUsed.model yields a
  // TS18047-only diagnostic — an upstream making a field nullable must be a
  // FAILURE on the standalone path, not a silent exemption.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-coupling-'))
  try {
    const coupling = withFieldPath(REAL, '@deepseek-ai/dsh-agent', 'lastUsed.model', {
      rootType: 'ModelSelectionProjectionState',
      accesses: [{ site: 'src/observer.ts:200', guards: [] }],
    })
    const file = join(dir, 'coupling.json')
    writeFileSync(file, JSON.stringify(coupling, null, 2))
    const result = spawnSync(process.execPath, [VERIFY_SCRIPT, file], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 })
    assert.equal(result.status, 1, `a nullable upstream field must fail the standalone verify:\n${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /lastUsed\.model/, 'the verdict must name the nullable-read probe')
    assert.match(result.stdout, /TS18047/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verify-coupling names each exempted surface, not just a count (R4)', () => {
  const result = spawnSync(process.execPath, [VERIFY_SCRIPT, 'coupling.json'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /exempt: @deepseek-ai\/dsh-tools::value\.messageId\b/, 'JsonValue exemptions must be named')
  assert.match(result.stdout, /exempt: @deepseek-ai\/cordis::mcpManager\b/, 'ctx-service exemptions must be named')
})
