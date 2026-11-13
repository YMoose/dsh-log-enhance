---
Status: Draft (Lane A complete, Lane B pending)
Last Updated: 2026-11-13
---

# RESEARCH.md — 上游变更影响面评估方法论调研

> 本报告记录"宿主型插件如何评估上游变更影响面"的方法论调研，供 dsh-log-enhance 后续版本治理机制演进参考。

## Contents
- Terms & Concepts
- User Intent
- Research Subjects
- Dependencies
- Validation Strategy
- Risks and Pitfalls
- Solved Blocks

---

## Terms & Concepts

- **宿主（Host / Upstream）**: DeepSeek Harness（DSH），npm 包列车 `@deepseek-ai/*`，0.x RC 阶段，无 semver 承诺。
- **影响面（Impact Surface）**: 上游一次变更可能影响本插件的全部范围，包括我们消费的 API 符号、字段路径、事件 hook、行为语义。
- **coupling.json**: 本项目用 TS AST 静态提取的"我们用了上游哪些 API"清单（commit `39a80c1` 引入）。
- **baseline.json**: 记录安装内容指纹（version + integrity hash）+ node 版本 + 日期，用于检测"同版本重发布"。
- **engines.dsh**: package.json 声明的宿主兼容范围；官方闸门（`plugin-compatibility.ts`）会**短路 peers 检查**。
- **Witness**（来自 cargo-semver-checks）: 为存疑 lint 自动生成"能在旧版编译、在新版编译失败"的最小下游样例，用于证明"这个变更真的算破坏"。
- **Outcome-diff**（来自 Crater）: 以"同一测试在新旧版本的结果差异"为告警，而非绝对红绿。
- **Golden Master / Approval Testing**: 录制宿主事件流/渲染输出的规范化快照，跨版本 diff。
- **Hyrum's Law**: "给定足够多的使用者，你在契约里承诺什么并不重要——系统的所有可观察行为都会被某人依赖。"
- **Consumer-driven contracts (CDC)**: Pact 模式，消费者生成契约文件，provider 侧回放验证。
- **API Extractor**: 微软的 TS API 面提取工具，产出签入仓库的 `*.api.md` 报告作为评审门。

---

## User Intent

- **What the user wants**: 了解业界针对"上游改动的插件项目"如何评估影响面，有什么方法论和工具；并对比 dsh-log-enhance 现有机制，找出差距和可借鉴的做法。
- **Expected outcome**: 一份结构化调研报告，明确指出"我们已有什么 / 业界怎么做 / 差距在哪 / 哪些可借鉴"。
- **Why it matters**: 本项目已建立较完整的版本治理基础设施（engines.dsh / baseline.json / coupling.json / canary / 红测试路由），但需要外部视角验证方向是否正确、是否遗漏关键方法论。
- **Main constraints**: 宿主是 0.x RC 阶段无 semver 承诺；已发生同版本重发布事故；不跟上游 master（dist-tag `next` 为准）；单线跟随策略（2026-11-13 定策）。

---

## Research Subjects

### Subject A: API Surface 建模（把"我用了什么"变成可评审产物）

**为什么相关**：影响面评估的前提是知道"我用了上游什么"。

- Source: https://api-extractor.com/ （API Extractor 官方文档）
  - Findings: API Extractor 产出签入仓库的 `*.api.md` 报告，PR diff 这份报告即"这次改了哪些 API"。支持 `@alpha/@beta/@public` 三级发布标签，同一份 d.ts 按标签裁剪。
  - Related to: 我们的 coupling.json 是 consumer 侧等价物，但缺 surface 快照与 stability tier。

- Source: https://github.com/obi1kenobi/cargo-semver-checks
  - Findings: Rust 生态用 lint 化路线（`function_missing` 等几十条命名 lint）判定破坏，每条可配 `deny/warn/allow`。**引入 witness**——为存疑 lint 自动生成最小下游样例，"能在旧版编译、在新版编译失败"才认定为真破坏。明确区分"API diff（告诉变了什么）"与"API lint（告诉为什么算破坏）"。
  - Related to: 我们的 coupling 校验是"存在性"检查，不是"可用性"检查。字段存在但类型收窄/可空性变化会被放过。

