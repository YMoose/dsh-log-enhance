# 上游升级检测机制评审：问题清单

评审日期：2026-11-13。本文记录对"上游代码升级检测"相关机制的一次评审发现的
问题，**仅列问题与证据，不含修复方案**。评审方式为静态代码阅读加 git 历史核对，
未实际触发 CI 运行；文中间接推断处已单独标注。

> **处理记录（2026-11-13，同日全部落实）**：评审结论全部属实。P1/P2/P5/P10 →
> `7368969`（列车移动原子化：bump 同步推进 engines.dsh、上界随次 minor 重算；
> 绊线看守全列车 14 个成员的 `time`；exact-version 认 build metadata；ci.yml
> 弃用第三方 dsh-plugin-checker，workflow 不再携带版本号）；P3/P7 → `5cba6e1`
> （canary 补齐 coupling 门禁 + pack 冒烟，与 S1 同覆盖面；周兜底判定改读
> schedule 列表，不再复制 cron 字面量）；P4 → `9bd3270`（未报备嫌疑与清单不可读
> 在 `--check` 下直接判红，红证：旧脚本对同一夹具 exit 0）；P6/P8/P9 → `fee7079`
> （baseline 排除嵌套 lockfile 键；engines 对象缺失走友好诊断；hook 行号改由
> coupling.json 提供，seam-verify 弃文本 grep）。每项修复均先以夹具复现红再转绿。

## 评审范围

- 脚本：`scripts/bump-upstream.mjs`、`scripts/write-baseline.mjs`、
  `scripts/check-compat.mjs`、`scripts/analyze-dsh-coupling.mjs`、
  `scripts/link-harness.mjs`
- 工作流：`.github/workflows/ci.yml`、`.github/workflows/canary.yml`
- 测试：`tests/baseline.test.ts`、`tests/seam-verify.test.ts`、
  `tests/check-compat.test.ts`、`tests/link-harness-contracts.test.ts`、
  `tests/contracts/implicit-seams.ts`
- 数据文件：`coupling.json`、`baseline.json`、`cordis.patch.yml`、`package.json`
- 文档：`docs/versioning.md`、`docs/seam-driven-verification.md`、
  `docs/upstream-audit.md`
- git 历史：`98172b6`（canary 落地）、`217929e`（seam-verify 落地）、
  `067147f`（rc.3 收编）及相关时间线

## 问题总览

| 编号 | 级别 | 一句话 |
|---|---|---|
| P1 | 设计矛盾 | canary 在列车前移时必然红：lockstep 探针与 canary 只改一处依赖的流程互相矛盾 |
| P2 | 盲区 + 文档失实 | 同版本重发布检测只锚定 bellwether 一个包，与历史事故形态不符，文档过度承诺 |
| P3 | 覆盖面 + 文档失实 | canary 绿不含真实宿主安装冒烟，bundle patch 注册路径无任何 canary 覆盖 |
| P4 | 计划烂尾 | 隐性嫌疑扫描停留在 advisory，与既定执行计划"阶段 B 后改硬门禁"不一致 |
| P5 | 流程缺口 | 跨 minor 收编流程未定义，"artifact 即全部材料"只对同 minor 成立 |
| P6 | 实现细节 | baseline 指纹对嵌套依赖路径的键名处理错误，属未触发的隐含假设 |
| P7 | 实现细节 | canary 周兜底判定依赖与 cron 定义重复的字符串 |
| P8 | 实现细节 | seam-verify 的 hook 定位用文本 grep，与整体 AST 风格不一致 |
| P9 | 实现细节 | check-compat 在 engines 对象整体缺失时报错不友好 |
| P10 | 实现细节 | 精确版本正则不认 build metadata |

---

## P1（设计矛盾）：canary 在列车前移时永远不可能绿

**现象**：S2 canary 的设计目标是"列车前移 → 全量验证 → 绿 → artifact 即重验
commit 材料"（`docs/versioning.md` §4 S2 行、`canary.yml` 头注释"On green, the
uploaded artifact is exactly the revalidation commit"）。但按当前实现，只要列车
前移，canary 的 `npm run check` 必然失败，与上游是否真的破坏兼容无关。

**证据链**：

1. canary 的列车前移路径是
   `bump-upstream.mjs`（write 模式）→ 重装 → 重生成 baseline → `npm run check`。
2. `scripts/bump-upstream.mjs:142-144` 的 write 模式只重写依赖声明里的 dsh-* 条目；
   `engines.dsh` 与 `.github/workflows/ci.yml` 的 `dshVersion` 不在其改写范围内
   （前者不是依赖声明，后者在另一个文件）。
