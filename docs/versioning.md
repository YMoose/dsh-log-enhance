# 版本与验证策略

整理日期：2026-11-10。本文定版本插件对宿主（DeepSeek Harness）的版本声明、
验证基线机制、跟随宿主迭代的 CI 路线与重验流程。上游接口契约见
[上游契约](upstream-audit.md)，运行配置见 [使用说明](runtime.md)。
决策依据的证据索引见文末；生态调研完成于 2026-11-10。

## 1. 四条版本轴，不混用

| 轴 | 承载物 | 规则 |
|---|---|---|
| 数据格式 | Journal `schemaVersion`、MCP 工具输出 | 只增不改；读者支持 N 与 N-1；迁移仅显式 CLI 命令，不在加载时隐式改写；与包版本解耦 |
| 插件自身 | `package.json` semver | 0.x 阶段 minor=破坏（配置或行为）、patch=修复；对外版本号单源派生（见 §2） |
| 宿主兼容 | `engines.dsh` | 宽**声明**：覆盖整条已验证列车（当前 0.2.x），上界必须带 `-0` 后缀 |
| 验证基线 | `baseline.json` | 窄**事实**：安装内容指纹 + 日期；任何变化必须走 §5 重验流程 |

核心区分：兼容声明回答"能在哪装"，验证基线回答"实际在哪验证过"。
声明可以宽（失效模式温和：gap 降级，不崩溃），事实必须窄（矩阵只记真实跑过的 run）。

> **Status（数据格式轴的 N-1 读者支持）**：未实现。当前 `src/records.ts:102`（`parseObservation`）
> 只接受 `SCHEMA_VERSION` 精确相等，遇到旧版本直接 `throw new Error('Unsupported observation schema')`。
> 因此上表"读者支持 N 与 N-1"是 **v2 schema 的目标状态**，不是现状；引入 N-1 兼容前不要据此推断
> 旧记录可读。已入库记录目前只有 N=1，未发生实际迁移，故该缺口尚未产生运行时影响。

## 2. 包声明（定案）

```jsonc
{
  "engines": {
    "node": ">=24.9.0",
    "dsh": ">=0.2.2-rc.1 <0.3.0-0"        // 宿主硬闸门（安装 + profile 启动双关卡）
  },
  "peerDependencies": {                     // 仅真实与宿主共享实例的运行时依赖
    "@deepseek-ai/cordis": "~4.1.0",
    "@deepseek-ai/schemastery": "^3.19.0"
  }
  // devDependencies: 全部 @deepseek-ai/* 精确版本，受 lockfile 管
}
```

依据与陷阱：

- `engines.dsh` 是官方闸门（`packages/boot/app-boot/src/plugin-compatibility.ts`）；
  **声明它会完全短路 peers 检查**，所以宿主版本覆盖责任全在 engines range 自己。
- 上界写 `<0.3.0-0` 而非裸 `<0.3.0`：闸门按 `includePrerelease` 语义裁决，
  裸上界会放行 `0.3.0-alpha.1`。
- 官方约定（docs/user/develop/publish.md）：与宿主共享实例的包同时进 peers + devDeps。
  本插件对 dsh-* 全部为 type-only import，不属共享实例，故只进 devDeps。
- cordis 家族必须与 dsh 列车同步升降（宿主单一版本列车；错位时 boot 报无关错误）。
- npm dist-tag 只认 `next`：多数 `@deepseek-ai/*` 子包的 `latest` 卡死在
  `0.0.1-rc.1`，内容以 `next` 为准。
- `SERVER_VERSION` 与 `PRODUCER` 运行时从 `package.json` 派生，仓库内不存在第二处版本号。
- lockfile（package-lock.json）必须入库；CI 一律 `npm ci`。

背景事故：2026-11-09，`@deepseek-ai/dsh-subagent@0.2.2-rc.1` 同版本重发布
（npm 内容变更，`startActivation` spec 形态改变），集成测试编译与运行双红。
上游 rc 无版本不可变保证，此类事件会重复发生。

## 3. 验证基线与验证矩阵

`baseline.json` 由 `scripts/write-baseline.mjs` 生成，记录验证时全部
`@deepseek-ai/*` 的 version + tarball integrity（内容寻址指纹）+ node 版本 + 日期。
`tests/baseline.test.ts` 断言当前 node_modules 指纹与基线一致。

三层防护的分工：

| 机制 | 拦截什么 |
|---|---|
| lockfile + `npm ci` | 同版本重发布后重装（EINTEGRITY 直接失败，天然告警） |
| baseline 测试 | 无意识重钉：lockfile 被更新但没人做过重验（"依赖变了"必须是有意识的决定） |
| 测试目录划分 | 红测试按所在文件路由：journal/query→采集侧，mcp-*→分析侧与存储布局，integration→宿主契约（对应 upstream-audit.md 各节） |

