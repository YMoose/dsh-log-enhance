/**
 * Shared fixtures for MCP-layer tests: builds a temporary session storage
 * tree with zstd-container and plain-JSONL artifacts shaped like the real
 * DSH persistence layout.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

export interface FixtureEvent {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data?: unknown
}

export interface FixtureSession {
  readonly sessionId: string
  readonly cwd?: string
  readonly header?: Record<string, unknown>
  readonly version?: number
  readonly compressed?: boolean
  /** Each batch becomes one frame (compressed) or is appended plainly. */
  readonly batches: readonly (readonly FixtureEvent[])[]
  /** Also write a stale older generation next to the current one. */
  readonly staleVersion?: number
}

function projectKeyOf(cwd: string | undefined): string {
  if (cwd === undefined) return '_no-cwd'
  return `--${cwd.replaceAll('/', '-').replaceAll(':', '-')}--`
}

export async function writeSessionRoot(root: string, sessions: readonly FixtureSession[]): Promise<void> {
  for (const session of sessions) {
    const version = session.version ?? 4
    const compressed = session.compressed ?? true
    const dir = join(root, projectKeyOf(session.cwd), session.sessionId)
    await mkdir(dir, { recursive: true })
    const header = {
      type: 'session',
      version,
      id: session.sessionId,
      createdAt: 1_700_000_000_000,
      cwd: session.cwd,
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'standard',
      ...session.header,
    }
    const filename = (v: number, z: boolean): string =>
      `${v === 0 ? 'session.jsonl' : `session.v${String(v)}.jsonl`}${z ? '.zstd' : ''}`
    const lines = (batches: readonly (readonly FixtureEvent[])[]): string =>
      batches.map(batch => batch.map(event => JSON.stringify(event)).join('\n')).join('\n')
    if (session.staleVersion !== undefined) {
      await writeFile(join(dir, filename(session.staleVersion, compressed)),
        compressed
          ? zstdCompressSync(`${JSON.stringify({ ...header, version: session.staleVersion })}\n${lines(session.batches.slice(0, 1))}\n`)
          : `${JSON.stringify({ ...header, version: session.staleVersion })}\n${lines(session.batches.slice(0, 1))}\n`)
    }
    const artifact = compressed
      ? Buffer.concat([
        zstdCompressSync(`${JSON.stringify(header)}\n`),
        ...session.batches.map(batch => zstdCompressSync(`${lines([batch])}\n`)),
      ])
      : Buffer.from(`${JSON.stringify(header)}\n${lines(session.batches)}\n`, 'utf8')
    await writeFile(join(dir, filename(version, compressed)), artifact)
  }
}

export async function withSessionRoot(
  sessions: readonly FixtureSession[],
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-log-enhance-mcp-test-'))
  try {
    await writeSessionRoot(root, sessions)
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** A realistic v4 session exercising the collaboration and token paths. */
export function primarySession(): FixtureSession {
  const t = (seconds: number): number => 1_700_000_000_000 + seconds * 1000
  return {
    sessionId: 'session-aaaa-1111',
    cwd: '/work/primary',
    header: { createdAt: 1_700_000_500_000 },
    batches: [
      [
        { type: 'permission/preset', seq: 0, time: t(0), data: { preset: 'workspace-write' } },
        { type: 'turn/start', seq: 1, time: t(1), data: { turn: 1 } },
        { type: 'step/start', seq: 2, time: t(2), data: { turn: 1, step: 1 } },
        {
          type: 'assistant/message', seq: 3, time: t(3),
          data: {
            turn: 1, step: 1,
            message: { role: 'assistant', content: [{ type: 'text', text: 'delegate' }] },
            usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 5, reasoningTokens: 2 },
          },
        },
        { type: 'tool/call', seq: 4, time: t(4), data: { turn: 1, step: 1, callId: 'call-1', name: 'subagent', arguments: '{"description":"d1","prompt":"abc"}' } },
        { type: 'tool/call', seq: 5, time: t(5), data: { turn: 1, step: 1, callId: 'call-2', name: 'send_message', arguments: '{"target":"lead","message":"hello"}' } },
        { type: 'step/end', seq: 6, time: t(6), data: { turn: 1, step: 1 } },
        {
          type: 'tool/result', seq: 7, time: t(7),
          data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'started subagent child-1' }] } },
        },
        {
          type: 'tool/result', seq: 8, time: t(8),
          data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call-2', content: [{ type: 'text', text: '{"messageId":"m1"}' }] }, meta: { messageId: 'm1' } },
        },
      ],
      [
        { type: 'step/start', seq: 9, time: t(20), data: { turn: 1, step: 2 } },
        {
          type: 'assistant/message', seq: 10, time: t(21),
          data: {
            turn: 1, step: 2,
            message: { role: 'assistant', content: [{ type: 'text', text: 'waiting' }] },
            usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 1000, cacheWriteTokens: 0 },
          },
        },
        {
          type: 'user/message', seq: 11, time: t(30),
          data: {
            role: 'user',
            content: [{ type: 'text', text: 'x'.repeat(80) }],
            source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-1' },
          },
        },
        {
          type: 'assistant/message', seq: 12, time: t(31),
          data: {
            turn: 1, step: 2,
            message: { role: 'assistant', content: [{ type: 'text', text: 'absorbed' }] },
            usage: { inputTokens: 30, outputTokens: 8, cacheReadTokens: 1200, cacheWriteTokens: 0 },
          },
        },
        { type: 'step/end', seq: 13, time: t(32), data: { turn: 1, step: 2 } },
        { type: 'turn/end', seq: 14, time: t(33), data: { turn: 1, reason: { kind: 'completed' } } },
        { type: 'compaction/end', seq: 15, time: t(34), data: { reason: 'manual' } },
      ],
    ],
  }
}

/** A plain-JSONL v3 session with nested tool-result blocks. */
export function legacySession(): FixtureSession {
  return {
    sessionId: 'session-bbbb-2222',
    cwd: '/work/legacy',
    header: { createdAt: 1_699_000_000_000 },
    version: 3,
    compressed: false,
    batches: [
      [
        { type: 'session/title', seq: 0, time: 1_699_000_000_500, data: { title: 'legacy' } },
        { type: 'tool/call', seq: 1, time: 1_699_000_001_000, data: { turn: 1, step: 1, callId: 'call-l1', name: 'read', arguments: '{"file_path":"/etc/host"}' } },
        {
          type: 'tool/result', seq: 2, time: 1_699_000_001_500,
          data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call-l1', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'y'.repeat(1375) }] }] } },
        },
      ],
    ],
  }
}

/** Same directory holding v3 and v4 generations; the v4 must win. */
export function migratedSession(): FixtureSession {
  return {
    ...primarySession(),
    sessionId: 'session-cccc-3333',
    cwd: '/work/primary',
    header: { createdAt: 1_700_000_600_000 },
    staleVersion: 3,
  }
}
