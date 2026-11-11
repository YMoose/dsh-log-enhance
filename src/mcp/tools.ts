/**
 * The seven analysis tools exposed over MCP. Tool handlers are pure with
 * respect to transport: they take parsed arguments and a {@link SessionStore},
 * and return JSON-serializable results. Failures raise {@link ToolError},
 * which the protocol layer renders as an `isError` tool result instead of a
 * transport error, so a bad query never kills the server.
 *
 * @module dsh-log-enhance/mcp/tools
 */

import { collaborations, eventRow, matchesFilter, summarize, tokenBill } from './analysis.js'
import { SessionStore } from './session-store.js'
import type { ParsedSession, SessionEvent, SessionListing } from './session-store.js'

/** A tool execution failure that is the caller's query problem, not a server fault. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

/** JSON Schema (draft 2020-12 subset accepted by MCP clients). */
export type JsonSchema = Record<string, unknown>

export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema
  run(args: Record<string, unknown>, store: SessionStore): Promise<Record<string, unknown>>
}

const ref = { type: 'string', description: 'Session id, or a unique id suffix' }

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') throw new ToolError(`"${key}" must be a nonempty string`)
  return value
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ToolError(`"${key}" must be a number`)
  return value
}

function clampMax(args: Record<string, unknown>, key: string, fallback: number, cap: number): number {
  const value = optionalNumber(args, key) ?? fallback
  return Math.max(1, Math.min(cap, Math.floor(value)))
}

function listingRow(listing: SessionListing): Record<string, unknown> {
  const header = listing.header
  return {
    session_id: listing.sessionId,
    cwd: header.cwd,
    created_at: new Date(header.createdAt).toISOString(),
    format_version: listing.formatVersion,
    compressed: listing.compressed,
    parent_session: header.parentSession,
    delegation_depth: header.delegationDepth,
    agent_preset: header.agentPreset,
    file_bytes: listing.fileBytes,
    last_modified: new Date(listing.lastModifiedMs).toISOString(),
  }
}

/** Load a session or fail with the lookup candidates for the model to retry. */
async function loadSession(store: SessionStore, sessionRef: string): Promise<ParsedSession> {
  try {
    return await store.load(sessionRef)
  } catch (error) {
    if (error instanceof Error && (error.name === 'SessionLookupError' || error.name === 'SessionReadError')) {
      const candidates = (error as { candidates?: readonly string[] }).candidates ?? []
      const suffix = candidates.length > 0 ? ` Candidates: ${candidates.slice(0, 10).join(', ')}` : ''
      throw new ToolError(`${error.message}${suffix}`)
    }
    throw error
  }
}

function eventsResult(events: readonly SessionEvent[], matched: number, maxResults: number): Record<string, unknown> {
  const slice = events.slice(0, maxResults)
  const last = slice.at(-1)
  // Resume strictly after the last returned match. Filtering before pagination
  // is essential: restarting from a seq range and filtering afterwards would
  // spend the page budget on non-matches and can starve later matches.
  const nextAfterSeq = slice.length < matched && last?.seq !== undefined ? last.seq : undefined
  return {
    matched,
    returned: slice.length,
    ...(nextAfterSeq === undefined ? {} : { next_after_seq: nextAfterSeq }),
    rows: slice.map(eventRow),
  }
}

function eventMatches(event: SessionEvent, filters: {
  type: string | undefined
  turn: number | undefined
  step: number | undefined
  fromSeq: number | undefined
  toSeq: number | undefined
  afterSeq: number | undefined
}): boolean {
  if (filters.type !== undefined && event.type !== filters.type) return false
  if (filters.turn !== undefined || filters.step !== undefined) {
    const data = typeof event.data === 'object' && event.data !== null ? event.data as Record<string, unknown> : undefined
    if (filters.turn !== undefined && data?.['turn'] !== filters.turn) return false
    if (filters.step !== undefined && data?.['step'] !== filters.step) return false
  }
  if (event.seq === undefined) {
    if (filters.fromSeq !== undefined || filters.toSeq !== undefined || filters.afterSeq !== undefined) return false
  } else {
    if (filters.fromSeq !== undefined && event.seq < filters.fromSeq) return false
    if (filters.toSeq !== undefined && event.seq > filters.toSeq) return false
    if (filters.afterSeq !== undefined && event.seq <= filters.afterSeq) return false
  }
  return true
}