验证矩阵（维护于本文，每次重验追加一行；**只记真实跑过的 run，不记应有状态**——
CI 配置本身不是证据）：

| 插件版本 | 宿主 commit | 列车版本 | integrity 指纹 | check 结果（run 日期） |
|---|---|---|---|---|
| 0.1.0 | fcc0ad46 | 0.2.2-rc.1（首发内容） | 未留存（重发布后不可寻址） | ✅ 2026-11-06（node 26.4.0，当时口径） |
| 0.1.0 | 不可寻址（重发布未带 commit 标识） | 0.2.2-rc.1（重发布内容） | `baseline.json` | ✅ 2026-11-10（node 25.6.1，单元 39/39、集成 8/8） |
| 0.2.0 | 不可寻址（同上） | 0.2.2-rc.1（重发布内容） | `baseline.json` | ✅ 2026-11-10（node 25.6.1，单元 46/46、集成 12/12；CI 门禁首跑绿） |
| 0.2.0 | 不可寻址（同上） | 0.2.2-rc.3 | `baseline.json` | ✅ 2026-11-13（node 25.6.1，单元 164 pass/1 skip、集成 12/12；单线跟随首收编：canary 11-12/11-13 连报 rc.2、rc.3 破坏 `SubagentActivationSpec` 嵌套形状，测试已随拍平签名适配） |

## 4. CI 路线（S0–S3，逐阶段独立可用）

| 阶段 | 触发 | 内容 | 参考实现 |
|---|---|---|---|
| S0 本地基线 | — | lockfile、engines.dsh、版本单源、baseline 机制、修集成测试 | 本文 |
| S1 PR/push 门禁 | push/PR | `npm ci` → typecheck → 单测（含 seam-verify 探针）→ 集成 → build → 官方 `evaluatePluginCompatibility`（`@deepseek-ai/dsh-app-boot` 导出）自检 manifest → coupling 门禁 → `npm pack` 产物冒烟 | 本仓 `ci.yml`（2026-11-13 起不再用第三方 dsh-plugin-checker；workflow 不携带版本号。挂载覆盖以 **loader 路径**为准：seam-verify 探针 + 集成测试经真实 cordis-plugin-loader 挂载；`cordis.patch.yml` 经宿主 profile（`dsh plugin add`）的**应用路径** S1/S2 均无验证，pack 冒烟只断言文件在 tarball 内——登记在案的残余缺口） |
| S2 跟随迭代 canary | 日绊线 + 周兜底；**已落地**（`.github/workflows/canary.yml`） | 绊线（`scripts/bump-upstream.mjs --check`，**无状态**：以已提交的 baseline.json 与 devDeps 列车为锚）比对 dist-tag `next` 与 registry `time`——列车前移**或任一列车成员同版本重发布**（主包 + 全部 dsh-* 子包逐一比对，不只主包）都触发；全量 run：bump（dist-tag `next` 优先，`versions` 末位兜底，绝不碰 `latest`；devDeps 与 engines.dsh **同一次原子推进**，上界随次 minor 重算 `-0`）→ 删 lockfile 重装 → 仓内重生成 baseline（有意安装不算漂移）→ `npm run check` + `check:compat` + coupling 门禁 + pack 冒烟（**与 S1 完全同一覆盖面**，绿 canary = 绿 S1 在新列车上的等价物）→ 上传 artifact。**绿后不自动开 PR**：artifact（package.json + lockfile + baseline.json）即 §5 重验 commit 的**全部**材料（engines.dsh 已随 bump 推进，无需手改任何文件），跟进上游保持有意识的人工决定 | langfuse upstream-canary（模式参考）；本仓 `scripts/bump-upstream.mjs` |
| S3 多线兼容矩阵 | ✗ **已取消**（2026-11-13 定策：单线跟随，见下） | ~~对每条已验证线：pack → 装入该版本真实 dsh CLI → `--dump-config` 断言挂载 → MCP 注册路径冒烟（覆盖 mountAnalysisServer）→ 卸载可逆~~（原方案存档备查） | dsh-context 基线 tag 矩阵（`DSH_REPO`）+ PerryLink compat 卸载检查 |

