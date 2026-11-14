/**
 * 接触面验货器（Commit 3，2026-11-13 拆分后的薄装配层）：
 *
 * - 引擎（`tests/seam/engine.ts`，闭环）：生成探路插件 → tsc 编译验货 →
 *   真实 `new Context()` 挂载验货，并发射全部测试。
 * - 规格机制与注入（`tests/seam/standard-specs.ts`，受管）：`standardSpecs()`
 *   与本仓 coupling.json 求交集；载荷只保留机制，不携带任何消费仓事实。
 * - 本仓规格库（`tests/seam/local-specs.ts`，非受管）：三类无法自动推导
 *   的内容（不可证豁免 / 隐性类型片段 / 反向自检场景）——按 L0–L4 模型
 *   属于本仓署名的事实，由上面的 `LOCAL_SPECS_LIBRARY` 注入。
 * - 本仓契约（本文件下方引入）：隐性契约登记 + 本仓探针与委派引用。
 *
 * 本仓没有标准库之外的自有规格，所以没有额外展开；有朝一日需要时，在
 * `implicitRuns` / 各 spec 记录旁展开合并即可，引擎不动。
 * 设计说明见 `docs/seam-driven-verification.md`，契约语义见 `docs/upstream-audit.md`。
 */

import { findRepositoryRoot, loadCoupling, runSeamSuite, standardRuns } from './seam/engine.js'
import { standardSpecs } from './seam/standard-specs.js'
import { LOCAL_SPECS_LIBRARY } from './seam/local-specs.js'
import { IMPLICIT_SEAMS } from './contracts/implicit-seams.js'
import { IMPLICIT_DELEGATIONS, IMPLICIT_RUNS } from './contracts/seam-runs.js'

const ROOT = findRepositoryRoot('dsh-log-enhance')
const COUPLING = loadCoupling(ROOT)
const SPECS = standardSpecs(COUPLING, IMPLICIT_SEAMS, LOCAL_SPECS_LIBRARY)

/** 引擎标准探针里，只有本仓登记过的隐性契约 id 才采纳。 */
const REGISTERED_SEAM_IDS = new Set(IMPLICIT_SEAMS.map(seam => seam.id))
const STANDARD_RUNS_APPLICABLE = Object.fromEntries(
  Object.entries(standardRuns).filter(([id]) => REGISTERED_SEAM_IDS.has(id)),
)

/**
 * 审计章节映射（docs/upstream-audit.md）——引擎不再内置。约定键：
 * `hook:<event>` 是钩子签名探针，`event:<name>` 是事件载荷；其余按
 * `pkg::path`。这个映射原样搬自引擎拆分前的 auditSection/hookSection，
 * 保证标题逐字不变。
 */
const sectionFor = (pkg: string, path: string): string => {
  if (pkg.startsWith('hook:')) return pkg.slice('hook:'.length).startsWith('agent/') ? '§3' : '§1'
  if (pkg.startsWith('event:')) return '§3'
  if (pkg === '@deepseek-ai/cordis') return path.startsWith('mcpManager') ? '§8' : '§1'
  if (pkg === '@deepseek-ai/dsh-tools') return path.startsWith('value') ? '§2' : '§1'
  if (pkg === '@deepseek-ai/dsh-agent') return '§3'
  if (pkg === '@deepseek-ai/dsh-session') {
    return path.startsWith('data.inserted')
      || path.startsWith('data.source')
      || path === 'data.id'
      || path === 'surfaceOp'
      || path === 'type'
      ? '§3'
      : '§1'
  }
  return '§1'
}

runSeamSuite({
  root: ROOT,
  coupling: COUPLING,
  /**
   * 库存下限哨兵：显式钉住在册库存（sync 复审 F1）。引擎默认值在泛化
   * 改造（dsh-seam f0c9d80）中归零，本薄入口不传 floors 的话，下次
   * sync 之后四条下限断言将静默变 `>= 0` 恒真。这里钉住当前 coupling.json
   * 在册数量——扫描器若静默丢面（少于下限）即红；有意收缩库存时随
   * coupling.json 一起显式下调。
   */
  inventoryFloors: {
    srcHooks: 6,
    testHooks: 3,
    fieldPathPackages: 7,
    discriminantPackages: 5,
  },
  fieldSpecs: SPECS.fieldSpecs,
  discriminantSpecs: SPECS.discriminantSpecs,
  unverifiable: SPECS.unverifiable,
  implicitFragments: SPECS.implicitFragments,
  implicitSeams: IMPLICIT_SEAMS,
  implicitRuns: { ...STANDARD_RUNS_APPLICABLE, ...IMPLICIT_RUNS },
  implicitDelegations: IMPLICIT_DELEGATIONS,
  sectionFor,
  /**
   * 探针 import 的 suite 层补充：隐性片段引用 dsh-llm 的 MessageSource
   * （coupling.json 里 dsh-llm 没有字段读取，rootType 推导看不见它）。
   * 其余 import 全部机械推导：rootType → 具名 import；packages 清单里
   * 没有字段读取的包（如 dsh-subagent）→ 裸 import，声明合并副作用随之
   * 生效（agent-message / subagent-settled 两个 source kind）。
   */
  typeImports: {
    '@deepseek-ai/dsh-llm': ['MessageSource'],
  },
  ...(SPECS.abnormal !== undefined ? { abnormal: SPECS.abnormal } : {}),
})
