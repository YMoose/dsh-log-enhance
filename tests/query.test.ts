import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observe, parseObservation } from '../src/records.js'
import type { CallRef, MessageRef, Observation } from '../src/records.js'
import { project } from '../src/query.js'

const call = (seq: number, sessionId = 'A'): CallRef => ({ sessionId, formatVersion: 4, seq, turn: 1, step: 2, callId: `call-${seq}` })
const message = (seq: number, id: string, sessionId = 'B'): MessageRef => ({ sessionId, formatVersion: 4, seq, messageId: id })
const accepted = (target: MessageRef, senderSessionId = 'A') => observe({ type: 'message.accepted', target, senderSessionId })
const receipt = (source: CallRef, messageId: string) => observe({ type: 'message.receipt', source, messageId })

test('concurrent identical-content sends join by identity in either arrival order', async () => {
  const records = [receipt(call(1), 'm1'), accepted(message(7, 'm2')), accepted(message(5, 'm1')), receipt(call(2), 'm2')]
  const result = await project(records)
  assert.deepEqual(result.messages.map(item => [item.target.messageId, item.source?.callId]), [['m1', 'call-1'], ['m2', 'call-2']])
  assert.deepEqual(await project([...records].reverse()), result)
})

test('duplicate replay is idempotent and another sender cannot claim the same message id', async () => {
  const a = accepted(message(2, 'm1'))
  const r = receipt(call(1), 'm1')
  const result = await project([a, r, { ...a, observedAt: a.observedAt + 100 }, r, receipt(call(4, 'C'), 'm1')])
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0]?.source?.sessionId, 'A')
  assert.equal(result.duplicates, 2)
  assert.equal(result.unmatchedReceipts, 1)
})

test('acceptance without a successful callback remains unknown; it is not a failed delivery', async () => {
  const result = await project([
    accepted(message(2, 'm1')),
    observe({ type: 'coverage.gap', reason: 'receipt-unavailable', sessionId: 'A' }),
  ])
  assert.equal(result.messages[0]?.attribution, 'unknown')
  assert.deepEqual(result.messages[0]?.stages, ['accepted'])
  assert.equal(result.gaps['receipt-unavailable'], 1)
})

test('multiple calls or inbox occurrences never select a source by timestamp', async () => {
  const result = await project([accepted(message(2, 'm1')), receipt(call(1), 'm1'), receipt(call(5), 'm1')])
  assert.equal(result.messages[0]?.attribution, 'ambiguous')
  const repeat = await project([accepted(message(2, 'm1')), accepted(message(3, 'm1')), receipt(call(1), 'm1')])
  assert.ok(repeat.messages.every(item => item.attribution === 'ambiguous' && !item.source))
})

test('one call may produce multiple identified messages', async () => {
  const result = await project([accepted(message(2, 'm1')), accepted(message(3, 'm2')), receipt(call(1), 'm1'), receipt(call(1), 'm2')])
  assert.ok(result.messages.every(item => item.source?.seq === 1))
})

test('claimed, admitted and canceled are independent recorded facts', async () => {
  const target = message(3, 'm1')
  const result = await project([
    accepted(target), observe({ type: 'message.claimed', target, turn: 7 }),
    observe({ type: 'message.admitted', target, event: { sessionId: 'B', formatVersion: 4, seq: 20 }, turn: 7, step: 1 }),
  ])
  assert.deepEqual(result.messages[0]?.stages, ['accepted', 'claimed', 'admitted'])
  assert.ok(!JSON.stringify(result).includes('completed'))
  const canceled = await project([accepted(target), observe({ type: 'message.canceled', target })])
  assert.deepEqual(canceled.messages[0]?.stages, ['accepted', 'canceled'])
})

test('reader validates evidence identities, schema and references and strips extraneous content', () => {
  const record = accepted(message(1, 'm1'))
  assert.throws(() => parseObservation({ ...record, schemaVersion: 2 }))
  assert.throws(() => parseObservation({ ...record, target: { ...record.target, seq: -1 } }))
  assert.throws(() => parseObservation({ ...record, senderSessionId: 'another' }))
  assert.deepEqual(parseObservation({ ...record, body: 'SECRET', target: { ...record.target, text: 'SECRET' } }), record)
})

test('query has an explicit memory bound and does not silently return a partial graph', async () => {
  await assert.rejects(project([accepted(message(1, 'm1')), accepted(message(2, 'm2'))], 1), /limit exceeded/)
  const malformed = { ...accepted(message(1, 'm1')), type: 'wrong' } as unknown as Observation
  await assert.rejects(project([malformed]), /Unknown observation/)
})

test('stable identity ignores JSON key order but rejects conflicting coordinates for one call event', async () => {
  const original = call(7)
  const reordered: CallRef = { callId: original.callId, seq: original.seq, step: original.step, turn: original.turn, formatVersion: 4, sessionId: 'A' }
  assert.equal(receipt(original, 'm1').id, receipt(reordered, 'm1').id)
  assert.equal((await project([receipt(original, 'm1'), receipt(reordered, 'm1')])).duplicates, 1)
  await assert.rejects(project([receipt(original, 'm1'), receipt({ ...original, callId: 'different' }, 'm1')]), /Conflicting call/)
})

test('admission evidence cannot refer to an event in another session or before acceptance', () => {
  const target = message(5, 'm1')
  assert.throws(() => parseObservation(observe({
    type: 'message.admitted', target, event: { sessionId: 'C', formatVersion: 4, seq: 8 }, turn: 1, step: 1,
  })), /same session/)
  assert.throws(() => parseObservation(observe({
    type: 'message.admitted', target, event: { sessionId: 'B', formatVersion: 4, seq: 2 }, turn: 1, step: 1,
  })), /same session/)
})

test('lifecycle evidence whose acceptance was lost is counted rather than silently discarded', async () => {
  const result = await project([observe({ type: 'message.claimed', target: message(5, 'm1'), turn: 1 })])
  assert.equal(result.unmatchedStages, 1)
  assert.deepEqual(result.messages, [])
})