- Source: https://code.visualstudio.com/api/advanced-topics/using-proposed-api
  - Findings: VS Code 显式分层 stable `vscode.d.ts` vs `vscode.proposed.<name>.d.ts`，后者必须白名单声明、只能 Insiders、禁止上架。
  - Related to: 我们没有 stability tier；上游 0.x 无分层信号，但可自建——给 coupling 条目打 `stable/internal/proposed` 标。

- Source: https://developer.hashicorp.com/terraform/plugin/sdkv2/resources/state-migration
  - Findings: Terraform provider 用**自有单调版本号** `SchemaVersion`（整数）+ `StateUpgraders` 链，而非依赖上游版本号。
  - Related to: 直接对应"同版本重发布"痛点。契约基线应由我们自己的单调 `contract epoch` 计数，上游 version 仅作元数据。

### Subject B: 变更信号源（从哪发现上游变了）

- Source: https://docs.npmjs.com/cli/v10/configuring-npm/package-json#engines
  - Findings: npm `engines` 字段"**除非用户设置 engine-strict，否则仅为 advisory**，安装依赖时只产生 warning"。
  - Related to: `engines.dsh` 虽有官方闸门短路 peers，但本质上仍是"声明式"——真正的门禁要么在宿主（VS Code 式硬拦截，我们无法要求），要么在**运行时自检**（插件启动读宿主版本/契约指纹）。

- Source: https://code.visualstudio.com/api/references/extension-manifest
  - Findings: VS Code `engines.vscode` 是 manifest **必填**且**不可为 `*`**，由 Marketplace 强制执行安装兼容性。
  - Related to: 硬门禁的范例，但需要宿主方配合。

- Source: https://developer.chrome.com/docs/extensions/reference/manifest/minimum-chrome-version
  - Findings: Chrome `minimum_chrome_version` 对**新装**硬拦截（商店显示 Not compatible），对**存量用户是静默停更**——官方原文提示 "happens silently so you should exercise caution"。
  - Related to: 提醒"版本门槛对存量用户的影响"是静默的，需要主动通知机制。

- Source: https://github.com/oasdiff/oasdiff
  - Findings: OpenAPI 生态的 oasdiff 把 diff 分三档：`breaking` / `changelog` / `diff`；有 `coverage` 检查（枚举"文档的每一种可能编辑"与"覆盖它的检查规则"的映射表）；有 **change fingerprint**（跨 commit 稳定 ID）；有 `VERSIONING` 检查（"报告未升 major 就发布的破坏性变更"）。
  - Related to: coverage 表是低成本高收益的补充——把我们的 surface kind × 检查规则列成矩阵，空缺格就是盲区。"事件 payload 形状"和"返回值语义"几乎必然在空缺里。

- Source: https://blog.rust-lang.org/2025/01/09/Rust-1.84.0/
  - Findings: Rust 1.84 稳定 MSRV-aware resolver——解析依赖时**自动回退到与声明 `rust-version` 兼容的旧版本**，而不是报错。
  - Related to: 反向思路：把兼容性判定从"版本区间"改为"契约子集关系"，对无 semver 的 0.x 宿主更稳健。

### Subject C: 影响面定位（只重核受影响的契约节）

- Source: https://github.com/doitintl/kube-no-trouble
  - Findings: kubent 用 **Rego 规则集**扫描集群/清单/Helm release 中的 API 版本，有 `--target-version` 参数"只显示与目标 K8s 版本相关的发现"。
  - Related to: 我们的"红测试 → upstream-audit.md 章节"路由是人工映射；kubent 是规则集 × 目标版本 → 相关发现的机器生成。

- Source: https://github.com/rust-lang/crater
  - Findings: Crater 跑全生态 crate 的 build/test，**在两个编译器版本间对比结果**，有成文的 **report triage procedure**（区分真回归 / 既有失败 / 已修复 / 环境噪声）。
  - Related to: **Outcome-diff** 是最值得抄的一条——以"同一测试在新版本下结果与上一版本不同"为告警，而非绝对红绿。能把长期红、环境性红、上游已知问题一次性过滤掉，直接解决 canary 噪声问题。

