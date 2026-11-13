import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as Controls from '@deepseek-ai/dsh-tool-subagent-control'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import * as plugin from '../../src/index.js'
import { project, readJournal } from '../../src/query.js'

class Query extends SessionQuery {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Search outside fixture scope')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Search outside fixture scope')) }
}

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const isChild = options.messages.some(message => message.role === 'user' &&
      message.content.some(part => part.type === 'text' && part.text === 'CHILD_START'))
    if (isChild && !options.messages.some(message => message.role === 'tool')) {
      const args = JSON.stringify({ agent: 'B', message: 'PRIVATE_PAYLOAD' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('call-123'), name: 'send_message', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('call-123'), name: 'send_message', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'DONE' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'DONE' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function scenario(enabled: boolean, rejectReceiver = false, failAfterDelivery = false, senders = 1, restoreChecks = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-enhance-integration-'))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(Persistence, { root: join(directory, 'sessions') })
    await ctx.plugin(Query)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Subagents)
    await ctx.plugin(Spawn, { providerName: 'spawn' })
    await ctx.plugin(Fork, { providerName: 'fork' })
    await ctx.plugin(Controls)
    const output = join(directory, 'observations')
    await ctx.plugin(Loader, { baseUrl: import.meta.url })
    const entry = enabled ? await ctx.loader.create({
      name: process.env.DSH_LOG_ENHANCE_TEST_PLUGIN ?? 'dsh-log-enhance', config: { directory: output },
    }) : undefined
    await ctx.loader.await()
    if (failAfterDelivery) ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name === 'send_message') throw new Error('fixture finalization failure')
      return next()
    })
    if (rejectReceiver) ctx.on('agent/pre-step', (payload, next) => {
      if (payload.agent.id === 'B') return Promise.resolve({ kind: 'reject' as const })
      return next()
    })
    const native: Array<{ sessionId: string; event: SessionEvent }> = []
    ctx.on('session/event', (session, event) => native.push({ sessionId: session.id, event }))
    const adapter = new Adapter()
    ctx.llm.registerAdapter(['fixture'], adapter)
    const parent = await ctx.agentLoop.create(SessionId('B'), { provider: 'fixture', model: 'fixture' })
    const activations = await Promise.all(Array.from({ length: senders }, (_, index) => ctx.subagents.startActivation({
      delivery: 'caller', provider: 'spawn', label: `sender-${index}`, childId: SessionId(`sender-${index}`),
      prompt: [{ type: 'text', text: 'CHILD_START' }], parent,
      signal: new AbortController().signal,
    })))
    await Promise.all(activations.map(activation => activation.result))
    await parent.whenIdle()
    if (restoreChecks && entry !== undefined) {
      // A genuine loader restart attaches to sessions that already contain accepted messages.
      await ctx.loader.update(entry, { disabled: true })
      await ctx.loader.update(entry, { disabled: false })
      await ctx.loader.await()
      const forked = await ctx.subagents.startActivation({
        delivery: 'caller', provider: 'fork', label: 'forked', childId: SessionId('forked'),
        prompt: [{ type: 'text', text: 'FORK_START' }], parent,
        signal: new AbortController().signal,
      })
      await forked.result
      await parent.whenIdle()
    }
    if (entry !== undefined) await ctx.loader.remove(entry)
    const report = enabled ? await project(readJournal(output)) : undefined
    const raw = enabled ? (await Promise.all((await readdir(output)).map(file => readFile(join(output, file), 'utf8')))).join('') : ''
    return { report, raw, native, childId: activations[0]!.childId, childIds: activations.map(item => item.childId), requests: adapter.requests }
  } finally {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}

test('real AgentLoop and subagent send_message produce a verifiable sidecar relation', { timeout: 20_000 }, async () => {
  const result = await scenario(true)
  assert.equal(result.report?.messages.length, 1)
  const message = result.report!.messages[0]!
  assert.equal(message.attribution, 'linked')
  assert.equal(message.source?.callId, 'call-123')
  assert.equal(message.source?.sessionId, result.childId)
  assert.equal(message.target.sessionId, 'B')
  assert.deepEqual(message.stages, ['accepted', 'claimed', 'admitted'])
  assert.deepEqual(result.report?.gaps, {})
  const call = result.native.find(item => item.sessionId === result.childId && item.event.seq === message.source?.seq)
  assert.equal(call?.event.type, 'tool/call')
  const inbox = result.native.find(item => item.sessionId === 'B' && item.event.seq === message.target.seq)
  assert.equal(inbox?.event.type, 'agent/inbox/spliced')
  const toolResult = result.native.find(item => item.event.type === 'tool/result')?.event
  assert.ok(toolResult?.type === 'tool/result')
  assert.ok(!JSON.stringify(toolResult).includes(message.target.messageId))
  assert.ok(!result.raw.includes('PRIVATE_PAYLOAD'))
  assert.ok(!result.raw.includes('CHILD_START'))
})

