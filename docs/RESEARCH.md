---
Status: Final
Last Updated: 2026-11-13
---

# RESEARCH — 接触面验证系统的先例调研与独特性定位

本报告回答：**"针对插件↔宿主集成系统的验证，有没有现成实现？我们系统的独特性在哪？"**
调研范围：契约测试、类型级兼容工具、插件生态治理模式、消费方侧版本验证。严格观察性
记录，不含实施指令。方法：本地仓库文档（versioning.md §7 的 2026-11-10 生态调研）+
六次定向网络检索（2026-11-13）。

## Terms & Concepts

- **CDC（Consumer-Driven Contract Testing）**：消费方驱动契约测试。消费方对 mock 提供方
  写测试生成契约工件，提供方回放验证自己满足契约。代表实现 Pact + Pact Broker。
  [来源：docs.pact.io/consumer、pactflow.io]
- **接触面（seam）**：本仓术语，指插件对宿主（DSH）类型的真实使用点（字段访问、hook
  注册、判别字面量），含守卫上下文。[来源：docs/seam-driven-verification.md]
- **列车（train）**：本仓术语，指 DSH 全家桶在同一版本号上一起发布的一组包
  （`@deepseek-ai/dsh-*`），走 npm dist-tag `next`。[来源：docs/versioning.md §2]
- **单线跟随（single-line follow）**：本仓政策——只保证在最新 `next` 列车上运行，不做
  多版本矩阵。[来源：docs/versioning.md §4，用户 2026-11-13 决策]
- **同版本重发布（same-version republish）**：上游在不变版本号的情况下重新发布包内容，
  只有 registry `time` 与 integrity 变化。2026-11-09 实际发生过。
  [来源：docs/versioning.md §5、本 session 记录]
- **MSRV / minimal-versions**：Rust 生态概念——声明最低支持版本，及消费方在依赖声明
  范围的**最低**版本上做测试的做法（`-Z minimal-versions`，RFC 3537）。
  [来源：rust-lang.github.io/rfcs/3537、rustprojectprimer.com]
- **proposed API**：VSCode 对不稳定扩展 API 的门控机制：`enabledApiProposals` 声明 +
  按宿主构建获取 dts，提案迭代后才转稳定。[来源：code.visualstudio.com/api/advanced-topics/using-proposed-api]

## User Intent

- Current State Snapshot：本仓已建成接触面发现（扫描器+耦合清单）、验证（探针编译+真实
  挂载）、迭代跟随（绊线+canary+收编）三层体系；守卫自动提取刚落地（`aa2d5a7`），
  验货器引擎已无宿主结构知识（仅剩 4 个适配点）。
- What the user wants：判断这套体系是否有现成先例/可替换的现成方案，以及它的真实独特性
  到底在哪（是否只是重复造轮子）。
- Expected outcome：一份有出处的先例地图 + 诚实的独特性结论（哪些成分是借来的、
  哪个组合是自己的）。
- Why it matters：决定未来是抽取成独立项目、还是定位为"用现成工具组合即可"的判断依据。
- Main constraints：无（纯调研）。

## Research Subjects

### Subject 1: 契约测试——概念上最近的祖先（Pact / CDC）

- Source: docs.pact.io/consumer；pactflow.io "What is CDC"；keploy.io 契约测试工具榜
    Findings：CDC 的核心结构是——消费方代码对 mock 提供方跑真实测试，产出序列化契约
    工件，发布到 broker；提供方在自己的流水线里回放契约验证自己没破坏消费方。
    [事实]
    Related to：我们的体系与 CDC 共享同一个核心立场（**契约由消费方的真实使用定义**，
    而非提供方的完整 API 面），但三个维度都不同：Pact 在 HTTP/消息层（我们是进程内
    类型层）；契约是运行时捕获的请求/响应工件（我们是从源码 AST 提取的静态使用面 +
    编译期探针）；需要 broker 协作治理（我们无上游协作，DSH 不会跑我们的契约）。
    [解释]

