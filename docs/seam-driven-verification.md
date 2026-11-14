# 接触面驱动的插件兼容性验证机制

> **目标**：把"依赖盘点 + 上游核查 + 报错定位"收拢成一条单向流水线——所有验证用例都由《接触面清单》直接派生，哪条接触面坏了，对应的那条测试就红，测试名字直接报出"坏在哪、影响我们哪行代码、去查文档哪一节"。

---

## 背景与动机

### 问题
`dsh-log-enhance` 是一个寄生在 DeepSeek Harness（DSH）上的插件，面临以下挑战：
1. **上游 0.x RC 阶段，无 semver 承诺**：同版本号重发布、API 形态突变（如 `SubagentActivationSpec` 从嵌套 `request` 变扁平）已发生多次。
2. **依赖面分散且隐性**：既有显性的 `import`、`ctx.on`、字段读取，也有隐性的"赌上游 `exec` 对象引用不变"、"赌磁盘 JSON 格式不变"、"赌正则匹配的文案不变"。
3. **静默失败风险**：上游改了字段名/事件名/参数形态，我们的代码可能既不报错也不崩溃，只是默默漏数据或算错账。

### 现有机制的不足
- `coupling.json`（AST 自动提取）只覆盖了**显性接触面**（包、hook、字段路径），且存在盲区：
  - 不抓 `export const inject`
  - 不抓 `switch (event.type)` 的判别字面量
  - 不抓 `for...of` 循环里的字段
  - 不抓 `ctx.on` 回调参数没类型注解时的字段
- `docs/upstream-audit.md` 记录了**隐性契约**，但纯文档、不可执行，靠人脑记得去查。
- `link-harness.mjs` 的契约校验是"存在性检查"（字段在 `.d.ts` 里还在吗），不是"可用性检查"（字段类型变了、参数形态变了能查出来吗）。

### 业界与生态的启发
调研了业界方法论（API Extractor、cargo-semver-checks、Crater、Pact、golden master）和 DSH 生态先例（`dsh-context`、`dsh-observe`、`dsh-telemetry-redactor` 等），发现：
- **`dsh-context` 是唯一做到"建模 + 定位 + 验证"三层的项目**，但它的 `baselines.ts` 是**手写 316 行**，维护成本高。
- **我们的 AST 自动提取是独有优势**，但需要补齐盲区 + 把隐性契约也纳入可执行验证。

---

## 核心设计：两层接触面 + 三步流水线

### 第一层：机器自动扫（显性接触面）
**原则**：凡是能从我们自己代码里顺藤摸瓜抠出来的，一律不让人写。

用 TypeScript AST 扫描 `src/`、`tests/`、`scripts/`，自动提取：
1. **包引用**：`import ... from '@deepseek-ai/*'`（含 `import type {}` 的声明合并包）
2. **注入服务**：`export const inject = ['sessions', 'agents', 'tools']`
3. **上下文服务访问**：`ctx.logger`、`ctx.mcpManager` 等
4. **事件钩子**：`ctx.on('session/event', (session, event) => ...)`，含回调参数形状
5. **字段路径**：对受追踪的上游参数/变量的点路径读取（如 `event.data.callId`、`message.source.senderSessionId`），含：
   - `const` 别名追踪（`const value = result.value; value.messageId`）
   - `for...of` 数组展开（`for (const message of event.data.inserted) { message.source.kind }`）
   - `ctx.on` 回调参数没类型注解时的字段（靠事件名归属）
   - 每条字段的**根类型**（如 `SessionEvent`）和**代码行号**（`src/observer.ts:100`）
6. **判别字面量**：`switch (event.type)` 的 `case 'tool/call'`、`source.kind === 'agent-message'` 等字符串比较

**产出**：`coupling.json`（机器生成，CI 用 `--check` 做漂移门禁）

### 第二层：人工补充（隐性接触面）
**原则**：只写机器从我们代码里绝对看不出来的东西。

