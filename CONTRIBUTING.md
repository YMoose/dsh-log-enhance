# Contributing

`dsh-log-enhance` enriches DeepSeek Harness logs with verifiable execution semantics,
event relationships, and runtime observations. Read README.md and docs/design.md first.
Contributions should preserve these observation and persistence contracts.

## Evidence and contracts

- Separate checked source facts, historical findings, proposals, and executed test results.
  Record the checked date and upstream revision. Revalidate before implementing against a new revision.
- Preserve unknown attribution. Never infer a source call from text similarity, timestamps,
  a current tool, task ownership, or Session ancestry alone.
- Prefer upstream identities and event references. Respect fork prefixes, restored history,
  message occurrences, and nested tool dispatches.
- Runtime `tools/result` and durable `tool/result` are different contracts. A successful
  runtime value is not automatically persisted, and inbox acceptance is not processing completion.
- Current external plugins must not use `appendPluginRecord`; do not bypass this restriction
  with casts or private APIs. The implementation uses independent supplementary storage.

## Implementation and documentation

- Keep observation failures isolated from tool execution and model requests. Bound queues,
  pending joins, and shutdown work; report coverage gaps and drops.
- Store the minimum evidence needed for correlation. Any future content capture or export
  needs explicit configuration and must apply its policy to every output path.
- Test concurrency, incomplete evidence, replay, fork/restore, and shutdown behavior when
  implementing those capabilities. Documentation edits need link and whitespace checks.
- OTel and visualization are optional consumers, not requirements of the core record model.
- Do not copy discontinued runtime code or assume historical community findings remain current.
- Keep documents self-contained after removal of the former research directory. Preserve
  attribution and licensing for migrated material; do not edit sibling projects incidentally.

## Development

Use Node.js 24.9 or later; the checked toolchain is Node.js 26.4.0 and TypeScript 6.0.3.
For the audited upstream revision, run `npm run link:harness -- /path/to/deepseek-harness`
against a prebuilt checkout. It creates links only under this project's ignored node_modules.
Run `npm run check` for type checks, component tests, real Loader/AgentLoop integration and build.
`npm pack` includes the built plugin, query CLI and bundle patch. A package release must build first.