3. `npm run check` → `npm test` → `node --test dist-test/tests/*.test.js` 包含
   `seam-verify.test.js`；其中 `probeVersionLockstep`
   （`tests/seam-verify.test.ts:738-765`）断言四处完全一致：
   devDependencies 的 dsh-* train（753 行）=== `engines.dsh` 下界（754 行）===
   `ci.yml` 的 `dshVersion`（756-757 行）=== `baseline.json` 指纹列车（759-764 行）。
4. canary 环境下：devDeps train 与 baseline 车次（重生成后）为新版本，
   `engines.dsh` 下界与 `ci.yml` `dshVersion` 仍是旧版本——754 行与 757 行的断言
   必然失败。

**后果**：

- "绿后 artifact 即 §5 重验 commit 的全部材料"这条主干路径在列车前移场景下
  不可达；canary 只会产出红 run 与（`if: always()` 上传的）不完整 artifact。
- 红色信号语义混杂：纪律性红（lockstep 预期失败）与上游真破坏红无法从 canary
  结果上区分，而区分这两者正是 canary 存在的目的。

**时间线佐证（该矛盾从未被真实运行暴露）**：

- `98172b6`（2026-11-11）canary 落地；夜间绊线于 11-12、11-13（04:23 UTC）触发，
  因 `SubagentActivationSpec` 真实破坏而红（`067147f` commit message 自述）。
- `217929e`（2026-11-13 18:23）seam-verify 连同 `probeVersionLockstep` 才落地，
  晚于最后一次真实 canary 触发；18:57 的 rc.3 收编（`067147f`）为人工本地完成
  （engines 下界、CI `dshVersion`、devDeps、baseline 四处同时改，故本地绿）。
- 即：带 lockstep 探针的 canary 尚未经历过任何一次列车前移运行。

## P2（盲区 + 文档失实）：重发布检测只锚定 bellwether 包

**现象**：绊线对"同版本重发布"的检测只读取 `@deepseek-ai/dsh` 本体一个包的
registry `time`，子包重发布不可见；而项目记录的唯一一次真实事故恰是子包重发布。

**证据链**：

1. `scripts/bump-upstream.mjs:38-40`：`BELLWETHER`/`REGISTRY_URL` 只指向
   `@deepseek-ai/dsh`；104-124 行的重发布检测比较的是该包
   `time[target]` 与 `baseline.json` 的 `generatedAt`。
2. `docs/versioning.md` §2 背景事故（55-57 行）：2026-11-09 事故为
   `@deepseek-ai/dsh-subagent@0.2.2-rc.1` **同版本重发布**（子包）。
   若 dsh 本体未同步重发，`time` 比较不触发。
3. `docs/versioning.md` §4 S2 行（89 行）声称"列车前移**或同版本重发布**都触发"，
   与实现不符。

**后果**：子包单独同版本重发布时，日绊线不触发。现存缓解只有两条：S1 的
`npm ci` EINTEGRITY（仅在 push/PR 时运行）与周一兜底全量 run；无提交的周内，
盲区最长约 7 天。

## P3（覆盖面 + 文档失实）：canary 绿不含真实宿主安装冒烟

**现象**：canary 的验证止于 `npm run check` + `check:compat`（两者都只针对
node_modules 中安装的包），不运行 S1 的真实 dsh CLI 安装冒烟；插件经
bundle patch 注册进宿主的路径没有任何 canary 覆盖。

**证据链**：

1. `canary.yml` 的 canary job 步骤为 bump → 重装 → 重生成 baseline →
   `npm run check` → `check:compat` → 上传 artifact；无安装冒烟步骤。
2. `.github/workflows/ci.yml` 的安装冒烟步骤（`bowenliang123/dsh-plugin-checker`，
   `dshVersion: 0.2.2-rc.3`）只在 push/PR 触发，且版本钉在**已收编**的列车上。
3. 插件经 `package.json` 的 `dsh.bundle.patch`（`cordis.patch.yml` 注入 config
   条目）向宿主注册，该路径只有 S1 的真实安装冒烟覆盖。
4. `docs/seam-driven-verification.md`（157-160 行，"包不住的部分 §3"）承认此
   gap 并指出只有 S1 能发现；但 `docs/versioning.md` §4 描述 canary 时未说明
   该语义收窄。

**后果**：canary 绿只证明"类型检查、测试、官方兼容门在新包上通过"，不证明
"插件能装进新版本的真实 dsh 并挂载"；收编决策基于前者，安装失败最早在收编
commit 的 S1 才暴露。

## P4（计划烂尾）：隐性嫌疑扫描停留在 advisory

**现象**：既定计划写明阶段 B（探路插件验货器）完成后将未报备嫌疑改为硬门禁；
阶段 B 已落地，硬门禁未做，三份文档口径不一。

**证据链**：

1. `docs/seam-driven-verification.md:86`："第一版先只打印报备单（不 exit 1），
   **等阶段 B 完成后再改成硬门禁**"；同文执行计划（176-179 行）阶段 B 即
   commit 3。