test('receiver rejecting pre-step is claimed but never marked admitted', { timeout: 20_000 }, async () => {
  const result = await scenario(true, true)
  assert.deepEqual(result.report?.messages[0]?.stages, ['accepted', 'claimed'])
  assert.equal(result.report?.messages[0]?.attribution, 'linked')
})

test('concurrent real senders with identical call ids and payloads keep distinct provenance', { timeout: 20_000 }, async () => {
  const result = await scenario(true, false, false, 2)
  assert.equal(result.report?.messages.length, 2)
  assert.deepEqual(result.report!.messages.map(message => message.source?.sessionId).sort(), result.childIds.sort())
  assert.ok(result.report!.messages.every(message => message.attribution === 'linked' && message.source?.callId === 'call-123'))
  assert.equal(new Set(result.report!.messages.map(message => message.target.messageId)).size, 2)
})

test('delivery followed by tool failure preserves acceptance with unknown origin', { timeout: 20_000 }, async () => {
  const result = await scenario(true, false, true)
  assert.equal(result.report?.messages.length, 1)
  assert.equal(result.report?.messages[0]?.attribution, 'unknown')
  assert.deepEqual(result.report?.messages[0]?.stages, ['accepted', 'claimed', 'admitted'])
  assert.equal(result.report?.gaps['receipt-unavailable'], 1)
})

test('loader restart and a real fork do not reclassify inherited history as fresh delivery', { timeout: 20_000 }, async () => {
  const result = await scenario(true, false, false, 1, true)
  assert.equal(result.report?.messages.length, 1)
  assert.equal(result.report?.messages[0]?.target.sessionId, 'B')
  assert.equal(result.report?.messages[0]?.attribution, 'linked')
  assert.equal(result.report?.duplicates, 0)
})

test('enabling observation leaves model-visible results and request count unchanged', { timeout: 20_000 }, async () => {
  const without = await scenario(false)
  const withPlugin = await scenario(true)
  assert.equal(withPlugin.requests.length, without.requests.length)
  function results(events: typeof without.native) {
    return events.flatMap(item => item.event.type === 'tool/result' ? [item.event.data.message.content] : [])
  }
  assert.deepEqual(results(withPlugin.native), results(without.native))
  function requestContent(requests: GenerateOptions[]) {
    // Preserve each agent's request order; independent agents have no shared scheduling order.
    const groups: { sender: unknown[]; receiver: unknown[] } = { sender: [], receiver: [] }
    for (const request of requests) {
      const sender = request.messages.some(message => message.role === 'user' &&
        message.content.some(part => part.type === 'text' && part.text === 'CHILD_START'))
      groups[sender ? 'sender' : 'receiver'].push(request.messages.map(message => ({ role: message.role, content: message.content })))
    }
    return groups
  }
  const normalize = (value: unknown) => JSON.stringify(value).replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, '<id>')
  assert.equal(normalize(requestContent(withPlugin.requests)), normalize(requestContent(without.requests)))
})

test('replacing a pending message with the same id cancels only the old occurrence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-enhance-replace-'))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const fiber = await ctx.plugin(plugin, { directory })
    const agent = await ctx.agentLoop.create(SessionId('B'))
    const message = createUserMessage({
      content: [{ type: 'text', text: 'PRIVATE' }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('A') },
    })
    agent.send(message, 'next-turn', false)
    assert.equal(agent.inbox.replace(message.id, message), true)
    await fiber.dispose()
    const report = await project(readJournal(directory))
    const occurrences = report.messages.sort((a, b) => a.target.seq - b.target.seq)
    assert.equal(occurrences.length, 2)
    assert.deepEqual(occurrences.map(item => item.stages), [['accepted', 'canceled'], ['accepted']])
    assert.deepEqual(report.gaps, {})
  } finally {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('capacity eviction reports a gap without attributing a discard to a different message', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-enhance-capacity-'))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const fiber = await ctx.plugin(plugin, { directory, maxEntries: 1 })
    const agent = await ctx.agentLoop.create(SessionId('B'))
    const make = () => createUserMessage({
      content: [{ type: 'text', text: 'PRIVATE' }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('A') },
    })
    const first = make()
    const second = make()
    agent.send(first, 'next-turn', false)
    agent.send(second, 'next-turn', false)
    agent.inbox.remove(first.id)
    await fiber.dispose()
    const report = await project(readJournal(directory))
    assert.equal(report.gaps['index-capacity'], 1)
    assert.equal(report.gaps['inbox-occurrence-unavailable'], 1)
    assert.ok(report.messages.every(item => !item.stages.includes('canceled')))
  } finally {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