人工维护 `tests/contracts/implicit-seams.ts`，登记以下隐性契约：
1. **版本号三处对齐**：`engines.dsh` 下界 == devDependencies 列车 == `baseline.json` 列车。
   workflow 不携带版本号——版本状态只在 package.json 与 baseline.json，
   `bump-upstream.mjs` 写模式把 devDeps 与 `engines.dsh` 原子推进（上界随次 minor 重算）
2. **磁盘格式**：`SESSION_FORMAT_VERSION === 4`、`KNOWN_SESSION_EVENT_TYPES` 覆盖我们消费的事件
3. **对象引用恒等**：`tools/pre-execute` 与 `tools/result` 收到的 `exec` 满足 `===` 引用相等
4. **回执位置**：`send_message` 成功时 `result.value.messageId` 有值，且不进原生 `tool/result`
5. **事件生命周期**：`spliced` → `claimed` → `user/message(append)` 顺序与 `message.id` 一致
6. **文案协议**：子代理启动返回的文本匹配 `/^started subagent (\S+)$/`
7. **工具参数 schema**：`send_message` 工具参数名含 `agent_id` / `target` / `agent`
8. **MCP 读盘字段对齐**：`src/mcp/` 直读磁盘的头行与事件字段（`usage` 五字段、`subagent-settled`、`delegationDepth` 等）与 `dsh-session` 类型一致
9. **未注入服务读取抛错**：未声明 `inject: ['mcpManager']` 时读 `ctx.mcpManager` 会同步抛错（可 catch）

**产出**：`tests/contracts/implicit-seams.ts`（人工维护，每条含 `id`、`description`、`usedAt`、`auditSection`、`probe`、`acknowledged`）

### 嫌疑扫描与报备机制
**问题**：人工隐性层全靠人自己想起来去写，万一忘了呢？

**解法**：在 `analyze-dsh-coupling.mjs` 扫代码时，多加一个 **"疑似隐性契约雷达"**，自动识别以下代码形状并向人报备：

| 嫌疑犯类型 | 代码形状 | 报备示例 |
|---|---|---|
| **无类型字段读取** | `record['fieldName']` 或 `record.fieldName`（`record` 是 `JSON.parse` 结果或 `unknown`） | `[untyped-field] src/mcp/analysis.ts:199 — usage.cacheReadTokens` |
| **正则表达式** | `/^started subagent (\S+)$/` 等正则字面量 | `[regex-protocol] src/mcp/analysis.ts:413` |
| **WeakMap 引用假设** | `new WeakMap<object, ...>` 且 key 是上游参数 | `[weakmap-identity] src/observer.ts:53` |
| **try-cast-ctx** | `try { (ctx as ...).xxx } catch` | `[try-cast-ctx] src/index.ts:84-87` |

**报备逻辑**：
- 对比扫描到的嫌疑项与 `implicit-seams.ts` 里的 `acknowledged` + `ignored`
- 未盖章的嫌疑项打印报备单：
  ```
  ⚠️  发现 2 处未报备的疑似隐性契约：
    1. [regex-protocol] src/mcp/analysis.ts:413 — /^started subagent (\S+)$/
       👉 请在 tests/contracts/implicit-seams.ts 中绑定到一条隐性契约探针，或标记为 internal。
  ```
- 第一版先只打印报备单（不 exit 1），等阶段 B 完成后再改成硬门禁

---

## 三步流水线

### 第一步：攒齐《接触面总表》
- **自动显性层**：`analyze-dsh-coupling.mjs` 扫描 `src/` → `coupling.json`
- **人工隐性层**：`tests/contracts/implicit-seams.ts`
- **嫌疑扫描**：自动揪出未报备的疑似隐性契约，向人报备

### 第二步：验货 —— 看着《总表》生成探路小插件并跑一遍
新增 `tests/seam-verify.test.ts`：

