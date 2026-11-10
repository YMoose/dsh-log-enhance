/**
 * Derived views over a parsed session: counts, token bills, collaboration
 * rows, and event previews. Everything here is a read-only projection of the
 * native event stream — unknown fields stay unknown, no attribution is
 * inferred beyond identity joins the log itself carries (callId pairing,
 * `senderSessionId`, the `started subagent <id>` acknowledgment text).
 *
 * @module dsh-log-enhance/mcp/analysis
 */

import type { ParsedSession, SessionEvent } from './session-store.js'

/** Billed input = uncached input + both cache legs (fields are disjoint). */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  readonly billedInputTokens: number
}

export interface SessionSummary {
  readonly session: {
    readonly id: string
    readonly cwd?: string
    readonly created_at: string
    readonly format_version: number
    readonly parent_session?: string
    readonly delegation_depth?: number
    readonly agent_preset?: string
  }
  readonly storage: {
    readonly path: string
    readonly file_bytes: number
    readonly last_modified: string
    readonly truncated_tail: boolean
    readonly events: number
  }
  readonly activity: {
    readonly turns: number
    readonly steps: number
    readonly assistant_messages: number
    readonly user_messages: number
    readonly tool_calls: number
    readonly tool_results: number
    readonly subagent_dispatches: number
    readonly subagent_settled_notices: number
    readonly send_message_calls: number
    readonly compaction_events: number
    readonly inbox_splices: number
  }
  readonly tokens: TokenUsage & {
    readonly cache_read_share: number
    /** Largest billed input on a single assistant message (per-message, not a per-step sum). */
    readonly peak_message_billed_input: number
  }
  readonly tools: ReadonlyArray<{
    readonly name: string
    readonly calls: number
    readonly errors: number
    readonly result_chars: number
  }>
  /** More distinct tools exist than the (at most ten) rows returned. */
  readonly tools_truncated: boolean
  readonly latency_ms: {
    readonly wall: number
    readonly step_p50: number
    readonly step_p95: number
  }
}

export interface TokenBillRow {
  readonly turn: number
  readonly step?: number
  readonly assistant_messages: number
  readonly usage: TokenUsage
}

export interface TokenBill {
  readonly group_by: 'turn' | 'step'
  readonly rows: readonly TokenBillRow[]
  readonly totals: TokenUsage
}

/** One cross-agent interaction row. Dispatch fields are null for notices without a local dispatch. */
export interface CollaborationRow {
  readonly kind: 'subagent' | 'subagent-settled' | 'send_message'
  readonly call_id?: string
  readonly seq?: number
  readonly turn?: number
  readonly step?: number
  readonly time?: number
  readonly duration_ms?: number | null
  // subagent
  readonly description?: string
  readonly prompt_chars?: number
  readonly child_session_id?: string | null
  readonly settled_seq?: number | null
  readonly stop_reason?: string | null
  readonly report_chars?: number | null
  // send_message
  readonly target?: string
  readonly message_chars?: number
  readonly is_error?: boolean
}

export interface EventRow {
  readonly seq: number | null
  readonly type: string
  readonly time: number | null
  readonly turn?: number
  readonly step?: number
  readonly preview: string
}

const PREVIEW_LIMIT = 160

/** Drop keys whose value is undefined, for clean optional-property output rows. */
function defined<T extends Record<string, unknown>>(row: T): T {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) result[key] = value
  }
  return result as T
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function textChars(blocks: unknown): number {
  if (!Array.isArray(blocks)) return 0
  let total = 0
  for (const block of blocks) {
    const record = asRecord(block)
    if (record === undefined) continue
    if (record['type'] === 'text' && typeof record['text'] === 'string') {
      total += (record['text'] as string).length
    } else if (record['type'] === 'tool-result') {
      total += textChars(record['content']) // v3 nests result content one level deeper
    }
  }
  return total
}

interface ToolCallInfo {
  readonly callId: string
  readonly name: string
  readonly turn: number | undefined
  readonly step: number | undefined
  readonly argsText: string
}

function toolCallInfo(event: SessionEvent): ToolCallInfo | undefined {
  const data = asRecord(event.data)
  if (data === undefined) return undefined
  const callId = data['callId']
  const name = data['name']
  if (typeof callId !== 'string' || typeof name !== 'string') return undefined
  return {
    callId,
    name,
    turn: typeof data['turn'] === 'number' ? data['turn'] : undefined,
    step: typeof data['step'] === 'number' ? data['step'] : undefined,
    argsText: typeof data['arguments'] === 'string' ? data['arguments'] : '',
  }
}

