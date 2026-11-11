import { readdir, readFile, mkdir, symlink, lstat, realpath } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Link a prebuilt checkout without installing or changing anything in that checkout.
//
// `--check` performs discovery and the version/contract audit but creates no
// symlinks, so it is safe to run in tests and against a checkout you do not want
// to wire up.
//
// Three defences, weakest to strongest:
//
// 1. Version strings (`auditVersions`): an upstream rc can be republished in
//    place with the same version string but different content (see
//    docs/versioning.md §2). A checkout older than the devDeps train links fine
//    and then fails later in a confusing way, so warn early — but do not fail
//    the link: the developer may deliberately be probing an older checkout.
// 2. `coupling.json` (CI drift gate): records *which* upstream surfaces this
//    repo touches. It cannot notice that a recorded surface stopped existing.
// 3. API contracts (`auditContracts`, this file): resolve the recorded types,
//    field paths, context services and events against the checkout's emitted
//    `.d.ts`. This is the only layer that catches "same version string, same
//    coupling inventory, but the member is gone".
//
// Every layer is advisory: contract drift prints warnings and exits 0.
const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
// Contract resolution parses a few hundred declaration files (~1s). Keep an
// escape hatch for iterative linking on a slow machine or a half-built checkout.
const skipContracts = args.includes('--skip-contracts')
const harnessArg = args.find(arg => !arg.startsWith('--'))
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = resolve(harnessArg ?? '../../deepseek-harness')
const root = JSON.parse(await readFile(join(harness, 'package.json'), 'utf8'))
if (root.name !== '@deepseek-ai/dsh-root') throw new Error('Expected a DeepSeek Harness checkout')

// `DSH_LOG_ENHANCE_MANIFEST` lets the regression test drive a deliberately
// mismatched devDeps train without editing the real package.json (same escape
// hatch as scripts/check-compat.mjs). `DSH_LOG_ENHANCE_COUPLING` does the same
// for the contract audit's coupling inventory.
const manifestPath = process.env.DSH_LOG_ENHANCE_MANIFEST ?? join(project, 'package.json')
const projectManifest = JSON.parse(await readFile(resolve(project, manifestPath), 'utf8'))
const devDeps = Object.entries(projectManifest.devDependencies ?? {})
  .filter(([name]) => name.startsWith('@deepseek-ai/'))
const couplingPath = process.env.DSH_LOG_ENHANCE_COUPLING
  ? resolve(project, process.env.DSH_LOG_ENHANCE_COUPLING)
  : join(project, 'coupling.json')

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
  manifests.push({
    name: manifest.name,
    version: manifest.version,
    path,
    types: manifest.types ?? manifest.typings,
    exports: manifest.exports,
  })
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

// --- API contract audit -------------------------------------------------------
//
// `coupling.json` says which upstream surfaces this repo touches; it is a
// snapshot, so on its own it cannot tell anyone that a snapshot entry stopped
// existing. This audit resolves every recorded entry against the checkout's own
// declaration files:
//
//   packages[pkg].types            → the symbol is still exported
//   packages[pkg].fields[{type,path}] → the path still resolves on that type
//   fieldPaths[pkg][]              → the path still resolves on some exported type
//   ctxAccesses{}                  → `ctx.<name>` still exists on merged `Context`
//   srcHooks/testHooks[].event     → the event still exists on merged `Events`
//
// Declarations are resolved through the TypeScript compiler API so mapped,
// conditional and module-augmented types behave exactly as they do in the real
// build. A dynamic segment (`JsonValue`, an index signature) is reported as
// unverifiable rather than as a defect: the inventory recorded a path across an
// opaque payload, and guessing would create noise instead of evidence.
//
// Paths recorded by scripts/analyze-dsh-coupling.mjs keep the *property chain*
// but drop the parameter name, and never record which annotated type carried it.
// First segments are therefore matched against named properties of every type
// the package exports (a "does this surface still exist anywhere in the
// package" check). That is deliberately weaker than a per-type check and is
// documented as such: it catches removal, not retyping.

