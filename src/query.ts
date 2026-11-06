import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { eventKey, messageKey, parseObservation } from './records.js'
import type { Observation, CallRef, MessageRef } from './records.js'

export interface ReadDiagnostic { file: string; line: number; reason: 'invalid-record' | 'incomplete-tail' | 'oversized-record' }

/** Read bounded lines. A concurrent or interrupted final write remains uncommitted evidence. */
export async function* readJournal(directory: string, report: (diagnostic: ReadDiagnostic) => void = () => {}): AsyncGenerator<Observation> {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')).map(entry => entry.name).sort()
  for (const file of files) {
    let pending = Buffer.alloc(0)
    let line = 0
    let oversized = false
    for await (const raw of createReadStream(join(directory, file), { highWaterMark: 16 * 1024 })) {
      const chunk: Buffer = raw
      let from = 0
      while (from < chunk.length) {
        const newline = chunk.indexOf(10, from)
        const end = newline < 0 ? chunk.length : newline
        if (!oversized) {
          const part = chunk.subarray(from, end)
          if (pending.length + part.length > 64 * 1024) { oversized = true; pending = Buffer.alloc(0) }
          else pending = Buffer.concat([pending, part])
        }
        if (newline < 0) break
        line++
        if (oversized) report({ file, line, reason: 'oversized-record' })
        else {
          try { yield parseObservation(JSON.parse(pending.toString('utf8'))) }
          catch { report({ file, line, reason: 'invalid-record' }) }
        }
        pending = Buffer.alloc(0)
        oversized = false
        from = newline + 1
      }
    }
    if (pending.length || oversized) report({ file, line: line + 1, reason: 'incomplete-tail' })
  }
}

export interface MessageView {
  target: MessageRef
  senderSessionId: string
  attribution: 'linked' | 'unknown' | 'ambiguous'
  source?: CallRef
  stages: Array<'accepted' | 'claimed' | 'admitted' | 'canceled'>
  evidenceIds: string[]
}

export interface Report {
  schemaVersion: 1
  messages: MessageView[]
  gaps: Record<string, number>
  unmatchedReceipts: number
  unmatchedStages: number
  records: number
  duplicates: number
}

/** Exact identity joins only. Multiple possible calls or occurrences are deliberately ambiguous. */
export async function project(records: AsyncIterable<Observation> | Iterable<Observation>, maxRecords = 100_000): Promise<Report> {
  const seen = new Map<string, string>()
  const accepted = new Map<string, Extract<Observation, { type: 'message.accepted' }>>()
  const receipts = new Map<string, Extract<Observation, { type: 'message.receipt' }> []>()
  const calls = new Map<string, string>()
  const stages = new Map<string, Observation[]>()
  const gaps: Record<string, number> = {}
  let duplicates = 0
  const joinKey = (sender: string, message: string) => JSON.stringify([sender, message])
  for await (const row of records) {
    // Validate public API callers as well as disk readers.
    const record = parseObservation(row)
    const { observedAt: _time, producer: _producer, ...stable } = record
    const canonical = JSON.stringify(stable)
    const prior = seen.get(record.id)
    if (prior !== undefined) {
      if (prior !== canonical) throw new Error('Conflicting observation identity')
      duplicates++
      continue
    }
    if (seen.size >= maxRecords) throw new Error('Query record limit exceeded; select a smaller journal directory or raise --max-records')
    seen.set(record.id, canonical)
    if (record.type === 'coverage.gap') { gaps[record.reason] = (gaps[record.reason] ?? 0) + 1; continue }
    if (record.type === 'message.receipt') {
      const callKey = eventKey(record.source)
      const identity = JSON.stringify(record.source)
      const priorCall = calls.get(callKey)
      if (priorCall !== undefined && priorCall !== identity) throw new Error('Conflicting call coordinates')
      calls.set(callKey, identity)
      const key = joinKey(record.source.sessionId, record.messageId)
      const group = receipts.get(key) ?? []
      group.push(record)
      receipts.set(key, group)
    } else if (record.type === 'message.accepted') {
      const key = messageKey(record.target)
      const priorAcceptance = accepted.get(key)
      if (priorAcceptance && priorAcceptance.senderSessionId !== record.senderSessionId) throw new Error('Conflicting sender for inbox occurrence')
      accepted.set(key, record)
    } else {
      const key = messageKey(record.target)
      const group = stages.get(key) ?? []
      group.push(record)
      stages.set(key, group)
    }
  }
  const occurrences = new Map<string, number>()
  for (const record of accepted.values()) {
    const key = joinKey(record.senderSessionId, record.target.messageId)
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1)
  }
  const messages: MessageView[] = []
  for (const record of accepted.values()) {
    const key = joinKey(record.senderSessionId, record.target.messageId)
    const candidates = receipts.get(key) ?? []
    const sources = new Map(candidates.map(candidate => [eventKey(candidate.source), candidate.source]))
    const source = sources.size === 1 && occurrences.get(key) === 1 ? sources.values().next().value : undefined
    const progression = stages.get(messageKey(record.target)) ?? []
    const present = new Set(progression.map(item => item.type))
    const states: MessageView['stages'] = ['accepted']
    if (present.has('message.claimed')) states.push('claimed')
    if (present.has('message.admitted')) states.push('admitted')
    if (present.has('message.canceled')) states.push('canceled')
    messages.push({
      target: record.target, senderSessionId: record.senderSessionId,
      attribution: source ? 'linked' : candidates.length ? 'ambiguous' : 'unknown',
      ...source ? { source } : {}, stages: states,
      evidenceIds: [record.id, ...candidates.map(item => item.id), ...progression.map(item => item.id)].sort(),
    })
  }
  messages.sort((a, b) => messageKey(a.target).localeCompare(messageKey(b.target)))
  let unmatchedReceipts = 0
  for (const [key, group] of receipts) if (!occurrences.has(key)) unmatchedReceipts += group.length
  let unmatchedStages = 0
  for (const [key, group] of stages) if (!accepted.has(key)) unmatchedStages += group.length
  return { schemaVersion: 1, messages, gaps, unmatchedReceipts, unmatchedStages, records: seen.size, duplicates }
}