1. **对自动显性层**：
   - 读取 `coupling.json` 的 `srcHooks`、`ctxAccesses`、`fieldPaths`、`discriminants`
   - 自动拼出一个迷你的 TypeScript 探路插件文件，里面按真实类型写好：
     ```ts
     ctx.on('session/event', (session, event) => {
       if (event.type === 'agent/inbox/spliced') {
         for (const message of event.data.inserted) {
           const _kind = message.source.kind
           if (message.source.kind === 'agent-message') {
             const _sender: string = message.source.senderSessionId
           }
         }
       }
     })
     ```
   - **第一关（编译验货）**：调 TypeScript 编译器对探路插件做真实类型检查——只要上游改了参数个数、删了联合类型分支、改了字段类型，立刻报错
   - **第二关（挂载验货）**：用真实的 `new Context()` 把探路插件挂上去跑一圈生命周期，验证钩子注册与服务读取不崩

2. **对人工隐性层**：
   - 每条隐性接触面配一个 5~15 行的真包探针（直接 import 已安装的 `@deepseek-ai/dsh-session`、`dsh-tool-subagent-control` 或最小 testkit 跑一下），验证那条潜规则在当前上游包里还成立

### 第三步：定位 —— 哪儿红就是哪儿
`tests/seam-verify.test.ts` 直接用接触面条目生成 `node:test` 的子测试名：

```text
✔ [auto/hook] session/event(session, event) (at src/index.ts:82) -> Audit §1
✔ [auto/discriminant] @deepseek-ai/dsh-session :: event.type === 'agent/inbox/spliced' (at src/observer.ts:110) -> Audit §2
✔ [auto/field] @deepseek-ai/dsh-tools :: result.value.messageId (at src/observer.ts:154) -> Audit §1/§2
✔ [implicit/send-message-receipt-local] tools/result carries value.messageId (at src/observer.ts:152) -> Audit §1/§2
✔ [implicit/subagent-spawn-text] spawn output matches /^started subagent (\S+)$/ (at src/mcp/analysis.ts:413) -> Audit §0-L2
```

哪条红了，看测试标题 3 秒钟就知道：**是显性还是隐性、上游改了啥、我们哪行代码受牵连、该翻 `upstream-audit.md` 第几节**。

---

## 引擎 / 标准规格库 / 本仓契约（2026-11-13 拆分）

`tests/seam-verify.test.ts` 原是 1100+ 行的单文件；现已拆成三层，开放扩展、关闭修改——另一个 dsh 插件仓库原样复制 `tests/seam/` 即可接入：

| 层 | 位置 | 职责 |
|---|---|---|
| 引擎（闭环） | `tests/seam/engine.ts` | 探路插件生成器、tsc 编译验货、真实 `Context` 挂载验货、清单完整性 / `[implicit/intro]` / `[abnormal]` 测试的发射器。只认 `SeamSuite` 数据，不含任何插件知识（不读本仓 `src/`、不写死仓库名） |
| 标准规格库 | `tests/seam/standard-specs.ts` | **推导不出来**的标准内容：不可证豁免（UNVERIFIABLE，写明"为什么类型上不可能"）、隐性类型片段（键是隐性契约 id）、异常自检场景。字段/判别探针规格已不再手写——见下方"守卫自动提取" |
| 本仓契约 | `tests/contracts/implicit-seams.ts`（隐性契约登记，路径被 `analyze-dsh-coupling.mjs` 依赖，不能挪）+ `tests/contracts/seam-runs.ts`（本仓探针 `IMPLICIT_RUNS` 与委派引用 `IMPLICIT_DELEGATIONS`） | 一切"读我们 `src/`、断言我们正则与记录 schema、引用我们测试标题"的插件知识 |

装配 API（`tests/seam-verify.test.ts` 薄入口，约 40 行）：