/** Declaration entry points to try when a manifest does not declare `types`. */
const DECLARATION_FALLBACKS = [
  'lib/index.d.ts',
  'lib/types/index.d.ts',
  'dist/index.d.ts',
  'dist/types/index.d.ts',
  'types/index.d.ts',
  'src/index.d.ts',
  'src/index.ts',
]

/** Resolve the single declaration entry file a package publishes, or null. */
function declarationEntry(manifest) {
  const declared = []
  if (typeof manifest.types === 'string') declared.push(manifest.types)
  if (typeof manifest.exports === 'string') declared.push(manifest.exports)
  else if (manifest.exports !== null && typeof manifest.exports === 'object') {
    const dot = manifest.exports['.']
    if (typeof dot === 'string') declared.push(dot)
    else if (dot !== null && typeof dot === 'object' && typeof dot.types === 'string') declared.push(dot.types)
    if (typeof manifest.exports.types === 'string') declared.push(manifest.exports.types)
  }
  for (const candidate of [...declared, ...DECLARATION_FALLBACKS]) {
    const file = resolve(manifest.path, candidate)
    if (existsSync(file)) return file
  }
  return null
}

/** `typescript` is a devDependency; the audit degrades to a note when absent. */
async function loadTypeScript() {
  try {
    const module = await import('typescript')
    return module.default ?? module
  } catch {
    return null
  }
}

function readCoupling(path) {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/**
 * Expand a type into the object shapes its members may be read from: unions are
 * flattened, undefined/null members dropped (an optional field still has the
 * shape), and generic forms resolved —
 *   · `SessionEventMap[T]` (generic index) → every member payload the map
 *     declares, including plugin/augmentation merges;
 *   · `T` constrained to `K`            → the constraint.
 */
function expandType(ts, checker, type, depth = 0) {
  if (type === undefined || depth > 8) return []
  const flags = type.flags
  if (flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.Never)) return []
  if (type.isUnion?.()) return type.types.flatMap(member => expandType(ts, checker, member, depth + 1))
  if (flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type)
    return constraint === undefined ? [] : expandType(ts, checker, constraint, depth + 1)
  }
  if (type.objectType !== undefined && type.indexType !== undefined) {
    const { objectType, indexType } = type
    if (indexType.flags & ts.TypeFlags.TypeParameter) {
      // `Map[T]` with T a type parameter: the map's own properties define the
      // complete payload set (augmentations included).
      return checker.getPropertiesOfType(objectType)
        .flatMap(property => expandType(ts, checker, typeOfSymbol(ts, checker, property), depth + 1))
    }
    return expandType(ts, checker, checker.getIndexType(objectType, indexType), depth + 1)
  }
  return [type]
}

/** The declared type of a property symbol, independent of where it was written. */
function typeOfSymbol(ts, checker, symbol) {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
  if (declaration !== undefined) {
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration)
    if (type !== undefined) return type
  }
  return typeof checker.getTypeOfSymbol === 'function' ? checker.getTypeOfSymbol(symbol) : undefined
}

/**
 * Every member shape a symbol's type contributes. Interfaces merge across
 * declarations (module augmentation), so a type is only complete when all its
 * declarations are combined.
 */
function shapesOfSymbol(ts, checker, symbol) {
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
  const shapes = []
  const declared = (() => {
    try { return checker.getDeclaredTypeOfSymbol(target) } catch { return undefined }
  })()
  if (declared !== undefined && declared.flags !== 0 && declared.flags !== undefined) shapes.push(declared)
  const declarations = target.declarations ?? []
  if (declarations.length > 0) {
    for (const declaration of declarations) {
      // A declaration contributes a shape only for interfaces/classes/type
      // aliases; `getTypeAtLocation` also works for them and covers merges.
      shapes.push(checker.getTypeAtLocation(declaration))
    }
  }
  else if (target.valueDeclaration !== undefined) shapes.push(checker.getTypeAtLocation(target.valueDeclaration))
  return shapes.filter(shape => shape !== undefined && shape.flags !== 0)
}