### Subject 2: 类型级兼容工具——同族技术，提供方侧或手写断言

- Source: npm-compare.com（api-extractor vs tsd vs typedoc）；arethetypeswrong.github.io
    Findings：`@microsoft/api-extractor` 把**提供方**导出面冻结成 API 报告并做漂移门禁；
  `tsd`/`dtslint` 是对 `.d.ts` 的**手写断言**测试框架；`arethetypeswrong` 检查包的类型
  在各模块系统下能否解析。三者都不扫描消费方代码。[事实]
    Related to：我们的 abnormal 测试（mock 声明删字段→探针必须编译失败）用的就是
    dtslint 式 mock 技巧；api-extractor 与我们的 coupling 门禁同构（快照+漂移判红），
    但方向相反：它盯"提供方导出什么"，我们盯"消费方怎么用"。[解释]

### Subject 3: 插件生态的通行治理模式（三种，均与本仓条件不匹配）

- Source: eslint.org/docs/latest/extend/plugins（peerDependency 约定）；
  jsx-eslint/eslint-plugin-react#4027（ESLint 10 peer 适配摩擦）
    Findings：主流宿主生态（ESLint/Babel/webpack）的插件声明 peer 版本范围并以
  **测试矩阵**验证兼容。[事实]
    Related to：这是被本仓明确拒绝的路线（S3 取消、单线跟随）——矩阵维护成本对
  一人维护的插件不成立，且 DSH 的 rc 线没有 semver 承诺可供范围声明。[解释]

- Source: code.visualstudio.com/api/advanced-topics/using-proposed-api；
  microsoft/vscode wiki "Extension API process"
    Findings：VSCode 由**宿主侧治理**不稳定 API（proposed API 门控 + 逐版本 dts +
  提案→稳定的年度节奏），扩展作者因此不需要自建防御体系。[事实]
    Related to：DSH 不提供任何等价治理（无 proposed/stable 之分、无 API 冻结节奏、
  日更 rc），这是本体系存在的前提条件——消费方只能自保。[解释]

- Source: rust-lang.github.io/rfcs/3537；rustprojectprimer.com（cargo-minimal-versions）；
  crates.io/crates/cargo-semver-checks
    Findings：Rust 生态把兼容验证拆成两侧——提供方 `cargo-semver-checks`（rustdoc
  对比断 semver），消费方 `minimal-versions`（在声明范围的最低版本上测试）。[事实]
    Related to：我们 check-compat 的边界探针（下界被范围接纳/上界外的第一个预发布被拒）
    与 minimal-versions 同精神；但单线政策下我们只验"最新线"，不做范围矩阵；
  且 cargo-semver-checks 依赖提供方守 semver——DSH 不守。[解释]

### Subject 4: 升级跟随与完整性基线——机制常见，组合罕见

- Source: 本仓 versioning.md §7（2026-11-10 调研：langfuse upstream-canary 模式参考、
  Renovate preset 共享仓 dsh-plugin-kit、bowenliang123/dsh-plugin-checker）
    Findings：定时探测上游→全量验证→上传收编材料的 canary 模式有先例；
  DSH 生态内已有共享 CI 配置（33 仓库先例）但无验证机制先例。[事实]
    Related to：dist-tag `next` 列车跟随 + 全列车成员同版本重发布检测（registry
  `time` 与 baseline generatedAt 比对）+ integrity 指纹基线——这个组合是 DSH 发版
  习惯（dist-tag 列车、rc 日更、同版本重发布）倒逼出来的，检索未见通用工具覆盖
  （Renovate/Dependabot 面向 semver 范围更新，无重发布检测）。[解释]
- Source: npm lockfile integrity（标准机制）
    Findings：integrity 锁定是 npm 标准能力。[事实]
    Related to：本仓的 baseline.json 是它的有意重组（提交指纹快照 + 漂移判红 +
  重验流程锚点），非新机制。[解释]

