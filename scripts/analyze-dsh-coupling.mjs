#!/usr/bin/env node
/**
 * 根据插件源码生成 DeepSeek 上游依赖清单。使用 TypeScript AST 分析语法，
 * 不直接用正则匹配整段源码。
 *
 * 提取内容：
 *   - 所有 `@deepseek-ai/*` 静态和动态 import，按 src / tests / scripts、
 *     类型或值导入，以及 package.json 中的声明字段分类。
 *   - src 中的 `ctx.on('<event>', …)` 注册及回调参数形状、`ctx.<service>`
 *     访问，以及带有上游类型注解的参数字段读取。每条字段路径保留所有
 *     `文件:行号` 访问位置、根类型和实际生效的类型收窄条件，包括 case、
 *     提前返回和可选链。这样上游字段改名或类型变化可以定位到具体源码。
 *   - 没有类型注解可依赖的信息：`export const inject`、字符串判别值、
 *     `for…of` 遍历元素的字段，以及未标注类型的 hook 载荷字段。后者记录在
 *     `event:<event>` 下，因为仅凭源码无法确定声明它的上游包。
 *   - tests 中的 hook/emit 调用，以及仅由 tests/scripts 引入的包。
 *
 * 不自动提取文件格式和业务语义，例如存储布局、zstd 容器、文本协议和消息
 * 生命周期顺序。这些约束由各消费仓人工维护在本仓的审计文档中（路径自定）。
 *
 * 对无法自动验证的隐含依赖，只报告可能相关的代码形状，例如无类型记录上的
 * 字段读取、日志文本正则、以上游对象为键的 WeakMap，以及在 try 中通过类型
 * 断言访问服务。`--check` 会要求这些位置在 tests/contracts/implicit-seams.ts
 * 中关联到一条检查规则，或明确标记为本项目内部逻辑。扫描结果表示需要检查的
 * 隐含依赖，不表示代码一定有缺陷；默认模式只输出报告草稿。
 *
 * 模式：
 *   默认模式  向标准输出打印 Markdown 报告草稿。
 *   --write   生成规范的 `coupling.json`，应提交到仓库。
 *   --check   重新扫描并与 `coupling.json` 比较；新增 hook、值导入或字段路径等
 *             差异会退出 1，要求明确更新清单。未确认的隐含依赖或无法读取
 *             tests/contracts/implicit-seams.ts 也会退出 1。
 *
 * 测试重定向：DSH_SEAM_ROOT（兼容旧名 DSH_LOG_ENHANCE_ROOT）指定仓库根目录，
 * coupling.json、源码目录和隐含依赖清单都从该目录解析。测试夹具见
 * tests/coupling-gate.test.ts。
 *
 * 可复用于其他 DSH 插件仓库，只需遵循包 scope 和 src/tests/scripts 目录约定。
 *
 * @module dsh-seam/scripts/analyze-dsh-coupling
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCOPE = '@deepseek-ai/'
const ROOTS = ['src', 'tests', 'scripts']
const ROOT_OVERRIDE = process.env.DSH_SEAM_ROOT ?? process.env.DSH_LOG_ENHANCE_ROOT
const REPO_ROOT = ROOT_OVERRIDE
  ? resolve(process.cwd(), ROOT_OVERRIDE)
  : fileURLToPath(new URL('..', import.meta.url))
const COUPLING_URL = join(REPO_ROOT, 'coupling.json')
const MANIFEST_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies']

function loadTypeScript() {
  const anchors = [
    import.meta.url,
    pathToFileURL(join(REPO_ROOT, 'package.json')).href,
    pathToFileURL(join(process.cwd(), 'package.json')).href,
  ]
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)('typescript')
    } catch {}
  }
  throw new Error(`cannot resolve package "typescript" from ${REPO_ROOT} or ${fileURLToPath(import.meta.url)}`)
}

const ts = loadTypeScript()

const args = process.argv.slice(2)
const known = new Set(['--write', '--check', '--json'])
const unknownArgs = args.filter(argument => !known.has(argument))
if (unknownArgs.length > 0) {
  console.error(`unknown argument(s): ${unknownArgs.join(' ')}; usage: analyze-dsh-coupling.mjs [--write | --check | --json]`)
  process.exit(1)
}
const activeModes = ['--write', '--check', '--json'].filter(flag => args.includes(flag))
if (activeModes.length > 1) {
  console.error(`${activeModes.join(' and ')} are mutually exclusive; usage: analyze-dsh-coupling.mjs [--write | --check | --json]`)
  process.exit(1)
}
const MODE = args.includes('--write') ? 'write' : args.includes('--check') ? 'check' : args.includes('--json') ? 'json' : 'report'

// --- file discovery -----------------------------------------------------------

function listDtsFiles(directory) {
  const files = []
  if (!existsSync(directory)) return files
  try {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry)
      if (!statSync(full).isDirectory() && entry.endsWith('.d.ts')) files.push(full)
    }
  } catch {}
  const srcDir = join(directory, 'src')
  if (existsSync(srcDir)) {
    const walk = current => {
      for (const entry of readdirSync(current)) {
        const full = join(current, entry)
        if (statSync(full).isDirectory()) walk(full)
        else if (entry.endsWith('.d.ts')) files.push(full)
      }
    }
    try { walk(srcDir) } catch {}
  }
  return files.sort()
}

const TS_BUILTIN_TYPES = new Set([
  'Array', 'ReadonlyArray', 'Readonly', 'Record', 'Partial', 'Required',
  'Pick', 'Omit', 'Exclude', 'Extract', 'NonNullable', 'Promise', 'Map',
  'Set', 'Date', 'RegExp', 'Error', 'Uint8Array', 'PromiseLike',
  'Iterable', 'AsyncIterable',
])

const CORDIS_BUILTIN_CONTEXT_MEMBERS = new Set([
  'on', 'once', 'emit', 'parallel', 'bail', 'serial', 'plugin', 'inject',
  'provide', 'scope', 'registry', 'events', 'reflect', 'get', 'set',
  'mixin', 'extend', 'isolate', 'effect', 'accept', 'dispose',
])

function isContextTypeText(annotation, contextTypeNames, localNames) {
  if (annotation === null) return false
  const core = unwrapReadonly(annotation).replace(/<.*>$/s, '').trim()
  if (contextTypeNames.has(core)) return true
  if (/^import\(\s*['"]@deepseek-ai\/cordis['"]\s*\)\.Context$/.test(core)) return true
  const dot = core.indexOf('.')
  if (dot !== -1) {
    const ns = core.slice(0, dot).trim()
    const member = core.slice(dot + 1).trim()
    return localNames.get(ns) === '@deepseek-ai/cordis' && member === 'Context'
  }
  return false
}

function leftmostTypeIdentifier(typeName) {
  let cursor = typeName
  while (ts.isQualifiedName(cursor)) cursor = cursor.left
  return ts.isIdentifier(cursor) ? cursor : null
}

function sanitizeAugmentationType(typeNode, source, localNames, localExportedNames, extraTypeParams = new Set()) {
  if (typeNode === undefined) return 'any'
  const scopedTypeParams = new Set(extraTypeParams)
  const collectTypeParams = current => {
    if (ts.isTypeParameterDeclaration(current)) scopedTypeParams.add(current.name.text)
    ts.forEachChild(current, collectTypeParams)
  }
  collectTypeParams(typeNode)

  // Object type literals may separate members by newlines — load-bearing
  // syntax that the whitespace collapse below would erase (J2: `{ a: string`
  // `\nb: number }` collapsed to `{ a: string b: number }`, an invalid type).
  // Serialize literals member by member with explicit `; ` separators,
  // recursing into member types so nested literals and identifier rewrites
  // keep working.
  if (ts.isTypeLiteralNode(typeNode)) {
    const members = typeNode.members.map(member =>
      augmentationMemberText(member, source, localNames, localExportedNames, scopedTypeParams))
    return `{ ${members.join('; ')} }`
  }

  let valid = true
  const replacements = []
  const inspect = current => {
    if (!valid) return
    if (ts.isTypeQueryNode(current)) {
      valid = false
      return
    }
    if (ts.isImportTypeNode(current)) {
      if (!(ts.isLiteralTypeNode(current.argument) && ts.isStringLiteral(current.argument.literal)
        && current.argument.literal.text.startsWith(SCOPE))) {
        valid = false
        return
      }
    }
    if (ts.isTypeReferenceNode(current)) {
      const rootId = leftmostTypeIdentifier(current.typeName)
      if (rootId === null) {
        valid = false
        return
      }
      const name = rootId.text
      const pkg = localNames.get(name)
      if (pkg !== undefined) {
        const exported = localExportedNames.get(name)
        const replacement = exported === '*'
          ? `import('${pkg}')`
          : `import('${pkg}').${exported ?? name}`
        replacements.push({ start: rootId.getStart(source), end: rootId.getEnd(), text: replacement })
      } else if (!TS_BUILTIN_TYPES.has(name) && !scopedTypeParams.has(name)) {
        valid = false
        return
      }
    }
    ts.forEachChild(current, inspect)
  }
  inspect(typeNode)
  if (!valid) return 'any'

  const baseStart = typeNode.getStart(source)
  const raw = typeNode.getText(source)
  if (replacements.length === 0) return raw.replace(/\s+/g, ' ').trim()
  replacements.sort((a, b) => b.start - a.start)
  let out = raw
  for (const rep of replacements) {
    out = out.slice(0, rep.start - baseStart) + rep.text + out.slice(rep.end - baseStart)
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** One type-literal member, single-line, separators made explicit (J2). */
function augmentationMemberText(member, source, localNames, localExportedNames, scopedTypeParams) {
  const name = member.name === undefined ? '' : member.name.getText(source)
  const optional = member.questionToken === undefined ? '' : '?'
  const paramText = param => {
    if (!ts.isIdentifier(param.name)) return param.getText(source).replace(/\s+/g, ' ').trim()
    const prefix = `${param.dotDotDotToken !== undefined ? '...' : ''}${param.name.text}${param.questionToken !== undefined ? '?' : ''}`
    const type = sanitizeAugmentationType(param.type, source, localNames, localExportedNames, scopedTypeParams)
    return `${prefix}: ${type}`
  }
  if (ts.isPropertySignature(member)) {
    const type = sanitizeAugmentationType(member.type, source, localNames, localExportedNames, scopedTypeParams)
    return `${name}${optional}: ${type}`
  }
  if (ts.isMethodSignature(member)) {
    const memberTypeParams = new Set(scopedTypeParams)
    for (const tp of member.typeParameters ?? []) memberTypeParams.add(tp.name.text)
    const typeParams = member.typeParameters === undefined || member.typeParameters.length === 0
      ? ''
      : `<${member.typeParameters.map(tp => tp.getText(source).replace(/\s+/g, ' ').trim()).join(', ')}>`
    const params = member.parameters.map(paramText).join(', ')
    const returnType = sanitizeAugmentationType(member.type, source, localNames, localExportedNames, memberTypeParams)
    return `${name}${optional}${typeParams}(${params}): ${returnType}`
  }
  if (ts.isIndexSignatureDeclaration(member)) {
    const params = member.parameters.map(paramText).join(', ')
    const type = sanitizeAugmentationType(member.type, source, localNames, localExportedNames, scopedTypeParams)
    return `${member.readonlyToken !== undefined ? 'readonly ' : ''}[${params}]: ${type}`
  }
  // Call/construct signatures and anything exotic: source text with whitespace
  // collapsed. Nested literals inside these rare members keep the pre-J2
  // behavior rather than failing outright.
  return member.getText(source).replace(/\s+/g, ' ').trim()
}