- Source: https://eslint.org/docs/latest/use/migrate-to-9.0.0
  - Findings: ESLint v9 迁移指南显式切三类受众：breaking changes for **users** / **plugin developers** / **integration developers**，每类下再逐条列举。
  - Related to: 我们的红测试可能同时命中"类型契约破坏 / 运行时行为破坏 / CI 工具链破坏"三类，混在一节会导致重核范围膨胀。可按受众分层章节。

### Subject D: 静默失败的防御（契约外行为）

- Source: https://docs.pact.io/
  - Findings: Pact 的消费者驱动契约模型：消费者测试生成 pact 文件 → 发布到 Broker → **provider 侧回放验证** → `can-i-deploy` 依据版本矩阵决定能否部署；`pending pacts` 让新增契约不阻塞 provider 构建。
  - Related to: 我们结构性缺 provider 侧验证（上游不会为我们跑契约）。唯一能搬运的形态是**把 coupling 上提给上游**：以 issue/PR 形式提交"我们依赖这些符号，请在 CI 里保留一个 consumer-smoke"。这是 vuejs/ecosystem-ci（`pnpm override` 强制装上游 commit 跑下游测试）和 nodejs/citgm 的反向最小版。

- Source: https://www.hyrumslaw.com/
  - Findings: Hyrum's Law——所有可观察行为都会被依赖。
  - Related to: **类型不变、行为变、事件没来**这类 Hyrum 面，我们的静态方法完全覆盖不到，是最大盲区。唯一有效手段是**行为级 golden master**：录制宿主事件流/渲染输出的规范化快照，跨版本 diff。"事件没来"的唯一可观测化手段是断言"N 个事件在 T 内到达且顺序稳定"。

- Source: https://approvaltests.com/
  - Findings: Approval Tests 定位一句话："A picture's worth a 1000 tests"——快照复杂输出并断言其不再变化。
  - Related to: 行为快照工具的直接范例。

- Source: https://github.com/tsdjs/tsd
  - Findings: `tsd` 的 `expectType<T>` 是严格同一性断言（非兼容），还有 `expectDeprecated` / `expectError`。
  - Related to: 业界对 d.ts 的断言是**签名级**而非存在级。我们的 Compiler API 校验可低成本升级为"从 coupling.json 生成 `.test-d.ts` 再跑 tsc"。

### Subject E: 现有机制逐项对照

| 维度 | 我们已有 | 业界等价物 | 差距 |
|---|---|---|---|
| 契约清单 | `coupling.json` (AST) | api-report.md / rustdoc baseline | 缺 surface 快照与 stability tier |
| 契约校验 | Compiler API 存在性 | witness / tsd 签名级 | 存在性 ≠ 可用性 |
| 基线指纹 | `baseline.json` (version+integrity) | Terraform SchemaVersion / MSRV 子集关系 | 依赖上游版本号，应改自有 epoch |
| 变更信号 | dist-tag + registry time | oasdiff 三档 + fingerprint；VS Code 硬门禁 | 缺"结果 diff"与运行时自检 |
| 局部重核 | 红测试→章节（人工） | kubent target-version / Crater triage | 应机器生成待重核清单 + 受众分层 |
| 静默失败 | canary（仅重发布） | Pact / golden master / property-based | 行为层零覆盖 |
| 版本声明 | `engines.dsh` | npm engines（仅 advisory） | 声明无强制力，需 runtime 自检或契约子集校验 |

---

## Dependencies

- [READY] `coupling.json` + `analyze-dsh-coupling.mjs`（commit `39a80c1`）
- [READY] `baseline.json` + `tests/baseline.test.ts`
- [READY] `engines.dsh` + `scripts/check-compat.mjs`
- [READY] canary workflow（`.github/workflows/canary.yml`）
- [READY] link-harness 契约校验（commit `f7b6e20`，Compiler API 存在性检查）
- [NICE-TO-HAVE] 上游 surface 快照（裁剪过的 .d.ts 基线）
- [NICE-TO-HAVE] 行为级 golden master 录制与 diff 工具
- [BLOCKING] 无——本调研不阻塞任何当前工作

