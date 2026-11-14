# 上游升级检测机制复审：问题清单

复审日期：2026-11-13（第二轮）与 2026-11-14（第三轮）。本文记录两轮复审
新发现的问题，**仅列现象、证据与后果，不含修复方案**。第一轮 P1–P10 的
处理经过记录在 git 历史（`57b88b8`）与各文档中，不再重复；N 条目的证据
行号以第二轮当时的版本为准，第三轮的行号更新见 R 条目。

> **处理记录（2026-11-14）**：11 项判定 8 修 2 缓 1 收尾，全部落实。
> N1/R1/R2/R3（build-metadata 口径：lockstep 三处以 semver 优先级归一化比较
> ——devDeps 保留完整 target、engines 剥 build；两份 comparator 补 build 组
> 解析、不参与优先级；越墙检查注释改真）与 R4（verify-coupling 豁免臂以
> 同问题集内 TS2339-on-JsonValue 证据限定 TS18047、豁免面逐条具名）、
> R5（扫描器字面 NUL 字节改 `\x00` 转义，file/grep 恢复文本可见）随红证
> 修复；N2/N3 文档如实化（S1 悬空引用改述现状；"覆盖更深的挂载面"限定为
> loader 路径，bundle-patch 的 profile 应用路径显式登记为无覆盖缺口）；
> R6 收尾（RESERACH.md 更名 RESEARCH.md，本文件随修复提交）。N4（行号
> 锚定摩擦系 conscious-update 纪律的固有代价）与 N5（分钟级重锚窗口，
> 周一兜底自愈；将来可用 registry `dist.integrity` 做内容锚加固）缓办。

## 验证记录

两轮均除静态阅读外实际运行了验证（node 25.6.1）：

- **第二轮（2026-11-13）**：`analyze-dsh-coupling.mjs --check`（绿，82 处
  嫌疑全部报备）、`check:compat`（绿）、`npm test`（174 pass / 1 skip）、
  `npm run test:integration`（12/12）、`bump-upstream.mjs --check`（真实
  registry，`UPSTREAM_CHANGED=no`，14 成员看守生效）。
- **第三轮（2026-11-14，seam 引擎化重构后）**：`analyze-dsh-coupling.mjs
  --check`（绿）、`check:compat`（绿）、`npm test`（220 测试，219 pass /
  1 skip，上轮 175 → 220）、`npm run test:integration`（12/12）、
  `verify-coupling.mjs coupling.json`（exit 0，100/105 探针编译干净、
  5 处豁免）；另以临时目录夹具直调 `probeVersionLockstep` 完成两组实证
  （见 R1、R2）。

## 复审范围

- **第二轮**：`7368969`、`5cba6e1`、`9bd3270`、`fee7079`、`57b88b8` 五个
  提交——`scripts/bump-upstream.mjs`、`.github/workflows/{ci,canary}.yml`、
  `scripts/analyze-dsh-coupling.mjs`、`scripts/write-baseline.mjs`、
  `tests/seam-verify.test.ts` 及配套测试、`tests/contracts/implicit-seams.ts`、
  `coupling.json`、`cordis.patch.yml`、相关文档。
- **第三轮**：`a3ea7f9`（引擎/标准库/契约三层拆分）、`aa2d5a7`（探针守卫
  从插件源码提取）、`fa4794d`（契约-only 路径、机械推导 import、suite 注入
  审计映射）、`89a9a2a`（`--keep-floor` 与 range lockstep）——
  `tests/seam/engine.ts`、`tests/seam/standard-specs.ts`、
  `tests/contracts/seam-runs.ts`、薄入口 `tests/seam-verify.test.ts`、
  `scripts/analyze-dsh-coupling.mjs`（+209 行守卫提取）、
  `scripts/bump-upstream.mjs`（+70 行）、`scripts/verify-coupling.mjs`（新）、
  `tests/{engine-contract,guard-extraction}.test.ts`、
  `tests/bump-upstream.test.ts`（+51 行）、`coupling.json`（`sites` →
  `accesses`+`guards` 新形状）、两份文档增补。

## 问题总览