/**
 * Property names declared directly on a symbol's type, used to index candidate
 * types by the first segment of a recorded path. Index signatures are
 * deliberately excluded: they would make every path look present.
 */
function namedProperties(ts, checker, symbol) {
  const names = new Set()
  for (const shape of shapesOfSymbol(ts, checker, symbol)) {
    for (const variant of expandType(ts, checker, shape)) {
      for (const property of checker.getPropertiesOfType(checker.getApparentType(variant))) {
        names.add(property.getName())
      }
    }
  }
  return names
}

/**
 * Read one property step across all currently-live variants.
 * @returns {{ types: unknown[], dynamic: boolean } | null} null when no variant
 *   declares the property. `dynamic` marks an index-signature/`any` hop whose
 *   remaining path cannot be verified.
 */
function stepTypes(ts, checker, types, name) {
  const found = []
  let dynamic = false
  for (const type of types) {
    for (const variant of expandType(ts, checker, type)) {
      const apparent = checker.getApparentType(variant)
      const property = checker.getPropertyOfType(apparent, name)
      if (property !== undefined) {
        const propertyType = typeOfSymbol(ts, checker, property)
        if (propertyType !== undefined) found.push(propertyType)
        continue
      }
      if (variant.flags & ts.TypeFlags.Any) { dynamic = true; continue }
      // Only a *string* index signature means "unknown named members". A
      // numeric one (`string`, arrays) must not launder a typo'd field name:
      // `source.kind.nope` has to fail, not resolve as unverifiable.
      const index = checker.getIndexInfoOfType(apparent, ts.IndexKind.String)
      if (index !== undefined) dynamic = true
    }
  }
  if (found.length === 0 && !dynamic) return null
  return { types: found, dynamic }
}

/**
 * Resolve a dotted path on a set of types.
 * @param {boolean} allowDynamicFirst whether the first segment may cross an
 *   opaque payload (explicit `fields[].path`, which names its owning type).
 * @returns {{ ok: boolean, at?: string, dynamic?: boolean }}
 */
function resolvePath(ts, checker, types, segments, allowDynamicFirst = false) {
  let current = types
  let dynamic = false
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]
    const step = stepTypes(ts, checker, current, segment)
    if (step === null) return { ok: false, at: segments.slice(0, index + 1).join('.') }
    if (step.types.length === 0) {
      // Opaque hop: everything below it is unverifiable by construction.
      if (!step.dynamic || (index === 0 && !allowDynamicFirst)) {
        return { ok: false, at: segments.slice(0, index + 1).join('.') }
      }
      return { ok: true, dynamic: true }
    }
    if (step.dynamic) dynamic = true
    current = step.types
  }
  return { ok: true, dynamic }
}

