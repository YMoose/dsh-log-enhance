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
 * rejecting the first prerelease past its upper bound). Exit 1: not — and also
 * exit 1 when either boundary probe cannot be derived from the range text, so a
 * range rewrite can never turn these assertions into silent no-ops.
 *
 * @module dsh-log-enhance/scripts/check-compat
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  evaluatePluginCompatibility,
  getDshRuntimeVersion,
  pluginCompatibilityWarning,
} from '@deepseek-ai/dsh-app-boot'

/**
 * The manifest under test. `DSH_LOG_ENHANCE_MANIFEST` overrides the path so
 * the regression tests can feed deliberately malformed ranges without editing
 * the real package.json.
 */
const MANIFEST_URL = process.env.DSH_LOG_ENHANCE_MANIFEST
  ? pathToFileURL(resolve(process.cwd(), process.env.DSH_LOG_ENHANCE_MANIFEST))
  : new URL('../package.json', import.meta.url)

/** Render an issue with both the official human diagnostic and the raw record. */
function detail(issue) {
  return `${pluginCompatibilityWarning(issue)}\n${JSON.stringify(issue, null, 2)}`
}

/**
 * The two shapes the probe below can decompose. Kept as named constants so a
 * failure report can print the exact expression that stopped matching.
 */
const LOWER_BOUND_RE = /^\s*>=\s*(\S+)/
const UPPER_BOUND_ZERO_RE = /<\s*(\d+\.\d+\.\d+)-0\s*$/

/**
 * Derive boundary probes from the declared range itself (single source of
 * truth): the `>=` lower bound, and the first prerelease past a `<X.Y.Z-0`
 * upper bound — the exact spelling the gate must reject per §2.
 *
 * Returns `null` for a bound it cannot decompose. Callers must treat that as a
 * hard failure: a range the gate cannot read is a range nobody has verified,
 * and skipping the probe would leave the gate green on an unchecked claim.
 */
function boundaryProbes(range) {
  const lower = LOWER_BOUND_RE.exec(range)?.[1] ?? null
  const upperBase = UPPER_BOUND_ZERO_RE.exec(range)?.[1] ?? null
  return { lower, firstPastUpper: upperBase ? `${upperBase}-alpha.1` : null }
}

/**
 * Abort when a boundary probe cannot be derived from `engines.dsh`. Never fall
 * back to a skip: these probes are the only thing proving the declared range
 * text means what docs/versioning.md §2 documents.
 */
function failUnparseableRange(range, probe, regex, expectation) {
  console.error(
    'FAIL cannot derive the engines.dsh boundary probe from the declared range:',
  )
  if (typeof range !== 'string') {
    console.error('  engines.dsh is missing from package.json (or is not a string)')
  }
  console.error(`  range:        ${JSON.stringify(range) ?? String(range)}`)
  console.error(`  probe wanted: ${probe}`)
  console.error(`  expected:     ${expectation}`)
  console.error(`  regex:        ${regex}`)
  console.error(
    'If the range syntax changed on purpose, update boundaryProbes() here and ' +
      'docs/versioning.md §2 together — the boundary assertions must never be ' +
      'silently skipped.',
  )
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(MANIFEST_URL, 'utf8'))
const runtimeVersion = getDshRuntimeVersion()
// A wholly missing `engines` object used to die on the label interpolation
// below (`Cannot read properties of undefined`) instead of the friendly
// missing-range diagnostic — same exit code, unreadable cause (review P9).
if (typeof manifest.engines?.dsh !== 'string') {
  failUnparseableRange(
    manifest.engines?.dsh,
    'lower bound',
    LOWER_BOUND_RE,
    'a leading `>=<version>` term, e.g. `>=0.2.2-rc.1 <0.3.0-0`',
  )
}
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
if (!lower) {
  failUnparseableRange(
    manifest.engines.dsh,
    'lower bound',
    LOWER_BOUND_RE,
    'a leading `>=<version>` term, e.g. `>=0.2.2-rc.1 <0.3.0-0`',
  )
}
if (!firstPastUpper) {
  failUnparseableRange(
    manifest.engines.dsh,
    'first prerelease past the upper bound',
    UPPER_BOUND_ZERO_RE,
    'a trailing `<X.Y.Z-0` term, e.g. `>=0.2.2-rc.1 <0.3.0-0` (docs/versioning.md §2)',
  )
}

const lowerIssue = evaluatePluginCompatibility(manifest, {}, lower)
if (lowerIssue) {
  console.error(`FAIL ${label} rejects its own lower bound ${lower}:`)
  console.error(detail(lowerIssue))
  process.exit(1)
}

const pastUpperIssue = evaluatePluginCompatibility(manifest, {}, firstPastUpper)
if (!pastUpperIssue) {
  console.error(
    `FAIL ${label} admits ${firstPastUpper}; the upper bound must keep its \`-0\` suffix (docs/versioning.md §2)`,
  )
  process.exit(1)
}

console.log(
  `ok: ${label} passes the official dsh ${runtimeVersion} compatibility gate ` +
    `(peers short-circuited by engines.dsh; lower bound ${lower} admitted, ${firstPastUpper} rejected)`,
)
