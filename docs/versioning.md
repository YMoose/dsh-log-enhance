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

## 4. CI 路线（S0–S3，逐阶段独立可用）

| 阶段 | 触发 | 内容 | 参考实现 |
|---|---|---|---|
| S0 本地基线 | — | lockfile、engines.dsh、版本单源、baseline 机制、修集成测试 | 本文 |
| S1 PR/push 门禁 | push/PR | `npm ci` → typecheck → 单测 → 集成 → build → 官方 `evaluatePluginCompatibility`（`@deepseek-ai/dsh-app-boot` 导出）自检 manifest → `npm pack` 产物安装冒烟 | dsh-plugin-checker（**SHA pin + 显式 `dshVersion`**，勿用其默认 latest） |
| S2 跟随迭代 canary | 周定时 + 信号源 | 脚本把全部 `@deepseek-ai/*` 解析到 npm 最新已发布版（取 `versions` 数组末位，绕开 dist-tag 滞后）→ 删 lockfile 重装 → 全量 check；PR 上 advisory、定时严格；失败上传 lockfile artifact；绿则自动开 PR 更新 baseline + 矩阵 | langfuse `bump-upstream.mjs`（upstream-canary workflow） |
| S3 多线兼容矩阵 | 新版本发布 / 手动 | 对每条已验证线：pack → 装入该版本真实 dsh CLI → `--dump-config` 断言挂载 → MCP 注册路径冒烟（覆盖 mountAnalysisServer）→ 卸载可逆 | dsh-context 基线 tag 矩阵（`DSH_REPO`）+ PerryLink compat 卸载检查 |

信号源优先级（S2/S3 触发用）：

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
  （安装冒烟 action，休眠中——必须 SHA pin）
- npm dist-tag 陷阱：`@deepseek-ai/dsh` latest=next=0.2.2-rc.1，但多数子包
  latest 卡死 0.0.1-rc.1
