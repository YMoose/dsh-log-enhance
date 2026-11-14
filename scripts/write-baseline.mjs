#!/usr/bin/env node
/**
 * 在仓库根目录生成依赖验证基线 `baseline.json`。
 *
 * 从 `node_modules/.package-lock.json`（npm 记录本次安装结果的内部 lockfile）
 * 提取每个 `@deepseek-ai/*` 包的 version 和 integrity，用于发现同版本重新发布
 * 或意外改变安装内容。仅凭版本号不能证明两次安装的 `0.2.2-rc.1` 内容相同，
 * 完整性哈希可以提供这项证据。
 *
 * 嵌套 lockfile 路径（`…/@deepseek-ai/foo/node_modules/@deepseek-ai/bar`）
 * 表示依赖解析产生的额外副本，不属于顶层同版本依赖组，因此不写入基线。
 * 否则嵌套副本的不同版本会干扰顶层依赖组的一致性检查。
 *
 * 重新生成基线必须是明确的人工操作，先阅读 docs/versioning.md §5。
 *
 * 测试重定向：DSH_SEAM_HIDDEN_LOCK / DSH_SEAM_BASELINE_OUT（均兼容旧名
 * DSH_LOG_ENHANCE_*）分别指定输入 lockfile 和输出 baseline；tests/baseline.test.ts
 * 使用这些夹具。
 *
 * @module dsh-seam/scripts/write-baseline
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SCOPE = 'node_modules/@deepseek-ai/'
const baselineOutOverride = process.env.DSH_SEAM_BASELINE_OUT ?? process.env.DSH_LOG_ENHANCE_BASELINE_OUT
const BASELINE_URL = baselineOutOverride
  ? pathToFileURL(resolve(process.cwd(), baselineOutOverride))
  : new URL('../baseline.json', import.meta.url)
const hiddenLockOverride = process.env.DSH_SEAM_HIDDEN_LOCK ?? process.env.DSH_LOG_ENHANCE_HIDDEN_LOCK
const HIDDEN_LOCK_URL = hiddenLockOverride
  ? pathToFileURL(resolve(process.cwd(), hiddenLockOverride))
  : new URL('../node_modules/.package-lock.json', import.meta.url)

/** Deterministic deep key sort so the file diffs cleanly between runs. */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value !== null && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) sorted[key] = sortDeep(value[key])
    return sorted
  }
  return value
}

/** Read `{ name: { integrity, version } }` for every scoped package, keys sorted. */
function readScopedPackages() {
  const lock = JSON.parse(readFileSync(HIDDEN_LOCK_URL, 'utf8'))
  const packages = {}
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith(SCOPE)) continue
    const name = key.slice(SCOPE.length)
    if (name.includes('/node_modules/')) continue // 嵌套依赖副本，不属于顶层同版本依赖组
    packages[name] = {
      integrity: entry.integrity ?? null,
      version: entry.version ?? null,
    }
  }
  return sortDeep(packages)
}

const baseline = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  packages: readScopedPackages(),
}

writeFileSync(BASELINE_URL, `${JSON.stringify(sortDeep(baseline), null, 2)}\n`)
console.log(`baseline.json: ${Object.keys(baseline.packages).length} @deepseek-ai packages (node ${baseline.node})`)