### Subject 5: 直接先例探针——"扫消费方使用并自动验证"（负结果）

- Source: 定向检索 "extract API usage from consumer codebase verify against library
  types automatic compatibility tool"（2026-11-13）
    Findings：返回 OpenAPI/Pact/LLM 工具噪音，未命中任何"扫描 TS 消费方代码的
  真实 API 使用 + 守卫上下文 → 对安装的提供方类型机械生成验证探针"的工具。
  [WARNING: UNCERTAIN] 这是**单轮检索的负结果**，不能证明不存在；knip 找的是
  "没用到的"导出（反向问题），typescript-eslint 的 type-aware 规则是逐节点语义
  判断的成熟基建（我们复用其路线），但都不是使用面验证器。[事实+不确定标注]
    Related to：这是独特性论断的核心证据，也是最薄弱的一环（见 Risks）。

## Dependencies

- [READY] 本仓全部机制文档与实现（docs/、scripts/、tests/seam/）
- [READY] versioning.md §7 的 DSH 生态内部调研（2026-11-10）
- [READY] 六次定向网络检索结果（2026-11-13，见各 Subject 出处）

## Validation Strategy

- Validation for: "每个成分都有先例"论断
    Timing: 已完成。Method: 每类先例至少 1 个权威来源（官方文档/registry/RFC）。
    Success condition: 本报告 Subject 1–4 的每个映射都有出处。✔
- Validation for: "该组合无现成实现"论断（负结果）
    Timing: 已完成一轮；结论强度有限。Method: 定向检索消费方使用验证工具。
    Success condition: 未命中即记录为 [WARNING: UNCERTAIN]。✔（已标注）
    复核触发条件：出现第二宿主接入需求时，用该宿主生态关键词重查一次。

## Risks and Pitfalls

- Risk: "无人做过"是过度声明。
    Linked to: Subject 5 的单轮负结果。
    Why it matters: 以"独创"自居会低估借用成熟方案的机会，也可能在对外表述时
    被一个反例击穿。
    Mitigation / Watch-out: 表述固定为"**成分皆有先例，组合未见先例**"；发现反例
    （任何"扫消费方使用面→对提供方类型自动验证"的工具）时修正定位。
- Risk: 把"DSH 条件特殊"绝对化。
    Linked to: Subject 3 的解释链。
    Why it matters: DSH 未来若引入 VSCode 式 API 治理或 semver 纪律，本体系的部分
    机制（重发布绊线、全列车看守）价值会下降。
    Mitigation / Watch-out: 把体系的存在条件（无承诺、日更、列车、重发布）写进定位
    文档，条件消失时按 §5 重验流程降级机制，而不是惯性维护。

## Solved Blocks

- Issue: 有没有现成的插件↔宿主集成验证系统可直接替换本仓自建体系？
    Why blocked: 决定未来投入方向（继续自建 vs 换用现成 vs 抽取独立项目）的前提。
    Method to solve: `[HIGH] Inferences`（本地文档 + 六次定向检索的综合推断）
    Why reasonable: 每个成分都映射到了成熟先例（Pact/api-extractor/tsd/peer 矩阵/
      minimal-versions/proposed API/Renovate），但没有一个先例覆盖"进程内类型层的
      消费方驱动验证"，也没有通用工具处理 DSH 的发版条件（dist-tag 列车 + 同版本
      重发布）。负结果已按规则标注不确定。
    Revisit Trigger: ①发现"扫消费方使用面自动验证"的现成工具；②DSH 引入官方
      兼容治理（proposed API 门控 / semver 承诺）；③出现第二个宿主的接入需求。
    Planning impact: 定位结论——本体系 = **Pact 式消费方驱动契约测试的单进程类型层
      变体**，成分皆借用，组合是 DSH 特殊条件倒逼的产物；这支持"按模式传播、
      不预抽包"的既有决策（versioning.md §6）。
