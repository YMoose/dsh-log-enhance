import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, appendFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Journal } from '../src/journal.js'
import type { JournalIO } from '../src/journal.js'
import { observe } from '../src/records.js'
import { project, readJournal } from '../src/query.js'
import type { ReadDiagnostic } from '../src/query.js'

const record = () => observe({ type: 'message.accepted', target: { sessionId: 'B', formatVersion: 4, seq: 1, messageId: 'm1' }, senderSessionId: 'A' })
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('activation files replay across restarts and ignore incomplete tails with diagnostics', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-enhance-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (let i = 0; i < 2; i++) {
    const journal = await Journal.open(directory, 1_000_000, 100, () => {})
    assert.equal(journal.enqueue(record()), true)
    await journal.flush()
    assert.equal((await journal.close(1000)).closed, true)
  }
  const files = await readdir(directory)
  assert.equal(files.length, 2)
  await appendFile(join(directory, files[0]!), '{"schemaVersion":1')
  const diagnostics: ReadDiagnostic[] = []
  const result = await project(readJournal(directory, item => diagnostics.push(item)))
  assert.equal(result.messages.length, 1)
  assert.equal(result.duplicates, 1)
  assert.deepEqual(diagnostics.map(item => item.reason), ['incomplete-tail'])
  assert.ok((await readFile(join(directory, files[1]!), 'utf8')).endsWith('\n'))
})

test('bounded reader skips malformed and oversized lines without losing subsequent evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-enhance-reader-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'input.jsonl'), 'bad\n' + 'x'.repeat(100_000) + '\n' + JSON.stringify(record()) + '\n')
  const reasons: string[] = []
  const result = await project(readJournal(directory, item => reasons.push(item.reason)))
  assert.equal(result.messages.length, 1)
  assert.deepEqual(reasons, ['invalid-record', 'oversized-record'])
})

test('slow writes respect capacity; timeout does not close a handle still in use', async () => {
  const pending = gate()
  const events: string[] = []
  const io: JournalIO = {
    async appendFile() { events.push('writing'); await pending.promise; events.push('written') },
    async sync() { events.push('sync') }, async close() { events.push('close') },
  }
  const journal = new Journal(io, 100_000, 1)
  assert.equal(journal.enqueue(record()), true)
  await tick()
  assert.equal(journal.enqueue(record()), true)
  assert.equal(journal.enqueue(record()), false)
  const status = await journal.close(5)
  assert.equal(status.timedOut, true)
  assert.equal(status.closed, false)
  assert.equal(status.dropped, 2)
  assert.deepEqual(events, ['writing'])
  pending.resolve()
  await tick()
  assert.deepEqual(events, ['writing', 'written', 'sync', 'close'])
  assert.equal(journal.status().pendingBytes, 0)
})

test('write failure stops the file, isolates diagnostics, and closes only once', async () => {
  let writes = 0
  let closes = 0
  const journal = new Journal({
    async appendFile() { writes++; throw new Error('private disk error') },
    async sync() { assert.fail('failed file must not be synced') },
    async close() { closes++ },
  }, 100_000, 100, () => { throw new Error('diagnostic failed') })
  journal.enqueue(record())
  journal.enqueue(record())
  await assert.rejects(journal.flush(), /write failed/)
  await journal.close(1000)
  await journal.close(1000)
  assert.equal(writes, 1)
  assert.equal(closes, 1)
  assert.equal(journal.status().dropped, 2)
})

test('close waits for an already-started checkpoint before closing the file', async () => {
  const checkpoint = gate()
  const events: string[] = []
  let syncs = 0
  const journal = new Journal({
    async appendFile() {},
    async sync() { if (++syncs === 1) await checkpoint.promise; events.push('synced') },
    async close() { events.push('closed') },
  })
  const flushing = journal.flush()
  const closing = journal.close(1000)
  await tick()
  assert.deepEqual(events, [])
  checkpoint.resolve()
  await Promise.all([flushing, closing])
  assert.deepEqual(events, ['synced', 'synced', 'closed'])
})
