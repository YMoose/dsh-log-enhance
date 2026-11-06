import { readdir, readFile, mkdir, symlink, lstat, realpath } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Link a prebuilt checkout without installing or changing anything in that checkout.
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = resolve(process.argv[2] ?? '../../deepseek-harness')
const root = JSON.parse(await readFile(join(harness, 'package.json'), 'utf8'))
if (root.name !== '@deepseek-ai/dsh-root') throw new Error('Expected a DeepSeek Harness checkout')

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
let count = 0
for (const path of candidates) {
  let manifest
  try { manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') continue; throw error }
  if (!manifest.name?.startsWith('@deepseek-ai/')) continue
  await link(manifest.name, path)
  count++
}
for (const name of ['typescript', '@types/node']) await link(name, join(harness, 'node_modules', name))
await mkdir(join(project, 'node_modules', '.bin'), { recursive: true })
const compiler = join(project, 'node_modules', '.bin', 'tsc')
try { await lstat(compiler) }
catch (error) {
  if (error.code !== 'ENOENT') throw error
  await symlink('../typescript/bin/tsc', compiler)
}
console.log(`Linked ${count} Harness packages and the TypeScript toolchain. The checkout was not modified.`)
