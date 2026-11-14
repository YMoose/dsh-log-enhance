#!/usr/bin/env node
/**
 * Mechanical inventory of this repository's coupling to DeepSeek packages.
 *
 * What it extracts (AST-based, no regex over source text):
 *   - Layer 0: every `@deepseek-ai/*` import — static or dynamic — classified
 *     by file root (src / tests / scripts), by kind (`import type` / value),
 *     and by the package.json field declaring the package.
 *   - Layer 1 (src only): `ctx.on('<event>', …)` hook registrations with their
 *     callback parameter shape (destructured names are the field surface),
 *     `ctx.<service>` accesses (casts unwrapped), and dotted field paths read
 *     on parameters annotated with imported DeepSeek types — attributed to
 *     the package the annotation type came from. Each field path keeps every
 *     reading site (`file:line`) with the root type it was read through AND
 *     the guard context it runs under (case labels, early-return negations,
 *     optional chains — `{ expr, kind: eq|ne|defined|falsy, literal? }`), so
 *     a renamed property is traceable to the code that breaks and the seam
 *     verifier can probe each access exactly as narrowly as the plugin
 *     itself reads it.
 *   - Layer 1 extras with no annotation to lean on: `export const inject`,
 *     string-literal discriminants (`switch (event.type)` cases and
 *     `event.type === '…'` comparisons), `for (const x of event.data.items)`
 *     element variables (recorded as `data.items[].field`), and `ctx.on`
 *     callbacks whose payload parameters are not annotated — those field reads
 *     are attributed to `event:<event>` because the owning package is not
 *     knowable from source alone.
 *   - Layer 3: hook/emit touch points used by tests (verification contracts)
 *     and packages that only tests/scripts import.
 *
 * What it deliberately does NOT extract: layer 2 — on-disk format and
 * semantic contracts (storage layout, zstd container, `started subagent`
 * text protocol, message lifecycle ordering). Those are intent, not code
 * shape; they live in docs/upstream-audit.md and are maintained by hand.
 *
 * What it *suspects*: layer 2 cannot be extracted, but most layer-2 bets leave
 * a shape behind — a string-literal field read off an untyped record, a regex
 * over log text, a WeakMap keyed by an upstream object, a service probed
 * through a cast inside `try`. Those shapes are reported in `--check` against
 * `tests/contracts/implicit-seams.ts`: every suspect must be acknowledged by a
 * seam id or explicitly ignored as internal — in `--check` an unacknowledged
 * suspect (or an unloadable registry) fails the gate; the shape is evidence
 * of a bet, not a defect, so the default mode still just prints the draft.
 *
 * Modes:
 *   (default)  print a markdown draft report to stdout.
 *   --write    write the canonical inventory to `coupling.json` (commit it).
 *   --check    regenerate and deep-compare against `coupling.json`; any drift
 *              (new hook, new value import, new field path) exits 1 — a
 *              coupling change must be a conscious update, mirroring what
 *              baseline.json does for dependency content. The implicit-contract
 *              suspect report gates the same run: an unacknowledged suspect or
 *              an unreadable tests/contracts/implicit-seams.ts also exits 1.
 *
 * Testability: DSH_LOG_ENHANCE_ROOT redirects the repo root (coupling.json,
 * the source roots, and the seam registry all resolve under it — fixture
 * roots in tests/coupling-gate.test.ts).
 *
 * Reusable in any dsh plugin repo as-is: the package scope and the three
 * source roots are the only conventions.
 *
 * @module dsh-log-enhance/scripts/analyze-dsh-coupling
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const SCOPE = '@deepseek-ai/'
const ROOTS = ['src', 'tests', 'scripts']
const REPO_ROOT = process.env.DSH_LOG_ENHANCE_ROOT
  ? resolve(process.cwd(), process.env.DSH_LOG_ENHANCE_ROOT)
  : fileURLToPath(new URL('..', import.meta.url))
const COUPLING_URL = join(REPO_ROOT, 'coupling.json')
const MANIFEST_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies']

const args = process.argv.slice(2)
const known = new Set(['--write', '--check'])
const unknownArgs = args.filter(argument => !known.has(argument))
if (unknownArgs.length > 0) {
  console.error(`unknown argument(s): ${unknownArgs.join(' ')}; usage: analyze-dsh-coupling.mjs [--write | --check]`)
  process.exit(1)
}
const MODE = args.includes('--write') ? 'write' : args.includes('--check') ? 'check' : 'report'

// --- file discovery -----------------------------------------------------------

function listSourceFiles(directory) {
  const files = []
  const walk = current => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(ts|mjs)$/.test(entry) && !/\.d\.ts$/.test(entry)) files.push(path)
    }
  }
  walk(directory)
  return files
}

// --- AST helpers ---------------------------------------------------------------

/** Strip parentheses / casts to reach the expression's base. */
function unwrap(node) {
  let cursor = node
  while (ts.isParenthesizedExpression(cursor) || ts.isAsExpression(cursor)
    || ts.isNonNullExpression(cursor) || ts.isSatisfiesExpression(cursor)) {
    cursor = cursor.expression
  }
  return cursor
}

/** `ctx` (or `something.ctx`) at the base of an expression, casts unwrapped. */
function isCtxBase(node) {
  const base = unwrap(node)
  if (ts.isIdentifier(base)) return base.text === 'ctx'
  return ts.isPropertyAccessExpression(base) && base.name.text === 'ctx'
}

function importKindOf(clause) {
  if (clause === undefined) return 'side-effect'
  if (clause.isTypeOnly) return 'type'
  const named = clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)
    ? clause.namedBindings.elements
    : []
  if (clause.name === undefined && named.length > 0 && named.every(element => element.isTypeOnly)) {
    return 'type'
  }
  return 'value'
}

function importNamesOf(clause) {
  if (clause === undefined) return []
  const names = []
  if (clause.name !== undefined) names.push(clause.name.text)
  if (clause.namedBindings !== undefined) {
    if (ts.isNamespaceImport(clause.namedBindings)) names.push(clause.namedBindings.name.text)
    else for (const element of clause.namedBindings.elements) names.push(element.name.text)
  }
  return names
}

// --- per-file extraction -------------------------------------------------------

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
])

/** `a.b.c` → `{ base: 'a', segments: ['b', 'c'] }`; anything else → null. */
function chainOf(node) {
  const segments = []
  let cursor = node
  for (;;) {
    cursor = unwrap(cursor)
    if (!ts.isPropertyAccessExpression(cursor)) break
    segments.unshift(cursor.name.text)
    cursor = cursor.expression
  }
  return ts.isIdentifier(cursor) ? { base: cursor.text, segments } : null
}