function extractModuleAugmentations(source, localNames, localExportedNames, siteOf, onMember) {
  const visit = current => {
    if (ts.isModuleDeclaration(current) && ts.isStringLiteral(current.name)
      && current.name.text.startsWith(SCOPE) && current.body !== undefined
      && ts.isModuleBlock(current.body)) {
      const pkg = current.name.text
      for (const stmt of current.body.statements) {
        if (!ts.isInterfaceDeclaration(stmt)) continue
        const ifaceName = stmt.name.text
        const ifaceTypeParams = new Set((stmt.typeParameters ?? []).map(tp => tp.name.text))
        for (const member of stmt.members) {
          const memberNameNode = member.name
          if (memberNameNode === undefined
            || (!ts.isIdentifier(memberNameNode) && !ts.isStringLiteralLike(memberNameNode)
              && !ts.isNumericLiteral(memberNameNode))) continue
          const memberName = memberNameNode.text
          const site = siteOf(member)
          const extractParams = (parameters, memberTypeParams) => {
            const localParams = new Set(ifaceTypeParams)
            for (const tp of memberTypeParams ?? []) localParams.add(tp.name.text)
            return parameters.map((param, index) => {
              const rawName = ts.isIdentifier(param.name) ? param.name.text
                : param.name.getText(source) === 'this' ? 'this'
                : `arg${index}`
              const rest = param.dotDotDotToken !== undefined
              const optional = param.questionToken !== undefined
              let type = sanitizeAugmentationType(param.type, source, localNames, localExportedNames, localParams)
              if (rest && type === 'any') type = 'any[]'
              return {
                name: rawName,
                type,
                ...(optional ? { optional: true } : {}),
                ...(rest ? { rest: true } : {}),
              }
            })
          }
          if (ts.isMethodSignature(member)) {
            onMember(pkg, ifaceName, memberName, {
              kind: 'method',
              params: extractParams(member.parameters, member.typeParameters),
              site,
            })
          } else if (ts.isPropertySignature(member)) {
            let memberType = member.type
            while (memberType !== undefined && ts.isParenthesizedTypeNode(memberType)) {
              memberType = memberType.type
            }
            if (memberType !== undefined && ts.isFunctionTypeNode(memberType)) {
              onMember(pkg, ifaceName, memberName, {
                kind: 'method',
                params: extractParams(memberType.parameters, memberType.typeParameters),
                ...(member.questionToken !== undefined ? { optional: true } : {}),
                site,
              })
            } else {
              onMember(pkg, ifaceName, memberName, {
                kind: 'property',
                type: sanitizeAugmentationType(member.type, source, localNames, localExportedNames, ifaceTypeParams),
                optional: member.questionToken !== undefined,
                site,
              })
            }
          }
        }
      }
    }
    ts.forEachChild(current, visit)
  }
  visit(source)
}

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
    || ts.isTypeAssertionExpression(cursor) || ts.isNonNullExpression(cursor)
    || ts.isSatisfiesExpression(cursor)) {
    cursor = cursor.expression
  }
  return cursor
}