---

## Validation Strategy

本调研本身的验证：
- 每条 finding 都有权威来源（官方文档/大项目源码/被广泛引用的博客）
- 每个"差距"判断都与 dsh-log-enhance 现有机制做了对照（§Subject E 表）
- 关键结论（如"engines 是 advisory"、"witness 是存在性→可用性的关键跃迁"）有 2+ 独立来源支撑

调研结果的后续验证（若引入新机制）：
- 引入 witness 式校验后，构造一个"字段存在但类型收窄"的 mock checkout，断言能检测出来
- 引入 outcome-diff 后，用历史 canary run 验证"噪声红"是否被过滤

---

## Risks and Pitfalls

- **Risk**: 盲目引入业界机制导致过度工程（over-engineering）。
  - Linked to: 宿主 0.x RC 阶段 + 单线跟随策略（2026-11-13 定策）。
  - Why it matters: versioning.md §6 明确"延迟承诺"，不预支机制。
  - Mitigation: 按 ROI 排序，优先引入"witness 式校验"和"outcome-diff"这两个高收益低成本的机制；golden master 等上游稳定后再考虑。

- **Risk**: 把"契约存在性"误认为"契约可用性"。
  - Linked to: 现有 link-harness 契约校验是存在性检查。
  - Why it matters: 字段存在但类型收窄/可空性变化会被放过，产生假绿。
  - Mitigation: 升级为 witness 式（生成最小调用样例真实编译）或 tsd 签名级断言。

- **Risk**: 依赖上游版本号做基线，遇同版本重发布失效。
  - Linked to: `baseline.json` 记录 version + integrity。
  - Why it matters: 2026-11-09 同版本重发布事故已发生一次。
  - Mitigation: integrity 指纹仍有效（内容变了 hash 就变），但 version 字符串不可信；可考虑引入自有 `contract epoch` 计数。

- **Risk**: 行为层（Hyrum 面）零覆盖，上游"语义不变但行为变"完全不可观测。
  - Linked to: 静态方法（AST/Compiler API）只能查契约存在性，查不了行为。
  - Why it matters: "事件没来"、"返回值语义变了"、"时机变了"都是静默失败。
  - Mitigation: 行为级 golden master（录制事件流快照跨版本 diff）+ 启动时契约自检（断言关键 hook 真实存在）。

---

## Solved Blocks

- **Issue**: 业界有没有"影响面评估"的标准方法论？
  - Method to solve: 深度调研（Lane A）
  - Why reasonable: 找到 4 段式主线（消费面固化 → lint 化判定 → outcome-diff → 行为快照兜底），有多生态权威来源支撑。
  - Planning impact: 确认我们的方向正确（coupling.json + 红测试路由），但有 3 个明确盲区（存在性≠可用性、缺 surface 快照、行为层零覆盖）。

- **Issue**: `engines.dsh` 声明的实际效力如何？
  - Method to solve: 查 npm 官方文档 + VS Code/Chrome 对比
  - Why reasonable: npm 官方明确 engines 是 advisory；VS Code 硬门禁需宿主配合；结论是"声明 ≠ 门禁，必须补运行时自检或契约子集校验"。
  - Planning impact: 确认需要在插件启动时做运行时版本/契约自检（对应 TODO 方案 B）。

---

## Research Subjects (Lane B: DSH 生态先例深挖)

### Subject F: dsh-context —— 生态内唯一建成"结构化影响面模型 + 可执行 seam 矩阵"的项目

