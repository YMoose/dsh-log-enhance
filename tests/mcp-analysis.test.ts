import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collaborations, eventRow, matchesFilter, summarize, tokenBill } from '../src/mcp/analysis.js'
import { SessionStore } from '../src/mcp/session-store.js'
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
  assert.equal(summary.tokens.peak_step_billed_input, 1230)
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