- `findRepositoryRoot(packageName?)` / `loadCoupling(root)`：定位仓库根、解析 coupling.json；
- `standardSpecs(coupling, implicitSeams)`：标准库 ∩ 本仓耦合面；
- `standardRuns`：引擎自带的与仓库无关的探针（目前仅 `version-lockstep` 版本三锁，只读 package.json / baseline.json / ci.yml），薄入口按本仓登记的契约 id 挑选合并；
- `runSeamSuite(suite)`：发射全部测试——auto field/discriminant/hook、`[auto/plugin]` 挂载、`[intro]` 完整性（下限可用 `suite.inventoryFloors` 覆盖）、implicit 循环（含委派文本断言）、`[implicit/intro]`、`[abnormal]`。

其他仓库接入三步：原样复制 `tests/seam/`（引擎 + 标准规格库）；自写 `tests/contracts/implicit-seams.ts`（自己的隐性契约登记，喂给 `analyze-dsh-coupling.mjs` 与引擎）与 `tests/contracts/seam-runs.ts`（自己的探针与委派）；写一个调用 `runSeamSuite` 的薄入口 `tests/<名>-verify.test.ts`。隐性类型片段按契约 id 复用：登记同名 id（如 `subagent-settled-surface`）即自动获得对应片段。挂载验货的 inject 清单从 coupling.json 的 `injectedServices` 推导，无需改引擎。

---

## 守卫自动提取（2026-11-13）

探针的收窄 prelude 曾经是 `standard-specs.ts` 里的手写字典，它漂移于插件的真实用法——三个已核实的漂移案例（对照 `src/observer.ts`）：

1. `sourceEventSeqs` 只在 `case 'tool/result'`（:105）里被读，字典却按 `user/message` 收窄探针——上游把字段从 tool/result 挪走，探针照绿，插件照坏；
2. `data.turn` 在 :100（tool/call）与 :107（step/start）被读，字典探的是插件根本不监听的 `turn/start`——完全探错对象；
3. `data.step` 漏掉 :100 的 tool/call 读取。

根因：本插件是 DeepSeek Harness 的**消费者**，接触面验货必须反映"插件实际怎么用上游"，而不是人对上游形状的转述。字典已死：扫描器（`analyze-dsh-coupling.mjs`）现在从插件自己的源码里提取**每次字段读取的守卫上下文**，记进 coupling.json 的 fieldPaths——`{ rootType, accesses: [{ site, guards, elementOf?, binding? }] }`，守卫是源码文本表达式 `{ expr, kind: eq|ne|defined|falsy, literal? }`。引擎的 `probeSpecsFromCoupling()` 把每条访问记录机械变成一个探针规格（每个访问点一个测试，数量随读取点增长），`standardSpecs()` 只保留推导不出的三块（豁免理由、隐性类型片段、异常自检）。

提取的语法形状（纯语法层，扫描器不加 Program/TypeChecker）：字面量比较（`===`/`!==`，含 switch case 标签——case 守卫止于下一 clause，落空继承守卫按保守处理）；`=== undefined` / `!== undefined`；对被追踪链的真值判断（`if (!exec.agent) return` ⇒ `defined`）；复合条件（`A && B` 守卫 then 块 ⇒ 两条守卫；`A || B` 出现在终止语句里 ⇒ 各取反守卫其后的代码；取反后不可表达的合取项被丢弃——**少记守卫只会让探针更宽**）。可选链（`exec.agent?.id`）自带其前缀的 defined 守卫；`for…of` 记录元素来源与绑定名。

语义校验留给流水线末端的 tsc 编译：漏提守卫 ⇒ 探针收窄不足 ⇒ 编译失败 ⇒ 响亮暴露（安全方向），绝不静默变绿。守卫里引用探针参数之外变量（跨根，如 `result` 探针里的 `exec.name`）或局部别名（如 `manager`）的，只进标题摘要、不回放进 prelude——回放需要第二参数的根类型，而清单只记路径级根类型。