- Source: https://github.com/bowenliang123/dsh-context
  - Findings:
    - **建模**：`tests/baselines.ts` 声明 3 个基线（tag `dsh-v0.2.0-rc.2`/`0.2.1-rc.2`/`0.2.2-rc.1`），每个声明 cordis/session 版本、`foldEventTypes`、按 **seam** 组织的表（`client.*`、`settings.register: boolean`（**退役面必须为 false**）、`balance.providerFiles[].needles` 等）。
    - **定位/执行**：`tests/compat/staging.ts` 用 `git show <tag>:<path>` 把真实宿主源码抽到 `.tmp/compat/<id>/`，`dshHasString(tag, pattern, pathspec)` 用 `git grep` 判定符号存在性（**负探针**），按该 tag 的 cordis/session 版本安装依赖，**boot 已构建的插件**。
    - **验证**：`matrix.spec.ts` 每个基线跑约 10 条断言：投影值经 wire 送达、checkpoint 过 lossless cache-write gate、cold restore == live 快照、`developerTokens === 35`、admission 允许该基线但拒绝被丢弃的 0.1.7 线、退役 seam 仍缺席、poisoned unit 行为。
    - **lockstep**：`tests/compat/manifest.spec.ts` 强制 `package.json` 的 `dshReleases` ↔ `tests/baselines.ts` ↔ CI workflow 的 fetch tag 列表三者一致。
  - Related to: 我们 `coupling.json` 粒度接近，但**只记录"哪里用了"**；dsh-context 多两维：① 该处**期望是什么**（present/absent、具体数字）；② 该处**行为是否还对**（boot 后实测）。

### Subject G: dsh-observe —— 安装级验证最强

- Source: https://github.com/PerryLink/dsh-observe
  - Findings:
    - **三级安装验证**：① bare-import（空项目只装 tarball 再 import，抓"devDeps 当 deps"）；② profile（临时 `DSH_HOME` 装 `dsh-base`+`dsh-headless`+tarball，`--dump-config | grep dsh-observe` 断言 row 挂载，跑无 key headless 任务靠 `MISSING_CREDENTIAL` 证明插件树已加载，120s 超时=缺注入服务）；③ 卸载可逆。
    - **影响面记录**：体现在 `pnpm-workspace.yaml` 的 `overrides` 中，每条 override 附动机注释（如把 `cordis-plugin-loader` 降级到 1.0.3 是因为 1.0.4 在 `Entry._init()` 中把 import 失败吞成日志）。
  - Related to: 我们的 `baseline.json` integrity 比它的 lockfile 更硬，但它的 **profile 挂载 + 卸载可逆冒烟**我们没有等价物。

### Subject H: dsh-telemetry-redactor —— sha256 fixture 覆盖"实际 import 的单文件"

- Source: https://github.com/030611/dsh-telemetry-redactor
  - Findings:
    - `fixtures/dsh-47f9438….json` 哈希两类东西：`sourceSha256`（6 个宿主**源码文件**）+ `runtime`（4 个**已发布包解包后的单文件** sha256 + version）。
    - 五段式验证：head→fixture→hash→API surface（断言 `Context`/`SessionId` 等都是函数）→ **行为断言**（导出层必须含 `[REDACTED]`、canonical 日志必须仍含明文）。
  - Related to: 我们 hash 的是 npm tarball integrity（包级、发布态），它 hash 解包后单文件（运行时态）+ 源码（源码态），能证明"我实际 import 的那个文件没变"。

### Subject I: dsh-scaffold —— dist-tag tripwire 正打中我们痛点

- Source: https://github.com/PerryLink/dsh-scaffold
  - Findings: `scripts/check-peer-range-latest.mjs` 对 `latest`/`next`/`alpha` 三个 dist-tag 断言被 canonical range 接纳（自带 semver 子集实现 + 单测）。
  - Related to: 这是"上游发版→我的声明是否还成立"的自动 tripwire，正打中我们痛点：prerelease 新 tuple 会**静默**不再匹配 `<X.Y.Z-0`。

### Subject J: 其他三个项目（简要）

- **dsh-plugin-langfuse**：upstream-canary 与我们 `bump-upstream.mjs` 同构，差距仅在 `test:package`（打包后在真 profile 再跑一遍）。
- **dsh-agent-observability**：有 golden master（`fixtures/*/events.json` + `expected-report.txt` + `update-goldens.mjs`），缺"not claimed"边界声明。
- **dsh-plugin-checker**：composite action 六步 cheapest-first（jq 校验 → `dsh plugin add` → `--dump-config | grep`），休眠中，被 dsh-context 以 floating `@v1` 引用（故 versioning.md 要求 SHA pin 正确）。