> **维护策略（2026-11-13 定）——单线跟随**：只保证插件在 dist-tag `next` 的**最新发版**上可跑，能跑即可。不做多版本矩阵（S3 取消）；不跟上游 master（绊线只看 registry 元数据，本就与上游 git 仓库无关）。上游发新版 → 绊线触发 → Canary 全量验证 → 绿则产出 artifact，人工决定何时收编。
>
> **定策背景**：DSH 尚处 Demo 阶段——快速迭代、无稳定版线、对外不作兼容承诺（0.x rc 乱序、同版本重发均有先例）；本插件同处 Demo 阶段，选择随其共同演进，只对齐最新发版，不透支承诺。
> **复审触发**：上游宣布稳定版 / semver 承诺（如发 1.0）时，重估是否放宽 engines 声明、降低绊线频率乃至恢复多线验证。
>
> **逃生口（2026-11-14）**：`bump-upstream.mjs --keep-floor` 已备——列车推进而 engines.dsh 不动（写入前先经官方 gate 验证目标落在现有区间内，越墙即拒绝写入）；配套 seam 引擎的 `versionLockstep: 'range'` 模式。当前策略仍是单线跟随，二者只是为未来矩阵/区间化预留的门，见 [seam-driven-verification.md](seam-driven-verification.md)。

信号源优先级（S2 触发用）：

1. npm dist-tags 轮询（`registry.npmjs.org/-/package/@deepseek-ai/dsh/dist-tags`，
   认 `next`；同一响应的 `time` 字段顺带检测同版本重发布）；
2. `releases.atom`（增量、免 token）用于 release notes 中粗体破坏性条目的粗筛；
3. `docs/upgrade-guide/` 目录树 diff——官方 CI 强制格式的结构化迁移指南，
   是比 release notes 文本更可靠的破坏性变更信号；
4. 每周盲扫兜底。

上游 alpha 线也跑（advisory）：alpha→rc 仅隔数天且无弃用窗口，等 rc 再看已经晚了。
官方在讨论区不参与版本话题，release 页与 upgrade-guide 是唯一通知渠道，不能指望被动通知。

## 5. 重验流程

```
触发：baseline 测试红 / canary 红 / 手动升级依赖
  1. npm run check 全量跑一遍，收集红点
  2. 按红的测试所在文件/模块路由到 upstream-audit.md 对应节，重核上游契约
     （只重核涉及的节，不全文重验）
  3. 修代码或测试；类型错误通常是第一信号（type-only import 即哨兵）
  4. 绿后一次 commit 完成：代码修复 + baseline.json 重生成 + 矩阵加行
     + upstream-audit 若契约描述变了则同步更新
  5. 该 commit 即一次"重验"，矩阵记录 run 日期
```

**2026-11-13 新增**：接触面驱动的验货机制（详见 [seam-driven-verification.md](seam-driven-verification.md)）：
- `tests/seam-verify.test.ts` 读取 `coupling.json`（显性层）+ `implicit-seams.ts`（隐性层），生成探路插件并跑 tsc + Context 挂载
- 每条测试以 `[层] 接触面 (at src/xxx:行号) -> Audit §章节` 命名，哪条红了直接报出是哪条接触面坏了
- 隐性嫌疑扫描（`analyze-dsh-coupling.mjs --check`）自动识别未报备的疑似隐性契约：**未报备（或清单不可读）直接判红**，不再是只打印的报备单

禁止：直接重写 baseline.json 让测试变绿；跳过矩阵更新；
在未重核契约的情况下"按报错猜"修改插件行为。

测试的版本分类不引入额外机制：`npm test`（单元，宿主无关）与
`npm run test:integration`（集成，宿主契约耦合）两个脚本即分组边界；
上游契约改写时测试原地改写，旧形态由 git 历史与本矩阵留档，不设
deprecated 保留区。将来若出现同一分支需同时验证多条不兼容宿主线的
真实需求，再评估按线分支或能力探测，不预支机制。

## 6. 通用化路线（延迟承诺）

判断：生态存在真实需求（共享 CI 配置已有 33 仓库级先例；安装冒烟 action 烂尾仍有用户；
官方曾在 release notes 推荐第三方升级 skill），但当前不对外承诺任何接口。

- **现在只做结构准备**：canary / matrix / baseline 的通用逻辑写成带参数的独立脚本
  （`scripts/*.mjs`），workflow YAML 只做薄调用。成本≈0，抽取随时可做。
- **抽取时机**：S2 canary 经过 2–3 个宿主发版周期考验、接口被真实发版打过脸之后。
- **抽取形态**：小组件 + 最小约定（composite action / Renovate preset / 文档配方），
  不是重框架。最小约定 = `engines.dsh` + `baseline.json` + 可选契约 tag。
- **定位**：兼容性**证据生成器**（跑矩阵 → 更新声明与带日期的证据文档），
  不做门禁。官方插件市场若落地，过滤依赖兼容声明，证据生成器是其上游而非竞争者。

### 其他插件仓库如何接入这套机制

以受管同步传播（工具链的家：独立仓 dsh-seam，见第 4 步），接入成本压到
"clone + 一条 sync + 一次手动验证"。前三步是前提，没有它们，同步来的 CI
只会永远绿——绿灯变成空话：

1. **地基**：提交 lockfile，CI 用 `npm ci`；全部 `@deepseek-ai/*` devDeps 精确版本。
   （pnpm 仓库需把 baseline 读写适配到 pnpm 的 lockfile 结构，其余不变。）
