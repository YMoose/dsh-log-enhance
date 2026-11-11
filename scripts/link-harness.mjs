import { readdir, readFile, mkdir, symlink, lstat, realpath } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Link a prebuilt checkout without installing or changing anything in that checkout.
//
// `--check` performs discovery and the version audit but creates no symlinks, so
// it is safe to run in tests and against a checkout you do not want to wire up.
//
// Version audit: an upstream rc can be republished in place with the same version
// string but different content (see docs/versioning.md §2). A checkout older than
// the devDeps train links fine and then fails later in a confusing way, so warn
// early — but do not fail the link: the developer may deliberately be probing an
// older checkout.
const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const harnessArg = args.find(arg => !arg.startsWith('--'))
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = resolve(harnessArg ?? '../../deepseek-harness')
const root = JSON.parse(await readFile(join(harness, 'package.json'), 'utf8'))
if (root.name !== '@deepseek-ai/dsh-root') throw new Error('Expected a DeepSeek Harness checkout')

// `DSH_LOG_ENHANCE_MANIFEST` lets the regression test drive a deliberately
// mismatched devDeps train without editing the real package.json (same escape
// hatch as scripts/check-compat.mjs).
const manifestPath = process.env.DSH_LOG_ENHANCE_MANIFEST ?? join(project, 'package.json')
const projectManifest = JSON.parse(await readFile(resolve(project, manifestPath), 'utf8'))
const devDeps = Object.entries(projectManifest.devDependencies ?? {})
  .filter(([name]) => name.startsWith('@deepseek-ai/'))

async function link(name, target) {
  const destination = join(project, 'node_modules', name)
  await mkdir(dirname(destination), { recursive: true })
  try {
    await lstat(destination)
    if (await realpath(destination) !== await realpath(target)) {
      throw new Error(`Refusing to replace existing dependency: ${name}`)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await symlink(target, destination, 'dir')
  }
}

const candidates = []
for (const entry of await readdir(join(harness, 'vendor'), { withFileTypes: true })) {
  if (entry.isDirectory()) candidates.push(join(harness, 'vendor', entry.name))
}
for (const group of await readdir(join(harness, 'packages'), { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  for (const entry of await readdir(join(harness, 'packages', group.name), { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(join(harness, 'packages', group.name, entry.name))
  }
}
const manifests = []
for (const path of candidates) {
  let manifest
  try { manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') continue; throw error }
  if (!manifest.name?.startsWith('@deepseek-ai/')) continue
  manifests.push({ name: manifest.name, version: manifest.version, path })
}

/**
 * Compare the checkout's package versions with the project's devDeps train.
 * Only exact devDeps pins are compared: a range or dist-tag carries no single
 * expected version, and the checkout's own non-dsh packages (cordis, cosmokit)
 * are peer/resolved deps rather than part of the pinned train.
 * @returns human-readable mismatch warnings; empty when the checkout matches.
 */
function auditVersions(rootVersion, loaded, devDeps) {
  const warnings = []
  const byName = new Map(loaded.map(entry => [entry.name, entry.version]))
  for (const [name, expected] of devDeps) {
    if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(expected)) continue
    const actual = byName.get(name)
    if (actual === undefined) {
      warnings.push(`${name}: expected ${expected} but the checkout does not provide it`)
      continue
    }
    if (actual !== expected) {
      warnings.push(
        `${name}: checkout has ${actual}, package.json devDependencies pins ${expected}`
        + ' — this checkout predates (or postdates) the pinned train; republished rc content is not interchangeable',
      )
    }
  }
  // The train version is the one every dsh-* pin agrees on; a root that disagrees
  // means the checkout itself is from a different release than the pinned train.
  // Scoped to dsh-* : the vendored cordis family carries its own version line.
  const dshPins = devDeps
    .filter(([name]) => name.startsWith('@deepseek-ai/dsh'))
    .map(([, expected]) => expected)
    .filter(expected => /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(expected))
  const trainVersions = new Set(dshPins)
  if (trainVersions.size === 1) {
    const [train] = [...trainVersions]
    if (rootVersion !== train) {
      warnings.push(`harness root is ${String(rootVersion)} but the pinned train is ${train}`)
    }
  }
  return warnings
}

const warnings = auditVersions(root.version, manifests, devDeps)
for (const warning of warnings) console.warn(`warning: ${warning}`)

if (checkOnly) {
  console.log(`Checked ${manifests.length} Harness packages against ${devDeps.length} devDependencies (${warnings.length} warning(s)). No links were created.`)
} else {
  for (const manifest of manifests) await link(manifest.name, manifest.path)
  for (const name of ['typescript', '@types/node']) await link(name, join(harness, 'node_modules', name))
  await mkdir(join(project, 'node_modules', '.bin'), { recursive: true })
  const compiler = join(project, 'node_modules', '.bin', 'tsc')
  try { await lstat(compiler) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    await symlink('../typescript/bin/tsc', compiler)
  }
  console.log(`Linked ${manifests.length} Harness packages and the TypeScript toolchain. The checkout was not modified.`)
}
