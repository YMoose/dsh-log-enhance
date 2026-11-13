#!/usr/bin/env node
/**
 * Resolve the dsh dependency train to the newest published version.
 *
 * The DSH-specific knowledge encoded here — the reasons a generic update
 * tool (Renovate/Dependabot) gets this wrong — is fourfold
 * (see docs/versioning.md §2/§7):
 *
 *  1. Follow the `next` dist-tag, never `latest`: most @deepseek-ai/*
 *     subpackages have their `latest` tag stranded at 0.0.1-rc.1; the
 *     current train travels on `next` (rc line).
 *  2. The dsh family is a single version train — every exact-version
 *     `@deepseek-ai/dsh-*` entry moves to the same target together.
 *  3. The cordis family (~4.x, plus cordis-plugin-loader 1.x) is a separate
 *     train and is never rewritten here; range specs are left untouched.
 *  4. Same-version rc republishes exist: `--check` compares the registry's
 *     publish timestamp (`time`) of the train version against
 *     baseline.json's generatedAt, catching a republish that no version
 *     comparison can see.
 *
 * Modes:
 *   --check       probe only. Prints `UPSTREAM_CHANGED=yes|no` plus a
 *                 reason and the advisory `alpha` tag; always exits 0 so
 *                 the tripwire workflow can parse the verdict (a registry
 *                 or baseline fetch failure exits 1 — loud, never a
 *                 silent "no").
 *   --print-only  resolve and print the plan; package.json untouched.
 *   (default)     rewrite package.json in place (2-space indent): every
 *                 exact-version dsh-* entry moves to the target AND
 *                 engines.dsh moves with it — floor = the target, upper
 *                 bound = next minor with the `-0` prerelease wall. A
 *                 train move is ONE atomic change (single-line follow,
 *                 docs/versioning.md §4), so the canary's artifact
 *                 (package.json + lockfile + baseline.json) is a complete
 *                 revalidation commit with nothing left to edit by hand.
 *
 * The republish watch covers EVERY train member, not just the bellwether:
 * the one real incident so far (2026-11-09) was a subpackage republished
 * under the same version string, which a bellwether-only watch would miss.
 * `--check` compares each member's publish time at its pinned spec against
 * baseline.json's generatedAt; an unreadable baseline disarms that
 * detection and therefore fails loudly.
 *
 * Testability: DSH_LOG_ENHANCE_MANIFEST / DSH_LOG_ENHANCE_BASELINE /
 * DSH_LOG_ENHANCE_REGISTRY redirect the manifest, baseline, and registry
 * base URL; the registry base also accepts `file://` for the offline
 * fixtures in tests/bump-upstream.test.ts.
 *
 * Reusable in any dsh plugin repo: the train is discovered dynamically from
 * exact-version `@deepseek-ai/dsh-*` entries; nothing repo-specific lives
 * here except the bellwether package used to read the registry.
 *
 * @module dsh-log-enhance/scripts/bump-upstream
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const BELLWETHER = '@deepseek-ai/dsh'
const TRAIN_PREFIX = '@deepseek-ai/dsh-'
const REGISTRY_BASE = process.env.DSH_LOG_ENHANCE_REGISTRY ?? 'https://registry.npmjs.org'
const FIELDS = ['dependencies', 'devDependencies', 'peerDependencies']
// Exact versions, prerelease AND build metadata (`0.2.2-rc.3+build.7`):
// a build-metadata spec is still a train pin, not a range to leave behind.
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

const args = process.argv.slice(2)
const known = new Set(['--check', '--print-only'])
const unknown = args.filter(argument => !known.has(argument))
if (unknown.length > 0) {
  console.error(`unknown argument(s): ${unknown.join(' ')}; usage: bump-upstream.mjs [--check | --print-only]`)
  process.exit(1)
}
const MODE = args.includes('--check') ? 'check' : args.includes('--print-only') ? 'print' : 'write'

// --- 1. Discover the installed train from package.json ---------------------

const manifestUrl = process.env.DSH_LOG_ENHANCE_MANIFEST
  ? pathToFileURL(resolve(process.cwd(), process.env.DSH_LOG_ENHANCE_MANIFEST))
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

const counts = new Map()
for (const entry of trainEntries) counts.set(entry.spec, (counts.get(entry.spec) ?? 0) + 1)
const current = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]

// --- 2. Resolve the newest published train version from the registry -------

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
    const response = await fetch(url, { headers: { accept: 'application/json' } })
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
  let changed = 'no'
  let reason = `train ${current} unchanged; last published ${String(times[target] ?? '?')}`
  if (target !== current) {
    changed = 'yes'
    reason = `train moved: ${current} -> ${target} (published ${String(times[target] ?? '?')})`
  } else {
    // Same version strings: a republish refreshes the registry `time` entry,
    // which the committed baseline's generatedAt anchors. EVERY train member
    // is watched — the 2026-11-09 incident was a subpackage republish the
    // bellwether alone would have missed.
    const baselineUrl = process.env.DSH_LOG_ENHANCE_BASELINE
      ? pathToFileURL(resolve(process.cwd(), process.env.DSH_LOG_ENHANCE_BASELINE))
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
      const publishedAt = (packument['time'] ?? {})[spec]
      const published = Date.parse(publishedAt ?? '')
      return Number.isFinite(published) && published > anchored
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
if (moves.length > 0 && manifest.engines?.dsh !== enginesRange) {
  console.log(`  engines.dsh: ${String(manifest.engines?.dsh ?? '(unset)')} -> ${enginesRange}`)
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
  // Single-line follow (docs/versioning.md §4): engines.dsh moves WITH the
  // train — floor = the new train, upper bound = next minor with the `-0`
  // prerelease wall. This is what makes the canary's artifact complete.
  manifest.engines ??= {}
  manifest.engines.dsh = enginesRange
  writeFileSync(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`package.json rewritten (train + engines.dsh -> ${enginesRange}); next: rm package-lock.json && npm install && node scripts/write-baseline.mjs && npm run check`)
}

// --- minimal semver ordering (fallback path only) ---------------------------

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
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text)
  if (match === null) return undefined
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}
