/**
 * verify-upstream.test.ts — `verify --upstream`（design.md 2.5 registry 层）的
 * 离线行为边界。
 *
 * 联网部分（npm pack 拉取、tag 解析、lockstep 校验、临时 types-root 装配）
 * 依赖真实 registry，不入机制测试（必须离线可跑、随 payload 同步到插件仓）；
 * 本文件覆盖三条在触网之前/之外就必须成立的行为：
 *   1. `--upstream` 与 `--types-root` 互斥（upstream 自己装配临时 types-root）；
 *   2. 仓库 coupling 里没有任何 @deepseek-ai/dsh-* 表面时显式报错退出，
 *      而不是带着空包集合去打 registry 或静默退化；
 *   3. manifest `dsh.client.inject` 模块的提取与 registry 存在性判定
 *      （design.md 2.8）——纯函数离线单测，npm view 的真实网络行为由真实
 *      语料仓实测覆盖（dsh-nce 形态）。
 *
 * 本文件同步到插件仓后自动跳过（cli.mjs 仅存在于 dsh-seam 仓库）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoCli = fileURLToPath(new URL('../../../cli.mjs', import.meta.url))
if (existsSync(repoCli)) {
  function runCli(args: string[], cwd?: string) {
    const result = spawnSync(process.execPath, [repoCli, ...args], { encoding: 'utf8', timeout: 60_000, cwd })
    return { status: result.status, out: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }
  }

  /** A repository with no @deepseek-ai coupling at all. */
  function writePlainRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'dsh-upstream-plain-'))
    writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'fx-plain', private: true, type: 'module' }, null, 2)}\n`)
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'index.ts'), 'export const nothing = 1\n')
    return root
  }

  test('verify --upstream rejects --types-root as mutually exclusive', () => {
    const root = writePlainRepo()
    try {
      const { status, out } = runCli(['verify', '--repo', root, '--types-root', root, '--upstream', '1.0.0'])
      assert.notEqual(status, 0, 'the combination must be rejected')
      assert.match(out, /--upstream.*--types-root|--types-root.*--upstream/, out)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('verify --upstream fails explicitly when the coupling pins no dsh-series packages', () => {
    const root = writePlainRepo()
    try {
      const { status, out } = runCli(['verify', '--repo', root, '--upstream', '1.0.0'])
      assert.notEqual(status, 0, 'a coupling without dsh-series packages must fail loudly')
      assert.match(out, /no @deepseek-ai\/dsh/, out)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // cli.mjs 挂了 ESM main guard 后可被 import：离线单测 --upstream 的版本决策。
  // 覆盖「包退出 lockstep」形态（真实语料：@deepseek-ai/dsh-client-runtime 停更于
  // 0.1.1-rc.2，而插件仓 coupling 引用它、其余包升 0.2.x——dsh-image-pathify 的
  // client.inject 声明，npm notarget 整体失败的实测）。
  test('pickUpstreamVersion falls back to the highest published version when the target is missing', async () => {
    const cli = await import(pathToFileURL(repoCli).href) as { pickUpstreamVersion?: (target: string, versions: readonly string[]) => { version: string; fellBack: boolean } | null }
    assert.equal(typeof cli.pickUpstreamVersion, 'function', 'cli.mjs must export pickUpstreamVersion (guarded main)')
    const exact = cli.pickUpstreamVersion!('0.2.2-rc.1', ['0.1.0-rc.6', '0.2.1-rc.5', '0.2.2-rc.1'])
    assert.deepEqual(exact, { version: '0.2.2-rc.1', fellBack: false })
    const fallback = cli.pickUpstreamVersion!('0.2.2-rc.1', ['0.1.0-rc.8', '0.1.1-rc.1', '0.1.1-rc.2'])
    assert.deepEqual(fallback, { version: '0.1.1-rc.2', fellBack: true }, 'prerelease numeric segments must rank (rc.2 > rc.1 > 0.1.0-rc.8)')
    // 回落不得超前于目标版本：评估「升到 0.2.x」时，一个已退出 lockstep 且
    // 又发布了 0.3.0 的包若被回退到 0.3.0，会把 0.3 的破坏混进 0.2 的评估。
    const noOvershoot = cli.pickUpstreamVersion!('0.2.2-rc.1', ['0.1.1-rc.2', '0.2.0-rc.1', '0.3.0'])
    assert.deepEqual(noOvershoot, { version: '0.2.0-rc.1', fellBack: true }, 'fallback must stay <= target')
    // 比目标还新的包（target 时代不存在）没有可回落形态 → null（整体失败）。
    assert.equal(cli.pickUpstreamVersion!('0.2.2-rc.1', ['0.3.0']), null, 'a package newer than the target cannot fall back')
    assert.equal(cli.pickUpstreamVersion!('0.2.2-rc.1', []), null, 'a package with no published versions cannot fall back')
    // build metadata（semver 规范：不参与优先级比较，但必须被解析接受）。
    // 历史缺陷：compareSemver 不认 +build → 目标不可解析 → 与所有候选比较得 0
    // → 全部视为 ≤ target → 选最大（实测 '0.2.2+build.1' + ['0.2.1','0.3.0']
    // → 0.3.0，超前）。回落上界必须对 +build 目标同样成立。
    const buildTarget = cli.pickUpstreamVersion!('0.2.2+build.1', ['0.2.1', '0.3.0'])
    assert.deepEqual(buildTarget, { version: '0.2.1', fellBack: true },
      'build metadata must not break the <= target ceiling (0.3.0 is still ahead of 0.2.2+build.1)')
    assert.deepEqual(cli.pickUpstreamVersion!('0.2.2+build.1', ['0.2.2', '0.3.0']),
      { version: '0.2.2', fellBack: true },
      'a version equal apart from build metadata satisfies the target')
    assert.deepEqual(cli.pickUpstreamVersion!('0.2.2', ['0.2.2+build.0']),
      { version: '0.2.2+build.0', fellBack: true },
      'build metadata does not raise a published version above the bare target')
    // 不可解析的目标整体失败：unparseable → 0 的比较语义在回落循环里会被曲解
    // 为「≤ target」，必须入口拦截，绝不参与回落。
    assert.equal(cli.pickUpstreamVersion!('latest', ['0.2.1']), null,
      'an unparseable target cannot fall back to anything')
  })

  // design.md 2.8：manifest 注入形态的 registry 存在性检查。client.inject 模块
  // 是纯 JS / manifest 注入仓唯一可见的耦合声明（源码无 import、类型契约不覆盖），
  // `verify --upstream` 对它们只做存在性检查（不 pack、无探针）——上游改名/下架
  // 在装配阶段显式报错。提取与判定逻辑为纯函数，离线单测。
  test('manifestInjectModulesOf extracts sorted unique client.inject declarations', async () => {
    const cli = await import(pathToFileURL(repoCli).href) as { manifestInjectModulesOf?: (root: string) => string[] }
    assert.equal(typeof cli.manifestInjectModulesOf, 'function', 'cli.mjs must export manifestInjectModulesOf (guarded main)')
    const root = mkdtempSync(join(tmpdir(), 'dsh-inject-'))
    try {
      writeFileSync(join(root, 'package.json'), `${JSON.stringify({
        name: 'fx-inject', private: true, type: 'module',
        dsh: { client: { inject: ['@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar', 42] } },
      })}\n`)
      assert.deepEqual(
        cli.manifestInjectModulesOf!(root),
        ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar'],
        'sorted, deduped, non-string entries dropped',
      )
      const plain = mkdtempSync(join(tmpdir(), 'dsh-inject-plain-'))
      try {
        writeFileSync(join(plain, 'package.json'), `${JSON.stringify({ name: 'fx-plain', private: true })}\n`)
        assert.deepEqual(cli.manifestInjectModulesOf!(plain), [], 'no dsh field -> no injected modules')
      } finally { rmSync(plain, { recursive: true, force: true }) }
      const bare = mkdtempSync(join(tmpdir(), 'dsh-inject-bare-'))
      try {
        assert.deepEqual(cli.manifestInjectModulesOf!(bare), [], 'no package.json at all -> empty, no throw')
      } finally { rmSync(bare, { recursive: true, force: true }) }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('verifyInjectModulesOnRegistry separates registry verdicts from environment failures', async () => {
    const cli = await import(pathToFileURL(repoCli).href) as {
      verifyInjectModulesOnRegistry?: (
        modules: Map<string, readonly string[]>,
        runView: (name: string) => { status: number | null; stdout?: string; stderr?: string; error?: unknown },
      ) => string | null
    }
    assert.equal(typeof cli.verifyInjectModulesOnRegistry, 'function', 'cli.mjs must export verifyInjectModulesOnRegistry (guarded main)')
    const modules = new Map([['@deepseek-ai/dsh-client-ui-layout', ['/repo/fixture-a']]])
    assert.equal(
      cli.verifyInjectModulesOnRegistry!(modules, () => ({ status: 0, stdout: '"2.3.0"', stderr: '' })),
      null,
      'a module the registry still serves passes the existence check',
    )
    const notFound = cli.verifyInjectModulesOnRegistry!(modules, () => ({ status: 1, stdout: '', stderr: 'npm error code E404' }))
    assert.ok(notFound !== null, 'a module missing from the registry must produce an explicit failure')
    assert.match(notFound, /dsh-client-ui-layout/, 'the failure names the module')
    assert.match(notFound, /fixture-a/, 'the failure names the declaring repo')
    assert.match(notFound, /rename|unpublish/i, 'the failure points at rename/unpublish as the likely cause')
    assert.match(notFound, /E404/, 'the failure keeps the underlying npm error for diagnosis')
    // 环境故障绝不冒充 registry 结论（design 原则 8 环境门 fail-fast）：spawn
    // 失败（Windows 无 shell 起 npm、PATH 摘除）与非 404 的 npm 非零退出都是
    // 「什么都没查成」，不是「registry 上没有」——误导用户改 manifest 比报错更糟。
    const spawnFailure = cli.verifyInjectModulesOnRegistry!(modules,
      () => ({ status: null, stdout: '', stderr: '', error: new Error('spawnSync npm ENOENT') }))
    assert.ok(spawnFailure !== null, 'a spawn failure must surface, never pass')
    assert.match(spawnFailure, /cannot run npm/i, 'the message states npm itself failed to run')
    assert.match(spawnFailure, /nothing was queried/i, 'the message states no registry conclusion was reached')
    assert.doesNotMatch(spawnFailure, /not found on the npm registry|update dsh\.client\.inject|rename|unpublish/i,
      'a spawn failure must not be phrased as a registry verdict')
    // shell:true 形态：npm 缺失由 shell 报告（POSIX exit 127 / Windows cmd 9009），
    // stderr 是 "npm: not found"——绝不能被大小写不敏感的 404 匹配误读成
    // 「registry 上不存在」（真实复验逮住：PATH 摘除时仍输出改名/下架话术）。
    const shellNotFound = cli.verifyInjectModulesOnRegistry!(modules,
      () => ({ status: 127, stdout: '', stderr: '/bin/sh: 1: npm: not found' }))
    assert.ok(shellNotFound !== null, 'a shell command-not-found must surface, never pass')
    assert.match(shellNotFound, /cannot run npm/i, 'command-not-found is an environment failure')
    assert.doesNotMatch(shellNotFound, /not found on the npm registry|update dsh\.client\.inject|rename|unpublish/i,
      '"npm: not found" must not be read as a registry 404')
    const networkFailure = cli.verifyInjectModulesOnRegistry!(modules,
      () => ({ status: 1, stdout: '', stderr: 'npm error code ETIMEDOUT' }))
    assert.ok(networkFailure !== null, 'a non-404 npm failure must surface, never pass')
    assert.match(networkFailure, /cannot query/i, 'the message says the registry could not be queried')
    assert.doesNotMatch(networkFailure, /update dsh\.client\.inject|rename|unpublish/i,
      'a network failure must not send the user editing their manifest')
  })
}