/** `arr ?? []` / `arr || []` → `arr`, so a `for…of` alias keeps its source chain. */
function optionalLeft(node) {
  let cursor = unwrap(node)
  while (ts.isBinaryExpression(cursor)
    && (cursor.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || cursor.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    cursor = unwrap(cursor.left)
  }
  return cursor
}

/** `for…of` element access: `['data', 'inserted']` → `['data', 'inserted[]']`. */
function elementOf(segments) {
  return segments.length === 0
    ? ['[]']
    : [...segments.slice(0, -1), `${segments[segments.length - 1]}[]`]
}

function analyzeFile(path, root, state) {
  const text = readFileSync(path, 'utf8')
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true,
    path.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS)
  const file = `${root}/${relative(join(REPO_ROOT, root), path)}`
  const siteOf = node => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`

  // Local identifier → declaring package, for annotation attribution (src only).
  const localNames = new Map()

  const recordImport = (specifier, kind) => {
    const entry = state.packages[specifier] ?? { roots: {} }
    const bucket = entry.roots[root] ?? { type: [], value: [] }
    if (kind === 'type') bucket.type.push(file)
    else if (kind === 'value') bucket.value.push(file)
    entry.roots[root] = bucket
    state.packages[specifier] = entry
  }

  /** Packages whose imported local name appears inside an annotation's text. */
  const packagesOfAnnotation = annotation => {
    const packages = new Set()
    for (const [name, specifier] of localNames) {
      if (new RegExp(`\\b${name}\\b`).test(annotation)) packages.add(specifier)
    }
    return packages
  }

  /**
   * Field reads and discriminant literals, with the guard context each read
   * runs under. `guards` are recorded as source-text expressions
   * (`{ expr, kind: 'eq'|'ne'|'defined'|'falsy', literal? }`); `loop` carries
   * a `for…of` element binding (`{ binding, elementOf }`) for reads through
   * the loop variable.
   */
  const recordFieldPath = (key, fieldPath, rootType, site, guards = [], loop = null) => {
    const bucket = state.fieldPaths[key] ?? new Map()
    const entry = bucket.get(fieldPath) ?? { rootTypes: new Set(), accesses: new Map() }
    entry.rootTypes.add(rootType)
    const guardId = guard => `${guard.expr}|${guard.kind}|${guard.literal ?? ''}`
    const access = entry.accesses.get(site) ?? { site, guards: [] }
    const seen = new Set(access.guards.map(guardId))
    for (const guard of guards) {
      if (seen.has(guardId(guard))) continue
      seen.add(guardId(guard))
      access.guards.push(guard)
    }
    if (loop !== null) {
      access.elementOf = loop.elementOf
      access.binding = loop.binding
    }
    entry.accesses.set(site, access)
    bucket.set(fieldPath, entry)
    state.fieldPaths[key] = bucket
  }

  const recordDiscriminant = (key, fieldPath, literal) => {
    const bucket = state.discriminants[key] ?? new Map()
    const literals = bucket.get(fieldPath) ?? new Set()
    literals.add(literal)
    bucket.set(fieldPath, literals)
    state.discriminants[key] = bucket
  }

  /**
   * Field reads and discriminant literals inside one function body.
   * `event` is the hook name for a `ctx.on` callback: an unannotated payload
   * parameter is still attributable to the event, even though the package that
   * declares its type lives in the host, not in this source file.
   */
  const analyzeFunction = (node, event) => {
    if (root !== 'src' || node.body === undefined) return

    const tracked = new Map() // local name → { keys, rootType, segments }
    const track = (name, annotation, segments) => {
      const packages = annotation === null ? new Set() : packagesOfAnnotation(annotation)
      const keys = packages.size > 0 ? packages : event === null ? null : new Set([`event:${event}`])
      if (keys === null) return
      tracked.set(name, { keys, rootType: annotation ?? 'unknown', segments })
    }

    for (const parameter of node.parameters) {
      const annotation = parameter.type === undefined ? null : parameter.type.getText(source)
      if (ts.isIdentifier(parameter.name)) {
        track(parameter.name.text, annotation, [])
      } else if (ts.isObjectBindingPattern(parameter.name)) {
        for (const element of parameter.name.elements) {
          if (element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name)) continue
          // `{ agent, message }` reads `payload.agent` / `payload.message`.
          const property = element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text
          track(element.name.text, annotation, [property])
        }
      }
    }
    if (tracked.size === 0) return

    const resolve = node => {
      const chain = chainOf(node)
      if (chain === null) return null
      const info = tracked.get(chain.base)
      if (info === undefined) return null
      return { keys: info.keys, rootType: info.rootType, segments: [...info.segments, ...chain.segments] }
    }

    // Pass 1: locals aliasing a tracked chain. A `for…of` element variable is
    // aliased as `arr[]` so the reads inside the loop keep the loop shape.
    const collect = current => {
      if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)
        && current.initializer !== undefined && !tracked.has(current.name.text)) {
        const info = resolve(current.initializer)
        if (info !== null) tracked.set(current.name.text, info)
      }
      if (ts.isForOfStatement(current) && ts.isVariableDeclarationList(current.initializer)) {
        const declarations = current.initializer.declarations
        const declaration = declarations.length === 1 ? declarations[0] : undefined
        if (declaration !== undefined && ts.isIdentifier(declaration.name)) {
          const info = resolve(optionalLeft(current.expression))
          if (info !== null) tracked.set(declaration.name.text, { ...info, segments: elementOf(info.segments) })
        }
      }
      ts.forEachChild(current, collect)
    }
    collect(node.body)

    // Pass 2: field reads and discriminant literals, carrying the guard
    // context (case labels, early returns, optional chains) so every access
    // records the narrowing it actually runs under. Guards are recorded as
    // source-text expressions; a shape this pass cannot express is dropped,
    // which only widens the probe — the engine's tsc compile is the semantic
    // verifier, so a missed guard fails loudly instead of passing broader.
    const guardId = guard => `${guard.expr}|${guard.kind}|${guard.literal ?? ''}`
    const mergeGuards = (guards, extra) => {
      const seen = new Set(guards.map(guardId))
      const merged = [...guards]
      for (const guard of extra) {
        if (seen.has(guardId(guard))) continue
        seen.add(guardId(guard))
        merged.push(guard)
      }
      return merged
    }

    /**
     * What a condition proves when true (`positive`) and when false
     * (`negative`). null = not expressible as a guard, so the dependent code
     * is probed without it (sound: fewer recorded guards only widen).
     */
    const conditionOf = condition => {
      const unwrapped = unwrap(condition)
      if (ts.isPrefixUnaryExpression(unwrapped) && unwrapped.operator === ts.SyntaxKind.ExclamationToken) {
        const inner = conditionOf(unwrapped.operand)
        return { positive: inner.negative, negative: inner.positive }
      }
      if (ts.isBinaryExpression(unwrapped)) {
        const operator = unwrapped.operatorToken.kind
        if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
          // (A && B) true proves both; the negation is a disjunction — drop.
          const parts = [conditionOf(unwrapped.left), conditionOf(unwrapped.right)]
          return {
            positive: parts.flatMap(part => part.positive ?? []),
            negative: null,
          }
        }
        if (operator === ts.SyntaxKind.BarBarToken) {
          // (A || B) false proves every negated disjunct (unexpressible ones
          // are dropped, which still holds); true proves no single one.
          const parts = [conditionOf(unwrapped.left), conditionOf(unwrapped.right)]
          return {
            positive: null,
            negative: parts.flatMap(part => part.negative ?? []),
          }
        }
        if (EQUALITY.has(operator)) {
          const negated = operator === ts.SyntaxKind.ExclamationEqualsToken
            || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
          for (const [access, literalNode] of [[unwrapped.left, unwrapped.right], [unwrapped.right, unwrapped.left]]) {
            if (resolve(access) === null) continue
            const expr = access.getText(source)
            if (ts.isIdentifier(literalNode) && literalNode.text === 'undefined') {
              return negated
                ? { positive: [{ expr, kind: 'defined' }], negative: null }
                : { positive: null, negative: [{ expr, kind: 'defined' }] }
            }
            if (ts.isStringLiteralLike(literalNode)) {
              const literal = literalNode.text
              return negated
                ? { positive: [{ expr, kind: 'ne', literal }], negative: [{ expr, kind: 'eq', literal }] }
                : { positive: [{ expr, kind: 'eq', literal }], negative: [{ expr, kind: 'ne', literal }] }
            }
          }
        }
      }
      // Truthiness of a tracked chain: `x` narrows optionals to defined and
      // `!x` (via the negation above) to falsy.
      if (resolve(unwrapped) !== null) {
        return { positive: [{ expr: unwrapped.getText(source), kind: 'defined' }], negative: [{ expr: unwrapped.getText(source), kind: 'falsy' }] }
      }
      return { positive: null, negative: null }
    }

    /** Control leaves the statement list at this statement (a terminating
     *  `if` only counts when every branch terminates). */
    const terminates = statement => {
      if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)
        || ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) return true
      if (ts.isBlock(statement)) return statement.statements.some(terminates)
      if (ts.isIfStatement(statement)) {
        return statement.elseStatement !== undefined
          && terminates(statement.thenStatement) && terminates(statement.elseStatement)
      }
      return false
    }

    const walk = (current, scope) => {
      if (ts.isBlock(current)) return walkStatements(current.statements, scope)
      if (ts.isIfStatement(current)) {
        walk(current.expression, scope) // the condition's reads carry the outer scope only
        const { positive, negative } = conditionOf(current.expression)
        walk(current.thenStatement,
          positive === null ? scope : { ...scope, guards: mergeGuards(scope.guards, positive) })
        if (current.elseStatement !== undefined) {
          walk(current.elseStatement,
            negative === null ? scope : { ...scope, guards: mergeGuards(scope.guards, negative) })
        }
        return
      }
      // switch (event.type) { case 'x': … } — every case is a discriminant,
      // and the clause body runs narrowed to the case literal. A clause's
      // guard ends at the next clause: a fall-through inherits nothing, so
      // it is probed conservatively rather than wrongly narrowed.
      if (ts.isSwitchStatement(current)) {
        walk(current.expression, scope)
        const target = resolve(current.expression)
        for (const clause of current.caseBlock.clauses) {
          if (target !== null && ts.isCaseClause(clause) && ts.isStringLiteralLike(clause.expression)) {
            for (const key of target.keys) {
              recordDiscriminant(key, target.segments.join('.'), clause.expression.text)
            }
            const caseGuard = {
              expr: current.expression.getText(source),
              kind: 'eq',
              literal: clause.expression.text,
            }
            walkStatements(clause.statements,
              { ...scope, guards: mergeGuards(scope.guards, [caseGuard]) })
          } else {
            walkStatements(clause.statements, scope)
          }
        }
        return
      }
      if (ts.isForOfStatement(current)) {
        walk(current.expression, scope)
        const declarations = ts.isVariableDeclarationList(current.initializer) ? current.initializer.declarations : []
        const declaration = declarations.length === 1 ? declarations[0] : undefined
        if (declaration !== undefined && ts.isIdentifier(declaration.name)) {
          const origin = optionalLeft(current.expression)
          if (resolve(origin) !== null) {
            // Element binding context: reads through the loop variable
            // record the iterated expression and the binding name.
            walk(current.statement,
              { ...scope, loop: { binding: declaration.name.text, elementOf: origin.getText(source) } })
            return
          }
        }
        walk(current.statement, scope)
        return
      }
      // event.type === 'x' / 'x' !== source.kind — a discriminant comparison.
      if (ts.isBinaryExpression(current) && EQUALITY.has(current.operatorToken.kind)) {
        for (const [left, right] of [[current.left, current.right], [current.right, current.left]]) {
          const literal = unwrap(right)
          if (!ts.isStringLiteralLike(literal)) continue
          const target = resolve(left)
          if (target === null) continue
          for (const key of target.keys) recordDiscriminant(key, target.segments.join('.'), literal.text)
        }
      }
      if (ts.isPropertyAccessExpression(current)) {
        const target = resolve(current)
        if (target !== null) {
          // An optional link (`exec.agent?.id`) narrows its own prefix.
          const optional = []
          for (let link = current; ts.isPropertyAccessExpression(link); link = unwrap(link.expression)) {
            if (link.questionDotToken !== undefined) {
              optional.push({ expr: link.expression.getText(source), kind: 'defined' })
            }
          }
          const guards = mergeGuards(scope.guards, optional)
          for (const key of target.keys) {
            recordFieldPath(key, target.segments.join('.'), target.rootType, siteOf(current), guards, scope.loop)
          }
        }
      }
      ts.forEachChild(current, child => walk(child, scope))
    }
    /**
     * A statement list carries guards proven by earlier terminating `if`s
     * (`if (A || B) return` proves ¬A ∧ ¬B for everything after it).
     */
    const walkStatements = (statements, scope) => {
      let carried = []
      for (const statement of statements) {
        walk(statement, { ...scope, guards: mergeGuards(scope.guards, carried) })
        if (ts.isIfStatement(statement)) {
          const { negative } = conditionOf(statement.expression)
          if (negative !== null && terminates(statement.thenStatement)) carried = mergeGuards(carried, negative)
        }
      }
    }
    walk(node.body, { guards: [], loop: null })
  }

  // A `ctx.on` callback is analyzed once, with its event name; visit() below
  // skips it so the same body is never read twice.
  const analyzed = new WeakSet()

  const visit = node => {
    // Static imports.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text.startsWith(SCOPE)) {
      const specifier = node.moduleSpecifier.text
      const kind = importKindOf(node.importClause)
      recordImport(specifier, kind)
      if (root === 'src') {
        for (const name of importNamesOf(node.importClause)) localNames.set(name, specifier)
      }
    }

    // Dynamic imports: await import('@deepseek-ai/…').
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text.startsWith(SCOPE)) {
      recordImport(node.arguments[0].text, 'value')
    }

    // export const inject = ['a', 'b'] — the service surface the host must
    // provide before this plugin loads at all; a rename here fails silently.
    if (root === 'src' && ts.isVariableStatement(node)
      && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
      && node.declarationList.declarations.length === 1) {
      const declaration = node.declarationList.declarations[0]
      const initializer = declaration.initializer === undefined ? undefined : unwrap(declaration.initializer)
      if (ts.isIdentifier(declaration.name) && declaration.name.text === 'inject'
        && initializer !== undefined && ts.isArrayLiteralExpression(initializer)) {
        for (const element of initializer.elements) {
          const service = unwrap(element)
          if (ts.isStringLiteralLike(service)) state.injectedServices.add(service.text)
        }
      }
    }

    // ctx.on('<event>', (…) => …) — hooks; ctx.emit('<event>', …) — test-side synthesis.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && isCtxBase(node.expression.expression)
      && (node.expression.name.text === 'on' || node.expression.name.text === 'emit')
      && node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0])) {
      const via = node.expression.name.text
      const callback = node.arguments[1]
      const params = via === 'on' && callback !== undefined
        && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        ? callback.parameters.map(parameter => parameter.name.getText(source))
        : []
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
      const hook = { event: node.arguments[0].text, via, params, at: `${file}:${line}` }
      if (root === 'src') state.srcHooks.push(hook)
      else if (root === 'tests') state.testHooks.push(hook)
      if (via === 'on' && callback !== undefined
        && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        analyzed.add(callback)
        analyzeFunction(callback, node.arguments[0].text)
      }
    }

    // ctx.<service> accesses (casts unwrapped, so `(ctx as …).mcpManager` counts).
    if (ts.isPropertyAccessExpression(node) && isCtxBase(node.expression)) {
      const bucket = state.ctxAccesses[node.name.text] ?? new Set()
      bucket.add(file)
      state.ctxAccesses[node.name.text] = bucket
    }

    // Field paths read on parameters annotated with imported DeepSeek types.
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.body !== undefined
      && !analyzed.has(node)) {
      analyzeFunction(node, null)
    }

    ts.forEachChild(node, visit)
  }
  visit(source)
}

// --- implicit suspects (layer 2 forensics) --------------------------------------
//
// Layer 2 is intent, so nothing here proves a contract. What these shapes do
// prove is that the code is *betting* on something the host does not type for
// us: a field name inside a JSON record, a log line's wording, an object's
// reference identity, a service that only exists after the host injects it.
// Each hit is reported against `tests/contracts/implicit-seams.ts` so the bet
// is either bound to a probe or explicitly declared internal.

const REGISTRY_PATH = join(REPO_ROOT, 'tests/contracts/implicit-seams.ts')

/** Types that carry no field guarantee: reading a member off them is a bet. */
const UNTYPED_SHAPE = /^(?:unknown|any|object|\{\}|Record<\s*string\s*,\s*(?:unknown|any)\s*>)$/

/** Calls that launder an untyped value (JSON text in, `Record<string, unknown>` out). */
const UNTYPED_FACTORY = /^(?:JSON\.parse|asRecord|asParams)$/

/** Collapse a node's source text to one readable line for the report. */
function flatten(text, limit = 120) {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`
}

