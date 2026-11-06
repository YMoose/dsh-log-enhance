import { createHash, randomUUID } from 'node:crypto'

export const SCHEMA_VERSION = 1
export const PRODUCER = 'dsh-log-enhance/0.1.0'

export interface EventRef {
  sessionId: string
  formatVersion: number
  seq: number
}

export interface CallRef extends EventRef {
  turn: number
  step: number
  callId: string
}

export interface MessageRef extends EventRef {
  messageId: string
}

export type Fact =
  | { type: 'message.accepted'; target: MessageRef; senderSessionId: string }
  | { type: 'message.receipt'; source: CallRef; messageId: string }
  | { type: 'message.claimed'; target: MessageRef; turn: number }
  | { type: 'message.admitted'; target: MessageRef; event: EventRef; turn: number; step: number }
  | { type: 'message.canceled'; target: MessageRef }
  | { type: 'coverage.gap'; reason: GapReason; sessionId?: string }

export const GAP_REASONS = [
  'source-unavailable', 'ambiguous-call', 'nested-call-unsupported', 'receipt-unavailable',
  'receipt-invalid', 'inbox-occurrence-unavailable', 'index-capacity', 'index-expired',
  'observer-error',
] as const
export type GapReason = typeof GAP_REASONS[number]

export interface ObservationHeader {
  schemaVersion: 1
  producer: string
  id: string
  observedAt: number
}
export type Observation = Fact & ObservationHeader

export function eventKey(ref: EventRef): string {
  return JSON.stringify([ref.sessionId, ref.formatVersion, ref.seq])
}

export function messageKey(ref: MessageRef): string {
  return JSON.stringify([ref.sessionId, ref.formatVersion, ref.seq, ref.messageId])
}

function identity(fact: Fact): unknown {
  switch (fact.type) {
    case 'message.accepted': return [fact.type, messageKey(fact.target), fact.senderSessionId]
    case 'message.receipt': return [fact.type, eventKey(fact.source), fact.source.turn, fact.source.step, fact.source.callId, fact.messageId]
    case 'message.claimed': return [fact.type, messageKey(fact.target), fact.turn]
    case 'message.admitted': return [fact.type, messageKey(fact.target), eventKey(fact.event), fact.turn, fact.step]
    case 'message.canceled': return [fact.type, messageKey(fact.target)]
    case 'coverage.gap': return [fact.type, randomUUID()]
  }
}

export function observe<T extends Fact>(fact: T, now = Date.now()): T & ObservationHeader {
  const id = createHash('sha256').update(JSON.stringify(identity(fact))).digest('hex')
  return { schemaVersion: SCHEMA_VERSION, producer: PRODUCER, id, observedAt: now, ...fact }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}

export function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) throw new Error('Invalid identifier')
  return value
}

function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error('Invalid integer')
  return value
}

function eventRef(value: unknown): EventRef {
  const ref = object(value)
  return { sessionId: identifier(ref.sessionId), formatVersion: integer(ref.formatVersion, 1), seq: integer(ref.seq) }
}

function messageRef(value: unknown): MessageRef {
  return { ...eventRef(value), messageId: identifier(object(value).messageId) }
}

function callRef(value: unknown): CallRef {
  const ref = object(value)
  return { ...eventRef(value), turn: integer(ref.turn, 1), step: integer(ref.step, 1), callId: identifier(ref.callId) }
}

/** Validate stored evidence and discard unrecognized fields, including accidental content. */
export function parseObservation(value: unknown): Observation {
  const row = object(value)
  if (row.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported observation schema')
  const id = identifier(row.id)
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid observation identity')
  const header = { schemaVersion: SCHEMA_VERSION as 1, producer: identifier(row.producer), id, observedAt: integer(row.observedAt) }
  let fact: Fact
  switch (row.type) {
    case 'message.accepted': fact = { type: row.type, target: messageRef(row.target), senderSessionId: identifier(row.senderSessionId) }; break
    case 'message.receipt': fact = { type: row.type, source: callRef(row.source), messageId: identifier(row.messageId) }; break
    case 'message.claimed': fact = { type: row.type, target: messageRef(row.target), turn: integer(row.turn, 1) }; break
    case 'message.admitted': {
      const target = messageRef(row.target)
      const event = eventRef(row.event)
      if (event.sessionId !== target.sessionId || event.formatVersion !== target.formatVersion || event.seq <= target.seq) {
        throw new Error('Admission must follow acceptance in the same session')
      }
      fact = { type: row.type, target, event, turn: integer(row.turn, 1), step: integer(row.step, 1) }
      break
    }
    case 'message.canceled': fact = { type: row.type, target: messageRef(row.target) }; break
    case 'coverage.gap': {
      const reason = GAP_REASONS.find(reason => reason === row.reason)
      if (!reason) throw new Error('Unknown coverage reason')
      fact = { type: row.type, reason, ...row.sessionId === undefined ? {} : { sessionId: identifier(row.sessionId) } }
      break
    }
    default: throw new Error('Unknown observation type')
  }
  if (fact.type !== 'coverage.gap' && observe(fact, header.observedAt).id !== id) {
    throw new Error('Observation identity does not match its evidence')
  }
  return { ...header, ...fact }
}
