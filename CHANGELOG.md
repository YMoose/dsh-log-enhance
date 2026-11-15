# Changelog

本文件记录面向用户的显著变更。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本语义见 [docs/versioning.md](docs/versioning.md)（0.x 阶段 minor=破坏性、patch=修复）。

## [0.2.1] - 2026-11-15

### Changed

- 包版本升级到 0.2.1（patch：无运行时行为变更）。此前 11-13 推进的
  `engines.dsh` 下界 `0.2.2-rc.3` 与重锚的 `baseline.json` 一直未随新版本发布，
  本次一并带上，供 DSH 插件页面的 registry 更新通道识别。
- 宿主列车推进到 `0.2.2-rc.3`：devDependencies 与 `engines.dsh` 同一次原子推进，
  `baseline.json` 于 2026-11-13 按真实安装内容重锚（单线跟随首收编：canary 连续报告
  rc.2、rc.3 拍平 `SubagentActivationSpec` 嵌套形状，集成测试随之适配）。
- 同步 dsh-seam 工具链受管载荷：多版本验货（`--types-root`/`--upstream`）、上游
  lockstep 回退与历史回放语料、manifest 规范化、TypeScript 7 native-build 守卫等。
  仅影响验证基建与测试，不改变采集、记录与查询协议。
- 文档版本事实对齐：README、`docs/runtime.md`、`docs/versioning.md` §2/§6 中残留的
  `0.2.2-rc.1` 与 `0.1.0` 产物名改为当前值；`docs/runtime.md` 现在显式区分
  "契约核对所用提交 `fcc0ad46`（包版本 rc.1）"与"依赖安装列车 rc.3"。
- 新增 `tests/version-facts.test.ts`：锁定文档中的包版本、安装产物名与
  `engines.dsh` 声明，使其必须等于 `package.json`；CHANGELOG 与验证矩阵属历史记录，
  不在此断言范围内。

### Added

- `publishConfig.access: public` 与发布说明：本包可通过 `npm publish` 发布到
  registry，`prepack` 会先构建 `dist/`。DSH 插件页面的"更新"只覆盖从 registry
  安装的组合包，本地 `file:` tarball 依赖不会出现"可更新"。

### Published

- 2026-11-15：`dsh-log-enhance@0.2.1` 发布到 npmjs，`dist-tag latest` 指向 0.2.1；
  tarball 41 个文件、98.0 kB，shasum `5c094a1013a665a8c0bfea6556ce27104724b346`
  与发布时的 `npm pack` 产物一致。首次发布时 registry 生成 `0.0.0-stage` 占位版本
  （`stub: true`，不在 `latest` 上），不参与 DSH 插件页的版本比较。
  registry 元数据含 `dsh.bundle` 与 `engines.dsh`，满足页面更新通道的识别条件。

## [0.2.0] - 2026-11-10

### Added

- 只读 MCP 分析服务：经 `mcp.enabled` 挂载进宿主，或以 `dsh-log-enhance-mcp` 独立运行。
  七个工具：`list-sessions`、`get-session-summary`、`list-events`、`get-event-detail`、
  `list-collaborations`、`get-token-bill`、`query-events`。事件过滤为结构相等比较
  （对象键序无关、数组顺序敏感）；`list-sessions` 以 `root_exists` 区分存储根缺失与空目录；
  工具榜超十行时以 `tools_truncated` 显式标记截断。
- 宿主兼容声明 `engines.dsh: >=0.2.2-rc.1 <0.3.0-0` 与依赖内容验证基线（`baseline.json`）：
  上游 rc 同版本重发布或无意重钉会被测试拦截并指路重验流程。
- CI 门禁：check 全链 + 官方兼容裁决（`evaluatePluginCompatibility`，含声明区间边界探针）
  + pack 产物安装冒烟。

### Changed

- peerDependencies 收窄为真实与宿主共享实例的 `@deepseek-ai/cordis` 与
  `@deepseek-ai/schemastery`；`@deepseek-ai/dsh-*` 均为 type-only 引用，移入 devDependencies。
- `PRODUCER` 与 MCP 服务版本号改为从 `package.json` 单源派生，仓库内无第二处版本号。

## [0.1.0] - 2026-11-06

- 首版：Native `send_message` 的来源证据采集、消息阶段记录与离线关联查询。
