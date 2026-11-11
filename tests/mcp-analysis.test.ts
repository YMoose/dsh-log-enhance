import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collaborations, eventRow, matchesFilter, summarize, tokenBill } from '../src/mcp/analysis.js'
import { SessionStore } from '../src/mcp/session-store.js'
import type { SessionEvent } from '../src/mcp/session-store.js'
import { legacySession, primarySession, withSessionRoot } from './mcp-fixtures.js'

async function loadPrimary(): Promise<Awaited<ReturnType<SessionStore['load']>>> {
  let result: Awaited<ReturnType<SessionStore['load']>> | undefined
  await withSessionRoot([primarySession()], async root => {
    result = await new SessionStore(root).load('session-aaaa-1111')
  })
  if (result === undefined) throw new Error('fixture did not run')
  return result
}

test('summary counts activity, tokens, tools, and latency from native facts', async () => {
  const summary = summarize(await loadPrimary())
  assert.equal(summary.session.id, 'session-aaaa-1111')
  assert.equal(summary.storage.events, 16)
  assert.equal(summary.activity.turns, 1)
  assert.equal(summary.activity.steps, 2)
  assert.equal(summary.activity.assistant_messages, 3)
  assert.equal(summary.activity.user_messages, 1)
  assert.equal(summary.activity.tool_calls, 2)
  assert.equal(summary.activity.tool_results, 2)
  assert.equal(summary.activity.subagent_dispatches, 1)
  assert.equal(summary.activity.subagent_settled_notices, 1)
  assert.equal(summary.activity.send_message_calls, 1)
  assert.equal(summary.activity.compaction_events, 1)
  // billed = (100+50+5) + (20+1000) + (30+1200) = 2405
  assert.equal(summary.tokens.billedInputTokens, 2405)
  assert.equal(summary.tokens.outputTokens, 23)
  assert.equal(summary.tokens.cacheReadTokens, 2250)
  assert.equal(summary.tokens.peak_message_billed_input, 1230)
  assert.ok(Math.abs(summary.tokens.cache_read_share - 2250 / 2405) < 0.0005)
  const subagent = summary.tools.find(tool => tool.name === 'subagent')
  assert.equal(subagent?.calls, 1)
  assert.equal(subagent?.result_chars, 'started subagent child-1'.length)
  assert.equal(summary.latency_ms.wall, 34_000)
  // step 1: t2→t6 = 4s; step 2: t20→t32 = 12s
  assert.equal(summary.latency_ms.step_p50, 4_000)
})

test('token bill groups usage by turn and by step with consistent totals', async () => {
  const parsed = await loadPrimary()
  const byTurn = tokenBill(parsed, 'turn')
  assert.equal(byTurn.rows.length, 1)
  assert.equal(byTurn.rows[0]?.turn, 1)
  assert.equal(byTurn.rows[0]?.assistant_messages, 3)
  assert.equal(byTurn.totals.billedInputTokens, 2405)
  const byStep = tokenBill(parsed, 'step')
  assert.deepEqual(byStep.rows.map(row => [row.turn, row.step]), [[1, 1], [1, 2]])
  assert.equal(byStep.rows[0]?.usage.billedInputTokens, 155)
  assert.equal(byStep.rows[1]?.usage.billedInputTokens, 2250)
  assert.equal(byStep.totals.billedInputTokens, byTurn.totals.billedInputTokens)
})

test('collaborations join dispatch, child session, and settlement by native identities', async () => {
  const rows = collaborations(await loadPrimary())
  assert.equal(rows.length, 2)
  const dispatch = rows.find(row => row.kind === 'subagent')
  assert.equal(dispatch?.call_id, 'call-1')
  assert.equal(dispatch?.prompt_chars, 3)
  assert.equal(dispatch?.description, 'd1')
  assert.equal(dispatch?.child_session_id, 'child-1')
  assert.equal(dispatch?.settled_seq, 11)
  assert.equal(dispatch?.stop_reason, null)
  assert.equal(dispatch?.report_chars, 80)
  assert.equal(dispatch?.duration_ms, 26_000) // t4 → t30
  const send = rows.find(row => row.kind === 'send_message')
  assert.equal(send?.target, 'lead')
  assert.equal(send?.message_chars, 5)
  assert.equal(send?.is_error, false)
  assert.equal(send?.duration_ms, 3_000) // t5 → t8
})

