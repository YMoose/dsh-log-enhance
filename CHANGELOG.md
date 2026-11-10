# Changelog

本文件记录面向用户的显著变更。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本语义见 [docs/versioning.md](docs/versioning.md)（0.x 阶段 minor=破坏性、patch=修复）。

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
