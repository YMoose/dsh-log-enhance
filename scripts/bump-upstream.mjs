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
 *                 fetch failure exits 1 — loud, never a silent "no").
 *   --print-only  resolve and print the plan; package.json untouched.
 *   (default)     rewrite package.json in place (2-space indent).
 *
 * Reusable in any dsh plugin repo: the train is discovered dynamically from
 * exact-version `@deepseek-ai/dsh-*` entries; nothing repo-specific lives
 * here except the bellwether package used to read the registry.
 *
 * @module dsh-log-enhance/scripts/bump-upstream
 */

import { readFileSync, writeFileSync } from 'node:fs'

const BELLWETHER = '@deepseek-ai/dsh'
const TRAIN_PREFIX = '@deepseek-ai/dsh-'
const REGISTRY_URL = `https://registry.npmjs.org/${BELLWETHER.replaceAll('/', '%2F')}`
const FIELDS = ['dependencies', 'devDependencies', 'peerDependencies']
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const args = process.argv.slice(2)
const known = new Set(['--check', '--print-only'])
const unknown = args.filter(argument => !known.has(argument))
if (unknown.length > 0) {
  console.error(`unknown argument(s): ${unknown.join(' ')}; usage: bump-upstream.mjs [--check | --print-only]`)
  process.exit(1)
}
const MODE = args.includes('--check') ? 'check' : args.includes('--print-only') ? 'print' : 'write'

// --- 1. Discover the installed train from package.json ---------------------

const manifestUrl = new URL('../package.json', import.meta.url)
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

let packument
try {
  const response = await fetch(REGISTRY_URL, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`registry responded ${String(response.status)}`)
  packument = await response.json()
} catch (error) {
  console.error(`cannot read the npm registry for ${BELLWETHER}: ${String(error)}`)
  process.exit(1) // loud: a silent "no change" here would blind the tripwire
}

const tags = packument['dist-tags'] ?? {}
const times = packument['time'] ?? {}
const target = typeof tags['next'] === 'string'
  ? tags['next']
  : Object.keys(packument['versions'] ?? {}).sort(compareVersions).at(-1)
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
    // Same version string: a republish refreshes the registry `time` entry,
    // which the committed baseline's generatedAt anchors.
    try {
      const baseline = JSON.parse(readFileSync(new URL('../baseline.json', import.meta.url), 'utf8'))
      const published = Date.parse(times[target] ?? '')
      const anchored = Date.parse(baseline.generatedAt ?? '')
      if (Number.isFinite(published) && Number.isFinite(anchored) && published > anchored) {
        changed = 'yes'
        reason = `same-version republish: ${target} republished ${String(times[target])} after baseline ${String(baseline.generatedAt)}`
      } else {
        reason = `train ${current} unchanged since baseline ${String(baseline.generatedAt)}`
      }
    } catch {
      reason = `train ${current} unchanged (no baseline.json to anchor republish detection)`
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
  writeFileSync(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log('package.json rewritten; next: rm package-lock.json && npm install && node scripts/write-baseline.mjs && npm run check')
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