逃生口：`SeamSuite.overrides`，键 `pkg::path@site`（只换该访问点的规格）或裸 `pkg::path`（整条路径只留一份），替换机械生成的规格——用于提取器暂不覆盖的形状（如嵌套循环元素链）。本仓今天为空；若哪天非空，那就是提取器的缺口信号。回归锚：`tests/guard-extraction.test.ts`（红→绿过程：字典时代三条断言全红，机械生成后全绿）。

---

## 契约工件与独立验货路径（2026-11-14）

守卫自动提取之后再往前一步：一个 **coupling.json 就是自包含的消费者契约**。三处仓库硬编码从引擎移除，契约层因此可以脱离本仓独立运行：

1. **探针 import 零硬编码**：生成的探路插件不再内置任何上游包名——具名 import 从 fieldPaths 的 rootType 机械推导（`baseTypeNames`：剥 `Readonly<…>`、按顶层 `|` 拆联合）；清单 `packages` 段里没有任何字段读取的包生成裸 `import type {}`（镜像插件自己的 import 环境，`@deepseek-ai/dsh-subagent` 的声明合并副作用由此生效）；suite 层 `typeImports` 补充清单看不见的名字（本仓只有 dsh-llm 的 `MessageSource`，隐性片段引用它）。
2. **契约层可独立调用**：`runContractSuite` 只发射编译可证的测试——字段/判别/钩子签名探针、隐性类型片段、unprobed/stale 完整性、记录下限；挂载验货、隐性真跑、委派核对、版本锁留在全套件 `runSeamSuite`（它先调契约层，测试标题逐字不变）。`scripts/verify-coupling.mjs` 是契约层的 CLI 形态：对任意 coupling.json 用 `probeSpecsFromCoupling` 生成探针、对着**当前 node_modules** 编译、按文件出裁决（任何探针失败即 exit 1）。注入服务读取（`ctx.*` 的 TS2339）与 JsonValue 不透明读取是编译证不了的运行时契约——报告为豁免而非失败，归接入仓的隐性层管辖；import 行报错（rootType 指向不存在的导出）映射回具体路径。
3. **版本锁有 range 模式**：`SeamSuite.versionLockstep: 'range'`（默认 `'single-line'` 断言不变）——列车只需落在 engines.dsh 区间内（下界 ≤ 列车 < 上界，含 `-0` 墙语义；引擎内置与 `bump-upstream.mjs` 同一套 semver 比较——引擎不能 import app-boot 去借官方 gate，那会把新包 import 记进 coupling.json 的 packages 清单），上界仍必须带 `-0` 墙；配套 `bump-upstream.mjs --keep-floor`：列车推进而 engines.dsh 不动，目标必须落在现有区间内（与 `check-compat.mjs` 官方 gate 相同的下界/`-0` 墙语义），越墙即**拒绝写入**（移动墙是有意识的决定）。

打开的三扇未来之门：**ESLint 式版本矩阵**——对每个宿主版本各跑一次契约编译（verify-coupling.mjs 换个 node_modules 即可）；**上游吸收**——DSH CI 可以用 verify-coupling.mjs 验社区插件提交的 coupling.json，不用装插件源码；**区间模式**——上游进入稳定期后 `--keep-floor` + `versionLockstep: 'range'` 是现成的逃生口。本仓策略不变：single-line（[versioning.md](versioning.md) §4）。回归锚：`tests/engine-contract.test.ts`（未见过的 rootType 自动获得正确 import、CLI 真清单 exit 0 / 坏清单 exit 1 点名探针、range 绿而 single-line 红同一夹具）。

---

## 能包住什么？包不住什么？

### ✅ 能被这套机制包住的部分（约 70%）
只要上游的暗改**体现在它发布的 npm 包代码里**（哪怕类型签名没变），我们的探针都能抓到：
1. **文案和固定常量的暗改**（如 `"started subagent abc"` 改成 `"spawned subagent: abc"`）
2. **事件先后顺序与回执位置的暗改**（如 `messageId` 从 `result.value.messageId` 挪到 `result.meta.messageId`）
3. **默认配置与门禁行为的暗改**（如 Cordis 对未 `inject` 的属性从"抛错"改成"返回空 Proxy"）

