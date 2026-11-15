/**
 * cli-manifest.test.ts — `.dsh-seam.json` 可移植化与 check/outdated 拆分
 * （design.md Phase 2.0 / 决策 7）。
 *
 * 覆盖三组行为：
 *   1. sync 写入可移植清单：`source.repo` + `source.ref` + 文件哈希，
 *      无本机绝对路径；ref 无法解析时显式报错（绝不写入 unknown）。
 *   2. check 纯离线门禁：只做受管文件哈希比对，不依赖 dsh-seam 源仓存在；
 *      legacy 清单（source.path / source.commit）兼容放行并提示重新 sync。
 *   3. outdated 联网版本提醒：`git ls-remote` 读上游 HEAD 与最新 semver tag
 *      （决策 16：tag 先解析成具体版本号再比较，非 semver tag 不参与），
 *      网络不可达只提示跳过、永不阻断退出。
 *
 * 本文件同步到插件仓后自动跳过（cli.mjs 仅存在于 dsh-seam 仓库）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoCli = fileURLToPath(new URL('../../../cli.mjs', import.meta.url))
const repoPayload = fileURLToPath(new URL('../../../payload', import.meta.url))

function runCli(cli: string, args: string[], cwd?: string) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000, cwd })
  return { status: result.status, out: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }
}

function git(dir: string, args: string[]) {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${String(result.stderr)}`)
  return result.stdout.trim()
}

/** 构造一个可完全控制的 dsh-seam 源仓：cli.mjs + payload/ + package.json，
 *  含一次提交与指定的 origin；originUrl 缺省时指向自建的本地 bare 仓（全程离线）。 */
function buildSourceRepo(originUrl?: string): { source: string; bare: string } {
  const source = mkdtempSync(join(tmpdir(), 'dsh-src-'))
  const bare = mkdtempSync(join(tmpdir(), 'dsh-bare-'))
  copyFileSync(repoCli, join(source, 'cli.mjs'))
  cpSync(repoPayload, join(source, 'payload'), { recursive: true })
  writeFileSync(join(source, 'package.json'), `${JSON.stringify({
    name: 'dsh-seam',
    version: '0.0.0',
    type: 'module',
    repository: 'example/dsh-seam-fixture',
  }, null, 2)}\n`)
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
  git(source, ['init', '-q', '-b', 'main'])
  git(source, ['config', 'user.email', 't@example.com'])
  git(source, ['config', 'user.name', 't'])
  git(source, ['add', '-A'])
  git(source, ['commit', '-q', '-m', 'init'])
  git(source, ['remote', 'add', 'origin', originUrl ?? bare])
  return { source, bare }
}

/** 只带 cli.mjs 的目录：模拟另一台机器上的 npx 入口（无 payload、无 git、无源仓）。 */
function cliOnlyCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-only-'))
  copyFileSync(repoCli, join(dir, 'cli.mjs'))
  return dir
}

