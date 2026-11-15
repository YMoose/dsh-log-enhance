import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 文档里的版本事实必须等于单一事实源：`package.json` 的包版本与 `engines.dsh`，
 * 以及由包版本派生的安装产物名。
 *
 * 手写在文档里的版本号会静默漂移（0.2.0 发布后列车推进到 rc.3，README 与
 * runtime.md 仍停在 rc.1）。这里只锁定"关于当前包"的陈述：CHANGELOG 的已发布
 * 条目与 versioning.md 的验证矩阵是历史记录，允许并应当保留旧列车，故不在扫描面内。
 */

const root = new URL('../../', import.meta.url)

function read(relative: string): string {
  return readFileSync(new URL(relative, root), 'utf8')
}

const manifest = JSON.parse(read('package.json')) as { version: string, engines: { dsh: string } }
const packageVersion = manifest.version
const declaredRange = manifest.engines.dsh

/** 陈述"当前包"事实的文档；历史记录类文档不在此列。 */
const CURRENT_FACTS_DOCS = ['README.md', 'docs/runtime.md', 'docs/versioning.md']

test('docs state the shipped package version', () => {
  const drift: string[] = []
  const status = /当前状态：\*\*([^*]+)\*\*/.exec(read('README.md'))
  if (status?.[1] !== packageVersion) {
    drift.push(`README.md 当前状态 ${JSON.stringify(status?.[1] ?? null)} != ${packageVersion}`)
  }
  const header = /^包版本：(\d+\.\d+\.\d+)/m.exec(read('docs/runtime.md'))
  if (header?.[1] !== packageVersion) {
    drift.push(`docs/runtime.md 包版本 ${JSON.stringify(header?.[1] ?? null)} != ${packageVersion}`)
  }
  assert.deepEqual(drift, [], `文档声明的包版本与 package.json 不一致:\n${drift.join('\n')}`)
})

test('install commands name the tarball this package builds', () => {
  const drift: string[] = []
  for (const file of ['README.md', 'docs/runtime.md']) {
    // 安装命令直接复制给用户执行；产物名与当前版本不符即装错包。
    for (const match of read(file).matchAll(/dsh-log-enhance-(\d+\.\d+\.\d+)\.tgz/g)) {
      if (match[1] !== packageVersion) {
        drift.push(`${file}: dsh-log-enhance-${match[1]}.tgz != dsh-log-enhance-${packageVersion}.tgz`)
      }
    }
  }
  assert.deepEqual(drift, [], `安装命令中的产物名与实际打包版本不一致:\n${drift.join('\n')}`)
})

test('every stated engines.dsh range equals package.json', () => {
  const drift: string[] = []
  const range = />=\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)? <\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/g
  for (const file of CURRENT_FACTS_DOCS) {
    for (const match of read(file).matchAll(range)) {
      if (match[0] !== declaredRange) {
        drift.push(`${file}: "${match[0]}" != "${declaredRange}"`)
      }
    }
  }
  assert.deepEqual(drift, [], `文档声明的 engines.dsh 与 package.json 不一致:\n${drift.join('\n')}`)
})