---

## Lane B 核心结论

**7 个项目里只有 dsh-context 建成"结构化影响面模型 + 可执行 seam 矩阵"**；其余项目大多是"单点检测器"（canary、hash、安装冒烟）。

能力分层：
- **dsh-context**：覆盖"建模 + 定位 + 验证"三层
- **dsh-observe**：覆盖"检测 + 验证"（安装级最强）
- **langfuse / telemetry-redactor**：各覆盖"检测"或"验证"一面
- 其余：单点能力

**我们 coupling.json 已在"建模"上接近 dsh-context，但缺"期望行为"与"负断言"两维。**

---

## 综合：业界（Lane A）× 生态（Lane B）× 我们现状

### 三层对照表

| 维度 | 业界最佳（Lane A） | 生态最强（Lane B） | 我们现状 | 差距 |
|---|---|---|---|---|
| **消费面建模** | api-report.md / rustdoc baseline | dsh-context `baselines.ts`（seam 表） | `coupling.json`（AST 提取） | 缺 stability tier、缺期望值/负断言 |
| **契约校验** | witness（cargo-semver-checks）/ tsd 签名级 | dsh-context `dshHasString` + boot 实测 | Compiler API 存在性 | 存在性 ≠ 可用性；无 boot 实测 |
| **基线指纹** | Terraform SchemaVersion（自有 epoch） | telemetry-redactor 五段式（head→hash→API→行为） | `baseline.json`（version+integrity） | 依赖上游版本号；无运行时单文件 hash |
| **变更信号** | oasdiff coverage + fingerprint；Crater outcome-diff | scaffold dist-tag tripwire | canary（dist-tag + time） | 缺"结果 diff"；无 dist-tag 断言 |
| **影响面定位** | kubent target-version；Crater triage | dsh-context 按基线组织断言 | 红测试→章节（人工） | 应机器生成待重核清单 |
| **静默失败** | Pact / golden master / property-based | dsh-context boot 实测 + 行为断言 | canary（仅重发布） | 行为层零覆盖 |
| **版本门禁** | npm engines（advisory）→ 运行时自检 | dsh-observe profile 挂载冒烟 | `engines.dsh` + check-compat | 声明无强制力，需 runtime 自检 |
| **lockstep** | —（业界未见） | dsh-context `manifest.spec.ts` | 无 | **完全缺失** |

### 三个最值得借鉴的具体做法

#### 1. **Witness 式校验**（业界 cargo-semver-checks）
- **现状**：我们查"字段存在吗"
- **改进**：生成最小调用样例，在 linked checkout 上真实编译
- **收益**：把"存在性"升级为"可用性"，抓住类型收窄/可空性变化

#### 2. **Outcome-diff 基线**（业界 Crater）
- **现状**：canary 红即告警（绝对红绿）
- **改进**：以"同一测试在新版本下结果与上一版本不同"为告警
- **收益**：过滤长期红、环境性红、上游已知问题，降低噪声

#### 3. **Lockstep spec**（生态 dsh-context）
- **现状**：`coupling.json` / `baseline.json` / CI pin 列表三处独立维护
- **改进**：写一个可执行一致性断言（类似 `manifest.spec.ts`），强制三者同步
- **收益**：范围改写无法静默变成 no-op

### 三个我们独有的优势（生态未见）

1. **coupling.json 的 AST 提取**：dsh-context 是手工维护 `baselines.ts`，我们是自动生成
2. **红测试路由机制**：按测试文件路由到 upstream-audit.md 章节，生态项目没有等价物
3. **link-harness 契约校验**：linked 开发树的早期警告，生态项目都是 CI 时才验证

### 三个最大的盲区（按风险排序）

1. **行为层零覆盖**（Hyrum 面）：上游"语义不变但行为变"、"事件没来"完全不可观测
   - **唯一有效手段**：行为级 golden master（录制事件流快照跨版本 diff）
   - **成本**：高（需要录制/规范化/diff 工具链）
   - **建议**：等上游稳定后再考虑（当前 0.x RC 阶段行为变化太频繁）