interface ToolResultInfo {
  readonly toolCallId: string
  readonly isError: boolean
  readonly chars: number
}

function toolResultInfo(event: SessionEvent): ToolResultInfo | undefined {
  const data = asRecord(event.data)
  if (data === undefined) return undefined
  const message = asRecord(data['message'])
  const toolCallId = message?.['toolCallId']
  if (message === undefined || typeof toolCallId !== 'string') return undefined
  return {
    toolCallId,
    isError: message['isError'] === true,
    chars: textChars(message['content']),
  }
}

function usageOf(event: SessionEvent): TokenUsage | undefined {
  const data = asRecord(event.data)
  const usage = asRecord(data?.['usage'])
  if (usage === undefined) return undefined
  const input = numberOr(usage['inputTokens'], 0)
  const cacheRead = numberOr(usage['cacheReadTokens'], 0)
  const cacheWrite = numberOr(usage['cacheWriteTokens'], 0)
  return {
    inputTokens: input,
    outputTokens: numberOr(usage['outputTokens'], 0),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: numberOr(usage['reasoningTokens'], 0),
    billedInputTokens: input + cacheRead + cacheWrite,
  }
}

function addUsage(into: { inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, reasoningTokens: number, billedInputTokens: number }, usage: TokenUsage): void {
  into.inputTokens += usage.inputTokens
  into.outputTokens += usage.outputTokens
  into.cacheReadTokens += usage.cacheReadTokens
  into.cacheWriteTokens += usage.cacheWriteTokens
  into.reasoningTokens += usage.reasoningTokens
  into.billedInputTokens += usage.billedInputTokens
}

const emptyUsage = (): { inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, reasoningTokens: number, billedInputTokens: number } =>
  ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, billedInputTokens: 0 })

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))
  return sorted[index] as number
}

function iso(ms: number | undefined): string {
  return ms === undefined ? 'unknown' : new Date(ms).toISOString()
}