/** The seven first-version analysis tools. */
export function analysisTools(): ToolSpec[] {
  return [
    {
      name: 'list-sessions',
      description: 'List sessions in the DSH session storage. Returns light header metadata per session '
        + '(id, cwd, creation time, format version, file size, last modified). Order: newest first. '
        + 'Filters: cwd substring, after/before (ISO 8601 or epoch ms) on creation time, min_events '
        + '(forces a full parse of each candidate). Default max_results 50, cap 200. The response '
        + 'carries root_exists: false when the configured storage root is missing, so it is '
        + 'distinguishable from a genuinely empty root.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Substring match on the session working directory' },
          after: { description: 'Creation-time lower bound: ISO 8601 string or epoch ms number' },
          before: { description: 'Creation-time upper bound: ISO 8601 string or epoch ms number' },
          min_events: { type: 'number', description: 'Minimum persisted event count (requires full parse)' },
          max_results: { type: 'number', description: `Maximum rows, default 50, cap 200` },
        },
      },
      async run(args, store) {
        const maxResults = clampMax(args, 'max_results', 50, 200)
        const cwdFilter = typeof args['cwd'] === 'string' && args['cwd'] !== '' ? args['cwd'] : undefined
        const timeBound = (key: string): number | undefined => {
          const value = args[key]
          if (value === undefined) return undefined
          if (typeof value === 'number' && Number.isFinite(value)) return value
          if (typeof value === 'string') {
            const parsed = Date.parse(value)
            if (!Number.isNaN(parsed)) return parsed
          }
          throw new ToolError(`"${key}" must be an ISO 8601 string or epoch milliseconds`)
        }
        const after = timeBound('after')
        const before = timeBound('before')
        const minEvents = optionalNumber(args, 'min_events')
        let listings = await store.list()
        listings = listings.filter(listing => {
          if (cwdFilter !== undefined && !(listing.header.cwd ?? '').includes(cwdFilter)) return false
          if (after !== undefined && listing.header.createdAt < after) return false
          if (before !== undefined && listing.header.createdAt > before) return false
          return true
        })
        if (minEvents !== undefined) {
          const kept: SessionListing[] = []
          for (const listing of listings) {
            const loaded = await loadSession(store, listing.sessionId)
            if (loaded.events.length >= minEvents) kept.push(listing)
          }
          listings = kept
        }
        listings = [...listings].sort((a, b) => b.header.createdAt - a.header.createdAt)
        return {
          total: listings.length,
          returned: Math.min(maxResults, listings.length),
          root_exists: await store.rootExists(),
          sessions: listings.slice(0, maxResults).map(listingRow),
        }
      },
    },
    {
      name: 'get-session-summary',
      description: 'Full picture of one session: activity counts (turns, steps, messages, tool calls), '
        + 'token totals (billed input = input + cacheRead + cacheWrite), tool distribution (top 10 '
        + 'by calls; tools_truncated flags when more exist), and latency statistics. '
        + 'Use list-sessions first to find the id.',
      inputSchema: {
        type: 'object',
        properties: { session_id: ref },
        required: ['session_id'],
      },
      async run(args, store) {
        const parsed = await loadSession(store, requireString(args, 'session_id'))
        return summarize(parsed) as unknown as Record<string, unknown>
      },
    },
    {
      name: 'list-events',
      description: 'List event rows of one session with one-line previews. Filters: event type, turn, '
        + 'step, seq range (from_seq/to_seq inclusive), or after_seq (exclusive). Rows carry raw '
        + 'epoch-ms times. Continue filtered pages with next_after_seq. Default max_results 50, cap 500.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: ref,
          type: { type: 'string', description: 'Exact event type, e.g. "tool/call", "assistant/message"' },
          turn: { type: 'number' },
          step: { type: 'number' },
          from_seq: { type: 'number' },
          to_seq: { type: 'number' },
          after_seq: { type: 'number', description: 'Return only events with seq greater than this value' },
          max_results: { type: 'number' },
        },
        required: ['session_id'],
      },
      async run(args, store) {
        const parsed = await loadSession(store, requireString(args, 'session_id'))
        const filters = {
          type: typeof args['type'] === 'string' ? args['type'] : undefined,
          turn: optionalNumber(args, 'turn'),
          step: optionalNumber(args, 'step'),
          fromSeq: optionalNumber(args, 'from_seq'),
          toSeq: optionalNumber(args, 'to_seq'),
          afterSeq: optionalNumber(args, 'after_seq'),
        }
        const matched = parsed.events.filter(event => eventMatches(event, filters))
        return eventsResult(matched, matched.length, clampMax(args, 'max_results', 50, 500))
      },
    },
    {
      name: 'get-event-detail',
      description: 'Full JSON of one event by seq. Long strings are preserved; the serialized event is '
        + 'truncated at max_chars (default 200000, cap 2000000) with a truncated flag.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: ref,
          seq: { type: 'number', description: 'Event seq from list-events rows' },
          max_chars: { type: 'number' },
        },
        required: ['session_id', 'seq'],
      },
      async run(args, store) {
        const parsed = await loadSession(store, requireString(args, 'session_id'))
        const seq = optionalNumber(args, 'seq')
        if (seq === undefined || !Number.isInteger(seq)) throw new ToolError('"seq" must be an integer')
        const event = parsed.events.find(item => item.seq === seq)
        if (event === undefined) throw new ToolError(`no event with seq ${String(seq)} in this session`)
        const maxChars = clampMax(args, 'max_chars', 200_000, 2_000_000)
        const json = JSON.stringify(event, null, 2) ?? ''
        if (json.length <= maxChars) return { seq, type: event.type, truncated: false, event }
        return { seq, type: event.type, truncated: true, event_json: `${json.slice(0, maxChars)}…` }
      },
    },
    {
      name: 'list-collaborations',
      description: 'Cross-agent interactions in one session: subagent dispatches (prompt size, child '
        + 'session id from the "started subagent" acknowledgment, settlement with stop reason and report '
        + 'size), settled notices without a local dispatch, and send_message calls. Facts only; delivery '
        + 'provenance on the receiving side lives in the dsh-log-enhance journal, not here.',
      inputSchema: {
        type: 'object',
        properties: { session_id: ref },
        required: ['session_id'],
      },
      async run(args, store) {
        const parsed = await loadSession(store, requireString(args, 'session_id'))
        const rows = collaborations(parsed)
        return {
          collaborations: rows,
          counts: {
            subagent_dispatches: rows.filter(row => row.kind === 'subagent').length,
            settled_notices: rows.filter(row => row.kind === 'subagent-settled').length,
            send_message_calls: rows.filter(row => row.kind === 'send_message').length,
          },
        }
      },
    },
    {
      name: 'get-token-bill',
      description: 'Token usage grouped by turn or step. billed_input = inputTokens + cacheReadTokens '
        + '+ cacheWriteTokens; the three input legs are disjoint. Tool-level attribution is not '
        + 'derivable: usage attaches to model calls, and a step may issue several tool calls.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: ref,
          group_by: { type: 'string', enum: ['turn', 'step'], description: 'Grouping, default "turn"' },
        },
        required: ['session_id'],
      },
      async run(args, store) {
        const parsed = await loadSession(store, requireString(args, 'session_id'))
        const rawGroupBy = args['group_by']
        if (rawGroupBy !== undefined && rawGroupBy !== 'turn' && rawGroupBy !== 'step') {
          throw new ToolError('"group_by" must be one of: "turn", "step"')
        }
        return tokenBill(parsed, rawGroupBy === 'step' ? 'step' : 'turn') as unknown as Record<string, unknown>
      },
    },
    {
      name: 'query-events',
      description: 'Generic exact-match filter over events when the dedicated tools do not fit. '
        + 'filter maps dotted paths to expected values, compared by structural equality '
        + '(object key order is irrelevant, array order is significant), e.g. '
        + '{"type": "tool/call", "data.name": "read"} or {"data.turn": 2}. Missing paths never match. '
        + 'Rows are the same shape as list-events. Continue filtered pages with next_after_seq. '
        + 'Default max_results 50, cap 500.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: ref,
          filter: { type: 'object', description: 'Dotted path → expected value (structural equality)' },
          after_seq: { type: 'number', description: 'Return only events with seq greater than this value' },
          max_results: { type: 'number' },
        },
        required: ['session_id', 'filter'],
      },
      async run(args, store) {
        const parsed = await loadSession(store, requireString(args, 'session_id'))
        const filter = args['filter']
        if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
          throw new ToolError('"filter" must be an object of dotted path → expected value')
        }
        const maxResults = clampMax(args, 'max_results', 50, 500)
        const afterSeq = optionalNumber(args, 'after_seq')
        const matched = parsed.events.filter(event =>
          (afterSeq === undefined || (event.seq !== undefined && event.seq > afterSeq))
          && matchesFilter(event, filter as Record<string, unknown>))
        return eventsResult(matched, matched.length, maxResults)
      },
    },
  ]
}