2. **存在性 ≠ 可用性**：字段存在但类型收窄/可空性变化会被放过
   - **改进**：witness 式校验（生成最小调用样例真实编译）
   - **成本**：中（需要为 coupling.json 每条生成样例代码）
   - **建议**：下次迭代可做

3. **三处真相可能漂移**：`coupling.json` / `baseline.json` / CI pin 列表独立维护
   - **改进**：lockstep spec（强制三者一致）
   - **成本**：低（写一个测试文件）
   - **建议**：立刻做

---

## Dependencies

- [READY] `coupling.json` + `analyze-dsh-coupling.mjs`（commit `39a80c1`）
- [READY] `baseline.json` + `tests/baseline.test.ts`
- [READY] `engines.dsh` + `scripts/check-compat.mjs`
- [READY] canary workflow（`.github/workflows/canary.yml`）
- [READY] link-harness 契约校验（commit `f7b6e20`，Compiler API 存在性检查）
- [NICE-TO-HAVE] 上游 surface 快照（裁剪过的 .d.ts 基线）
- [NICE-TO-HAVE] 行为级 golden master 录制与 diff 工具
- [BLOCKING] 无——本调研不阻塞任何当前工作

---

## Validation Strategy

本调研本身的验证：
- 每条 finding 都有权威来源（官方文档/大项目源码/被广泛引用的博客）
- 每个"差距"判断都与 dsh-log-enhance 现有机制做了对照
- 关键结论有 2+ 独立来源支撑（业界 Lane A + 生态 Lane B 交叉验证）

调研结果的后续验证（若引入新机制）：
- 引入 witness 式校验后，构造一个"字段存在但类型收窄"的 mock checkout，断言能检测出来
- 引入 outcome-diff 后，用历史 canary run 验证"噪声红"是否被过滤
- 引入 lockstep spec 后，故意改一处不改其他两处，断言测试红

---

## Risks and Pitfalls

- **Risk**: 盲目引入业界机制导致过度工程（over-engineering）。
  - Linked to: 宿主 0.x RC 阶段 + 单线跟随策略（2026-11-13 定策）。
  - Why it matters: versioning.md §6 明确"延迟承诺"，不预支机制。
  - Mitigation: 按 ROI 排序，优先引入 lockstep spec（低成本高收益）和 witness 式校验（中成本高收益）；golden master 等上游稳定后再考虑。

- **Risk**: 把"契约存在性"误认为"契约可用性"。
  - Linked to: 现有 link-harness 契约校验是存在性检查。
  - Why it matters: 字段存在但类型收窄/可空性变化会被放过，产生假绿。
  - Mitigation: 升级为 witness 式或 tsd 签名级断言。

- **Risk**: 依赖上游版本号做基线，遇同版本重发布失效。
  - Linked to: `baseline.json` 记录 version + integrity。
  - Why it matters: 2026-11-09 同版本重发布事故已发生一次。
  - Mitigation: integrity 指纹仍有效（内容变了 hash 就变），但 version 字符串不可信；可考虑引入自有 `contract epoch` 计数。

- **Risk**: 行为层（Hyrum 面）零覆盖，上游"语义不变但行为变"完全不可观测。
  - Linked to: 静态方法（AST/Compiler API）只能查契约存在性，查不了行为。
  - Why it matters: "事件没来"、"返回值语义变了"、"时机变了"都是静默失败。
  - Mitigation: 行为级 golden master（录制事件流快照跨版本 diff）+ 启动时契约自检（断言关键 hook 真实存在）。

---

## Solved Blocks

- **Issue**: 业界有没有"影响面评估"的标准方法论？
  - Method to solve: 深度调研（Lane A + Lane B）
  - Why reasonable: 找到 4 段式主线（消费面固化 → lint 化判定 → outcome-diff → 行为快照兜底），有多生态权威来源支撑。
  - Planning impact: 确认我们的方向正确（coupling.json + 红测试路由），但有 3 个明确盲区（存在性≠可用性、缺 lockstep、行为层零覆盖）。