2. 阶段 B 已落地（`217929e`，2026-11-13），但
   `scripts/analyze-dsh-coupling.mjs:737-781`（`suspectSection`）对未报备嫌疑
   仍只打印；脚本头部注释（43-47 行）亦声明
   "unacknowledged suspects are advisory only and never change the exit code"。
3. `docs/versioning.md` §5（125 行）与 `docs/upstream-audit.md` §0（19 行）只写
   "报备"，未提硬门禁的后续口径。

**后果**：未报备嫌疑的报备单没有任何机制保证被人看到（尤其它只在
`--check` 与默认模式的 stdout 里）；计划承诺的门禁状态与实现、文档三方不一致。

## P5（流程缺口）：跨 minor 收编流程未定义

**现象**：`engines.dsh` 上界（`>=0.2.2-rc.3 <0.3.0-0`）配合单线跟随策略，
意味着上游发 0.3.0-rc.1 时 canary 必红且 artifact 必不完整；该情形与同 minor
前移是两种不同流程，文档只描述了一种。

**证据链**：

1. 跨 minor 前移时：`probeVersionLockstep` 红（P1 的机制），`check-compat.mjs`
   的官方闸门判定也红（`<0.3.0-0` 拒绝 `0.3.0-rc.1`，后者是正确行为）。
2. canary artifact 仅含 `package.json` + `package-lock.json` + `baseline.json`
   （`canary.yml` "Upload the revalidation material" 步骤），不含
   `engines.dsh` / `ci.yml` `dshVersion` 改动。
3. `docs/versioning.md` §4 的"artifact（package.json + lockfile + baseline.json）
   即 §5 重验 commit 的全部材料"只对不触动 engines 上界的同 minor 前移成立；
   §5 重验流程未区分两种情形。

**后果**：第一次 0.3.0-rc 出现时，"红 canary → 如何收编"没有可循文档；
"artifact 即全部材料"的表述在该场景下失实。

## P6（实现细节）：baseline 指纹的嵌套路径键名处理错误

**证据**：`scripts/write-baseline.mjs:36-44` 用
`key.startsWith('node_modules/@deepseek-ai/')` 前缀截取生成键名。嵌套依赖的
lockfile 键（`node_modules/@deepseek-ai/foo/node_modules/@deepseek-ai/bar`）
同样命中该前缀，生成的键名为 `foo/node_modules/@deepseek-ai/bar`。同时
`tests/seam-verify.test.ts:761` 用 `name.startsWith('dsh-')` 过滤列车成员，
形如 `dsh-foo/node_modules/...` 的嵌套键会被误计入列车版本集合，可能使
"恰好一条列车"的断言（763 行）失真。当前依赖树全平铺，未触发；属隐含假设。

## P7（实现细节）：周兜底判定依赖重复的 cron 字符串

**证据**：`canary.yml` 的 `on.schedule` 定义 `"37 4 * * 1"`，canary job 的
`if` 条件里以字面量 `github.event.schedule == '37 4 * * 1'` 再次出现。两处
需同步维护；只改其中一处时，周兜底静默退化为"仅周一绊线照常、全量 run 不再
触发"，无任何报错。

## P8（实现细节）：seam-verify 的 hook 定位退化为文本 grep

**证据**：`tests/seam-verify.test.ts:401-410`（`hookSite`）在固定候选文件里以
`line.includes("ctx.on('${event}'")` 定位 hook 注册点，假定单引号、直接调用
形态与固定文件列表。耦合扫描器（`analyze-dsh-coupling.mjs`）本身是 AST 的，
此处与其风格不一致；源码改为双引号、提取变量或移动文件时会 throw（响亮失败，
非静默）。

## P9（实现细节）：check-compat 对 engines 对象整体缺失报错不友好

**证据**：`scripts/check-compat.mjs:95-97` 在进入边界探针之前先构造
`label`（内插 `manifest.engines.dsh`）。`engines` 对象整体缺失时，
97 行直接 `TypeError: Cannot read properties of undefined`，而非走
`failUnparseableRange` 里"engines.dsh is missing"的友好路径。退出码仍非 0
（响亮），仅报错形态退化。`tests/check-compat.test.ts:72-88` 只覆盖了
"删除 `dsh` 键但保留 `engines` 对象"的场景。

## P10（实现细节）：精确版本正则不认 build metadata

**证据**：`scripts/bump-upstream.mjs:42` 的
`EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/` 不匹配带
`+build` 后缀的 semver。若上游某天发布带 build metadata 的版本，该条目会被
排除出 train（bump 不改写它），而 `probeVersionLockstep` 的 train 集合
（不校验格式）仍会收它，造成两处对"train"的口径分叉。当前上游未发此类版本。
