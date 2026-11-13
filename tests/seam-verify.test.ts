/**
 * 接触面验货器（Commit 3，2026-11-13 拆分后的薄装配层）：
 *
 * - 引擎（`tests/seam/engine.ts`，闭环）：生成探路插件 → tsc 编译验货 →
 *   真实 `new Context()` 挂载验货，并发射全部测试。
 * - 标准规格库（`tests/seam/standard-specs.ts`）：按上游表面键控的探针规格，
 *   `standardSpecs()` 与本仓 coupling.json 求交集。
 * - 本仓契约（本文件下方引入）：隐性契约登记 + 本仓探针与委派引用。
 *
 * 本仓没有标准库之外的自有规格，所以没有额外展开；有朝一日需要时，在
 * `implicitRuns` / 各 spec 记录旁展开合并即可，引擎不动。
 * 设计说明见 `docs/seam-driven-verification.md`，契约语义见 `docs/upstream-audit.md`。
 */

import { findRepositoryRoot, loadCoupling, runSeamSuite, standardRuns } from './seam/engine.js'
import { standardSpecs } from './seam/standard-specs.js'
import { IMPLICIT_SEAMS } from './contracts/implicit-seams.js'
import { IMPLICIT_DELEGATIONS, IMPLICIT_RUNS } from './contracts/seam-runs.js'

const ROOT = findRepositoryRoot('dsh-log-enhance')
const COUPLING = loadCoupling(ROOT)
const SPECS = standardSpecs(COUPLING, IMPLICIT_SEAMS)

/** 引擎标准探针里，只有本仓登记过的隐性契约 id 才采纳。 */
const REGISTERED_SEAM_IDS = new Set(IMPLICIT_SEAMS.map(seam => seam.id))
const STANDARD_RUNS_APPLICABLE = Object.fromEntries(
  Object.entries(standardRuns).filter(([id]) => REGISTERED_SEAM_IDS.has(id)),
)

runSeamSuite({
  root: ROOT,
  coupling: COUPLING,
  fieldSpecs: SPECS.fieldSpecs,
  discriminantSpecs: SPECS.discriminantSpecs,
  unverifiable: SPECS.unverifiable,
  implicitFragments: SPECS.implicitFragments,
  implicitSeams: IMPLICIT_SEAMS,
  implicitRuns: { ...STANDARD_RUNS_APPLICABLE, ...IMPLICIT_RUNS },
  implicitDelegations: IMPLICIT_DELEGATIONS,
  ...(SPECS.abnormal !== undefined ? { abnormal: SPECS.abnormal } : {}),
})