/** Strip only wrappers that do not alter the expression's type or cast intent. */
function unwrapValue(node) {
  let cursor = node
  while (ts.isParenthesizedExpression(cursor) || ts.isNonNullExpression(cursor)) cursor = cursor.expression
  return cursor
}

const DEFAULT_CTX_NAMES = new Set(['ctx'])

/** `ctx` (or `something.ctx`, or any `: Context` parameter in scope) at the base of an expression, casts unwrapped. */
function isCtxBase(node, ctxNames = DEFAULT_CTX_NAMES) {
  const base = unwrap(node)
  if (ts.isIdentifier(base)) return ctxNames.has(base.text)
  return ts.isPropertyAccessExpression(base) && base.name.text === 'ctx'
}

const PARAMETER_NAMES = {
  Context: 'ctx',
  Agent: 'agent',
  Session: 'session',
  SessionEvent: 'event',
  ToolExecution: 'exec',
  'Readonly<ToolExecution>': 'exec',
  'Readonly<ToolExecution>|ToolExecution': 'exec',
  'Readonly<ToolExecutionResult>': 'result',
}

function unwrapReadonly(text) {
  let core = text.trim()
  for (;;) {
    const wrapped = /^Readonly<(.*)>$/.exec(core)
    if (wrapped === null) break
    core = wrapped[1].trim()
  }
  return core
}

