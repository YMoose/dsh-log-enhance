#!/usr/bin/env node
/**
 * Write the dependency verification baseline (repo-root `baseline.json`).
 *
 * Extracts every `@deepseek-ai/*` entry's `version` + `integrity` from
 * `node_modules/.package-lock.json` (npm's hidden per-install lockfile) so a
 * same-version republish or accidental re-pin becomes detectable: version
 * numbers alone cannot prove two installs of `0.2.2-rc.1` are byte-identical,
 * but integrity hashes can.
 *
 * Regenerating is a deliberate act — see docs/versioning.md §5 first.
 *
 * @module dsh-log-enhance/scripts/write-baseline
 */

import { readFileSync, writeFileSync } from 'node:fs'

const SCOPE = 'node_modules/@deepseek-ai/'
const BASELINE_URL = new URL('../baseline.json', import.meta.url)
const HIDDEN_LOCK_URL = new URL('../node_modules/.package-lock.json', import.meta.url)

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
    packages[key.slice(SCOPE.length)] = {
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