- **Issue**: `engines.dsh` 声明的实际效力如何？
  - Method to solve: 查 npm 官方文档 + VS Code/Chrome 对比
  - Why reasonable: npm 官方明确 engines 是 advisory；VS Code 硬门禁需宿主配合；结论是"声明 ≠ 门禁，必须补运行时自检或契约子集校验"。
  - Planning impact: 确认需要在插件启动时做运行时版本/契约自检（对应 TODO 方案 B）。

- **Issue**: 生态内谁做得最完整？
  - Method to solve: Lane B 逐个深挖 7 个项目
  - Why reasonable: dsh-context 唯一做到"建模 + 定位 + 验证"三层，其余都是单点检测器。
  - Planning impact: 明确借鉴对象（dsh-context 的 lockstep spec、负断言、boot 实测；dsh-observe 的 profile 冒烟；telemetry-redactor 的五段式）。

---

## 下一步建议（按 ROI 排序）

### 🔥 P0 - 立刻做（低成本高收益）

1. **Lockstep spec**：写 `tests/versioning-lockstep.test.ts`，强制 `coupling.json` / `baseline.json` / `check-compat.mjs` 的 `dshVersion` / CI workflow 的 pin 列表四者一致
   - 借鉴：dsh-context `manifest.spec.ts`
   - 工作量：小（~50 行测试）
   - 收益：防止三处真相漂移

### 🟡 P1 - 下次迭代（中成本高收益）

2. **Witness 式校验**：为 `coupling.json` 每条生成最小调用样例，在 linked checkout 上真实编译
   - 借鉴：cargo-semver-checks witness
   - 工作量：中（需要为每条生成样例代码 + 跑 tsc）
   - 收益：把"存在性"升级为"可用性"

3. **Dist-tag tripwire**：对 `latest`/`next`/`alpha` 三个 dist-tag 断言被 `engines.dsh` range 接纳
   - 借鉴：dsh-scaffold `check-peer-range-latest.mjs`
   - 工作量：小（~30 行脚本）
   - 收益：抓住"prerelease 新 tuple 静默不再匹配 `<X.Y.Z-0`"

### 🔵 P2 - 等触发条件

4. **行为级 golden master**：录制事件流快照跨版本 diff
   - 借鉴：Approval Tests / dsh-agent-observability 的 golden
   - 触发条件：上游发布 1.0 / semver 承诺后（当前 0.x RC 阶段行为变化太频繁）

5. **Outcome-diff 基线**：以"结果差异"而非"绝对红绿"为告警
   - 借鉴：Crater
   - 触发条件：canary 噪声成为实际问题时

---

## 参考清单

### Lane A（业界）
1. VS Code – Using Proposed API: https://code.visualstudio.com/api/advanced-topics/using-proposed-api
2. API Extractor: https://api-extractor.com/
3. cargo-semver-checks: https://github.com/obi1kenobi/cargo-semver-checks
4. Terraform State Migration: https://developer.hashicorp.com/terraform/plugin/sdkv2/resources/state-migration
5. kubent: https://github.com/doitintl/kube-no-trouble
6. oasdiff: https://github.com/oasdiff/oasdiff
7. Pact: https://docs.pact.io/
8. Hyrum's Law: https://www.hyrumslaw.com/
9. npm engines: https://docs.npmjs.com/cli/v10/configuring-npm/package-json#engines
10. Crater: https://github.com/rust-lang/crater
11. tsd: https://github.com/tsdjs/tsd
12. Approval Tests: https://approvaltests.com/
13. ESLint v9 迁移指南: https://eslint.org/docs/latest/use/migrate-to-9.0.0

### Lane B（生态）
1. dsh-context: https://github.com/bowenliang123/dsh-context
2. dsh-observe: https://github.com/PerryLink/dsh-observe
3. dsh-plugin-langfuse: https://github.com/linyp/dsh-plugin-langfuse
4. dsh-telemetry-redactor: https://github.com/030611/dsh-telemetry-redactor
5. dsh-agent-observability: https://github.com/beibeihk/dsh-agent-observability
6. dsh-plugin-checker: https://github.com/bowenliang123/dsh-plugin-checker
7. dsh-scaffold: https://github.com/PerryLink/dsh-scaffold