### ❌ 包不住的部分（剩下的 30%，以及为什么）
有 **3 类暗改**，哪怕我们写了探路插件和隐性测试，在 CI 里跑也是全绿的，但到真机上就会出事：

#### 1. 模型网关 / 服务端下发的字段含义变了（不在 npm 包代码里！）
- **例子**：`assistant/message` 里的 `usage: { inputTokens, cacheReadTokens, cacheWriteTokens }`。我们在 MCP 里假设"这三个桶是互斥的，加起来等于总输入 token"（`src/mcp/analysis.ts:193-206`）。
- **为什么包不住**：这三个数字到底互不互斥，很多时候是由 **DeepSeek API 服务端 / LLM Adapter 怎么填这个字段** 决定的。在单元测试或 testkit 里，LLM 返回的 token 数字是**我们自己造的假数据（mock）**！你喂假数据 `{ inputTokens: 100, cacheReadTokens: 50 }` 进去，算出来永远等于 150，测试永远绿；但如果真实网关把 `inputTokens` 改成了"已包含缓存的总数"，我们的测试根本不知道，账单就会算翻倍。
- **怎么补**：这种没法靠装包测试发现，只能靠**拿一份真实跑出来的 `~/.dsh/sessions` 样本做离线对账**，或者盯上游 `llm-deepseek` 解析网关响应的那几行源码。

#### 2. 只在"完整桌面端 / Web 端 Profile"或长链路异常下才触发的分支
- **例子**：上游在 `agent-loop` 里加了一个新特性："当上下文超过 10 万字自动触发 compaction（压缩）时，悄悄把消息的 `id` 重新生成了一遍"。
- **为什么包不住**：我们的探路小插件跑在轻量级的 `Context` 或 `agent-loop-testkit` 里，测试的是**正常 Happy Path**。如果上游在异常分支改了行为，我们的探路测试全绿，但用户跑长会话时消息溯源就断了。
- **怎么补**：这就得靠我们运行时自带的 **`coverage.gap`（缺口告警）** 在真实使用中兜底——当发现线上日志里的 `unknown` / `gap` 比例突然飙升，反过来把那个新分支补进我们的隐性测试里。

#### 3. 上游发到了我们没装进 `devDependencies` 的包里
- **例子**：`@deepseek-ai/dsh-mcp-manager`（见 `upstream-audit.md §8`：不是本包依赖，`node_modules` 中无其发布产物）。
- **为什么包不住**：既然 `node_modules` 里根本没装这个包，我们的探路小插件在本地/CI 里就拿不到它的真代码，只能用我们自己模拟的假 `mcpManager` 去测。要是上游真把 `dsh-mcp-manager` 的 `register()` 参数校验改了，我们本地是测不出来的。
- **怎么补**：原指望的 S1"装进真实 `dsh` CLI 跑 `--dump-config`"步骤已随
  dsh-plugin-checker 弃用一并移除（2026-11-13，ci.yml 不再做真机安装冒烟）；
  当前覆盖止于集成测试经真实 cordis-plugin-loader 的挂载路径（loader 面），
  `dsh-mcp-manager` 自身的 `register()` 语义仍是登记在案的缺口——只能等将来
  恢复真机 CLI 冒烟、或上游提供可测的挂载 API 时补上。

---

## 执行计划

### 阶段 A：升级扫描器 + 报备机制 + 隐性清单（Commit 1-2）
- **Commit 1**：升级自动层扫描器
  - 补抓 `inject`、`switch/case` 判别字面量、`for...of` 数组展开、字段代码行号与根类型
  - 更新 `coupling.json`
  - 修复 `link-harness.mjs` 对新格式的兼容性
- **Commit 2**：新增隐性嫌疑扫描与报备机制
  - 加正则/WeakMap/无类型字段读取的嫌疑扫描
  - 新建 `tests/contracts/implicit-seams.ts`（登记 9 条隐性契约）
  - 未报备项打印报备单（第一版不 exit 1）

