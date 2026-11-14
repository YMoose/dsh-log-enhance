#!/usr/bin/env node
/**
 * 将 DSH 同版本依赖组更新到 registry 中最新的目标版本。
 *
 * 通用依赖更新工具（Renovate/Dependabot）无法直接处理以下 DSH 发布规则
 * （详见 docs/versioning.md §2/§7）：
 *
 *  1. 跟随 `next` 标签而不是 `latest`：多数 @deepseek-ai/* 子包的
 *     `latest` 仍停在 0.0.1-rc.1，当前预发布版本通过 `next` 发布。
 *  2. DSH 系列包使用同一版本：所有精确版本的 `@deepseek-ai/dsh-*`
 *     依赖必须一起更新到相同目标版本。
 *  3. cordis 系列（约 4.x，以及 cordis-plugin-loader 1.x）单独管理，
 *     本脚本不修改；使用版本范围的依赖也不修改。
 *  4. 同一个 rc 版本号可能重新发布：`--check` 比较 registry 中该版本的
 *     发布时间与 baseline.json 的 generatedAt，发现仅比较版本号无法识别的变化。
 *
 * 模式：
 *   --check       只检查，不修改文件。输出 `UPSTREAM_CHANGED=yes|no`、原因和
 *                 仅供参考的 `alpha` 标签。正常完成时退出 0，供工作流解析结果；
 *                 registry 或 baseline 读取失败时退出 1，不误报为“没有变化”。
 *   --print-only  输出升级计划，不修改 package.json。
 *   --keep-floor  仅在写入或 --print-only 时使用：更新依赖版本，但保留
 *                 engines.dsh 原文（docs/versioning.md §4）。写入前会检查现有
 *                 范围是否仍接受目标版本，即下界 <= 目标 < 上界，并采用与
 *                 scripts/check-compat.mjs 相同的预发布边界规则。本文件保留自己的
 *                 compareVersions，避免新增 dsh-app-boot import 改变依赖清单。
 *                 目标超出范围时拒绝更新；调整兼容范围必须单独明确决定。
 *   默认模式      原地重写 package.json（两个空格缩进）：所有精确版本的 dsh-*
 *                 依赖更新到目标版本，同时更新 engines.dsh。下界设为目标版本，
 *                 上界设为下一小版本的 `-0` 预发布边界。一次完整升级应提交
 *                 package.json、lockfile 和 baseline.json，并重新执行全部检查。
 *
 * 同版本重新发布检查覆盖依赖组中的每个包，而不只检查主包：2026-11-09 的
 * 实际事件就是子包以原版本号重新发布，只检查主包会漏掉。`--check` 将每个包
 * 当前版本的发布时间与 baseline.json 的 generatedAt 比较；baseline 无法读取时
 * 直接失败，因为此时无法判断依赖内容是否发生变化。
 *
 * 测试重定向：DSH_SEAM_MANIFEST / DSH_SEAM_BASELINE / DSH_SEAM_REGISTRY
 * （均兼容旧名 DSH_LOG_ENHANCE_*）分别指定 manifest、baseline 和 registry 地址；
 * registry 也支持 file://，供 tests/bump-upstream.test.ts 使用离线夹具。
 *
 * 可复用于其他 DSH 插件仓库：依赖组从精确版本的 `@deepseek-ai/dsh-*` 条目
 * 动态发现，只有读取 registry 时使用的 DSH 主包名是固定配置。
 *
 * @module dsh-seam/scripts/bump-upstream
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const BELLWETHER = '@deepseek-ai/dsh'
const TRAIN_PREFIX = '@deepseek-ai/dsh-'
const REGISTRY_BASE = process.env.DSH_SEAM_REGISTRY
  ?? process.env.DSH_LOG_ENHANCE_REGISTRY
  ?? 'https://registry.npmjs.org'
const FIELDS = ['dependencies', 'devDependencies', 'peerDependencies']
// Exact versions, prerelease AND build metadata (`0.2.2-rc.3+build.7`):
// 带 build metadata 的精确版本仍属于同版本依赖组，不是需要跳过的版本范围。
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

const args = process.argv.slice(2)
const known = new Set(['--check', '--print-only', '--keep-floor'])
const unknown = args.filter(argument => !known.has(argument))
if (unknown.length > 0) {
  console.error(`unknown argument(s): ${unknown.join(' ')}; usage: bump-upstream.mjs [--check | --print-only] [--keep-floor]`)
  process.exit(1)
}
const MODE = args.includes('--check') ? 'check' : args.includes('--print-only') ? 'print' : 'write'
const KEEP_FLOOR = args.includes('--keep-floor')
if (KEEP_FLOOR && MODE === 'check') {
  console.error('--keep-floor applies to the plan/rewrite modes, not --check')
  process.exit(1)
}

// --- 1. 从 package.json 找出当前使用的同版本依赖组 -------------------------

const manifestOverride = process.env.DSH_SEAM_MANIFEST ?? process.env.DSH_LOG_ENHANCE_MANIFEST
const manifestUrl = manifestOverride
  ? pathToFileURL(resolve(process.cwd(), manifestOverride))
  : new URL('../package.json', import.meta.url)
const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'))

const trainEntries = []
const otherDeepseek = []
for (const field of FIELDS) {
  for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
    if (name !== BELLWETHER && !name.startsWith(TRAIN_PREFIX)) {
      if (name.startsWith('@deepseek-ai/')) otherDeepseek.push(`${field}/${name}: ${spec}`)
      continue
    }
    if (EXACT_VERSION.test(spec)) trainEntries.push({ field, name, spec })
  }
}
if (trainEntries.length === 0) {
  console.error('no exact-version @deepseek-ai/dsh-* entries found; nothing to resolve')
  process.exit(1)
}

const stripBuild = version => version.replace(/\+[0-9A-Za-z.-]+$/, '')
const counts = new Map()
for (const entry of trainEntries) counts.set(entry.spec, (counts.get(entry.spec) ?? 0) + 1)
const current = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]

// --- 2. 从 registry 解析同版本依赖组的最新发布版本 -------------------------

async function fetchPackument(name) {
  // `file://` base: offline fixture registry for the regression tests
  // (tests/bump-upstream.test.ts) — same JSON per package, no network.
  if (REGISTRY_BASE.startsWith('file://')) {
    const path = join(fileURLToPath(REGISTRY_BASE), `${name.replaceAll('/', '%2F')}.json`)
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      console.error(`cannot read the fixture registry entry for ${name}: ${String(error)}`)
      process.exit(1) // loud, same contract as a failed registry fetch
    }
  }
  const url = `${REGISTRY_BASE}/${name.replaceAll('/', '%2F')}`
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`registry responded ${String(response.status)}`)
    return await response.json()
  } catch (error) {
    console.error(`cannot read the npm registry for ${name}: ${String(error)}`)
    process.exit(1) // loud: a silent "no change" here would blind the tripwire
  }
}

const bellwether = await fetchPackument(BELLWETHER)
const tags = bellwether['dist-tags'] ?? {}
const times = bellwether['time'] ?? {}
const target = typeof tags['next'] === 'string'
  ? tags['next']
  : Object.keys(bellwether['versions'] ?? {}).sort(compareVersions).at(-1)
if (target === undefined) {
  console.error('registry exposes neither a next dist-tag nor any version')
  process.exit(1)
}

// --- 3. Verdict / plan / rewrite --------------------------------------------

if (MODE === 'check') {
  if (compareVersions(target, current) < 0) {
    console.error(`REFUSED: registry next tag (${target}) is older than current train (${current})`)
    process.exit(1)
  }
  const skewed = trainEntries.filter(entry => stripBuild(entry.spec) !== stripBuild(target))
  let changed = 'no'
  let reason = `train ${current} unchanged; last published ${String(times[target] ?? '?')}`
  if (target !== current) {
    changed = 'yes'
    reason = `train moved: ${current} -> ${target} (published ${String(times[target] ?? '?')})`
  } else if (skewed.length > 0) {
    changed = 'yes'
    reason = `train skewed against ${target}: ${skewed.map(entry => `${entry.name}@${entry.spec}`).join(', ')}`
  } else {
    // 版本号不变时，通过 registry 的发布时间与已提交 baseline 的 generatedAt
    // 比较来发现重新发布。依赖组中的每个包都要检查；2026-11-09 的事件就是
    // 子包重新发布，只检查 DSH 主包会漏掉。
    const baselineOverride = process.env.DSH_SEAM_BASELINE ?? process.env.DSH_LOG_ENHANCE_BASELINE
    const baselineUrl = baselineOverride
      ? pathToFileURL(resolve(process.cwd(), baselineOverride))
      : new URL('../baseline.json', import.meta.url)
    let anchored
    try {
      const baseline = JSON.parse(readFileSync(baselineUrl, 'utf8'))
      anchored = Date.parse(baseline.generatedAt ?? '')
    } catch (error) {
      console.error(`cannot read ${baselineUrl.href} to anchor republish detection: ${String(error)}`)
      process.exit(1) // loud: an unreadable anchor disarms the republish watch
    }
    if (!Number.isFinite(anchored)) {
      console.error(`baseline ${baselineUrl.href} has no parseable generatedAt; republish detection cannot anchor`)
      process.exit(1)
    }
    const members = [...new Set([BELLWETHER, ...trainEntries.map(entry => entry.name)])]
    const republished = await Promise.all(members.map(async name => {
      const spec = name === BELLWETHER ? current : trainEntries.find(entry => entry.name === name)?.spec
      if (spec === undefined) return null
      const packument = name === BELLWETHER ? bellwether : await fetchPackument(name)
      const strippedSpec = spec.replace(/\+[0-9A-Za-z.-]+$/, '')
      const timeMap = packument['time'] ?? {}
      const publishedAt = timeMap[spec] ?? timeMap[strippedSpec]
      const published = Date.parse(publishedAt ?? '')
      if (!Number.isFinite(published)) {
        console.error(`registry packument for ${name} has no parseable publish time for ${spec}; republish detection cannot verify`)
        process.exit(1)
      }
      return published > anchored
        ? `${name}@${spec} (published ${String(publishedAt)})`
        : null
    }))
    const hits = republished.filter(hit => hit !== null)
    if (hits.length > 0) {
      changed = 'yes'
      reason = `same-version republish after baseline: ${hits.join(', ')}`
    } else {
      reason = `train ${current} unchanged since baseline ${new Date(anchored).toISOString()} (${members.length} members watched)`
    }
  }
  console.log(`UPSTREAM_CHANGED=${changed}`)
  console.log(`reason: ${reason}`)
  console.log(`advisory alpha tag: ${String(tags['alpha'] ?? 'none')} (watched, not a trigger)`)
  process.exit(0)
}

const moves = trainEntries.filter(entry => entry.spec !== target)
console.log(`train: ${current} -> ${target} (${trainEntries.length} dsh-* entries)`)
for (const move of moves) console.log(`  ${move.field}/${move.name}: ${move.spec} -> ${target}`)
const floor = target.replace(/\+[0-9A-Za-z.-]+$/, '')
const core = /^(\d+)\.(\d+)\.(\d+)/.exec(floor)
if (core === null) {
  console.error(`cannot derive an engines.dsh floor from the resolved train: ${target}`)
  process.exit(1)
}
const enginesRange = `>=${floor} <${core[1]}.${Number(core[2]) + 1}.0-0`
if (KEEP_FLOOR) {
  // The floor stays put, so the EXISTING range must still admit the target;
  // the admission check below decides that locally.
  const range = manifest.engines?.dsh
  if (typeof range !== 'string') {
    console.error('--keep-floor needs an existing engines.dsh range to keep')
    process.exit(1)
  }
  if (moves.length > 0) {
    // floor <= target < upper with full semver precedence (build metadata
    // ignored), using the same `-0` prerelease boundary semantics as
    // boundary probes enforce — but decided HERE by this file's
    // compareVersions, not by the official gate (a second
    // @deepseek-ai/dsh-app-boot import site would drift the coupling
    // inventory's file list; see header note). The official gate remains
    // the final backstop at S1 via `npm run check:compat`.
    const lower = /^\s*>=\s*(\S+)/.exec(range)?.[1]
    const upper = /<\s*(\S+)\s*$/.exec(range)?.[1]
    if (lower === undefined || upper === undefined) {
      console.error(`REFUSED: cannot derive both bounds from engines.dsh ${JSON.stringify(range)} — rerun without --keep-floor to move floor and wall together`)
      process.exit(1)
    }
    if (compareVersions(lower, target) > 0 || compareVersions(target, upper) >= 0) {
      console.error(`REFUSED: engines.dsh ${range} does not admit the target ${target} (floor ${lower}, wall ${upper})`)
      console.error('Moving the wall (engines.dsh) is a conscious decision — rerun without --keep-floor to move floor and wall together.')
      process.exit(1) // loud, and NOTHING has been written
    }
  }
  console.log(`  engines.dsh: ${range} (kept; train ${target} admitted)`)
} else {
  if (compareVersions(target, current) < 0) {
    console.error(`REFUSED: target ${target} downgrades the current train ${current} (monotonicity check failed)`)
    process.exit(1)
  }
  if (moves.length > 0 && manifest.engines?.dsh !== enginesRange) {
    console.log(`  engines.dsh: ${String(manifest.engines?.dsh ?? '(unset)')} -> ${enginesRange}`)
  }
}
if (otherDeepseek.length > 0) {
  console.log('left untouched (separate trains / ranges):')
  for (const entry of otherDeepseek) console.log(`  ${entry}`)
}
if (moves.length === 0) {
  console.log('nothing to do.')
  process.exit(0)
}
if (MODE === 'write') {
  for (const move of moves) manifest[move.field][move.name] = target
  if (KEEP_FLOOR) {
    // 版本范围模式（docs/versioning.md §4）：只更新依赖版本，
    // engines.dsh 保持原有兼容范围不变。
    console.log(`package.json rewritten (train -> ${target}; engines.dsh kept); next: npm install && node scripts/write-baseline.mjs && npm run check`)
  } else {
    // 固定同一版本模式（docs/versioning.md §4）：依赖版本和 engines.dsh
    // 一起更新。下界设为新版本，上界设为下一小版本的 `-0` 预发布边界，
    // 使升级后的安装和验证可以使用同一组完整产物。
    manifest.engines ??= {}
    manifest.engines.dsh = enginesRange
    console.log(`package.json rewritten (train + engines.dsh -> ${enginesRange}); next: rm package-lock.json && npm install && node scripts/write-baseline.mjs && npm run check`)
  }
  writeFileSync(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`)
}

// --- minimal semver ordering (fallback resolution + --keep-floor admission) --
// Build metadata parses but never participates in precedence; localeCompare
// remains only for truly unparseable input.

function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === undefined || right === undefined) return a.localeCompare(b)
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1
  }
  const lp = left.pre
  const rp = right.pre
  if (lp.length === 0 && rp.length === 0) return 0
  if (lp.length === 0) return 1 // release sorts above any prerelease
  if (rp.length === 0) return -1
  for (let index = 0; index < Math.max(lp.length, rp.length); index += 1) {
    const x = lp[index]
    const y = rp[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const numericX = /^\d+$/.test(x)
    const numericY = /^\d+$/.test(y)
    if (numericX && numericY) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    } else if (numericX) return -1
    else if (numericY) return 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function parseVersion(text) {
  // Build metadata (`+<build>`) is parsed but ignored, exactly as semver
  // precedence demands — behavioral sync with tests/seam/engine.ts's
  // compareVersions is pinned by the vector sets in tests/engine-contract
  // .test.ts and tests/bump-upstream.test.ts.
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text)
  if (match === null) return undefined
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}