function typeTextOf(typeNode, source) {
  return typeNode === undefined ? '' : flatten(typeNode.getText(source), 200)
}

/** `string`, `number`, `unknown[]`, `readonly Foo[]` — a shape that names no field. */
const PRIMITIVE_SHAPE = /^(?:string|number|boolean|bigint|symbol|(?:readonly\s+)?[\w$.]+(?:<[^>]*>)?\[\])$/

function isPrimitiveShape(text) {
  return PRIMITIVE_SHAPE.test(text.replace(/\s+/g, ' ').trim())
}

/** `unknown | undefined`, `Record<string, unknown>` — a shape with no field contract. */
function isUntypedShape(text) {
  if (text === '') return false
  return UNTYPED_SHAPE.test(text.replace(/\s*\|\s*(?:undefined|null)/g, '').trim())
}

/** Strip only the wrappers that do not change the value's provenance. */
function unwrapValue(node) {
  let cursor = node
  while (ts.isParenthesizedExpression(cursor) || ts.isNonNullExpression(cursor)) cursor = cursor.expression
  return cursor
}

/** `a['b'].c` / `a?.b['c']` → `a.b.c`; falls back to the source text. */
function accessPathOf(node, source) {
  const segments = []
  let cursor = unwrapValue(node)
  for (;;) {
    if (ts.isPropertyAccessExpression(cursor)) {
      segments.unshift(cursor.name.text)
      cursor = unwrapValue(cursor.expression)
      continue
    }
    if (ts.isElementAccessExpression(cursor) && cursor.argumentExpression !== undefined
      && ts.isStringLiteralLike(cursor.argumentExpression)) {
      segments.unshift(cursor.argumentExpression.text)
      cursor = unwrapValue(cursor.expression)
      continue
    }
    break
  }
  const head = ts.isIdentifier(cursor) ? cursor.text : flatten(cursor.getText(source), 40)
  return segments.length === 0 ? head : `${head}.${segments.join('.')}`
}