/** Whole-session picture: counts, tokens, tool distribution, latencies. */
export function summarize(parsed: ParsedSession): SessionSummary {
  const { events, header, listing } = parsed
  const turns = new Set<number>()
  const steps = new Set<string>()
  const stepStarts = new Map<string, number>()
  const stepDurations: number[] = []
  const tools = new Map<string, { calls: number, errors: number, result_chars: number }>()
  const callsById = new Map<string, ToolCallInfo>()
  const totals = emptyUsage()
  let peakMessageBilled = 0
  let assistantMessages = 0
  let userMessages = 0
  let toolCalls = 0
  let toolResults = 0
  let subagentDispatches = 0
  let settledNotices = 0
  let sendMessageCalls = 0
  let compactionEvents = 0
  let inboxSplices = 0
  let firstTime: number | undefined
  let lastTime: number | undefined

  for (const event of events) {
    if (typeof event.time === 'number') {
      firstTime ??= event.time
      lastTime = event.time
    }
    const data = asRecord(event.data)
    switch (event.type) {
      case 'turn/start':
        if (typeof data?.['turn'] === 'number') turns.add(data['turn'])
        break
      case 'step/start':
        if (data !== undefined && typeof data['turn'] === 'number' && typeof data['step'] === 'number') {
          const key = `${String(data['turn'])}.${String(data['step'])}`
          steps.add(key)
          // A start without a timestamp cannot join time-based aggregation; skip it
          // there (the step still counts toward activity.steps).
          if (typeof event.time === 'number' && Number.isFinite(event.time)) stepStarts.set(key, event.time)
        }
        break
      case 'step/end':
        if (data !== undefined && typeof data['turn'] === 'number' && typeof data['step'] === 'number') {
          const start = stepStarts.get(`${String(data['turn'])}.${String(data['step'])}`)
          if (start !== undefined && typeof event.time === 'number') stepDurations.push(event.time - start)
        }
        break
      case 'assistant/message': {
        assistantMessages += 1
        const usage = usageOf(event)
        if (usage !== undefined) {
          addUsage(totals, usage)
          peakMessageBilled = Math.max(peakMessageBilled, usage.billedInputTokens)
        }
        break
      }
      case 'user/message':
        userMessages += 1
        if (asRecord(data?.['source'])?.['kind'] === 'subagent-settled') settledNotices += 1
        break
      case 'tool/call': {
        toolCalls += 1
        const call = toolCallInfo(event)
        if (call === undefined) break
        callsById.set(call.callId, call)
        const entry = tools.get(call.name) ?? { calls: 0, errors: 0, result_chars: 0 }
        entry.calls += 1
        tools.set(call.name, entry)
        if (call.name === 'subagent') subagentDispatches += 1
        if (call.name === 'send_message') sendMessageCalls += 1
        break
      }
      case 'tool/result': {
        toolResults += 1
        const result = toolResultInfo(event)
        if (result === undefined) break
        const call = callsById.get(result.toolCallId)
        if (call !== undefined) {
          const entry = tools.get(call.name)
          if (entry !== undefined) {
            entry.result_chars += result.chars
            if (result.isError) entry.errors += 1
            tools.set(call.name, entry)
          }
        }
        break
      }
      case 'agent/inbox/spliced':
        inboxSplices += 1
        break
      default:
        if (event.type.startsWith('compaction/')) compactionEvents += 1
        break
    }
  }

  const sortedDurations = [...stepDurations].sort((a, b) => a - b)
  const toolRows = [...tools.entries()]
    .map(([name, entry]) => ({ name, ...entry }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
    .slice(0, 10)
  const billedTotal = totals.billedInputTokens

  return {
    session: defined({
      id: header.id,
      cwd: header.cwd,
      created_at: iso(header.createdAt),
      format_version: listing.formatVersion,
      parent_session: header.parentSession,
      delegation_depth: header.delegationDepth,
      agent_preset: header.agentPreset,
    }) as SessionSummary['session'],
    storage: {
      path: listing.path,
      file_bytes: listing.fileBytes,
      last_modified: iso(listing.lastModifiedMs),
      truncated_tail: parsed.truncatedTail,
      events: events.length,
    },
    activity: {
      turns: turns.size,
      steps: steps.size,
      assistant_messages: assistantMessages,
      user_messages: userMessages,
      tool_calls: toolCalls,
      tool_results: toolResults,
      subagent_dispatches: subagentDispatches,
      subagent_settled_notices: settledNotices,
      send_message_calls: sendMessageCalls,
      compaction_events: compactionEvents,
      inbox_splices: inboxSplices,
    },
    tokens: {
      ...totals,
      cache_read_share: billedTotal === 0 ? 0 : Math.round((totals.cacheReadTokens / billedTotal) * 1000) / 1000,
      peak_message_billed_input: peakMessageBilled,
    },
    tools: toolRows,
    tools_truncated: toolRows.length < tools.size,
    latency_ms: {
      wall: firstTime !== undefined && lastTime !== undefined ? lastTime - firstTime : 0,
      step_p50: percentile(sortedDurations, 0.5),
      step_p95: percentile(sortedDurations, 0.95),
    },
  }
}

/** Token usage grouped by turn or by step. */
export function tokenBill(parsed: ParsedSession, groupBy: 'turn' | 'step'): TokenBill {
  interface Group { turn: number, step: number | undefined, messages: number, usage: ReturnType<typeof emptyUsage> }
  const groups = new Map<string, Group>()
  const totals = emptyUsage()
  for (const event of parsed.events) {
    if (event.type !== 'assistant/message') continue
    const usage = usageOf(event)
    const data = asRecord(event.data)
    const turn = data?.['turn']
    if (usage === undefined || typeof turn !== 'number') continue
    const step = data?.['step']
    const key = groupBy === 'turn' || typeof step !== 'number'
      ? `t${String(turn)}`
      : `t${String(turn)}.s${String(step)}`
    const group = groups.get(key) ?? {
      turn,
      step: typeof step === 'number' && groupBy === 'step' ? step : undefined,
      messages: 0,
      usage: emptyUsage(),
    }
    group.messages += 1
    addUsage(group.usage, usage)
    groups.set(key, group)
    addUsage(totals, usage)
  }
  const rows: TokenBillRow[] = [...groups.values()]
    .sort((a, b) => a.turn - b.turn || (a.step ?? 0) - (b.step ?? 0))
    .map(group => defined({ turn: group.turn, step: group.step, assistant_messages: group.messages, usage: group.usage }) as TokenBillRow)
  return { group_by: groupBy, rows, totals }
}

const STARTED_SUBAGENT = /^started subagent (\S+)$/

/** Mutable working row; frozen into {@link CollaborationRow} at the end. */
interface WorkingRow {
  kind: 'subagent' | 'subagent-settled' | 'send_message'
  call_id?: string | undefined
  seq?: number | undefined
  turn?: number | undefined
  step?: number | undefined
  time?: number | undefined
  duration_ms?: number | null | undefined
  description?: string | undefined
  prompt_chars?: number | undefined
  child_session_id?: string | null | undefined
  settled_seq?: number | null | undefined
  stop_reason?: string | null | undefined
  report_chars?: number | null | undefined
  target?: string | undefined
  message_chars?: number | undefined
  is_error?: boolean | undefined
}

/** Parse `tool/call` JSON arguments once, tolerating non-JSON raw text. */
function callArguments(argsText: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(argsText)
    return asRecord(parsed)
  } catch {
    return undefined
  }
}

/** Extract `started subagent <id>` acknowledgment text from a tool result event's data. */
function startedSubagentText(data: Record<string, unknown>): string | undefined {
  const message = asRecord(data['message'])
  const blocks = message?.['content']
  if (!Array.isArray(blocks)) return undefined
  for (const block of blocks) {
    const record = asRecord(block)
    const text = record?.['text']
    if (record?.['type'] === 'text' && typeof text === 'string') {
      const match = STARTED_SUBAGENT.exec(text.trim())
      if (match !== null) return match[1]
    }
  }
  return undefined
}

/** Cross-agent interactions: subagent dispatches with settlements, plus send_message calls. */
export function collaborations(parsed: ParsedSession): CollaborationRow[] {
  const rows: WorkingRow[] = []
  const dispatchByCallId = new Map<string, WorkingRow>() // subagent tool callId → row
  const dispatchByChild = new Map<string, WorkingRow>() // childSessionId → row
  const sendByCallId = new Map<string, WorkingRow>() // send_message tool callId → row
  const settledChildren = new Set<string>()

  for (const event of parsed.events) {
    const data = asRecord(event.data)
    if (event.type === 'tool/call') {
      const call = toolCallInfo(event)
      if (call === undefined) continue
      if (call.name === 'subagent') {
        const args = callArguments(call.argsText)
        const row: WorkingRow = {
          kind: 'subagent',
          call_id: call.callId,
          seq: event.seq,
          turn: call.turn,
          step: call.step,
          time: event.time,
          description: typeof args?.['description'] === 'string' ? args['description'] : undefined,
          prompt_chars: typeof args?.['prompt'] === 'string' ? (args['prompt'] as string).length : undefined,
          child_session_id: null,
          settled_seq: null,
          stop_reason: null,
          report_chars: null,
          duration_ms: null,
        }
        rows.push(row)
        dispatchByCallId.set(call.callId, row)
      } else if (call.name === 'send_message') {
        const args = callArguments(call.argsText)
        const row: WorkingRow = {
          kind: 'send_message',
          call_id: call.callId,
          seq: event.seq,
          turn: call.turn,
          step: call.step,
          time: event.time,
          target: typeof args?.['target'] === 'string' ? args['target'] : undefined,
          message_chars: typeof args?.['message'] === 'string' ? (args['message'] as string).length : undefined,
          is_error: false,
          duration_ms: null,
        }
        rows.push(row)
        sendByCallId.set(call.callId, row)
      }
    } else if (event.type === 'tool/result') {
      const result = toolResultInfo(event)
      if (result === undefined || data === undefined) continue
      const started = startedSubagentText(data)
      if (started !== undefined) {
        const row = dispatchByCallId.get(result.toolCallId)
        if (row !== undefined) {
          row.child_session_id = started
          dispatchByChild.set(started, row)
        }
        continue
      }
      const send = sendByCallId.get(result.toolCallId)
      if (send !== undefined) {
        send.is_error = result.isError
        if (send.time !== undefined && typeof event.time === 'number') send.duration_ms = event.time - send.time
      }
    } else if (event.type === 'user/message') {
      const source = asRecord(data?.['source'])
      if (source?.['kind'] !== 'subagent-settled') continue
      const sender = source['senderSessionId']
      if (typeof sender !== 'string') continue
      const stopReason = typeof source['stopReason'] === 'string' ? source['stopReason'] : null
      const reportChars = textChars(data?.['content'])
      // The first settlement notice per child wins — symmetrically for dispatched
      // children and orphans, so a replayed notice never duplicates a row.
      if (settledChildren.has(sender)) continue
      settledChildren.add(sender)
      const dispatch = dispatchByChild.get(sender)
      if (dispatch !== undefined) {
        dispatch.settled_seq = event.seq ?? null
        dispatch.stop_reason = stopReason
        dispatch.report_chars = reportChars
        if (dispatch.time !== undefined && typeof event.time === 'number') dispatch.duration_ms = event.time - dispatch.time
      } else {
        // A settled notice with no local dispatch (team-spawned or foreign child).
        rows.push({
          kind: 'subagent-settled',
          seq: event.seq,
          time: event.time,
          child_session_id: sender,
          stop_reason: stopReason,
          report_chars: reportChars,
        })
      }
    }
  }
  return rows.map(row => defined({ ...row }) as CollaborationRow)
}

/** Compact one-line preview of an event for listing rows. */
export function previewEvent(event: SessionEvent): string {
  const data = asRecord(event.data)
  const at = data !== undefined && typeof data['turn'] === 'number'
    ? `t${String(data['turn'])}` + (typeof data['step'] === 'number' ? `.s${String(data['step'])}` : '') + ' '
    : ''
  let detail = ''
  switch (event.type) {
    case 'assistant/message': {
      const usage = usageOf(event)
      const message = asRecord(data?.['message'])
      const blockTypes = message !== undefined && Array.isArray(message['content'])
        ? (message['content'] as unknown[]).map(block => String(asRecord(block)?.['type'] ?? '?')).join(',')
        : ''
      detail = `blocks=${blockTypes}`
      if (usage !== undefined) detail += ` billed_in=${String(usage.billedInputTokens)} out=${String(usage.outputTokens)}`
      if (message?.['interrupted'] === true) detail += ' interrupted'
      break
    }
    case 'user/message': {
      const source = asRecord(data?.['source'])
      const kind = typeof source?.['kind'] === 'string' ? source['kind'] : 'user'
      detail = `source=${kind} chars=${String(textChars(data?.['content']))}`
      break
    }
    case 'tool/call': {
      const call = toolCallInfo(event)
      detail = call === undefined ? 'unparsed' : `${call.name} args_chars=${String(call.argsText.length)}`
      break
    }
    case 'tool/result': {
      const result = toolResultInfo(event)
      detail = result === undefined ? 'unparsed' : `chars=${String(result.chars)}${result.isError ? ' isError' : ''}`
      break
    }
    default: {
      const json = JSON.stringify(event.data) ?? ''
      detail = json.length > PREVIEW_LIMIT ? `${json.slice(0, PREVIEW_LIMIT)}…` : json
      break
    }
  }
  const prefix = `${at}${detail}`
  return prefix.length > PREVIEW_LIMIT ? `${prefix.slice(0, PREVIEW_LIMIT)}…` : prefix
}

/** One listing row for an event. */
export function eventRow(event: SessionEvent): EventRow {
  const data = asRecord(event.data)
  const turn = data !== undefined && typeof data['turn'] === 'number' ? data['turn'] : undefined
  const step = data !== undefined && typeof data['step'] === 'number' ? data['step'] : undefined
  return defined({
    seq: typeof event.seq === 'number' ? event.seq : null,
    type: event.type,
    time: typeof event.time === 'number' ? event.time : null,
    turn,
    step,
    preview: previewEvent(event),
  }) as EventRow
}

/**
 * Exact-match filter over dotted paths into an event (`data.name`, `seq`, …).
 * Values compare by structural equality — object key order is irrelevant,
 * array order is significant; missing paths never match.
 */
export function matchesFilter(event: SessionEvent, filter: Record<string, unknown>): boolean {
  for (const [path, expected] of Object.entries(filter)) {
    const actual = resolvePath(event, path.split('.'))
    if (actual === undefined) return false
    if (!jsonEqual(actual, expected)) return false
  }
  return true
}

/** Structural equality over JSON-shaped values: object keys unordered, array order significant. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b)
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => jsonEqual(item, b[index]))
  }
  const left = asRecord(a)
  const right = asRecord(b)
  if (left === undefined || right === undefined) return false
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every(key => key in right && jsonEqual(left[key], right[key]))
}

function resolvePath(value: unknown, segments: readonly string[]): unknown {
  let current: unknown = value
  for (const segment of segments) {
    const record = asRecord(current)
    if (record === undefined || !(segment in record)) return undefined
    current = record[segment]
  }
  return current
}
