/**
 * 共享检查机制（2026-11-14 起载荷只保留机制，内容由各消费仓注入）：
 *
 * - 字段和判别值检查规则由 `tests/seam/engine.ts` 的 `probeSpecsFromCoupling()`
 *   按 coupling.json 中的访问位置和类型收窄条件自动生成。
 * - 三类无法自动推导的内容——不可证豁免、隐性类型片段、反向自检场景——
 *   按 L0–L4 模型属于**消费仓署名的事实**（豁免理由必须引用本仓登记的
 *   `implicit/<id>`；片段按本仓的隐含依赖 id 键控），因此不内置在共享载荷
 *   里：各仓维护在自己的非受管规格库文件中，经 `standardSpecs()` 的
 *   `library` 参数注入。
 * - 复用是消费仓之间的自主决定：一个仓可以引用另一个仓的库内容，但署名
 *   与运行时证据绑定始终跟随导入方自己的登记。
 */

import { probeSpecsFromCoupling } from './engine.js'
import type { Coupling, DiscriminantSpec, MockCheckoutScenario, ProbeSpec, TypeFragment } from './engine.js'
import type { ImplicitSeam } from '../contracts/implicit-seams.js'

/* ------------------------------------------------------------------ *
 * 机制：消费仓注入的规格库 ∩ 本仓 coupling.json
 * ------------------------------------------------------------------ */

/** 消费仓自有的规格库：三类无法自动推导的内容，由各仓维护在非受管文件。 */
export interface SpecsLibrary {
  /** 不可证豁免：表面键（`pkg::path`）→ 原因文本（引擎会解析其中的
   *  `implicit/<id>` 并要求对应隐性契约在本仓登记且有运行时证据）。 */
  readonly unverifiable?: Readonly<Record<string, string>>
  /** 隐性类型片段：本仓隐含依赖 id → 检查片段。 */
  readonly implicitFragments?: Readonly<Record<string, readonly TypeFragment[]>>
  /** 反向自检场景（至多一个）：mock 上游声明并删除一个字段，确认生成的
   *  检查代码确实会编译失败。 */
  readonly abnormal?: MockCheckoutScenario | undefined
}

export interface StandardSpecs {
  readonly fieldSpecs: Readonly<Record<string, readonly ProbeSpec[]>>
  readonly discriminantSpecs: Readonly<Record<string, DiscriminantSpec>>
  readonly unverifiable: Readonly<Record<string, string>>
  readonly implicitFragments: Readonly<Record<string, readonly TypeFragment[]>>
  readonly abnormal?: MockCheckoutScenario | undefined
}

const splitKey = (key: string): { readonly pkg: string, readonly path: string } => {
  const separator = key.lastIndexOf('::')
  return { pkg: key.slice(0, separator), path: key.slice(separator + 2) }
}

/**
 * 注入库 ∩ 本仓耦合面：不可证豁免按 coupling.json 记录的上游表面求交，
 * 隐性类型片段按本仓登记的隐含依赖 id 求交；fieldSpecs /
 * discriminantSpecs 来自引擎的自动生成（类型收窄条件来自插件实际用法）。
 * 不传 `library` 时结果不含任何注入内容——载荷不携带任何消费仓的事实。
 */
export function standardSpecs(
  coupling: Coupling,
  implicitSeams: readonly ImplicitSeam[],
  library: SpecsLibrary = {},
): StandardSpecs {
  const unverifiable = Object.fromEntries(
    Object.entries(library.unverifiable ?? {}).filter(([key]) => {
      const { pkg, path } = splitKey(key)
      return coupling.fieldPaths[pkg]?.[path] !== undefined
    }),
  )
  const registeredSeams = new Set(implicitSeams.map(seam => seam.id))
  const implicitFragments = Object.fromEntries(
    Object.entries(library.implicitFragments ?? {}).filter(([id]) => registeredSeams.has(id)),
  )
  const generated = probeSpecsFromCoupling(coupling)
  const abnormal = library.abnormal
  return {
    fieldSpecs: generated.fieldSpecs,
    discriminantSpecs: generated.discriminantSpecs,
    unverifiable,
    implicitFragments,
    ...(abnormal !== undefined && generated.fieldSpecs[abnormal.specKey] !== undefined ? { abnormal } : {}),
  }
}