| 编号 | 轮次 | 级别 | 一句话 | 第三轮判定 |
|---|---|---|---|---|
| N1 | 二 | 中等 | dist-tag 指向 build-metadata 版本时，原子移动自造 lockstep 违规 | 未解决，实证补全 → R1 |
| N2 | 二 | 轻微 | seam 文档兜底指引指向已删除的 S1 步骤（悬空引用） | 未处理（`:213` 仍在） |
| N3 | 二 | 轻微 | bundle patch 应用路径零覆盖，文档"覆盖更深的挂载面"表述偏满 | 未处理（`versioning.md:88/:199` 仍在） |
| N4 | 二 | 属性 | 嫌疑硬门禁的行号锚定摩擦：重锚是手工活，与 coupling.json 机械重生成不对称 | 未变（`implicit-seams.ts` 本轮未动） |
| N5 | 二 | 轻微（既有残余） | canary 内"安装→重锚 baseline"窗口的重发布竞态 | 未变（两 workflow 本轮未动） |
| R1 | 三 | 中等 | build-metadata 版本目标在本仓策略（single-line）下仍自造 lockstep 红 | — |
| R2 | 三 | 中等 | 两份 `compareVersions` 均不解析 build metadata，localeCompare 兜底方向可错，"低于下界被静默放行"已实证 | — |
| R3 | 三 | 轻微 | `--keep-floor` 外层注释陈述了实现中不存在的保证（"official gate decides"） | — |
| R4 | 三 | 轻微 | verify-coupling 的 TS18047 豁免臂不限定 JsonValue，豁免面只打印计数 | — |
| R5 | 三 | 轻微（既有） | 扫描器源文件含字面 NUL 字节，grep/file 判为 binary | — |
| R6 | 三 | 备忘 | 工作区文档收尾未落（RESERACH.md 文件名拼写、本文件未提交） | — |

---

# 第二轮发现（2026-11-13）

## N1（中等）：build-metadata 版本目标使 lockstep 三处失配，canary 必红

**现象**：若 dist-tag `next` 某天指向带 build metadata 的版本
（如 `0.2.2-rc.4+build.1`），写模式会产出一个 lockstep 探针必然拒绝的
package.json——这正是上一轮 P1 的故障形态，且恰好发生在 P10 修复
（exact-version 认 build metadata）声称支持的输入类别上。

**证据链**：

1. `scripts/bump-upstream.mjs:215`：devDeps 各条目钉到**完整 target**
   （含 `+build` 后缀）。
2. `scripts/bump-upstream.mjs:196`：`floor = target.replace(/\+[0-9A-Za-z.-]+$/, '')`
   ——engines 下界**剥掉** build metadata；202 行据此生成 `enginesRange`，
   220 行写入。
3. `tests/seam-verify.test.ts:757`：`assert.equal([...train][0], floor)` 是
   精确字符串比较；`'0.2.2-rc.4+build.1' !== '0.2.2-rc.4'` 必然失败。
   773 行的 baseline 列车断言同样失配（lockfile 的 `version` 字段携带完整
   版本串）。
4. 覆盖缺口：`tests/bump-upstream.test.ts` 只覆盖了"依赖规格带
   `+build.7`、target 干净"的方向（68 行、120 行）；"target 本身带 build
   metadata"的方向无任何测试。

**后果**：该输入类别下"绿 canary → artifact 收编"主干不可达，且红色是
纪律性红（自造的失配），与上游真破坏红无法区分——P1 修复所要消灭的信号
混杂在该输入类别上原样复现。失败是响亮的（lockstep 红），非静默。
当前上游未向 `next` 发过 build-metadata 版本，属未触发的输入类别。

## N2（轻微）：seam 文档兜底指引指向已删除的 S1 步骤

**证据**：`docs/seam-driven-verification.md:162`（"包不住的部分 §3"的
"怎么补"）仍写"只有等到 S1 的'装进真实 `dsh` CLI 跑 `--dump-config`'
……才能发现"。该步骤恰在此前的重构中从 `ci.yml` 整体移除
（`ci.yml:56-62` 现为"Real host mounting is NOT checked through a
third-party action"的说明注释）。`docs/versioning.md` 已如实记录弃用决策，
这份交叉引用漏改。读者会以为那道安全网仍然存在。

## N3（轻微）：bundle patch 应用路径零覆盖，等价性表述偏满

**证据链**：