2. **声明**：`engines.dsh` 覆盖已验证列车，上界必须带 `-0`（如 `>=0.2.2-rc.1 <0.3.0-0`）；
   peers 只留真实共享实例的运行时依赖（通常 cordis + schemastery）。
3. **传感器**：至少一条真的碰宿主 API 的集成测试（hook 或读盘格式）。这是唯一
   不能抄的部分——测试存在，门禁与 canary 才有意义。
4. **受管同步（dsh-seam）**：工具链的家是独立仓
   [YMoose/dsh-seam](https://github.com/YMoose/dsh-seam)（2026-11-14 定策：提前
   抽取——"外部使用者从别人的插件仓借文件"身份上不成立，原定"首个外部消费者
   再独立"的触发条件作废）。接入 = `git clone` + `node cli.mjs sync --into .`。
   受管面：五个脚本（`bump-upstream.mjs` 跟上游、`write-baseline.mjs` 钉安装内容
   防同版本重发布、`check-compat.mjs` 官方兼容门自检、`analyze-dsh-coupling.mjs`
   出耦合草表、`verify-coupling.mjs` 对任意 coupling.json 独立跑契约编译——
   上游 CI 也能拿它验接入仓的清单）+ `tests/seam/` 验货引擎与标准规格库（见
   [seam-driven-verification.md](seam-driven-verification.md)；探针收窄不靠手写
   字典——守卫从插件自己的源码提取，验货器对上游结构不可知）+ 三个机制测试。
   `node cli.mjs check` 按 `.dsh-seam.json`（源 commit + 逐文件 sha256）校验
   受管文件；本地改过的受管文件 sync 会拒绝覆盖——**引擎改动一律在 dsh-seam
   侧发起、sync 回消费仓**，消费仓不留分叉。
   各家自备（不在受管面）：`tests/contracts/{implicit-seams,seam-runs}.ts`、调
   `runSeamSuite` 的薄入口、现实版 `tests/baseline.test.ts`（机制半边随载荷走，
   现实半边各家自留）、`.github/workflows/{ci,canary}.yml`（S1 门禁与 S2 绊线
   手工对齐；第三方 action 一律 SHA pin——本仓不依赖任何第三方 action；workflow
   里不出现版本号——版本状态只在 package.json 与 baseline.json）。
   接入后手动 `workflow_dispatch` 跑一次 canary，链路通了才算闭环。

随配方一起迁移的两条纪律：**两处同步**（engines.dsh 下界 = baseline 指纹；
`bump-upstream.mjs` 写模式把 devDeps 与 engines.dsh 一起推进，收编时核对
baseline 重锚即可）；**重验流程**（baseline/coupling 红了走 §5 重核上游契约，
不是重写文件让它变绿）。耦合草表的层 2 部分（读盘格式与语义契约）各家不同，
照 [upstream-audit.md](upstream-audit.md) §0 的分层体例手写。

## 7. 证据索引（2026-11-10 调研）

- 官方插件发布规范（engines.dsh / peers 约定）：
  `deepseek-ai/deepseek-harness` `docs/user/develop/basic/publish.md`
- 兼容门实现：`packages/boot/app-boot/src/plugin-compatibility.ts`（engines.dsh 短路 peers）
- 官方升级指南目录（结构化破坏性变更信号）：`docs/upgrade-guide/`
- 上游 Atom 订阅：`https://github.com/deepseek-ai/deepseek-harness/releases.atom`
- 讨论 #12213（闸门只证明声明、engines.dsh 短路 cordis peers）、
  #12210（cordis 未随列车对齐致 boot 失败）、#11012（升级后 MCP 工具静默消失）、
  #6540（请求弃用窗口，无官方回应）
- 生态实践：PerryLink/dsh-observe（lockfile+overrides、周度 compat、Renovate preset
  共享仓 dsh-plugin-kit）、linyp/dsh-plugin-langfuse（upstream-canary +
  bump-upstream.mjs）、030611/dsh-telemetry-redactor（宿主包内容 sha256 fixture）、
  beibeihk/dsh-agent-observability（带日期证据文档）、bowenliang123/dsh-context
  （基线 tag 宿主源码矩阵、OIDC 发布、tag↔版本断言）、bowenliang123/dsh-plugin-checker
  （安装冒烟 action，休眠中——2026-11-13 起本仓弃用：seam-verify 探针 + 集成测试
  覆盖更深的挂载面——**loader 挂载路径**；`cordis.patch.yml` 的 profile 应用路径
  仍无覆盖——且 workflow 无需携带版本号）
- npm dist-tag 陷阱：`@deepseek-ai/dsh` latest=next=0.2.2-rc.1，但多数子包
  latest 卡死 0.0.1-rc.1
