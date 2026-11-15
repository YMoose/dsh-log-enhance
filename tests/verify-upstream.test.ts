/**
 * verify-upstream.test.ts — `verify --upstream`（design.md 2.5 registry 层）的
 * 离线行为边界。
 *
 * 联网部分（npm pack 拉取、tag 解析、lockstep 校验、临时 types-root 装配）
 * 依赖真实 registry，不入机制测试（必须离线可跑、随 payload 同步到插件仓）；
 * 本文件覆盖两条在触网之前就必须成立的错误路径：
 *   1. `--upstream` 与 `--types-root` 互斥（upstream 自己装配临时 types-root）；
 *   2. 仓库 coupling 里没有任何 @deepseek-ai/dsh-* 表面时显式报错退出，
 *      而不是带着空包集合去打 registry 或静默退化。
 *
 * 本文件同步到插件仓后自动跳过（cli.mjs 仅存在于 dsh-seam 仓库）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    const cli = await import(repoCli) as { pickUpstreamVersion?: (target: string, versions: readonly string[]) => { version: string; fellBack: boolean } | null }
    assert.equal(typeof cli.pickUpstreamVersion, 'function', 'cli.mjs must export pickUpstreamVersion (guarded main)')
    const exact = cli.pickUpstreamVersion!('0.2.2-rc.1', ['0.1.0-rc.6', '0.2.1-rc.5', '0.2.2-rc.1'])
    assert.deepEqual(exact, { version: '0.2.2-rc.1', fellBack: false })
    const fallback = cli.pickUpstreamVersion!('0.2.2-rc.1', ['0.1.0-rc.8', '0.1.1-rc.1', '0.1.1-rc.2'])
    assert.deepEqual(fallback, { version: '0.1.1-rc.2', fellBack: true }, 'prerelease numeric segments must rank (rc.2 > rc.1 > 0.1.0-rc.8)')
    assert.equal(cli.pickUpstreamVersion!('0.2.2-rc.1', []), null, 'a package with no published versions cannot fall back')
  })
}
