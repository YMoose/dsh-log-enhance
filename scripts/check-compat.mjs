#!/usr/bin/env node
/**
 * CI gate: run the host's own plugin-compatibility gate on this manifest.
 *
 * Calls `evaluatePluginCompatibility` exported by `@deepseek-ai/dsh-app-boot`
 * (upstream: `packages/boot/app-boot/src/plugin-compatibility.ts`) so the CI
 * ruling is byte-for-byte the gate a real dsh install performs — including the
 * `includePrerelease` semantics behind the `<0.3.0-0` upper-bound discipline
 * (docs/versioning.md §2). With `engines.dsh` present the official gate decides
 * on it alone and ignores peerDependencies; the whole parsed manifest is passed
 * so the gate also throws on malformed engines/peer fields.
 *
 * The runtime version defaults to the installed app-boot package's version —
 * the same train pinned by the devDependency and fingerprinted in
 * baseline.json, so this script has no version number of its own to maintain.
 *
 * Exit 0: compatible (and declared range admits its own lower bound while
 * rejecting the first prerelease past its upper bound). Exit 1: not.
 *
 * @module dsh-log-enhance/scripts/check-compat
 */

import { readFileSync } from 'node:fs'

import {
  evaluatePluginCompatibility,
  getDshRuntimeVersion,
  pluginCompatibilityWarning,
} from '@deepseek-ai/dsh-app-boot'

const MANIFEST_URL = new URL('../package.json', import.meta.url)

/** Render an issue with both the official human diagnostic and the raw record. */
function detail(issue) {
  return `${pluginCompatibilityWarning(issue)}\n${JSON.stringify(issue, null, 2)}`
}

/**
 * Derive boundary probes from the declared range itself (single source of
 * truth): the `>=` lower bound, and the first prerelease past a `<X.Y.Z-0`
 * upper bound — the exact spelling the gate must reject per §2.
 */
function boundaryProbes(range) {
  const lower = /^\s*>=\s*(\S+)/.exec(range)?.[1] ?? null
  const upperBase = /<\s*(\d+\.\d+\.\d+)-0\s*$/.exec(range)?.[1] ?? null
  return { lower, firstPastUpper: upperBase ? `${upperBase}-alpha.1` : null }
}

const manifest = JSON.parse(readFileSync(MANIFEST_URL, 'utf8'))
const runtimeVersion = getDshRuntimeVersion()
const label = `${manifest.name}@${manifest.version} (engines.dsh ${manifest.engines.dsh})`

// 1. Official ruling against the current verification-baseline runtime.
const baselineIssue = evaluatePluginCompatibility(manifest)
if (baselineIssue) {
  console.error(`FAIL ${label} is incompatible with dsh ${runtimeVersion}:`)
  console.error(detail(baselineIssue))
  process.exit(1)
}

// 2. Range-boundary self-checks: prove the declared range admits its own
//    verified lower bound and rejects the first prerelease past its upper
//    bound (a bare `<0.3.0` would silently admit `0.3.0-alpha.1`).
const { lower, firstPastUpper } = boundaryProbes(manifest.engines.dsh)
if (lower) {
  const lowerIssue = evaluatePluginCompatibility(manifest, {}, lower)
  if (lowerIssue) {
    console.error(`FAIL ${label} rejects its own lower bound ${lower}:`)
    console.error(detail(lowerIssue))
    process.exit(1)
  }
} else {
  console.log('note: engines.dsh lower bound not machine-derivable, probe skipped')
}
if (firstPastUpper) {
  const pastUpperIssue = evaluatePluginCompatibility(manifest, {}, firstPastUpper)
  if (!pastUpperIssue) {
    console.error(
      `FAIL ${label} admits ${firstPastUpper}; the upper bound must keep its \`-0\` suffix (docs/versioning.md §2)`,
    )
    process.exit(1)
  }
} else {
  console.log('note: engines.dsh upper bound is not `<X.Y.Z-0`, past-upper probe skipped')
}

console.log(
  `ok: ${label} passes the official dsh ${runtimeVersion} compatibility gate ` +
    `(peers short-circuited by engines.dsh; lower bound ${lower ?? '?'} admitted, ${firstPastUpper ?? '?'} rejected)`,
)