test('send_message targets are recognized across upstream schema variants', async () => {
  // The upstream tool schema changed across 0.2.2-rc.1 republishes: some builds
  // emit `target`, others `agent_id` (the current schema) or `agent`. All three
  // name the same thing — the recipient — so the analysis must read them all
  // rather than reporting an unknown target for 81% of real calls.
  const send = (seq: number, callId: string, args: Record<string, unknown>) => ({
    type: 'tool/call', seq, time: 1_000 + seq,
    data: { turn: 1, step: 1, callId, name: 'send_message', arguments: JSON.stringify(args) },
  })
  await withSessionRoot([
    {
      sessionId: 'session-target-variants',
      batches: [[
        send(0, 'c-target', { target: 'lead', message: 'a' }),
        send(1, 'c-agent-id', { agent_id: 'subagent-7', message: 'bb' }),
        send(2, 'c-agent', { agent: 'worker', message: 'ccc' }),
        // No recognizable recipient key: stays unknown rather than guessed.
        send(3, 'c-unknown', { message: 'dddd' }),
      ]],
    },
  ], async root => {
    const rows = collaborations(await new SessionStore(root).load('session-target-variants'))
    const targets = new Map(rows.map(row => [row.call_id, row.target]))
    assert.equal(targets.get('c-target'), 'lead')
    assert.equal(targets.get('c-agent-id'), 'subagent-7')
    assert.equal(targets.get('c-agent'), 'worker')
    assert.equal(targets.get('c-unknown'), undefined)
  })
})

test('a settled notice without a local dispatch stays unattributed', async () => {
  await withSessionRoot([
    {
      sessionId: 'session-orphan-0',
      batches: [[
        {
          type: 'user/message', seq: 0, time: 5,
          data: { content: [{ type: 'text', text: 'done' }], source: { kind: 'subagent-settled', senderSessionId: 'foreign-child' } },
        },
      ]],
    },
  ], async root => {
    const rows = collaborations(await new SessionStore(root).load('session-orphan-0'))
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.kind, 'subagent-settled')
    assert.equal(rows[0]?.child_session_id, 'foreign-child')
    assert.equal(rows[0]?.report_chars, 4)
  })
})

test('v3 nested tool-result content counts toward result chars', async () => {
  await withSessionRoot([legacySession()], async root => {
    const summary = summarize(await new SessionStore(root).load('session-bbbb-2222'))
    const read = summary.tools.find(tool => tool.name === 'read')
    assert.equal(read?.result_chars, 1375)
    assert.equal(summary.tokens.billedInputTokens, 0)
  })
})

test('event rows preview known types compactly and bound unknown ones', async () => {
  const parsed = await loadPrimary()
  const call = parsed.events.find(event => event.type === 'tool/call' && (event.data as { name?: string }).name === 'subagent')
  assert.ok(call !== undefined)
  const callRow = eventRow(call)
  assert.equal(callRow.seq, 4)
  assert.equal(callRow.turn, 1)
  assert.match(callRow.preview, /subagent args_chars=\d+/)
  const long = eventRow({ type: 'weird/event', seq: 99, time: 1, data: { blob: 'z'.repeat(500) } })
  assert.ok(long.preview.length <= 162)
  const settled = parsed.events.find(event => event.seq === 11)
  assert.ok(settled !== undefined)
  assert.match(eventRow(settled).preview, /source=subagent-settled chars=80/)
})

test('query filter matches dotted paths by deep equality and rejects missing paths', async () => {
  const parsed = await loadPrimary()
  const events = parsed.events
  assert.equal(events.filter(event => matchesFilter(event, { type: 'tool/call' })).length, 2)
  assert.equal(events.filter(event => matchesFilter(event, { 'data.name': 'send_message' })).length, 1)
  assert.equal(events.filter(event => matchesFilter(event, { 'data.turn': 1, 'data.step': 2 })).length, 4)
  assert.equal(events.filter(event => matchesFilter(event, { 'data.nope': 1 })).length, 0)
})

