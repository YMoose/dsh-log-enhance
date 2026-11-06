import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'
import { identifier, observe } from './records.js'
import type { CallRef, EventRef, Fact, GapReason, MessageRef, Observation } from './records.js'

class Index<T> {
  private entries = new Map<string, { value: T; time: number }>()
  constructor(private readonly capacity: number, private readonly ttl: number, private readonly gap: (reason: GapReason) => void) {}
  set(key: string, value: T): void {
    if (!this.entries.has(key) && this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
      this.gap('index-capacity')
    }
    this.entries.set(key, { value, time: Date.now() })
  }
  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (entry && Date.now() - entry.time >= this.ttl) {
      this.entries.delete(key)
      this.gap('index-expired')
      return undefined
    }
    return entry?.value
  }
  delete(key: string): void { this.entries.delete(key) }
  values(): Array<[string, T]> {
    this.sweep()
    return [...this.entries].map(([key, entry]) => [key, entry.value])
  }
  sweep(): void {
    const now = Date.now()
    for (const [key, entry] of this.entries) {
      if (now - entry.time < this.ttl) continue
      this.entries.delete(key)
      this.gap('index-expired')
    }
  }
  clear(): void { this.entries.clear() }
}

interface TrackedMessage { target: MessageRef; senderSessionId: string }
interface ActiveCall { ref: CallRef; scope: number; bound: boolean }
interface ClaimedMessage extends TrackedMessage { turn: number }

/** Capture only metadata. Exec object identity binds a callback to its original Native call. */
export class Observer {
  private active = true
  private serial = 0
  private scopes = new WeakMap<Session, number>()
  private executions = new WeakMap<object, CallRef>()
  private calls: Index<ActiveCall>
  private inserted: Index<TrackedMessage>
  private pending: Index<TrackedMessage>
  private claimed: Index<ClaimedMessage>
  private steps: Index<{ turn: number; step: number }>

  constructor(private readonly write: (record: Observation) => boolean, capacity = 4096, ttlMs = 3_600_000) {
    const gap = (reason: GapReason) => this.gap(reason)
    this.calls = new Index(capacity, ttlMs, gap)
    this.inserted = new Index(capacity, ttlMs, gap)
    this.pending = new Index(capacity, ttlMs, gap)
    this.claimed = new Index(capacity, ttlMs, gap)
    this.steps = new Index(capacity, ttlMs, gap)
  }

  private emit(fact: Fact): void { this.write(observe(fact)) }
  private gap(reason: GapReason, sessionId?: string): void {
    this.emit({ type: 'coverage.gap', reason, ...sessionId === undefined ? {} : { sessionId } })
  }
  private scope(session: Session): number {
    let id = this.scopes.get(session)
    if (id === undefined) { id = ++this.serial; this.scopes.set(session, id) }
    return id
  }
  private key(session: Session, messageId: string): string {
    return JSON.stringify([this.scope(session), identifier(messageId)])
  }
  private ref(session: Session, event: SessionEvent): EventRef {
    return { sessionId: identifier(session.id), formatVersion: session.header.version, seq: event.seq }
  }

  /** All listener bodies are contained, including a broken storage or diagnostic callback. */
  run(body: () => void): void {
    if (!this.active) return
    try { body() }
    catch { try { this.gap('observer-error') } catch { /* Never alter the agent operation. */ } }
  }