/** Merged members of an augmented interface (`Context` / `Events`) + signatures. */
function augmentedMembers(ts, checker, program, moduleName, interfaceName) {
  const members = new Map()
  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) continue
    const visit = node => {
      if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name) && node.name.text === moduleName
        && node.body !== undefined && ts.isModuleBlock(node.body)) {
        for (const statement of node.body.statements) {
          if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== interfaceName) continue
          const type = checker.getTypeAtLocation(statement)
          for (const property of checker.getPropertiesOfType(type)) {
            if (members.has(property.getName())) continue
            const propertyType = typeOfSymbol(ts, checker, property)
            const signatures = propertyType === undefined
              ? []
              : checker.getSignaturesOfType(propertyType, ts.SignatureKind.Call)
            members.set(property.getName(), {
              arity: signatures.map(signature => ({
                parameters: signature.parameters.length,
                required: signature.minArgumentCount,
                rest: signature.parameters.some(parameter => parameter.valueDeclaration?.dotDotDotToken !== undefined),
              })),
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return members
}

const CONTRACT_MODULE = '@deepseek-ai/cordis'

/**
 * Verify `coupling.json` against the checkout's declaration output.
 * Never throws and never affects the exit code: a stale checkout must still be
 * linkable, and an unparsable one must not turn a convenience script into a
 * gate.
 *
 * @param {string} checkout harness root (for diagnostics only)
 * @param {Array<{name:string,path:string,types?:string,exports?:unknown}>} loaded
 * @returns {string[]} human-readable warnings
 */
async function auditContracts(checkout, loaded) {
  const coupling = readCoupling(couplingPath)
  if (coupling === null) {
    console.log(`· coupling.json not found at ${relative(project, couplingPath)} — skipping API contract audit`)
    return []
  }
  const packages = coupling.packages ?? {}
  const coupled = Object.keys(packages)
  if (coupled.length === 0) return []

  const ts = await loadTypeScript()
  if (ts === null) {
    console.log('· typescript is not installed — skipping API contract audit')
    return []
  }

  const byName = new Map(loaded.map(manifest => [manifest.name, manifest]))
  const entries = new Map() // package name → declaration entry file
  const undeclared = [] // coupled package present in the checkout but without a build
  for (const name of coupled) {
    const manifest = byName.get(name)
    if (manifest === undefined) continue // the version audit already reports this
    const file = declarationEntry(manifest)
    if (file === null) { undeclared.push(name); continue }
    entries.set(name, file)
  }
  // "Nobody is built" and "this one package is not built" are different facts:
  // the first is normal on a fresh clone, the second is exactly the drift this
  // audit exists to report.
  const anyBuilt = loaded.some(manifest => declarationEntry(manifest) !== null)
  if (!anyBuilt) {
    console.log('· the checkout has no declaration output yet (not built?) — skipping API contract audit')
    return []
  }
  // A coupled package present in the checkout but unbuilt is exactly the drift
  // this audit exists to report: the inventory is not being verified.
  const warnings = undeclared.map(name =>
    `contract: ${name}: no declaration file found in ${relative(checkout, byName.get(name).path) || '.'} — inventory entry unverified`)
  if (entries.size === 0) return warnings

  // `ctx` services and events are declared by module augmentation, so a package
  // the inventory never imports can still contribute to the merged interfaces.
  const programFiles = new Set(entries.values())
  for (const manifest of loaded) {
    if (entries.has(manifest.name)) continue
    const file = declarationEntry(manifest)
    if (file === null) continue
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    if (/interface\s+(Context|Events)\b/.test(text)) programFiles.add(file)
  }

  let program
  let checker
  try {
    program = ts.createProgram([...programFiles], {
      skipLibCheck: true,
      noEmit: true,
      types: [],
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    })
    checker = program.getTypeChecker()
  } catch (error) {
    console.log(`· declaration parsing failed (${error.message}) — skipping API contract audit`)
    return []
  }

/**
 * The exports of a package's published entry point. Deliberately *not* every
 * module inside the package: an internal `types.d.ts` that the entry never
 * re-exports is not a surface we can depend on, so counting it would let a
 * removed export pass the audit.
 */
function entryExports(checker, program, entryFile) {
  const types = new Map()
  const sourceFile = program.getSourceFile(entryFile)
  if (sourceFile === undefined) return types
  let moduleSymbol
  try { moduleSymbol = checker.getSymbolAtLocation(sourceFile) } catch { return types }
  if (moduleSymbol === undefined) return types
  let exports
  try { exports = checker.getExportsOfModule(moduleSymbol) } catch { return types }
  for (const symbol of exports) if (!types.has(symbol.getName())) types.set(symbol.getName(), symbol)
  return types
}

  // Merged interfaces are checked once, against all augmented declaration files.
  const contextMembers = augmentedMembers(ts, checker, program, CONTRACT_MODULE, 'Context')
  const eventMembers = augmentedMembers(ts, checker, program, CONTRACT_MODULE, 'Events')

  let checked = 0
  for (const name of coupled) {
    const file = entries.get(name)
    if (file === undefined) continue
    const entry = packages[name] ?? {}
    const exported = entryExports(checker, program, file)

    // 1. Recorded types must still be exported.
    for (const typeName of entry.types ?? []) {
      checked++
      if (!exported.has(typeName)) {
        warnings.push(`contract: ${name}: type ${typeName} is no longer exported`)
      }
    }

    // 2. Recorded fields must still resolve on their owning type.
    for (const field of entry.fields ?? []) {
      checked++
      const symbol = exported.get(field.type)
      if (symbol === undefined) {
        warnings.push(`contract: ${name}: cannot check ${field.type}.${field.path} — type ${field.type} is not exported`)
        continue
      }
      const shapes = shapesOfSymbol(ts, checker, symbol)
      const result = resolvePath(ts, checker, shapes, String(field.path).split('.'), true)
      if (!result.ok) {
        warnings.push(`contract: ${name}: ${field.type}.${field.path} does not resolve (stopped at ${result.at})`)
      }
    }

    // 3. Recorded field paths must still resolve on some exported type.
    //    Candidate types are pre-filtered by the first segment so the check stays
    //    linear; the first segment must be a *named* property of some exported
    //    type (an index signature would make every path look present).
    const paths = coupling.fieldPaths?.[name] ?? []
    if (paths.length > 0) {
      const index = new Map() // first segment → symbols
      for (const symbol of exported.values()) {
        for (const propertyName of namedProperties(ts, checker, symbol)) {
          const bucket = index.get(propertyName) ?? []
          bucket.push(symbol)
          index.set(propertyName, bucket)
        }
      }
      for (const path of paths) {
        checked++
        const segments = String(path).split('.')
        const candidates = index.get(segments[0]) ?? []
        if (candidates.length === 0) {
          warnings.push(`contract: ${name}: field path '${path}' — no exported type declares '${segments[0]}'`)
          continue
        }
        const resolved = candidates.some(symbol =>
          resolvePath(ts, checker, shapesOfSymbol(ts, checker, symbol), segments).ok)
        if (!resolved) {
          warnings.push(`contract: ${name}: field path '${path}' does not resolve on any exported type`)
        }
      }
    }
  }

  // 4. Context services (a global inventory section) against merged Context.
  for (const service of Object.keys(coupling.ctxAccesses ?? {})) {
    checked++
    if (!contextMembers.has(service)) {
      warnings.push(`contract: ctx.${service} is not declared on merged Context`)
    }
  }

  // 5. Hook events (src + tests) against the merged Events interface.
  const hooks = new Map()
  for (const hook of [...(coupling.srcHooks ?? []), ...(coupling.testHooks ?? [])]) {
    if (hook?.event === undefined) continue
    hooks.set(hook.event, Math.max(hooks.get(hook.event) ?? 0, (hook.params ?? []).length))
  }
  for (const [event, handlerParameters] of hooks) {
    checked++
    const member = eventMembers.get(event)
    if (member === undefined) {
      warnings.push(`contract: hook '${event}' is not declared on merged Events`)
      continue
    }
    // Our handler may ignore trailing arguments, but it can never receive more
    // than the emitter passes (a rest parameter accepts any count).
    if (member.arity.length > 0 && !member.arity.some(signature => signature.rest || handlerParameters <= signature.parameters)) {
      warnings.push(`contract: hook '${event}' handler declares ${handlerParameters} parameter(s) but the event provides ${member.arity[0].parameters}`)
    }
  }

  console.log(`· API contracts: ${checked} check(s) against ${entries.size} package(s)`)
  return warnings
}

const warnings = auditVersions(root.version, manifests, devDeps)
if (!skipContracts) {
  console.log('→ checking API contracts against coupling.json...')
  try {
    warnings.push(...await auditContracts(harness, manifests))
  } catch (error) {
    // The audit is advisory; an internal failure must not block linking.
    console.warn(`warning: contract audit unavailable (${error.message})`)
  }
}
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
