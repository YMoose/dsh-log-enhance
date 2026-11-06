# dsh-log-enhance

**DSH 日志增强：为 DeepSeek Harness 原生日志补充结构化语义、事件关联与运行时观测信息。**

项目以 DSH 的事件日志为基础，捕获可验证的运行时事实，保存来源关系，供查询、回放、
协作分析和可观测平台使用。首个落地点是把一次 `send_message` 工具调用与接收方的具体消息关联起来。

当前状态：**0.1.0 首版实现**。支持 Native `send_message` 的来源证据、消息阶段与离线关联查询。
验证基线：Harness `fcc0ad4621`（源码包版本 `0.2.2-rc.1`），Node.js 26.4.0。更新日期：2026-11-06。

## 构建与使用

开发时可复用已安装依赖、已构建的 Harness checkout，不修改该 checkout：

```sh
npm run link:harness -- /path/to/deepseek-harness
npm run check
npm pack
```

将本地包加入需要启用的 DSH profile，bundle patch 会注册插件：

```sh
dsh plugin --profile headless add ./dsh-log-enhance-0.1.0.tgz
```

默认在宿主启动目录的 `.dsh-log-enhance/` 写入独立 JSONL 文件。建议在 profile patch 中将
`directory` 设置成明确的持久目录。查询不需要启动 DSH，也不调用模型：

```sh
node dist/cli.js query /path/to/.dsh-log-enhance
```

输出包含接收消息、来源调用、已观察阶段、证据 ID 和覆盖缺口。只有明确匹配才标记 `linked`；
回执缺失为 `unknown`，存在多个候选为 `ambiguous`。配置、协议与限制见 [使用说明](docs/runtime.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [使用说明与记录协议](docs/runtime.md) | 配置、JSONL 记录、查询、持久化边界及已执行验证 |
| [项目设计](docs/design.md) | 讨论结论、首版范围、关联记录示例、持久化方案与验收标准 |
| [当前上游契约](docs/upstream-audit.md) | 当前源码证据、工具回执与日志的区别、Team 任务与成员模型、插件接口限制 |
| [迁入的研究与经验](docs/research-handoff.md) | 旧项目中有用的社区资料、行为约束、失败场景和历史版本依据 |

## 核心原则

- 每条关联保留证据；没有来源时明确记录未知，不按时间、文本或当前活跃工具猜测。
- 区分运行时观察、日志提交、持久化确认，以及模型实际使用等不同阶段。
- 补充记录具有独立身份和版本，能够定位原始 Session 事件。
- 插件错误、慢存储与远端导出不得改变 Agent 的工具行为或模型输入。
- 首版保存独立补充日志；直接扩展 DSH 主日志需要受支持的写入与恢复契约。

项目覆盖操作、关联和生命周期语义。OTel GenAI、Span Links、关系图等可以成为下游适配，
不构成核心事件模型的前置依赖。

## 调研基线与来源

当前 Harness 基线为 [`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159)。
接口核查见上游契约；Native 消息链路已通过真实 Cordis Loader、AgentLoop、subagent service 和
`send_message` 的集成测试。测试使用确定性 adapter，不访问模型服务。

有用研究从原 `dsh-genai-obs` 文档筛选、更新后迁入；本文档集合不依赖旧目录。
旧版结论在研究交接中单独标明，不应当作当前缺陷。迁入资料保留原 [MIT 许可证](LICENSE)
与版权署名；第三方项目代码仍遵循其各自许可证。