  sessionEvent(session: Session, event: SessionEvent): void {
    // No reads of seed/history and no reclassification of inherited events as live work.
    if (event.seq < session.firstLiveSeq || !session.isOwnSeq(event.seq)) return
    const ref = this.ref(session, event)
    const scope = this.scope(session)
    switch (event.type) {
      case 'tool/call':
        if (event.data.name === 'send_message') {
          const call = { ...ref, turn: event.data.turn, step: event.data.step, callId: identifier(event.data.callId) }
          this.calls.set(JSON.stringify([scope, ref.seq]), { ref: call, scope, bound: false })
        }
        break
      case 'tool/result':
        for (const seq of event.sourceEventSeqs ?? []) this.calls.delete(JSON.stringify([scope, seq]))
        break
      case 'step/start': this.steps.set(String(scope), { turn: event.data.turn, step: event.data.step }); break
      case 'step/end':
      case 'turn/end': this.steps.delete(String(scope)); break
      case 'agent/inbox/spliced':
        for (const message of event.data.inserted) {
          if (message.source.kind !== 'agent-message') continue
          const target = { ...ref, messageId: identifier(message.id) }
          const senderSessionId = identifier(message.source.senderSessionId)
          this.emit({ type: 'message.accepted', target, senderSessionId })
          // Wait for inserted: a replacement emits discarded before inserted after this commit.
          this.inserted.set(this.key(session, message.id), { target, senderSessionId })
        }
        break
      case 'user/message': {
        if (event.surfaceOp !== 'append' || event.data.source.kind !== 'agent-message') break
        const key = this.key(session, event.data.id)
        const claimed = this.claimed.get(key)
        const position = this.steps.get(String(scope))
        if (!claimed || !position || position.turn !== claimed.turn || claimed.senderSessionId !== event.data.source.senderSessionId) {
          this.gap('inbox-occurrence-unavailable', session.id)
          break
        }
        this.emit({ type: 'message.admitted', target: claimed.target, event: ref, ...position })
        this.claimed.delete(key)
        break
      }
    }
  }

  beforeTool(exec: ToolExecution): void {
    if (exec.name !== 'send_message' || exec.parent !== undefined || !exec.agent) return
    const scope = this.scope(exec.agent.session)
    const candidates = this.calls.values().filter(([, call]) =>
      call.scope === scope && call.ref.callId === exec.callId && !call.bound)
    if (candidates.length !== 1) {
      this.gap(candidates.length ? 'ambiguous-call' : 'source-unavailable', exec.agent.id)
      return
    }
    const [, candidate] = candidates[0]!
    candidate.bound = true
    this.executions.set(exec, candidate.ref)
  }

  toolResult(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    if (exec.name !== 'send_message') return
    if (exec.parent !== undefined) { this.gap('nested-call-unsupported', exec.agent?.id); return }
    const source = this.executions.get(exec)
    this.executions.delete(exec)
    if (!source) { this.gap('source-unavailable', exec.agent?.id); return }
    if (result.isError) { this.gap('receipt-unavailable', source.sessionId); return }
    const value = result.value
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        typeof value.messageId !== 'string' || value.messageId.length === 0 || value.messageId.length > 1024) {
      this.gap('receipt-invalid', source.sessionId)
      return
    }
    this.emit({ type: 'message.receipt', source, messageId: value.messageId })
  }

  inboxInserted(agent: Agent, messageId: string): void {
    const key = this.key(agent.session, messageId)
    const inserted = this.inserted.get(key)
    if (!inserted) return
    this.pending.set(key, inserted)
    this.inserted.delete(key)
  }

  inboxClaimed(agent: Agent, messageId: string, turn: number): void {
    const key = this.key(agent.session, messageId)
    const pending = this.pending.get(key)
    this.pending.delete(key)
    if (!pending || this.claimed.get(key)) {
      this.claimed.delete(key)
      this.gap('inbox-occurrence-unavailable', agent.id)
      return
    }
    this.claimed.set(key, { ...pending, turn })
    this.emit({ type: 'message.claimed', target: pending.target, turn })
  }

  inboxDiscarded(agent: Agent, messageId: string): void {
    const key = this.key(agent.session, messageId)
    const pending = this.pending.get(key)
    this.pending.delete(key)
    if (!pending) { this.gap('inbox-occurrence-unavailable', agent.id); return }
    this.emit({ type: 'message.canceled', target: pending.target })
  }

  sweep(): void {
    for (const index of [this.calls, this.inserted, this.pending, this.claimed, this.steps]) index.sweep()
  }

  stop(): void {
    this.active = false
    for (const index of [this.calls, this.inserted, this.pending, this.claimed, this.steps]) index.clear()
    this.executions = new WeakMap()
  }
}
