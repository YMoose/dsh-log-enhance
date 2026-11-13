# Commit 3 设计：探路插件验货器

## 目标
读取 `coupling.json`（显性层）+ `implicit-seams.ts`（隐性层），生成探路插件并跑 tsc + Context 挂载，每条测试以 `[层] 接触面 (at src/xxx:行号) -> Audit §章节` 命名。

## 核心组件

### 1. 探路插件生成器（`tests/seam-verify.test.ts`）

#### 输入
- `coupling.json`：`srcHooks`、`ctxAccesses`、`fieldPaths`、`discriminants`
- `implicit-seams.ts`：9 条隐性契约

#### 生成逻辑
对每个显性接触面，生成对应的探路代码片段：

**示例 1：hook**
```ts
// 输入：{ event: 'session/event', via: 'on', params: ['session', 'event'] }
ctx.on('session/event', (session, event) => {
  // 空实现，只验证签名
})
```

**示例 2：字段路径**
```ts
// 输入：{ path: 'data.callId', rootType: 'SessionEvent', sites: ['src/observer.ts:100'] }
function probe_session_event_data_callId(event: SessionEvent) {
  const _x: string = event.data.callId  // 类型检查
}
```

**示例 3：判别字面量**
```ts
// 输入：{ type: ['agent/inbox/spliced', 'tool/call'] }
function probe_discriminant_type(event: SessionEvent) {
  if (event.type === 'agent/inbox/spliced') { /* ... */ }
  if (event.type === 'tool/call') { /* ... */ }
}
```

**示例 4：for...of 数组展开**
```ts
// 输入：{ path: 'data.inserted[].source.senderSessionId', rootType: 'SessionEvent' }
function probe_for_of(event: SessionEvent) {
  if (event.type === 'agent/inbox/spliced') {
    for (const message of event.data.inserted) {
      const _sender: string = message.source.senderSessionId
    }
  }
}
```

#### 组装
把所有片段组装成一个完整的探路插件文件：
```ts
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'  // 声明合并

export const name = 'seam-probe'
export const inject = ['sessions', 'agents', 'tools']

export function apply(ctx: Context) {
  // ... 所有探路片段 ...
}
```

### 2. 编译验货（tsc）
- 用 TypeScript Compiler API 编译探路插件
- 如果编译失败，提取错误信息并映射回接触面条目

### 3. 挂载验货（Context）
- 用真实的 `new Context()` 挂载探路插件
- 验证钩子注册与服务读取不崩

### 4. 隐性契约探针
对每条隐性契约，运行对应的探针函数（在 `implicit-seams.ts` 里定义）

## 测试命名
```ts
test(`[auto/hook] session/event(session, event) (at src/index.ts:82) -> Audit §1`, async () => { ... })
test(`[auto/field] @deepseek-ai/dsh-session :: data.callId (at src/observer.ts:100) -> Audit §1`, async () => { ... })
test(`[implicit/subagent-spawn-text] spawn output matches /^started subagent (\S+)$/ (at src/mcp/analysis.ts:413) -> Audit §0-L2`, async () => { ... })
```

## 验证
1. **正常场景**：当前 `node_modules` 下的上游包，所有探路插件编译通过、挂载成功
2. **异常场景**：用 mock checkout 删掉一个字段（如 `senderSessionId`），探路插件编译报错

## 依赖
- Commit 1（`67e99d4`）：自动层扫描器升级
- Commit 2（进行中）：隐性嫌疑扫描与报备机制
- `link-harness.mjs` 的 mock checkout 机制（复用）

## 输出
- `tests/seam-verify.test.ts`（~300 行）
- 测试报告：每条接触面的验证结果