test('sync writes a portable manifest (repo + ref, no absolute path) and check runs fully offline', () => {
  if (!existsSync(repoCli) || !existsSync(repoPayload)) return
  const ORIGIN = 'https://github.com/example/dsh-seam-fixture.git'
  const { source, bare } = buildSourceRepo(ORIGIN)
  const consumer = mkdtempSync(join(tmpdir(), 'dsh-consumer-'))
  const cliOnly = cliOnlyCopy()
  const cli = join(cliOnly, 'cli.mjs')
  try {
    const synced = runCli(repoCli, ['sync', '--into', consumer, '--source', source], source)
    assert.equal(synced.status, 0, synced.out)
    assert.match(synced.out, /pinned to example\/dsh-seam-fixture@[0-9a-f]{7,40}/)

    const manifestPath = join(consumer, '.dsh-seam.json')
    const text = readFileSync(manifestPath, 'utf8')
    const manifest = JSON.parse(text) as { source?: Record<string, unknown>; files: Record<string, string> }
    // 可移植：https origin 归一化（去 .git），ref 为 40 位提交，绝无本机绝对路径
    assert.equal(manifest.source?.repo, 'https://github.com/example/dsh-seam-fixture')
    assert.match(String(manifest.source?.ref), /^[0-9a-f]{40}$/)
    assert.equal(manifest.source?.path, undefined)
    assert.ok(!text.includes(source), 'manifest must not embed the source checkout path')
    assert.ok(!text.includes(tmpdir()), 'manifest must not embed any absolute temp path')

    // 离线 check：cli 副本所在机器没有 dsh-seam 源仓，命令不找源仓、不联网
    const green = runCli(cli, ['check'], consumer)
    assert.equal(green.status, 0, green.out)
    assert.match(green.out, /managed file\(s\) match/)
    assert.match(green.out, /pinned to example\/dsh-seam-fixture@[0-9a-f]{7,40}/)

    // 漂移与缺失仍判红（纯本地判定）
    const somePath = join(consumer, 'scripts/verify-coupling.mjs')
    const original = readFileSync(somePath, 'utf8')
    writeFileSync(somePath, `${original}\n// drift\n`)
    const drifted = runCli(cli, ['check'], consumer)
    assert.equal(drifted.status, 1)
    assert.match(drifted.out, /drift/)
    writeFileSync(somePath, original)
    rmSync(somePath)
    const missing = runCli(cli, ['check'], consumer)
    assert.equal(missing.status, 1)
    assert.match(missing.out, /missing managed file/)
  } finally {
    for (const dir of [source, consumer, cliOnly, bare]) rmSync(dir, { recursive: true, force: true })
  }
})

test('check accepts a legacy manifest (source.path/source.commit) with a re-sync notice', () => {
  if (!existsSync(repoCli) || !existsSync(repoPayload)) return
  const { source, bare } = buildSourceRepo('https://github.com/example/dsh-seam-fixture.git')
  const consumer = mkdtempSync(join(tmpdir(), 'dsh-consumer-'))
  const cliOnly = cliOnlyCopy()
  try {
    assert.equal(runCli(repoCli, ['sync', '--into', consumer, '--source', source], source).status, 0)
    const manifestPath = join(consumer, '.dsh-seam.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      source: Record<string, unknown>
      files: Record<string, string>
    }
    // 旧字段结构：本机绝对路径 + commit（迁移期真实存在的形态）
    manifest.source = {
      path: '/nonexistent-machine-path/dsh-seam',
      commit: String(manifest.source.ref),
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const checked = runCli(join(cliOnly, 'cli.mjs'), ['check'], consumer)
    assert.equal(checked.status, 0, checked.out)
    assert.match(checked.out, /managed file\(s\) match/)
    assert.match(checked.out, /legacy/)
    assert.match(checked.out, /dsh-seam sync/)
  } finally {
    for (const dir of [source, consumer, cliOnly, bare]) rmSync(dir, { recursive: true, force: true })
  }
})

test('sync refuses loudly when no commit can be resolved (never writes unknown)', () => {
  if (!existsSync(repoCli) || !existsSync(repoPayload)) return
  const source = mkdtempSync(join(tmpdir(), 'dsh-src-nogit-'))
  const consumer = mkdtempSync(join(tmpdir(), 'dsh-consumer-'))
  try {
    // 无 .git、package.json 无 gitHead/_resolved：必须显式报错而不是记录 unknown
    copyFileSync(repoCli, join(source, 'cli.mjs'))
    cpSync(repoPayload, join(source, 'payload'), { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'dsh-seam', version: '0.0.0', type: 'module' }))
    const failed = runCli(repoCli, ['sync', '--into', consumer, '--source', source], source)
    assert.equal(failed.status, 1, 'sync must fail when the source commit cannot be resolved')
    assert.match(failed.out, /commit|ref/i)
    assert.equal(existsSync(join(consumer, '.dsh-seam.json')), false, 'no manifest may be written on failure')
  } finally {
    for (const dir of [source, consumer]) rmSync(dir, { recursive: true, force: true })
  }
})