/**
 * Suspects in one src file.
 *
 * The only inference here is provenance: which locals carry a value with no
 * field contract (JSON.parse output, `asRecord(...)`, a `Record<string, unknown>`
 * / `unknown` / `object` annotation, a caught error, or anything derived from
 * one). Provenance is resolved lexically — bindings live in scopes, so the
 * `usage: TokenUsage` parameter of one function is not smeared into the
 * `usage` record of another — and closed under assignment to a fixed point,
 * because one untyped local usually declares the next
 * (`const usage = asRecord(data?.['usage'])`).
 */
function scanFileForSuspects(file, source) {
  const suspects = []
  const lineAt = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const endLineAt = node => source.getLineAndCharacterOfPosition(Math.max(node.getStart(source), node.getEnd() - 1)).line + 1
  const add = (kind, node, symbol) => suspects.push({
    kind, file, line: lineAt(node), endLine: endLineAt(node), symbol,
  })

  // --- lexical scopes + untyped provenance -------------------------------------

  const scopeAt = new Map() // node → innermost scope in effect at that node
  const untypedEntry = new Map() // binding → does its value carry no field contract?
  const variableEntries = [] // bindings whose untypedness depends on an initializer
  const newScope = parent => ({ parent, bindings: new Map() })
  const rootScope = newScope(null)

  /** Bind one name (or every name of a destructuring pattern) in `scope`. */
  const bind = (scope, name, binding) => {
    if (ts.isIdentifier(name)) {
      const entry = { ...binding, name: name.text }
      scope.bindings.set(name.text, entry)
      return [entry]
    }
    const entries = []
    for (const element of name.elements) {
      if (!ts.isBindingElement(element) || element.dotDotDotToken !== undefined) continue
      entries.push(...bind(scope, element.name, binding))
    }
    return entries
  }

  const catchBindings = new Set() // `catch (e)` declarations, bound by the clause below
  const structure = (node, scope) => {
    let inner = scope
    if (ts.isFunctionLike(node)) {
      inner = newScope(scope)
      for (const parameter of node.parameters) {
        const annotation = typeTextOf(parameter.type, source)
        for (const entry of bind(inner, parameter.name, { from: 'parameter' })) {
          untypedEntry.set(entry, isUntypedShape(annotation))
        }
      }
    } else if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
      // `catch (error)` is `unknown`; naming its shape is exactly the bet we report.
      inner = newScope(scope)
      catchBindings.add(node.variableDeclaration)
      for (const entry of bind(inner, node.variableDeclaration.name, { from: 'catch' })) {
        untypedEntry.set(entry, true)
      }
    } else if (ts.isBlock(node) || ts.isModuleBlock(node)) {
      inner = newScope(scope)
    }
    if (ts.isVariableDeclaration(node) && !catchBindings.has(node)) {
      for (const entry of bind(inner, node.name, { from: 'variable' })) {
        untypedEntry.set(entry, false)
        variableEntries.push({ entry, initializer: node.initializer })
      }
    }
    scopeAt.set(node, inner)
    ts.forEachChild(node, child => structure(child, inner))
  }
  structure(source, rootScope)

  const bindingOf = identifier => {
    let scope = scopeAt.get(identifier) ?? rootScope
    while (scope !== null) {
      const entry = scope.bindings.get(identifier.text)
      if (entry !== undefined) return entry
      scope = scope.parent
    }
    return undefined
  }

  const untypedValue = node => {
    const cursor = unwrapValue(node)
    if (ts.isIdentifier(cursor)) {
      const entry = bindingOf(cursor)
      // A name this file cannot resolve (a global, an import, a callee whose
      // return type we do not model) is left to the type checker.
      return entry !== undefined && untypedEntry.get(entry) === true
    }
    if (ts.isPropertyAccessExpression(cursor) || ts.isElementAccessExpression(cursor)) {
      return untypedValue(cursor.expression)
    }
    if (ts.isCallExpression(cursor)) {
      const callee = unwrapValue(cursor.expression)
      const name = callee.getText(source).replace(/\s+/g, '')
      if (UNTYPED_FACTORY.test(name)) return true
      return ts.isIdentifier(callee) && untypedValue(callee)
    }
    if (ts.isAsExpression(cursor) || ts.isSatisfiesExpression(cursor)) {
      // `(x as string)` / `(x as unknown[])` assert a primitive or array shape,
      // never a field name: the record read underneath is already reported.
      return isPrimitiveShape(typeTextOf(cursor.type, source)) ? false : untypedValue(cursor.expression)
    }
    if (ts.isAwaitExpression(cursor)) return untypedValue(cursor.expression)
    if (ts.isConditionalExpression(cursor)) {
      return untypedValue(cursor.whenTrue) || untypedValue(cursor.whenFalse)
    }
    if (ts.isBinaryExpression(cursor)
      && (cursor.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        || cursor.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      return untypedValue(cursor.left) || untypedValue(cursor.right)
    }
    return false
  }

  // Monotone closure: a binding only ever becomes untyped, so this terminates.
  for (let round = 0; round < 24; round += 1) {
    let changed = false
    for (const { entry, initializer } of variableEntries) {
      if (initializer === undefined || untypedEntry.get(entry) === true) continue
      if (untypedValue(initializer)) {
        untypedEntry.set(entry, true)
        changed = true
      }
    }
    if (!changed) break
  }

  // Local names imported from the host: a WeakMap keyed by one of these bets on
  // the identity of an object the plugin does not own.
  const upstreamNames = new Set()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!statement.moduleSpecifier.text.startsWith(SCOPE)) continue
    for (const name of importNamesOf(statement.importClause)) upstreamNames.add(name)
  }

  // --- reporting pass -----------------------------------------------------------

  const visit = node => {
    // Suspect 1a: a field read on a value with no field contract.
    if (ts.isElementAccessExpression(node) && node.argumentExpression !== undefined
      && ts.isStringLiteralLike(node.argumentExpression) && untypedValue(node.expression)) {
      add('untyped-field', node, accessPathOf(node, source))
    }
    if (ts.isPropertyAccessExpression(node) && untypedValue(node.expression)
      && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
      add('untyped-field', node, accessPathOf(node, source))
    }
    // Suspect 1b: `x as { field: Type }` invents a shape for an untyped value.
    if (ts.isAsExpression(node) && node.type !== undefined
      && node.type.getText(source).trim().startsWith('{') && untypedValue(node.expression)) {
      add('untyped-field', node, `as ${flatten(node.type.getText(source), 100)}`)
    }

    // Suspect 2: a regex is a bet on the exact wording of an upstream string.
    if (ts.isRegularExpressionLiteral(node)) {
      add('regex-protocol', node, flatten(node.getText(source)))
    }

    // Suspect 3: WeakMap identity — the host must hand back the same object.
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'WeakMap'
      && node.typeArguments !== undefined && node.typeArguments.length > 0) {
      const key = typeTextOf(node.typeArguments[0], source)
      const keyName = node.typeArguments[0].getText(source).replace(/\s+/g, '')
      if (isUntypedShape(key) || upstreamNames.has(keyName)) {
        add('weakmap-identity', node, flatten(node.getText(source)))
      }
    }

    // Suspect 4: a service reachable only through a cast, probed inside `try`.
    if (ts.isTryStatement(node)) {
      const scan = current => {
        if (ts.isPropertyAccessExpression(current) && isCtxBase(current.expression)
          && ts.isAsExpression(unwrapValue(current.expression))) {
          add('try-cast-ctx', current, flatten(current.getText(source), 100))
        }
        ts.forEachChild(current, scan)
      }
      scan(node.tryBlock)
    }

    ts.forEachChild(node, visit)
  }
  visit(source)
  return suspects
}