### 阶段 B：探路插件验货器（Commit 3）
- 新建 `tests/seam-verify.test.ts`
- 读取 `coupling.json` + `implicit-seams.ts`，生成探路插件并跑 tsc + Context 挂载
- 每条测试以 `[层] 接触面 (at src/xxx:行号) -> Audit §章节` 命名

### 阶段 C：文档同步（Commit 4）
- 更新 `docs/upstream-audit.md` §0：说明两层接触面架构
- 更新 `docs/versioning.md`：补充"接触面驱动验货"流程
- 更新 `TODO.md`：标记已完成项

---

## 验证证据链（Evidence Path）

我们要证明 3 件事，每件事有明确的证伪方式：

| 主张 | 证据路径 | 证伪条件 |
|---|---|---|
| **A1. 自动层能抓全显性接触面** | 升级后的 `analyze-dsh-coupling.mjs` 扫描当前 `src/`，生成的 `coupling.json` 应包含：`inject` 服务、7 个 `switch/case` 事件名、`for...of` 里的 `message.source.senderSessionId`、`ctx.on` 回调里的 `message.source.kind` | 对比升级前后的 `coupling.json` diff，如果新字段缺失或误报，即失败 |
| **A2. 隐性嫌疑扫描能发现未报备项** | 构造一个 mock 场景：在 `src/mcp/` 里临时加一行 `const x = record['unknownField']`，运行 `--check` 应输出未报备告警；在 `src/` 里加 `const re = /^test/` 也应告警 | 如果新加的嫌疑项没被揪出来，即失败 |
| **B1. 探路插件能验出上游字段被删** | 用 `link-harness.mjs` 的 mock checkout 机制：构造一个缺了 `senderSessionId` 的 `dsh-session` 类型，运行探路插件生成器 + tsc，应编译报错 | 如果字段被删但探路插件编译通过，即失败 |

---

## 与现有机制的关系

| 现有机制 | 与本计划的关系 |
|---|---|
| `coupling.json` + 漂移门禁 | **被增强**：补抓 `inject`、判别字面量、`for...of`、字段行号与根类型 |
| `link-harness.mjs` 契约校验 | **被复用**：探路插件生成器与 `link-harness` 共用核心逻辑，避免重复维护 |
| `docs/upstream-audit.md` | **被结构化**：隐性契约从纯文档升级为可执行的 `implicit-seams.ts`，每条带 `auditSection` 指针 |
| `coverage.gap` 运行时告警 | **互补**：本计划覆盖"装包时能测到的契约"，`coverage.gap` 兜底"只有真实运行时才能发现的暗改" |
| canary workflow | **被增强**：canary 红 → 跑 `seam-verify.test.ts` → 直接报出是哪条接触面坏了，不用人工翻文档 |

---

## 通用化潜力

这套机制对**任何一个 DSH 插件**都是通用的：
1. **第一步（摸接触面）**：把 `analyze-dsh-coupling.mjs` 丢进任何插件仓库，自动扫出它的 `coupling.json`（显性层），那个仓库的作者只需要自己填一个小小的 `implicit-seams.ts`（隐性层）
2. **第二步（生成探路插件验货）**：通用执行器读这两份文件，自动捏出探路小插件，在宿主上编译 + 挂载验证
3. **第三步（直接报出坏在哪个接触面）**：天然自带

---

## 参考

- 业界方法论：API Extractor、cargo-semver-checks（witness）、Crater（outcome-diff）、Pact（consumer-driven contracts）、golden master
- DSH 生态先例：`dsh-context`（baselines.ts + lockstep spec）、`dsh-observe`（profile 冒烟）、`dsh-telemetry-redactor`（sha256 fixture）
- 本仓库现有机制：`coupling.json`、`baseline.json`、`engines.dsh`、`check-compat.mjs`、`link-harness.mjs`、`coverage.gap`