test('sync reports how far the previous manifest lagged behind HEAD', () => {
  if (!existsSync(repoCli) || !existsSync(repoPayload)) return
  const { source, bare } = buildSourceRepo('https://github.com/example/dsh-seam-fixture.git')
  const consumer = mkdtempSync(join(tmpdir(), 'dsh-consumer-'))
  try {
    assert.equal(runCli(repoCli, ['sync', '--into', consumer, '--source', source], source).status, 0)
    for (const message of ['second', 'third']) {
      writeFileSync(join(source, 'payload/.marker'), message)
      git(source, ['add', '-A'])
      git(source, ['commit', '-q', '-m', message])
    }
    const resynced = runCli(repoCli, ['sync', '--into', consumer, '--source', source], source)
    assert.equal(resynced.status, 0, resynced.out)
    assert.match(resynced.out, /behind|updated/i)
    const manifest = JSON.parse(readFileSync(join(consumer, '.dsh-seam.json'), 'utf8')) as { source: { ref: string } }
    assert.equal(manifest.source.ref, git(source, ['rev-parse', 'HEAD']))
  } finally {
    for (const dir of [source, consumer, bare]) rmSync(dir, { recursive: true, force: true })
  }
})

test('outdated reports upstream state via ls-remote and never blocks (decision 7/16)', () => {
  if (!existsSync(repoCli) || !existsSync(repoPayload)) return
  const { source, bare } = buildSourceRepo() // origin 指向本地 bare 仓，全程离线
  const consumer = mkdtempSync(join(tmpdir(), 'dsh-consumer-'))
  const cliOnly = cliOnlyCopy()
  try {
    git(source, ['push', '-q', 'origin', 'HEAD:refs/heads/main'])
    git(source, ['tag', 'v0.1.0'])
    git(source, ['push', '-q', 'origin', 'v0.1.0'])
    assert.equal(runCli(repoCli, ['sync', '--into', consumer, '--source', source], source).status, 0)

    const cli = join(cliOnly, 'cli.mjs')
    // pinned == 上游 HEAD == 最新 tag：报 up to date
    const fresh = runCli(cli, ['outdated'], consumer)
    assert.equal(fresh.status, 0, fresh.out)
    assert.match(fresh.out, /up to date/i)
    assert.match(fresh.out, /v0\.1\.0/)

    // 上游前进两个版本 + 一个非 semver tag：报落后与最新 tag（semver 判定，snapshot 不参与）
    writeFileSync(join(source, 'payload/.marker'), 'bump')
    git(source, ['add', '-A'])
    git(source, ['commit', '-q', '-m', 'bump'])
    git(source, ['tag', 'v0.2.0'])
    git(source, ['push', '-q', 'origin', 'HEAD:refs/heads/main', 'v0.2.0'])
    writeFileSync(join(source, 'payload/.marker'), 'bump2')
    git(source, ['add', '-A'])
    git(source, ['commit', '-q', '-m', 'bump2'])
    git(source, ['tag', 'v0.3.0'])
    git(source, ['tag', 'snapshot'])
    git(source, ['push', '-q', 'origin', 'HEAD:refs/heads/main', 'v0.3.0', 'snapshot'])
    const stale = runCli(cli, ['outdated'], consumer)
    assert.equal(stale.status, 0, stale.out)
    assert.match(stale.out, /moved|behind|update/i)
    assert.match(stale.out, /v0\.3\.0/)
    assert.ok(!/latest tag snapshot/.test(stale.out), 'non-semver tags must not be treated as versions')

    // 上游不可达：只提示跳过，exit 0（advisory 不具备阻断权力）
    const manifestPath = join(consumer, '.dsh-seam.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { source: { repo: string } }
    manifest.source.repo = '/nonexistent/upstream/repo'
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    const unreachable = runCli(cli, ['outdated'], consumer)
    assert.equal(unreachable.status, 0, unreachable.out)
    assert.match(unreachable.out, /skip/i)

    // 无清单：用法错误才允许非零退出
    const empty = mkdtempSync(join(tmpdir(), 'dsh-empty-'))
    try {
      const usage = runCli(cli, ['outdated'], empty)
      assert.equal(usage.status, 1)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  } finally {
    for (const dir of [source, consumer, cliOnly, bare]) rmSync(dir, { recursive: true, force: true })
  }
})