function splitTopLevelUnion(text) {
  const parts = []
  let depth = 0
  let current = ''
  for (const character of text) {
    if (character === '<' || character === '(') depth += 1
    if (character === '>' || character === ')') depth -= 1
    if (character === '|' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  parts.push(current.trim())
  return parts.filter(part => part !== '' && part !== 'undefined' && part !== 'null')
}

/** Canonical probe parameter name for a rootType (matches engine.ts's `parameterNameOf`). */
function parameterNameOf(rootType) {
  const known = PARAMETER_NAMES[rootType]
  if (known !== undefined) return known
  const members = splitTopLevelUnion(rootType)
  const candidate = members.length === 1 ? members[0] : rootType
  const core = unwrapReadonly(candidate)
  if (PARAMETER_NAMES[core] !== undefined) return PARAMETER_NAMES[core]
  const identifier = /([A-Za-z_$][\w$]*)\s*$/.exec(core)?.[1] ?? 'value'
  return identifier.charAt(0).toLowerCase() + identifier.slice(1)
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

function exportKindOf(node) {
  if (node.isTypeOnly) return 'type'
  if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
    const elements = node.exportClause.elements
    if (elements.length > 0 && elements.every(element => element.isTypeOnly)) return 'type'
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

/** `a.b?.c` → `{ base: 'a', segments: ['b', 'c'], dotted: ['.b', '?.c'], hasCast }`; anything else → null. */
function chainOf(node) {
  const segments = []
  const dotted = []
  let hasCast = false
  let cursor = node
  for (;;) {
    while (ts.isParenthesizedExpression(cursor) || ts.isAsExpression(cursor)
      || ts.isTypeAssertionExpression(cursor) || ts.isNonNullExpression(cursor)
      || ts.isSatisfiesExpression(cursor)) {
      if (ts.isAsExpression(cursor) || ts.isTypeAssertionExpression(cursor)) hasCast = true
      cursor = cursor.expression
    }
    if (!ts.isPropertyAccessExpression(cursor)) break
    segments.unshift(cursor.name.text)
    dotted.unshift(`${cursor.questionDotToken !== undefined ? '?.' : '.'}${cursor.name.text}`)
    cursor = cursor.expression
  }
  return ts.isIdentifier(cursor) ? { base: cursor.text, segments, dotted, hasCast } : null
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
  const file = `${root}/${relative(join(REPO_ROOT, root), path).replaceAll('\\', '/')}`
  const siteOf = node => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`

  // Local identifier → declaring package, for annotation attribution (src only).
  const localNames = new Map()
  // Local identifier → original exported symbol name (or '*' for namespace import).
  const localExportedNames = new Map()
  // Local identifiers imported as `Context` from `@deepseek-ai/cordis`.
  const contextTypeNames = new Set()
  // Identifier names in scope currently typed as Cordis `Context`.
  const ctxNames = new Set(['ctx'])

  const isContextAnnotation = annotation => isContextTypeText(annotation, contextTypeNames, localNames)

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
    for (const match of annotation.matchAll(/import\(\s*['"](@deepseek-ai\/[^'"]+)['"]\s*\)/g)) {
      packages.add(match[1])
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
    if (rootType === 'Context' && fieldPath !== '') {
      const firstSeg = fieldPath.split('.')[0].replace(/\[\]$/, '')
      if (firstSeg !== '') {
        const ctxBucket = state.ctxAccesses[firstSeg] ?? new Set()
        ctxBucket.add(file)
        state.ctxAccesses[firstSeg] = ctxBucket
      }
    }
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

    const tracked = new Map() // local name → { keys, rootType, segments, exprPrefix, isCtx }
    const track = (name, annotation, segments, exprPrefix, isCtx = false, customKey = null) => {
      const packages = isCtx
        ? new Set(['@deepseek-ai/cordis'])
        : annotation === null ? new Set() : packagesOfAnnotation(annotation)
      if (packages.size === 0 && annotation !== null && isUntypedShape(annotation)) return
      const keys = packages.size > 0 ? packages : customKey === null ? null : new Set([customKey])
      if (keys === null) return
      const rootType = isCtx ? 'Context' : (annotation ?? 'unknown')
      tracked.set(name, { keys, rootType, segments, exprPrefix, isCtx })
    }

    node.parameters.forEach((parameter, paramIndex) => {
      const annotation = parameter.type === undefined ? null : parameter.type.getText(source)
      const isCtx = isContextAnnotation(annotation)
      const rootType = isCtx ? 'Context' : (annotation ?? 'unknown')
      const customKey = event === null ? null : paramIndex === 0 ? `event:${event}` : `event:${event}#${paramIndex}`
      const canonicalParam = annotation === null
        ? (event !== null ? (paramIndex === 0 ? 'payload' : `payload_${paramIndex}`) : null)
        : parameterNameOf(rootType)
      const fallbackParam = paramIndex === 0 ? 'payload' : `payload_${paramIndex}`
      if (ts.isIdentifier(parameter.name)) {
        track(parameter.name.text, annotation, [], canonicalParam ?? parameter.name.text, isCtx, customKey)
      } else if (ts.isObjectBindingPattern(parameter.name)) {
        for (const element of parameter.name.elements) {
          if (element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name)) continue
          // `{ agent, message }` reads `payload.agent` / `payload.message`.
          const property = element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text
          track(element.name.text, annotation, [property], `${canonicalParam ?? fallbackParam}.${property}`, isCtx, customKey)
        }
      }
    })
    if (tracked.size === 0) return

    const resolve = targetNode => {
      const chain = chainOf(targetNode)
      if (chain === null) return null
      const info = tracked.get(chain.base)
      if (info === undefined) return null
      if (chain.hasCast && !info.isCtx) return null
      return {
        keys: info.keys,
        rootType: info.rootType,
        segments: [...info.segments, ...chain.segments],
        expr: `${info.exprPrefix}${chain.dotted.join('')}`,
      }
    }

    // Pass 1: locals aliasing a tracked chain. A `for…of` element variable is
    // aliased as `arr[]` so the reads inside the loop keep the loop shape.
    const collect = current => {
      if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)
        && current.initializer !== undefined && !tracked.has(current.name.text)) {
        const varAnnotation = current.type === undefined ? null : current.type.getText(source)
        if (varAnnotation === null || packagesOfAnnotation(varAnnotation).size > 0) {
          const info = resolve(current.initializer)
          if (info !== null) tracked.set(current.name.text, { ...info, exprPrefix: info.expr })
        }
      }
      if (ts.isForOfStatement(current) && ts.isVariableDeclarationList(current.initializer)) {
        const declarations = current.initializer.declarations
        const declaration = declarations.length === 1 ? declarations[0] : undefined
        if (declaration !== undefined && ts.isIdentifier(declaration.name)) {
          const info = resolve(optionalLeft(current.expression))
          if (info !== null) {
            tracked.set(declaration.name.text, {
              ...info,
              segments: elementOf(info.segments),
              exprPrefix: declaration.name.text,
            })
          }
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
            const resolved = resolve(access)
            if (resolved === null) continue
            const expr = resolved.expr
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
      const resolved = resolve(unwrapped)
      if (resolved !== null) {
        return { positive: [{ expr: resolved.expr, kind: 'defined' }], negative: [{ expr: resolved.expr, kind: 'falsy' }] }
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

    const recordDiscriminantHit = (target, literal, siteNode, scope) => {
      const fieldPath = target.segments.join('.')
      for (const key of target.keys) {
        recordDiscriminant(key, fieldPath, literal)
        // A bare-parameter comparison (`kind === 'tools'`) has no property
        // access chain, so synthesize an empty-path site record to preserve
        // rootType, guards, and source location for discriminant verification.
        if (target.segments.length === 0) {
          recordFieldPath(key, fieldPath, target.rootType, siteOf(siteNode), scope.guards, scope.loop)
        }
      }
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
            recordDiscriminantHit(target, clause.expression.text, clause.expression, scope)
            const caseGuard = {
              expr: target.expr,
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
          const originInfo = resolve(origin)
          if (originInfo !== null) {
            // Element binding context: reads through the loop variable
            // record the iterated expression and the binding name.
            walk(current.statement,
              { ...scope, loop: { binding: declaration.name.text, elementOf: originInfo.expr } })
            return
          }
        }
        walk(current.statement, scope)
        return
      }
      // event.type === 'x' / 'x' !== source.kind — a discriminant comparison.
      if (ts.isBinaryExpression(current) && EQUALITY.has(current.operatorToken.kind)) {
        for (const [left, right] of [[current.left, current.right], [current.right, current.left]]) {
          const literal = unwrapValue(right)
          if (!ts.isStringLiteralLike(literal)) continue
          const target = resolve(left)
          if (target === null) continue
          recordDiscriminantHit(target, literal.text, current, scope)
        }
      }
      if (ts.isPropertyAccessExpression(current)) {
        const target = resolve(current)
        if (target !== null) {
          // An optional link (`exec.agent?.id`) narrows its own prefix.
          const optional = []
          for (let link = current; ts.isPropertyAccessExpression(link); link = unwrap(link.expression)) {
            if (link.questionDotToken !== undefined) {
              const prefix = resolve(link.expression)
              if (prefix !== null) optional.push({ expr: prefix.expr, kind: 'defined' })
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
  const isFunctionNode = node => ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
    || ts.isArrowFunction(node) || ts.isFunctionExpression(node)

  const visit = node => {
    // Static imports.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text.startsWith(SCOPE)) {
      const specifier = node.moduleSpecifier.text
      const kind = importKindOf(node.importClause)
      recordImport(specifier, kind)
      if (root === 'src' || root === 'tests') {
        if (node.importClause !== undefined) {
          if (node.importClause.name !== undefined) {
            localNames.set(node.importClause.name.text, specifier)
            localExportedNames.set(node.importClause.name.text, 'default')
          }
          if (node.importClause.namedBindings !== undefined) {
            if (ts.isNamespaceImport(node.importClause.namedBindings)) {
              localNames.set(node.importClause.namedBindings.name.text, specifier)
              localExportedNames.set(node.importClause.namedBindings.name.text, '*')
            } else {
              for (const element of node.importClause.namedBindings.elements) {
                const exported = (element.propertyName ?? element.name).text
                localNames.set(element.name.text, specifier)
                localExportedNames.set(element.name.text, exported)
                if (specifier === '@deepseek-ai/cordis' && exported === 'Context') {
                  contextTypeNames.add(element.name.text)
                }
              }
            }
          }
        }
      }
    }

    // Dynamic imports: await import('@deepseek-ai/…').
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text.startsWith(SCOPE)) {
      recordImport(node.arguments[0].text, 'value')
    }

    // Re-exports: export ... from '@deepseek-ai/…'.
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined
      && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text.startsWith(SCOPE)) {
      recordImport(node.moduleSpecifier.text, exportKindOf(node))
    }

    // Type-position import('@deepseek-ai/…').
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)
      && node.argument.literal.text.startsWith(SCOPE)) {
      recordImport(node.argument.literal.text, 'type')
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
      && isCtxBase(node.expression.expression, ctxNames)
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
    if (ts.isPropertyAccessExpression(node) && isCtxBase(node.expression, ctxNames)) {
      const bucket = state.ctxAccesses[node.name.text] ?? new Set()
      bucket.add(file)
      state.ctxAccesses[node.name.text] = bucket
    }

    let savedCtxNames = null
    if (isFunctionNode(node)) {
      savedCtxNames = new Set(ctxNames)
      for (const parameter of node.parameters) {
        if (!ts.isIdentifier(parameter.name)) continue
        const annotation = parameter.type === undefined ? null : parameter.type.getText(source)
        if (isContextAnnotation(annotation)) ctxNames.add(parameter.name.text)
        else if (parameter.type !== undefined) ctxNames.delete(parameter.name.text)
      }
    }

    // Field paths read on parameters annotated with imported DeepSeek types.
    if (isFunctionNode(node) && node.body !== undefined && !analyzed.has(node)) {
      analyzeFunction(node, null)
    }

    ts.forEachChild(node, visit)

    if (savedCtxNames !== null) {
      ctxNames.clear()
      for (const name of savedCtxNames) ctxNames.add(name)
    }
  }
  visit(source)

  // Extract L2b in-source module augmentations after imports are populated.
  if (root === 'src') {
    extractModuleAugmentations(source, localNames, localExportedNames, siteOf, (pkg, ifaceName, memberName, memberSpec) => {
      const byIface = state.augmentations[pkg] ?? {}
      const byMember = byIface[ifaceName] ?? {}
      byMember[memberName] = memberSpec
      byIface[ifaceName] = byMember
      state.augmentations[pkg] = byIface
    })
  }
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

  // Local names imported from the host: a WeakMap keyed by one of these bets on
  // the identity of an object the plugin does not own.
  const localNames = new Map()
  const upstreamNames = new Set()
  const contextTypeNames = new Set()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!statement.moduleSpecifier.text.startsWith(SCOPE)) continue
    const specifier = statement.moduleSpecifier.text
    for (const name of importNamesOf(statement.importClause)) {
      upstreamNames.add(name)
      localNames.set(name, specifier)
    }
    if (specifier === '@deepseek-ai/cordis' && statement.importClause?.namedBindings !== undefined
      && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const element of statement.importClause.namedBindings.elements) {
        if ((element.propertyName ?? element.name).text === 'Context') contextTypeNames.add(element.name.text)
      }
    }
  }

  const hasUpstreamType = annotation => {
    if (annotation === '') return false
    for (const name of upstreamNames) {
      if (new RegExp(`\\b${name}\\b`).test(annotation)) return true
    }
    return /import\(\s*['"]@deepseek-ai\//.test(annotation)
  }

  const bindingInScope = (scope, identifier) => {
    let cursor = scope
    while (cursor !== null) {
      const entry = cursor.bindings.get(identifier.text)
      if (entry !== undefined) return entry
      cursor = cursor.parent
    }
    return undefined
  }

  const hookCallbacks = new Set()
  const trackedEntry = new Map()
  const widenedEntry = new Map()
  const trackedVarEntries = []
  const catchBindings = new Set() // `catch (e)` declarations, bound by the clause below
  const structure = (node, scope) => {
    let inner = scope
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'on' && node.arguments.length >= 2
      && ts.isStringLiteral(node.arguments[0])) {
      const callback = node.arguments[1]
      const calleeBase = unwrap(node.expression.expression)
      const isCtxCallee = (ts.isIdentifier(calleeBase)
        && (calleeBase.text === 'ctx' || bindingInScope(scope, calleeBase)?.isContext === true))
        || (ts.isPropertyAccessExpression(calleeBase) && calleeBase.name.text === 'ctx')
      if (isCtxCallee && callback !== undefined
        && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        hookCallbacks.add(callback)
      }
    }
    if (ts.isFunctionLike(node)) {
      inner = newScope(scope)
      const isHookCallback = hookCallbacks.has(node)
      for (const parameter of node.parameters) {
        const annotation = typeTextOf(parameter.type, source)
        const isContext = isContextTypeText(annotation === '' ? null : annotation, contextTypeNames, localNames)
        const isUntyped = isUntypedShape(annotation)
        const isTracked = !isContext && (hasUpstreamType(annotation) || (isHookCallback && !isUntyped))
        for (const entry of bind(inner, parameter.name, { from: 'parameter', isContext })) {
          untypedEntry.set(entry, isUntyped)
          trackedEntry.set(entry, isTracked)
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
      const varAnnotation = typeTextOf(node.type, source)
      for (const entry of bind(inner, node.name, { from: 'variable' })) {
        untypedEntry.set(entry, false)
        variableEntries.push({ entry, initializer: node.initializer })
        trackedVarEntries.push({ entry, initializer: node.initializer, varAnnotation })
      }
    }
    scopeAt.set(node, inner)
    ts.forEachChild(node, child => structure(child, inner))
  }
  structure(source, rootScope)

  const bindingOf = identifier => bindingInScope(scopeAt.get(identifier) ?? rootScope, identifier)

  const trackedValue = node => {
    const cursor = unwrapValue(node)
    if (ts.isIdentifier(cursor)) {
      const entry = bindingOf(cursor)
      return entry !== undefined && trackedEntry.get(entry) === true
    }
    if (ts.isPropertyAccessExpression(cursor) || ts.isElementAccessExpression(cursor)) {
      return trackedValue(cursor.expression)
    }
    return false
  }

  // Monotone closure for L0 tracked & widened upstream bindings (H4' Port C routing).
  for (;;) {
    let changed = false
    for (const { entry, initializer, varAnnotation } of trackedVarEntries) {
      if (initializer === undefined || !trackedValue(initializer)) continue
      if (varAnnotation === '' || hasUpstreamType(varAnnotation)) {
        if (trackedEntry.get(entry) !== true) {
          trackedEntry.set(entry, true)
          changed = true
        }
      } else if (!isUntypedShape(varAnnotation) && isPrimitiveShape(varAnnotation)) {
        if (widenedEntry.get(entry) !== true) {
          widenedEntry.set(entry, true)
          changed = true
        }
      } else if (isUntypedShape(varAnnotation)) {
        if (untypedEntry.get(entry) !== true) {
          untypedEntry.set(entry, true)
          changed = true
        }
      }
    }
    if (!changed) break
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
    if (ts.isAsExpression(cursor) || ts.isTypeAssertionExpression(cursor) || ts.isSatisfiesExpression(cursor)) {
      const castType = typeTextOf(cursor.type, source)
      if ((ts.isAsExpression(cursor) || ts.isTypeAssertionExpression(cursor))
        && !hasUpstreamType(castType) && !isPrimitiveShape(castType)
        && trackedValue(unwrap(cursor.expression))) {
        return true
      }
      // `(x as string)` / `(x as unknown[])` assert a primitive or array shape,
      // never a field name: the record read underneath is already reported.
      return isPrimitiveShape(castType) ? false : untypedValue(cursor.expression)
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
  for (;;) {
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

  // --- reporting pass -----------------------------------------------------------

  const isWidenedIdentifier = node => {
    const cursor = unwrapValue(node)
    if (!ts.isIdentifier(cursor)) return false
    const entry = bindingOf(cursor)
    return entry !== undefined && widenedEntry.get(entry) === true
  }

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
    // Suspect 1b: `x as { field: Type }` invents a shape for an untyped or cast-tracked value.
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && node.type !== undefined
      && node.type.getText(source).trim().startsWith('{')
      && (untypedValue(node.expression)
        || (!hasUpstreamType(typeTextOf(node.type, source)) && trackedValue(unwrap(node.expression))))) {
      add('untyped-field', node, `as ${flatten(node.type.getText(source), 100)}`)
    }
    // Suspect 1c: string literal discriminant comparison against a widened variable (`const t: string = event.type`).
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      for (const [left, right] of [[node.left, node.right], [node.right, node.left]]) {
        const literal = unwrapValue(right)
        if (!ts.isStringLiteralLike(literal) || !isWidenedIdentifier(left)) continue
        add('untyped-field', node, flatten(node.getText(source), 100))
      }
    }
    if (ts.isSwitchStatement(node)) {
      const expr = unwrapValue(node.expression)
      if (isWidenedIdentifier(expr)) {
        for (const clause of node.caseBlock.clauses) {
          if (ts.isCaseClause(clause) && ts.isStringLiteralLike(clause.expression)) {
            add('untyped-field', clause.expression, `${expr.text} === ${clause.expression.getText(source)}`)
          }
        }
      }
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
        if (ts.isPropertyAccessExpression(current) && ts.isAsExpression(unwrapValue(current.expression))) {
          const base = unwrap(current.expression)
          const isCtx = isCtxBase(current.expression)
            || (ts.isIdentifier(base) && bindingOf(base)?.isContext === true)
          if (isCtx) add('try-cast-ctx', current, flatten(current.getText(source), 100))
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
    suspects.push(...scanFileForSuspects(`src/${relative(rootPath, path).replaceAll('\\', '/')}`, source))
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
 * One acknowledgement, e.g. `src/plugin.ts:199`, `src/plugin.ts:110-133`,
 * `src/store.ts:24,30`, `src/plugin.ts:/STARTED_SUBAGENT/`, or
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
    const pieces = part.trim().split('-')
    if (pieces.length > 2) {
      throw new Error(`invalid line range '${part}' in acknowledgement '${raw}'`)
    }
    const from = Number(pieces[0])
    const to = Number(pieces[1] ?? pieces[0])
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
      throw new Error(`invalid line range '${part}' in acknowledgement '${raw}'`)
    }
    return [from, to]
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
    return { seams: [], specifications: [], error: `missing ${relative(REPO_ROOT, REGISTRY_PATH).replaceAll('\\', '/')}` }
  }
  try {
    // Node ≥ 22.18 / 24 strips the types in place; the file has no runtime deps.
    const module = await import(pathToFileURL(REGISTRY_PATH).href)
    const seams = Array.isArray(module.IMPLICIT_SEAMS) ? module.IMPLICIT_SEAMS : []
    const specifications = seams.flatMap(seam => [
      ...(seam.acknowledged ?? []).map(raw => ({ seam: seam.id, effect: 'acknowledged', ...acknowledgementMatcher(raw) })),
      ...(seam.ignored ?? []).map(raw => ({ seam: seam.id, effect: 'ignored', ...acknowledgementMatcher(raw) })),
    ])
    return { seams, specifications, error: null }
  } catch (error) {
    return { seams: [], specifications: [], error: `cannot load ${relative(REPO_ROOT, REGISTRY_PATH).replaceAll('\\', '/')}: ${String(error)}` }
  }
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

const manifestPath = join(REPO_ROOT, 'package.json')
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : {}
const state = {
  packages: {},
  injectedServices: new Set(),
  srcHooks: [],
  testHooks: [],
  ctxAccesses: {},
  fieldPaths: {},
  discriminants: {},
  augmentations: {},
}

for (const root of ROOTS) {
  const rootPath = join(REPO_ROOT, root)
  if (existsSync(rootPath)) {
    for (const path of listSourceFiles(rootPath)) analyzeFile(path, root, state)
  }
}

function unwrapExportTarget(entry) {
  let cursor = entry
  for (let depth = 0; depth < 6 && cursor !== null && typeof cursor === 'object'; depth += 1) {
    cursor = cursor.types ?? cursor.import ?? cursor.default ?? null
  }
  return typeof cursor === 'string' ? cursor : null
}

function resolveDtsCandidate(basePath) {
  if (/\.(?:d\.ts|d\.mts|d\.cts)$/.test(basePath) && existsSync(basePath)) return basePath
  const replaced = basePath.replace(/\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/, '')
  for (const ext of ['.d.ts', '.d.mts', '.d.cts']) {
    if (existsSync(`${replaced}${ext}`)) return `${replaced}${ext}`
  }
  for (const ext of ['index.d.ts', 'index.d.mts', 'index.d.cts']) {
    const indexPath = join(basePath, ext)
    if (existsSync(indexPath)) return indexPath
  }
  return null
}

function resolvePackageDtsEntry(specifier) {
  const parts = specifier.split('/')
  if (parts.length < 2) return null
  const pkgName = `${parts[0]}/${parts[1]}`
  const subpath = parts.length > 2 ? `./${parts.slice(2).join('/')}` : '.'
  const pkgDir = join(REPO_ROOT, 'node_modules', parts[0], parts[1])
  const pkgJsonPath = join(pkgDir, 'package.json')
  if (!existsSync(pkgJsonPath)) return null
  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    const exported = pkgJson.exports?.[subpath]
    const target = exported !== undefined
      ? unwrapExportTarget(exported)
      : (subpath === '.' ? (pkgJson.types ?? pkgJson.typings ?? 'index.d.ts') : subpath)
    if (target === null) return null
    const file = resolveDtsCandidate(resolve(pkgDir, target))
    return file === null ? null : { file, pkg: pkgName }
  } catch {
    return null
  }
}

function collectContextMembersFromDecl(decl, members) {
  for (const member of decl.members) {
    if (ts.isConstructorDeclaration(member)) continue
    if (member.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword)) continue
    const nameNode = member.name
    if (nameNode !== undefined && (ts.isIdentifier(nameNode) || ts.isStringLiteralLike(nameNode)
      || ts.isNumericLiteral(nameNode))) {
      members.add(nameNode.text)
    }
  }
}

function collectAnchoredContextMembers() {
  const members = new Set(CORDIS_BUILTIN_CONTEXT_MEMBERS)
  for (const memberName of Object.keys(state.augmentations['@deepseek-ai/cordis']?.Context ?? {})) {
    members.add(memberName)
  }

  const scanDts = (filePath, pkg, collectRefs) => {
    const text = readFileSync(filePath, 'utf8')
    const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
    const dir = dirname(filePath)
    const refs = []
    const visit = node => {
      if (pkg === '@deepseek-ai/cordis'
        && ((ts.isInterfaceDeclaration(node) && node.name.text === 'Context')
          || (ts.isClassDeclaration(node) && node.name?.text === 'Context'))) {
        collectContextMembersFromDecl(node, members)
      }
      if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)
        && node.body !== undefined && ts.isModuleBlock(node.body)) {
        const targetMod = node.name.text
        if (targetMod === '@deepseek-ai/cordis' || (pkg === '@deepseek-ai/cordis' && targetMod.startsWith('.'))) {
          for (const stmt of node.body.statements) {
            if ((ts.isInterfaceDeclaration(stmt) && stmt.name.text === 'Context')
              || (ts.isClassDeclaration(stmt) && stmt.name?.text === 'Context')) {
              collectContextMembersFromDecl(stmt, members)
            }
          }
        }
      }
      if (collectRefs) {
        let spec
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) spec = node.moduleSpecifier.text
        else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
          spec = node.moduleSpecifier.text
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
          && ts.isStringLiteral(node.argument.literal)) {
          spec = node.argument.literal.text
        }
        if (spec !== undefined) {
          if (spec.startsWith('.')) {
            const relTarget = resolveDtsCandidate(resolve(dir, spec))
            if (relTarget !== null) refs.push({ file: relTarget, pkg })
          } else if (spec.startsWith(SCOPE)) {
            const pkgTarget = resolvePackageDtsEntry(spec)
            if (pkgTarget !== null) refs.push(pkgTarget)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    return refs
  }

  for (const ambientFile of listDtsFiles(REPO_ROOT)) {
    scanDts(ambientFile, null, false)
  }

  if (existsSync(join(REPO_ROOT, 'node_modules/@deepseek-ai'))) {
    const queue = []
    const visited = new Set()
    const seeds = new Set(['@deepseek-ai/cordis', ...Object.keys(state.packages)])
    for (const pkg of seeds) {
      const resolved = resolvePackageDtsEntry(pkg)
      if (resolved !== null) queue.push(resolved)
    }
    while (queue.length > 0) {
      const next = queue.shift()
      const key = `${next.pkg ?? ''}:${next.file}`
      if (visited.has(key)) continue
      visited.add(key)
      for (const ref of scanDts(next.file, next.pkg, true)) queue.push(ref)
    }
  }
  return members
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

  const augmentations = {}
  for (const pkg of Object.keys(state.augmentations).sort()) {
    const ifaces = {}
    for (const ifaceName of Object.keys(state.augmentations[pkg]).sort()) {
      const members = {}
      for (const memberName of Object.keys(state.augmentations[pkg][ifaceName]).sort()) {
        members[memberName] = state.augmentations[pkg][ifaceName][memberName]
      }
      ifaces[ifaceName] = members
    }
    augmentations[pkg] = ifaces
  }

  const result = {
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
  if (Object.keys(augmentations).length > 0) result.augmentations = augmentations
  if (existsSync(join(REPO_ROOT, 'node_modules/@deepseek-ai'))) {
    const anchoredMembers = collectAnchoredContextMembers()
    const borrowed = Object.keys(state.ctxAccesses).sort().filter(svc => !anchoredMembers.has(svc))
    if (borrowed.length > 0) result.borrowed = borrowed
  }
  return result
}

// --- report ----------------------------------------------------------------------

function report(data) {
  const lines = []
  lines.push('# DeepSeek 耦合面清单（机械层）')
  lines.push('')
  lines.push('由 `scripts/analyze-dsh-coupling.mjs` 生成：层 0（npm 面）、层 1（进程内契约）、层 3（验证契约）。')
  lines.push('层 2（读盘格式与语义契约）无法从代码形状提取，由人维护在各消费仓自己的审计文档中（路径自定）。')
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
  for (const hook of data.srcHooks) {
    lines.push(`| ${hook.event} | ctx.${hook.via} | (${hook.params.join(', ')}) | ${hook.sites.join(', ')} |`)
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
  for (const hook of data.testHooks) {
    lines.push(`| ${hook.event} | ctx.${hook.via} | (${hook.params.join(', ')}) | ${hook.sites.join(', ')} |`)
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
  const allSections = [...new Set([...Object.keys(data), ...Object.keys(committed)])]
  const drifted = allSections.filter(
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
} else if (MODE === 'json') {
  console.log(JSON.stringify(data, null, 2))
} else {
  console.log(report(data))
  const suspects = implicitSuspects()
  const registry = await loadRegistry()
  console.log(suspectSection(suspects, registry).text)
}