1. `cordis.patch.yml` 经 `package.json` 的 `dsh.bundle.patch` 由宿主 profile
   机制（`dsh plugin add`）消费。该应用路径在 S1/S2 均无验证：两条工作流的
   pack 冒烟只断言文件在 tarball 里（`ci.yml:54`、`canary.yml:110` 的
   `test -f smoke/package/cordis.patch.yml`）。
2. 删除 dsh-plugin-checker 后，"loader 挂载面"确有真实覆盖
   （`tests/integration/harness.test.ts:63-66` 经真实
   `cordis-plugin-loader` 挂载本插件），但 bundle-patch 应用不属于 loader
   路径，两者不等价。
3. `docs/versioning.md:88` 写"真实挂载由 seam-verify + 集成测试覆盖"，
   §7 证据索引写"覆盖更深的挂载面"——对 loader 挂载成立，对 bundle-patch
   应用不成立。

**后果**：宿主 profile 机制（`insert` 的 patch 格式语义）变化时，
S1/S2 全绿而真机 `dsh plugin add` 失效，与上一轮 P3 指出的缺口同类，
只是现在两道门禁都不再覆盖它，且文档以等价性表述盖过了残余缺口。

## N4（属性，需知晓）：嫌疑硬门禁的行号锚定摩擦

**证据**：`tests/contracts/implicit-seams.ts` 的 68 处 acknowledged 全部为
行号/区间锚定，`/pattern/` 语法一处未用（文件头声明的正则锚形式）。硬门禁
（`9bd3270`）生效后，任何在认可区间上方插行都会让 `--check` 红；与
`coupling.json`（一条 `--write` 机械重生成）不同，隐性清单的区间重锚是
手工活。这是"conscious update"纪律的一贯延伸，非缺陷；摩擦不对称是它的
代价。

## N5（轻微，既有残余，非当轮引入）：canary 重锚窗口的重发布竞态

**证据**：绊线以 `baseline.json` 的 `generatedAt` 为锚
（`scripts/bump-upstream.mjs:153-185`），而 canary 的 `npm install` 与
`write-baseline` 之间若发生同版本重发布：安装内容为发布前旧内容，
`generatedAt` 晚于发布时间，下一次绊线判定"未变化"。窗口为分钟级；
下次列车移动或周一兜底重装后自愈。上一轮 bellwether-only 实现同样存在，
此处仅登记残余。

---

# 第三轮发现（2026-11-14）

## R1（中等）：build-metadata 版本目标在本仓策略下仍自造 lockstep 红（N1 未解决，实证补全）

**现象**：本轮新增的 range 模式是逃生口而非修复——`docs/versioning.md`
§4 明确"当前策略仍是单线跟随"（single-line），而默认写模式对 `+build`
target 产出的组合在 single-line 探针下必然红。

**证据链**：

1. `scripts/bump-upstream.mjs:214`：`const floor = target.replace(/\+[0-9A-Za-z.-]+$/, '')`
   ——engines 下界剥掉 build metadata；`:261`：
   `manifest[move.field][move.name] = target`——devDeps 钉到完整 target
   （含 `+build`）。口径分叉与 N1 所述一致，仅行号漂移。
2. `tests/seam/engine.ts:563`：`assert.equal(trainVersion, floorOf(), …)`
   精确字符串比较；`:583` baseline 指纹列车与 floor 的比较同为精确串
   （lockfile 的 `version` 字段携带完整版本串）。
3. **实证（2026-11-14，临时夹具直调 dist-test 引擎）**：构造 bump 写模式
   对 `+build` target 会产出的精确组合（devDeps
   `0.2.2-rc.4+build.1`、`engines.dsh >=0.2.2-rc.4 <0.3.0-0`、baseline
   指纹 `0.2.2-rc.4+build.1`）喂给 `probeVersionLockstep`：single-line 报
   `'0.2.2-rc.4+build.1' !== '0.2.2-rc.4'`（红），range 通过。
4. 覆盖缺口延续：`tests/bump-upstream.test.ts` 新增的 51 行 `--keep-floor`
   测试只覆盖干净版本方向（rc.4 与越墙 rc.1），"target 带 build metadata"
   方向两轮累计零覆盖。

**后果**：同 N1——上游把 `next` 指向 `+build` 版本时，绿 canary →
artifact 收编主干不可达，且红是纪律性红、与上游真破坏红不可区分。

