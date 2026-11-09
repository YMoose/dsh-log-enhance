import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'
import { decompressFrame, scanZstdFrames, ZstdFrameFormatError } from '../src/mcp/zstd-frames.js'
import { SessionStore } from '../src/mcp/session-store.js'
import { legacySession, migratedSession, primarySession, withSessionRoot } from './mcp-fixtures.js'

test('frame scan splits a concatenated-frame container and round-trips payloads', () => {
  const header = zstdCompressSync('{"type":"session","version":4}\n')
  const batch1 = zstdCompressSync('{"type":"a"}\n{"type":"b"}\n')
  const batch2 = zstdCompressSync('{"type":"c"}\n')
  const buffer = Buffer.concat([header, batch1, batch2])
  const scan = scanZstdFrames(buffer)
  assert.equal(scan.frames.length, 3)
  assert.equal(scan.tornStart, undefined)
  assert.equal(decompressFrame(buffer, scan.frames[0] as { start: number, end: number }).toString('utf8'), '{"type":"session","version":4}\n')
  assert.equal(decompressFrame(buffer, scan.frames[1] as { start: number, end: number }).toString('utf8'), '{"type":"a"}\n{"type":"b"}\n')
})

test('frame scan honors maxFrames for header-only reads', () => {
  const buffer = Buffer.concat([zstdCompressSync('a'), zstdCompressSync('b'), zstdCompressSync('c')])
  const scan = scanZstdFrames(buffer, 1)
  assert.equal(scan.frames.length, 1)
})

test('a truncated final frame is reported as a torn tail, not corruption', () => {
  const whole = zstdCompressSync('abcdefghijklmnopqrstuvwxyz')
  const scan = scanZstdFrames(Buffer.concat([whole, whole.subarray(0, Math.floor(whole.length / 2))]))
  assert.equal(scan.frames.length, 1)
  assert.equal(typeof scan.tornStart, 'number')
})

test('invalid magic rejects with a structural error', () => {
  assert.throws(() => scanZstdFrames(Buffer.from('not zstd at all...............')), ZstdFrameFormatError)
})

test('store discovers sessions across projects and parses zstd v4 artifacts', async () => {
  await withSessionRoot([primarySession(), legacySession()], async root => {
    const store = new SessionStore(root)
    const listings = await store.list()
    assert.deepEqual(listings.map(l => l.sessionId).sort(), ['session-aaaa-1111', 'session-bbbb-2222'])
    const parsed = await store.load('session-aaaa-1111')
    assert.equal(parsed.events.length, 16)
    assert.equal(parsed.header.cwd, '/work/primary')
    assert.equal(parsed.truncatedTail, false)
    assert.equal((parsed.events[0] as { type: string }).type, 'permission/preset')
    assert.equal(typeof parsed.events[0]?.seq, 'number')
  })
})

test('the newest generation file wins when a directory holds several', async () => {
  await withSessionRoot([migratedSession()], async root => {
    const store = new SessionStore(root)
    const listing = await store.resolve('session-cccc-3333')
    assert.equal(listing.formatVersion, 4)
  })
})

test('session references resolve by exact id or unique suffix, and ambiguity names candidates', async () => {
  const twin = {
    sessionId: 'session-dddd-1111',
    batches: [[{ type: 'session/title', seq: 0 }]] as const,
  }
  await withSessionRoot([primarySession(), legacySession(), twin], async root => {
    const store = new SessionStore(root)
    assert.equal((await store.resolve('session-aaaa-1111')).sessionId, 'session-aaaa-1111')
    assert.equal((await store.resolve('-2222')).sessionId, 'session-bbbb-2222')
    await assert.rejects(store.resolve('-1111'), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /matches 2 sessions/)
      assert.deepEqual((error as { candidates?: string[] }).candidates, ['session-aaaa-1111', 'session-dddd-1111'])
      return true
    })
    await assert.rejects(store.resolve('nope'), /unknown session/)
  })
})

test('parse cache invalidates when the artifact changes on disk', async () => {
  await withSessionRoot([legacySession()], async root => {
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const store = new SessionStore(root)
    const first = await store.load('-2222')
    assert.equal(first.events.length, 3)
    const path = first.listing.path
    const header = JSON.stringify({ ...first.header })
    const appended = `${header}\n${first.events.map(event => JSON.stringify(event)).join('\n')}\n${JSON.stringify({ type: 'session/title', seq: 3 })}\n`
    // Grow and restamp so the stat key changes even on coarse-mtime filesystems.
    await new Promise(resolve => setTimeout(resolve, 10))
    await writeFile(path, appended)
    const second = await store.load('-2222')
    assert.equal(second.events.length, 4)
  })
})

test('unreadable storage roots yield an empty listing, not a crash', async () => {
  const store = new SessionStore('/nonexistent/dsh-log-enhance-root')
  assert.deepEqual(await store.list(), [])
})