function implicitSuspects() {
  const rootPath = join(REPO_ROOT, 'src')
  if (!existsSync(rootPath)) return []
  const suspects = []
  for (const path of listSourceFiles(rootPath)) {
    const text = readFileSync(path, 'utf8')
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
    suspects.push(...scanFileForSuspects(`src/${relative(rootPath, path)}`, source))
  }
  const seen = new Set()
  return suspects
    .filter(suspect => {
      const key = `${suspect.kind}|${suspect.file}|${suspect.line}|${suspect.symbol}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind))
}

// --- the manual seam registry ----------------------------------------------------

/**
 * One acknowledgement, e.g. `src/mcp/analysis.ts:199`, `src/observer.ts:110-133`,
 * `src/mcp/session-store.ts:24,30`, `src/mcp/analysis.ts:/STARTED_SUBAGENT/`, or
 * a bare `src/foo.ts` for "everything in this file". An optional ` — reason`
 * suffix is for humans and is stripped before matching.
 */
function acknowledgementMatcher(raw) {
  const spec = raw.split(' — ')[0].trim()
  const colon = spec.indexOf(':')
  if (colon === -1) return { spec, scannable: spec.startsWith('src/'), match: suspect => suspect.file === spec }
  const file = spec.slice(0, colon)
  const rest = spec.slice(colon + 1).trim()
  const asPattern = /^\/(.*)\/$/.exec(rest)
  if (asPattern !== null) {
    const pattern = new RegExp(asPattern[1], 'i')
    return {
      spec,
      scannable: file.startsWith('src/'),
      match: suspect => suspect.file === file && pattern.test(suspect.symbol),
    }
  }
  const ranges = rest.split(',').map(part => {
    const [from, to] = part.trim().split('-')
    return [Number(from), Number(to ?? from)]
  })
  return {
    spec,
    scannable: file.startsWith('src/'),
    match: suspect => suspect.file === file
      && ranges.some(([from, to]) => suspect.line <= to && suspect.endLine >= from),
  }
}

async function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) {
    return { seams: [], specifications: [], error: `missing ${relative(REPO_ROOT, REGISTRY_PATH)}` }
  }
  let module
  try {
    // Node ≥ 22.18 / 24 strips the types in place; the file has no runtime deps.
    module = await import(pathToFileURL(REGISTRY_PATH).href)
  } catch (error) {
    return { seams: [], specifications: [], error: `cannot load ${relative(REPO_ROOT, REGISTRY_PATH)}: ${String(error)}` }
  }
  const seams = Array.isArray(module.IMPLICIT_SEAMS) ? module.IMPLICIT_SEAMS : []
  const specifications = seams.flatMap(seam => [
    ...(seam.acknowledged ?? []).map(raw => ({ seam: seam.id, effect: 'acknowledged', ...acknowledgementMatcher(raw) })),
    ...(seam.ignored ?? []).map(raw => ({ seam: seam.id, effect: 'ignored', ...acknowledgementMatcher(raw) })),
  ])
  return { seams, specifications, error: null }
}

/**
 * Compare the scanned suspects with the registry. Returns the report text
 * plus what the `--check` gate rules on: a suspect shape that no seam
 * acknowledges (and no entry ignores) FAILS the gate, and so does a registry
 * that cannot be loaded — an unverifiable report must never read as "all
 * acknowledged".
 */
function suspectSection(suspects, registry) {
  const lines = []
  const unaccounted = suspects.filter(suspect =>
    !registry.specifications.some(specification => specification.match(suspect)))

  lines.push(`## 层 2 · 隐性契约嫌疑扫描（src ${suspects.length} 处嫌疑）`)
  lines.push('')
  lines.push('代码形状由 `scripts/analyze-dsh-coupling.mjs` 提取；每处嫌疑必须在 '
    + '`tests/contracts/implicit-seams.ts` 里绑定到一条隐性契约，或标为 internal。'
    + '`--check` 模式下未报备（或清单不可读）直接判红；默认模式仅打印草表。')
  lines.push('')

  if (registry.error !== null) {
    lines.push(`⚠️  无法读取隐性契约清单：${registry.error}`)
    lines.push('')
    return { text: lines.join('\n'), unaccounted: unaccounted.length, registryError: registry.error }
  }

  const acknowledged = registry.specifications.filter(specification => specification.effect === 'acknowledged')
  const ignored = registry.specifications.filter(specification => specification.effect === 'ignored')
  const covered = suspects.filter(suspect => acknowledged.some(specification => specification.match(suspect)))
  const internal = suspects.filter(suspect => !acknowledged.some(specification => specification.match(suspect))
    && ignored.some(specification => specification.match(suspect)))
  // Seals that match no suspect shape are the ones the type system already
  // covers (a typed `result.value.messageId` is a contract too, just not a
  // shape this pass can see). Count them; do not cry wolf about them.
  const typeCovered = acknowledged.filter(specification => specification.scannable
    && !suspects.some(suspect => specification.match(suspect)))
  lines.push(`${registry.seams.length} 条隐性契约；嫌疑已绑探针 ${covered.length} 处、标为 internal ${internal.length} 处、`
    + `未报备 ${unaccounted.length} 处；另有 ${typeCovered.length} 条盖章已由类型覆盖（不产生嫌疑形状）。`)
  lines.push('')

  if (unaccounted.length === 0) {
    lines.push('all implicit suspects acknowledged')
  } else {
    lines.push(`⚠️  发现 ${unaccounted.length} 处未报备的疑似隐性契约：`)
    unaccounted.forEach((suspect, index) => {
      lines.push(`  ${index + 1}. [${suspect.kind}] ${suspect.file}:${suspect.line} — ${suspect.symbol}`)
      lines.push('     👉 请在 tests/contracts/implicit-seams.ts 中绑定到一条隐性契约探针，或标记为 internal。')
    })
  }

  lines.push('')
  return { text: lines.join('\n'), unaccounted: unaccounted.length, registryError: null }
}

// --- orchestration --------------------------------------------------------------

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const state = {
  packages: {},
  injectedServices: new Set(),
  srcHooks: [],
  testHooks: [],
  ctxAccesses: {},
  fieldPaths: {},
  discriminants: {},
}

for (const root of ROOTS) {
  const rootPath = join(REPO_ROOT, root)
  if (existsSync(rootPath)) {
    for (const path of listSourceFiles(rootPath)) analyzeFile(path, root, state)
  }
}

function declaredInFor(specifier) {
  const exact = MANIFEST_FIELDS.filter(field => manifest[field]?.[specifier] !== undefined)
  if (exact.length > 0) return exact
  const base = specifier.replace(/\/[^/]+$/, '') // subpath import → base package
  return MANIFEST_FIELDS.filter(field => manifest[field]?.[base] !== undefined)
}

/** Deterministic structure for coupling.json (sorted, no timestamps). */
function canonical() {
  const packages = {}
  for (const specifier of Object.keys(state.packages).sort()) {
    const entry = state.packages[specifier]
    const roots = {}
    for (const root of Object.keys(entry.roots).sort()) {
      roots[root] = {
        type: [...new Set(entry.roots[root].type)].sort(),
        value: [...new Set(entry.roots[root].value)].sort(),
      }
    }
    packages[specifier] = { declaredIn: declaredInFor(specifier), roots }
  }
  /** `file:line`, ordered by file then numerically by line. */
  const bySite = (a, b) => {
    const cut = value => value.replace(/:\d+$/, '')
    const line = value => Number(value.slice(value.lastIndexOf(':') + 1))
    return cut(a).localeCompare(cut(b)) || line(a) - line(b)
  }

  // Hooks keep their reading sites exactly like field paths do: the seam
  // verifier reads them from coupling.json instead of re-grepping sources
  // (quoting style or an extracted variable must never break verification).
  const hookSet = hooks => {
    const merged = new Map()
    for (const { event, via, params, at } of hooks) {
      const key = `${event}\x00${via} ${JSON.stringify(params)}`
      if (!merged.has(key)) merged.set(key, { event, via, params, sites: new Set() })
      merged.get(key).sites.add(at)
    }
    return [...merged.values()]
      .map(hook => ({ event: hook.event, via: hook.via, params: hook.params, sites: [...hook.sites].sort(bySite) }))
      .sort((a, b) => a.event.localeCompare(b.event)
        || a.via.localeCompare(b.via)
        || JSON.stringify(a.params).localeCompare(JSON.stringify(b.params)))
  }

  const fieldPaths = {}
  for (const key of Object.keys(state.fieldPaths).sort()) {
    const paths = {}
    for (const fieldPath of [...state.fieldPaths[key].keys()].sort()) {
      const entry = state.fieldPaths[key].get(fieldPath)
      paths[fieldPath] = {
        rootType: [...entry.rootTypes].sort().join('|'),
        accesses: [...entry.accesses.values()]
          .sort((a, b) => bySite(a.site, b.site))
          .map(access => access.elementOf === undefined
            ? { site: access.site, guards: access.guards }
            : { site: access.site, guards: access.guards, elementOf: access.elementOf, binding: access.binding }),
      }
    }
    fieldPaths[key] = paths
  }

  const discriminants = {}
  for (const key of Object.keys(state.discriminants).sort()) {
    const paths = {}
    for (const fieldPath of [...state.discriminants[key].keys()].sort()) {
      paths[fieldPath] = [...state.discriminants[key].get(fieldPath)].sort()
    }
    discriminants[key] = paths
  }

  return {
    packages,
    injectedServices: [...state.injectedServices].sort(),
    srcHooks: hookSet(state.srcHooks),
    testHooks: hookSet(state.testHooks),
    ctxAccesses: Object.fromEntries(
      Object.keys(state.ctxAccesses).sort()
        .map(name => [name, [...state.ctxAccesses[name]].sort()]),
    ),
    fieldPaths,
    discriminants,
  }
}

// --- report ----------------------------------------------------------------------

function report(data) {
  const lines = []
  lines.push('# DeepSeek 耦合面清单（机械层）')
  lines.push('')
  lines.push('由 `scripts/analyze-dsh-coupling.mjs` 生成：层 0（npm 面）、层 1（进程内契约）、层 3（验证契约）。')
  lines.push('层 2（读盘格式与语义契约）无法从代码形状提取，由人维护在 `docs/upstream-audit.md`。')
  lines.push('`--write` 固化到 `coupling.json`；`--check` 是漂移门禁（与 baseline.json 同语义：变化必须是有意识的决定）。')
  lines.push('')

  lines.push(`## 层 0 · npm 包面（${Object.keys(data.packages).length} 个包）`)
  lines.push('')
  lines.push(`| 包 | 声明位置 | ${ROOTS.join(' | ')} |`)
  lines.push(`|---|---|${ROOTS.map(() => '---').join('|')}|`)
  for (const [specifier, entry] of Object.entries(data.packages)) {
    const cells = ROOTS.map(root => {
      const bucket = entry.roots[root]
      if (bucket === undefined) return '—'
      const parts = []
      if (bucket.type.length > 0) parts.push(`type: ${bucket.type.join(', ')}`)
      if (bucket.value.length > 0) parts.push(`value: ${bucket.value.join(', ')}`)
      return parts.length > 0 ? parts.join('<br>') : 'side-effect'
    })
    lines.push(`| ${specifier} | ${entry.declaredIn.join(' + ') || '未声明'} | ${cells.join(' | ')} |`)
  }
  lines.push('')

  lines.push(`## 层 1 · 进程内契约（src 注册 ${data.srcHooks.length} 个 hook）`)
  lines.push('')
  lines.push(`插件注入面（\`export const inject\`；宿主服务改名即插件静默不启动）：${data.injectedServices.join(', ') || '—'}`)
  lines.push('')
  lines.push('| 事件 | via | 回调参数形状 | 位置 |')
  lines.push('|---|---|---|---|')
  for (const hook of state.srcHooks) {
    lines.push(`| ${hook.event} | ctx.${hook.via} | (${hook.params.join(', ')}) | ${hook.at} |`)
  }
  lines.push('')
  lines.push('### ctx 服务访问')
  lines.push('')
  lines.push('| 服务 | 文件 |')
  lines.push('|---|---|')
  for (const [name, files] of Object.entries(data.ctxAccesses)) {
    lines.push(`| ctx.${name} | ${files.join(', ')} |`)
  }
  lines.push('')
  lines.push('### 按类型注解归属的字段读取面（observer 侧 payload 契约）')
  lines.push('')
  lines.push('`event:<事件>` 表示该 hook 回调的参数没有类型注解，字段读取归属只能记到事件上。')
  lines.push('')
  lines.push('| 归属（包 / 事件） | 字段路径（根类型）与读取点 |')
  lines.push('|---|---|')
  for (const [specifier, paths] of Object.entries(data.fieldPaths)) {
    const cells = Object.entries(paths)
      .map(([fieldPath, entry]) => `${fieldPath} <sub>${entry.rootType}</sub> (${entry.accesses.map(access => access.site).join(', ')})`)
    lines.push(`| ${specifier} | ${cells.join('<br>')} |`)
  }
  lines.push('')
  lines.push('### 判别字面量（`switch` case 与 `===` 比较里的字符串）')
  lines.push('')
  lines.push('| 归属（包 / 事件） | 判别字段 | 字面量 |')
  lines.push('|---|---|---|')
  for (const [specifier, paths] of Object.entries(data.discriminants)) {
    for (const [fieldPath, literals] of Object.entries(paths)) {
      lines.push(`| ${specifier} | ${fieldPath} | ${literals.map(literal => `\`${literal}\``).join(', ')} |`)
    }
  }
  lines.push('')

  lines.push(`## 层 3 · 验证契约（tests 触碰 ${data.testHooks.length} 处）`)
  lines.push('')
  lines.push('| 事件 | via | 参数形状 | 位置 |')
  lines.push('|---|---|---|---|')
  for (const hook of state.testHooks) {
    lines.push(`| ${hook.event} | ctx.${hook.via} | (${hook.params.join(', ')}) | ${hook.at} |`)
  }
  lines.push('')
  const testOnly = Object.entries(data.packages)
    .filter(([, entry]) => !Object.keys(entry.roots).includes('src'))
    .map(([specifier]) => specifier)
  lines.push(`仅 tests/scripts 引用的包（验证列车，不随插件发布）：${testOnly.join(', ')}`)
  lines.push('')
  return lines.join('\n')
}

// --- diff for the check failure message -------------------------------------------

function sectionDiff(before, after) {
  const entriesOf = value => Array.isArray(value)
    ? value.map(entry => [JSON.stringify(entry), entry])
    : Object.entries(value ?? {})
  const beforeMap = new Map(entriesOf(before))
  const afterMap = new Map(entriesOf(after))
  const lines = []
  for (const [key, entry] of afterMap) {
    if (!beforeMap.has(key)) lines.push(`+ ${key}`)
    else if (JSON.stringify(beforeMap.get(key)) !== JSON.stringify(entry)) lines.push(`~ ${key}`)
  }
  for (const key of beforeMap.keys()) {
    if (!afterMap.has(key)) lines.push(`- ${key}`)
  }
  return lines
}

// --- driver ------------------------------------------------------------------------

const data = canonical()

if (MODE === 'write') {
  writeFileSync(COUPLING_URL, `${JSON.stringify(data, null, 2)}\n`)
  const discriminants = Object.values(data.discriminants)
    .reduce((total, paths) => total + Object.keys(paths).length, 0)
  console.log(`coupling.json written: ${Object.keys(data.packages).length} packages, `
    + `${data.injectedServices.length} injected services, ${data.srcHooks.length} src hooks, `
    + `${discriminants} discriminant paths, ${data.testHooks.length} test touch points`)
} else if (MODE === 'check') {
  let committed
  try {
    committed = JSON.parse(readFileSync(COUPLING_URL, 'utf8'))
  } catch {
    console.error('coupling.json 缺失或不可读：先跑默认模式 review 草表，再 --write 生成并提交')
    process.exit(1)
  }
  const drifted = Object.keys(data).filter(
    section => JSON.stringify(committed[section]) !== JSON.stringify(data[section]),
  )
  if (drifted.length === 0) {
    console.log('coupling inventory matches coupling.json')
  } else {
    console.error(`耦合面与 coupling.json 漂移（${drifted.join(', ')}）：`)
    for (const section of drifted) {
      for (const line of sectionDiff(committed[section], data[section])) console.error(`  ${line}`)
    }
    console.error('若是有意的耦合变更：review 默认模式的草表后 --write 固化；否则这是意外耦合，先改代码。')
  }

  // Implicit-contract suspect gate: every suspect shape must be bound to a
  // seam or explicitly ignored, and the registry must be loadable at all.
  // Printed even when the drift gate above failed, so one run shows both.
  const suspects = implicitSuspects()
  const registry = await loadRegistry()
  const suspectReport = suspectSection(suspects, registry)
  console.log('')
  console.log(suspectReport.text)
  if (suspectReport.registryError !== null) {
    console.error(`FAIL cannot verify implicit-contract suspects: ${suspectReport.registryError}`)
    process.exit(1)
  }
  if (suspectReport.unaccounted > 0) {
    console.error(`FAIL ${suspectReport.unaccounted} unacknowledged implicit-contract suspect(s) listed above — ` +
      'bind each to a seam in tests/contracts/implicit-seams.ts or mark it internal')
    process.exit(1)
  }

  if (drifted.length > 0) process.exit(1)
} else {
  console.log(report(data))
  const suspects = implicitSuspects()
  const registry = await loadRegistry()
  console.log(suspectSection(suspects, registry).text)
}