## R2（中等）：两份 `compareVersions` 均不解析 build metadata，localeCompare 兜底方向可错，静默放行已实证

**证据链**：

1. `tests/seam/engine.ts:493` 与 `scripts/bump-upstream.mjs:305` 的解析正则
   `^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$` **均无 build-metadata 组**；
   `+build` 版本落 `a.localeCompare(b)` 兜底（engine.ts:501 /
   bump-upstream.mjs:283）。localeCompare 是 locale 相关的字典序，非 semver。
2. **实测**：`'0.2.2-rc.4+build.1'.localeCompare('0.2.10')` 返回 `1`，
   semver 真值为 `<0`（0.2.10 更新）。
3. **静默放行实证（夹具直调引擎）**：floor `0.2.10` + 列车
   `0.2.9+build.1`（semver 明确低于下界，应拒）在 range 模式下 PASS；
   `--keep-floor` 的准入检查（`scripts/bump-upstream.mjs:242`）用同一算法，
   同样放行——"越墙即拒绝写入（拒绝零写入）"的保证在该输入类上失守。
4. 与声明的冲突：`docs/versioning.md` §4 逃生口写"写入前先经官方 gate
   验证目标落在现有区间内"；`docs/seam-driven-verification.md` 写"含
   `-0` 墙语义、与 check-compat.mjs 官方 gate 相同的下界/`-0` 墙语义"。
   实际裁决来自本地比较器，且恰在 P10 打开的输入类（`EXACT_VERSION` 认
   `+build`，`bump-upstream.mjs:82`）上退化。最终兜底是 `check:compat`
   的官方 gate（低于下界的运行时会被拒），不会漏到用户，但失败形态与
   真因不一致。
5. 附注：engine 与 bump-upstream 是两份手工同步的 `compareVersions` 副本
   （引擎不 import `@deepseek-ai/dsh-app-boot` 的理由成立），文档称
   "同一套算法"，但没有任何共享测试向量钉住两边同步——本条"两边一起漏"
   即其例证。

## R3（轻微）：`--keep-floor` 外层注释陈述了实现中不存在的保证

**证据**：`scripts/bump-upstream.mjs:222-225` 写"The official gate decides
(same ruling as scripts/check-compat.mjs's boundary probes …); this script
never reimplements semver"——与实现（本地 `compareVersions`）直接矛盾；
内层注释（`:230-232`）与文件头（`:30-36`）如实说明了实际实现。这恰是
全文件安全最敏感的检查（越墙准入），注释却陈述了一个不存在的保证。

## R4（轻微）：verify-coupling 的 TS18047 豁免臂不限定 JsonValue，豁免面不可见

**证据**：`scripts/verify-coupling.mjs:28` 的豁免谓词中，第二臂
`/^TS2339:.*JsonValue/` 用 JsonValue 收窄了，第一臂 `/^TS18047:/` 没有
——独立验货路径上任何"唯一诊断是 possibly-nullish"的探针一律静默豁免，
与 JsonValue 无关。上游把某字段改为可空、探针恰好只报 TS18047 时，CLI 会
把它记为豁免而非失败。同时 `:54-55` 只打印豁免**计数**（"N runtime-contract
surface(s) exempt"）、不列名，豁免了哪些面不可见。全套件路径不受影响
（本仓这些面走 unverifiable 库 + implicit 探针），但 CLI 的服务对象恰是
任意外来 coupling.json。

## R5（轻微，既有，非本轮引入）：扫描器源文件含字面 NUL 字节

**证据**：`scripts/analyze-dsh-coupling.mjs:1020`（文件偏移 45799）的
Map 键 `` `${event}\x00…` `` 写的是**原始 NUL 字节**而非 `\x00` 转义文本，
`file` 判为 "binary data"、`grep` 报 "binary file matches" 并吞掉行号
（第三轮复审中 `grep '\.sites'` 实际被挡）。57b88b8 已有此字节；本轮
该文件 +209 行、成为守卫提取的独占真相源后，工具链可见性的代价上升。

## R6（备忘，工作区）：文档收尾未落

**证据**：`docs/RESERACH.md` 未跟踪且文件名拼写错误（应为 RESEARCH；
文内自称 "SURVEY.md"）；`docs/upgrade-detection-review.md`（本文件）为
未提交的工作区修改。