test('query filter equality is structural: object key order is irrelevant, array order is significant', async () => {
  const parsed = await loadPrimary()
  // The seq-10 usage object with its keys written in a different order still matches.
  const reorderedUsage = { cacheWriteTokens: 0, cacheReadTokens: 1000, outputTokens: 5, inputTokens: 20 }
  assert.equal(parsed.events.filter(event => matchesFilter(event, { 'data.usage': reorderedUsage })).length, 1)
  const event = { type: 'weird/event', seq: 90, time: 1, data: { list: [1, 2], nested: { x: 1, y: { b: 2, a: 3 } } } } as SessionEvent
  assert.equal(matchesFilter(event, { 'data.nested': { y: { a: 3, b: 2 }, x: 1 } }), true)
  assert.equal(matchesFilter(event, { 'data.list': [1, 2] }), true)
  assert.equal(matchesFilter(event, { 'data.list': [2, 1] }), false)
  assert.equal(matchesFilter(event, { 'data.nested': { x: 1, y: { a: 3 } } }), false)
})

test('a step whose start lacks a timestamp is skipped from latency aggregates, not zero-based', async () => {
  await withSessionRoot([
    {
      sessionId: 'session-notime-0',
      batches: [[
        { type: 'step/start', seq: 0, time: 1_000, data: { turn: 1, step: 1 } },
        { type: 'step/end', seq: 1, time: 6_000, data: { turn: 1, step: 1 } },
        { type: 'step/start', seq: 2, data: { turn: 1, step: 2 } }, // no time: must not fake a 0-based duration
        { type: 'step/end', seq: 3, time: 50_000, data: { turn: 1, step: 2 } },
      ]],
    },
  ], async root => {
    const summary = summarize(await new SessionStore(root).load('session-notime-0'))
    assert.equal(summary.activity.steps, 2)
    assert.equal(summary.latency_ms.step_p50, 5_000)
    assert.equal(summary.latency_ms.step_p95, 5_000)
  })
})

test('replayed settlement notices dedupe symmetrically for dispatched children and orphans', async () => {
  const settled = (seq: number, time: number, sender: string, text: string) => ({
    type: 'user/message', seq, time,
    data: { content: [{ type: 'text', text }], source: { kind: 'subagent-settled', senderSessionId: sender } },
  })
  await withSessionRoot([
    {
      sessionId: 'session-dedup-0',
      batches: [[
        { type: 'tool/call', seq: 1, time: 1_000, data: { turn: 1, step: 1, callId: 'c1', name: 'subagent', arguments: '{"prompt":"p"}' } },
        {
          type: 'tool/result', seq: 2, time: 2_000,
          data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'started subagent child-1' }] } },
        },
        settled(3, 10_000, 'child-1', 'first'),
        settled(4, 11_000, 'child-1', 'replay'),
        settled(5, 12_000, 'foreign-1', 'first'),
        settled(6, 13_000, 'foreign-1', 'replay'),
      ]],
    },
  ], async root => {
    const rows = collaborations(await new SessionStore(root).load('session-dedup-0'))
    assert.equal(rows.length, 2) // one dispatch row plus one orphan row; both replays dropped
    const dispatch = rows.find(row => row.kind === 'subagent')
    assert.equal(dispatch?.settled_seq, 3)
    assert.equal(dispatch?.report_chars, 5)
    assert.equal(dispatch?.duration_ms, 9_000)
    const orphan = rows.find(row => row.kind === 'subagent-settled')
    assert.equal(orphan?.seq, 5)
    assert.equal(orphan?.report_chars, 5)
  })
})

test('summary tool distribution is capped at ten rows and flags truncation', async () => {
  const manyTools = {
    sessionId: 'session-manytools-0',
    batches: [Array.from({ length: 11 }, (_, index) => ({
      type: 'tool/call', seq: index, time: 1_000,
      data: { turn: 1, step: 1, callId: `c${String(index)}`, name: `tool-${String(index)}`, arguments: '{}' },
    }))],
  }
  await withSessionRoot([primarySession(), manyTools], async root => {
    const store = new SessionStore(root)
    const primary = summarize(await store.load('session-aaaa-1111'))
    assert.ok(primary.tools.length <= 10)
    assert.equal(primary.tools_truncated, false)
    const capped = summarize(await store.load('session-manytools-0'))
    assert.equal(capped.tools.length, 10)
    assert.equal(capped.tools_truncated, true)
  })
})
