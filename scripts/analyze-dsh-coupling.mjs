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
 *     the package the annotation type came from.
 *   - Layer 3: hook/emit touch points used by tests (verification contracts)
 *     and packages that only tests/scripts import.
 *
 * What it deliberately does NOT extract: layer 2 — on-disk format and
 * semantic contracts (storage layout, zstd container, `started subagent`
 * text protocol, message lifecycle ordering). Those are intent, not code
 * shape; they live in docs/upstream-audit.md and are maintained by hand.
 *
 * Modes:
 *   (default)  print a markdown draft report to stdout.
 *   --write    write the canonical inventory to `coupling.json` (commit it).
 *   --check    regenerate and deep-compare against `coupling.json`; any drift
 *              (new hook, new value import, new field path) exits 1 — a
 *              coupling change must be a conscious update, mirroring what
 *              baseline.json does for dependency content.
 *
 * Reusable in any dsh plugin repo as-is: the package scope and the three
 * source roots are the only conventions.
 *
 * @module dsh-log-enhance/scripts/analyze-dsh-coupling
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SCOPE = '@deepseek-ai/'
const ROOTS = ['src', 'tests', 'scripts']
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const COUPLING_URL = new URL('../coupling.json', import.meta.url)
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

function analyzeFile(path, root, state) {
  const text = readFileSync(path, 'utf8')
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true,
    path.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS)
  const file = `${root}/${relative(join(REPO_ROOT, root), path)}`

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
    }

    // ctx.<service> accesses (casts unwrapped, so `(ctx as …).mcpManager` counts).
    if (ts.isPropertyAccessExpression(node) && isCtxBase(node.expression)) {
      const bucket = state.ctxAccesses[node.name.text] ?? new Set()
      bucket.add(file)
      state.ctxAccesses[node.name.text] = bucket
    }

    // Field paths read on parameters annotated with imported DeepSeek types (src only).
    if (root === 'src' && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.body !== undefined) {
      const watch = new Map() // parameter name → declaring packages
      for (const parameter of node.parameters) {
        if (!ts.isIdentifier(parameter.name) || parameter.type === undefined) continue
        const annotation = parameter.type.getText(source)
        for (const [name, specifier] of localNames) {
          if (new RegExp(`\\b${name}\\b`).test(annotation)) {
            const packages = watch.get(parameter.name.text) ?? new Set()
            packages.add(specifier)
            watch.set(parameter.name.text, packages)
          }
        }
      }
      if (watch.size > 0) {
        // Locals derived from watched parameters (`const value = result.value`)
        // extend the tracked surface — chains read through them count too.
        const aliases = new Map() // local name → { param, prefix }
        const collectAliases = current => {
          if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)
            && current.initializer !== undefined) {
            const chain = []
            let cursor = unwrap(current.initializer)
            while (ts.isPropertyAccessExpression(cursor)) {
              chain.unshift(cursor.name.text)
              cursor = cursor.expression
            }
            if (ts.isIdentifier(cursor) && (watch.has(cursor.text) || aliases.has(cursor.text))) {
              const base = watch.has(cursor.text)
                ? { param: cursor.text, prefix: [] }
                : aliases.get(cursor.text)
              aliases.set(current.name.text, { param: base.param, prefix: [...base.prefix, ...chain] })
            }
          }
          ts.forEachChild(current, collectAliases)
        }
        collectAliases(node.body)

        const walkBody = current => {
          if (ts.isPropertyAccessExpression(current)) {
            const chain = []
            let cursor = current
            while (ts.isPropertyAccessExpression(cursor)) {
              chain.unshift(cursor.name.text)
              cursor = cursor.expression
            }
            if (ts.isIdentifier(cursor)) {
              let param = null
              let prefix = []
              if (watch.has(cursor.text)) {
                param = cursor.text
              } else if (aliases.has(cursor.text)) {
                const alias = aliases.get(cursor.text)
                param = alias.param
                prefix = alias.prefix
              }
              if (param !== null) {
                for (const specifier of watch.get(param)) {
                  const bucket = state.fieldPaths[specifier] ?? new Set()
                  bucket.add([...prefix, ...chain].join('.'))
                  state.fieldPaths[specifier] = bucket
                }
              }
            }
          }
          ts.forEachChild(current, walkBody)
        }
        walkBody(node.body)
      }
    }

    ts.forEachChild(node, visit)
  }
  visit(source)
}

// --- orchestration --------------------------------------------------------------

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const state = { packages: {}, srcHooks: [], testHooks: [], ctxAccesses: {}, fieldPaths: {} }

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
  const hookSet = hooks => hooks
    .map(({ event, via, params }) => ({ event, via, params }))
    .sort((a, b) => a.event.localeCompare(b.event)
      || a.via.localeCompare(b.via)
      || JSON.stringify(a.params).localeCompare(JSON.stringify(b.params)))
  return {
    packages,
    srcHooks: hookSet(state.srcHooks),
    testHooks: hookSet(state.testHooks),
    ctxAccesses: Object.fromEntries(
      Object.keys(state.ctxAccesses).sort()
        .map(name => [name, [...state.ctxAccesses[name]].sort()]),
    ),
    fieldPaths: Object.fromEntries(
      Object.keys(state.fieldPaths).sort()
        .map(specifier => [specifier, [...state.fieldPaths[specifier]].sort()]),
    ),
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
  lines.push('| 注解类型来源包 | 读取的字段路径 |')
  lines.push('|---|---|')
  for (const [specifier, paths] of Object.entries(data.fieldPaths)) {
    lines.push(`| ${specifier} | ${paths.join(', ')} |`)
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
  console.log(`coupling.json written: ${Object.keys(data.packages).length} packages, `
    + `${data.srcHooks.length} src hooks, ${data.testHooks.length} test touch points`)
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
    process.exit(1)
  }
} else {
  console.log(report(data))
}
