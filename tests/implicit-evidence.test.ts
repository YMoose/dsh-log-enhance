import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 隐含依赖证据的空值不是证据（批 3 G6，原则 8「静默的零结果不是成功」）：
 * `implicitFragments[id] = []` 曾为 seam 占坑一个零检查的类型探针 segment、
 * `implicitDelegations[id] = []` 曾因 `!== undefined` 判定通过完整性检查、
 * delegation 条目 `tests: []` 曾让覆盖测试循环零迭代——三种形态都让
 * 「已登记的隐含依赖」在没有任何真实探针或测试的情况下全绿（外部 review
 * 实测的空证据假绿）。本测试锁定：空证据必须落入「无证据」红。
 */

function locate(candidates: string[]): string {
  for (const candidate of candidates) {
    const path = fileURLToPath(new URL(candidate, import.meta.url))
    if (existsSync(path)) return path
  }
  assert.fail(`cannot locate compiled engine (tried ${candidates.join(', ')})`)
}

const ENGINE = locate(['../seam/engine.js', './seam/engine.js'])

/** 在独立进程里跑 runSeamSuite（node:test 顶层注册，失败 → exit 1）。
 *  必须剔除 NODE_TEST_CONTEXT：npm test 父进程设置了它，子进程继承后
 *  node:test 会切到二进制诊断流，输出不再可读、无法断言消息文本。 */
function runSuiteProcess(caseName: string): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-implicit-evidence-'))
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(join(root, 'tests', 'cover.test.ts'), "test('covering', () => {})\n")
  const runner = join(root, 'runner.mjs')
  const evidence = {
    emptyFragments: {
      implicitFragments: `{ 'seam-x': [] }`,
      implicitDelegations: `{}`,
    },
    emptyDelegations: {
      implicitFragments: `{}`,
      implicitDelegations: `{ 'seam-x': [] }`,
    },
    emptyTestTitles: {
      implicitFragments: `{}`,
      implicitDelegations: `{ 'seam-x': [{ file: 'tests/cover.test.ts', tests: [] }] }`,
    },
  }[caseName]
  assert.ok(evidence !== undefined, `unknown case ${caseName}`)
  writeFileSync(runner, `import { runSeamSuite } from ${JSON.stringify(pathToFileURL(ENGINE).href)}
runSeamSuite({
  root: ${JSON.stringify(root)},
  coupling: { packages: {}, injectedServices: [], srcHooks: [], testHooks: [], ctxAccesses: {}, fieldPaths: {}, discriminants: {} },
  fieldSpecs: {}, discriminantSpecs: {}, unverifiable: {},
  implicitFragments: ${evidence.implicitFragments},
  implicitSeams: [{ id: 'seam-x', description: 'fixture', probe: 'probe-x', usedAt: 'src/x.ts:1', auditSection: 'audit', acknowledged: [] }],
  implicitRuns: {},
  implicitDelegations: ${evidence.implicitDelegations},
})
`)
  const { NODE_TEST_CONTEXT: _ignored, ...spawnEnv } = process.env
  void _ignored
  const result = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 120_000, env: spawnEnv })
  const output = `${result.stdout}\n${result.stderr}`
  return { status: result.status, output }
}

test('an empty implicitFragments list is not evidence (G6)', () => {
  const { status, output } = runSuiteProcess('emptyFragments')
  assert.notEqual(status, 0,
    `implicitFragments['seam-x'] = [] must fail as no evidence — an empty list used to claim a zero-check probe segment:\n${output}`)
  assert.match(output, /no probe, type fragment, or covering-test/i)
})

test('an empty implicitDelegations list is not evidence (G6)', () => {
  const { status, output } = runSuiteProcess('emptyDelegations')
  assert.notEqual(status, 0,
    `implicitDelegations['seam-x'] = [] must fail as no evidence — [] !== undefined used to pass the completeness check:\n${output}`)
  assert.match(output, /no probe, type fragment, or covering-test/i)
})

test('a delegation entry without test titles is not evidence (G6)', () => {
  const { status, output } = runSuiteProcess('emptyTestTitles')
  assert.notEqual(status, 0,
    `delegation { file, tests: [] } must fail — the covering-test loop used to iterate zero times and pass:\n${output}`)
  assert.match(output, /no test titles|at least one covering test/i)
})
