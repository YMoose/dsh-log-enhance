import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Observation } from './records.js'

export interface JournalIO {
  appendFile(data: string, encoding: 'utf8'): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface JournalStatus {
  queued: number
  pendingBytes: number
  written: number
  dropped: number
  failed: boolean
  closing: boolean
  closed: boolean
  timedOut: boolean
}

/** One writer per activation; distinct files avoid cross-process interleaving and lock recovery. */
export class Journal {
  private queue: string[] = []
  private pendingBytes = 0
  private running: Promise<void> | undefined
  private closingPromise: Promise<void> | undefined
  private checkpoints = new Set<Promise<void>>()
  private state = { written: 0, dropped: 0, failed: false, closing: false, closed: false, timedOut: false }

  constructor(
    private readonly io: JournalIO,
    private readonly maxPendingBytes = 4 * 1024 * 1024,
    private readonly maxRecords = 4096,
    private readonly diagnostic: (code: string) => void = () => {},
  ) {}

  static async open(directory: string, maxPendingBytes: number, maxRecords: number, diagnostic: (code: string) => void): Promise<Journal> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const file = await open(join(directory, `${Date.now()}-${randomUUID()}.jsonl`), 'wx', 0o600)
    return new Journal(file, maxPendingBytes, maxRecords, diagnostic)
  }

  status(): JournalStatus {
    return { ...this.state, queued: this.queue.length, pendingBytes: this.pendingBytes }
  }

  enqueue(record: Observation): boolean {
    const line = JSON.stringify(record) + '\n'
    const size = Buffer.byteLength(line)
    if (this.state.closing || this.state.failed || size > 64 * 1024 ||
        this.pendingBytes + size > this.maxPendingBytes || this.queue.length >= this.maxRecords) {
      this.state.dropped++
      if (this.state.dropped === 1) this.warn('journal-record-dropped')
      return false
    }
    this.queue.push(line)
    this.pendingBytes += size
    this.start()
    return true
  }

  private warn(code: string): void {
    try { this.diagnostic(code) } catch { /* Diagnostics cannot affect the writer. */ }
  }

  private start(): void {
    if (this.running) return
    // Deferral also makes synchronous enqueue batches share one pump.
    this.running = Promise.resolve().then(() => this.pump()).finally(() => {
      this.running = undefined
      if (this.queue.length && !this.state.failed) this.start()
    })
  }

  private async pump(): Promise<void> {
    while (this.queue.length) {
      const line = this.queue.shift()!
      try {
        await this.io.appendFile(line, 'utf8')
        this.state.written++
      } catch {
        // Stop after a possible partial write: later records must never follow an invalid tail.
        this.state.failed = true
        this.state.dropped += 1 + this.queue.length
        this.queue = []
        this.pendingBytes = 0
        this.warn('journal-write-failed')
        return
      }
      this.pendingBytes -= Buffer.byteLength(line)
    }
  }

  /** A caller-owned checkpoint for supplementary evidence; never attached to Session.flush. */
  flush(): Promise<void> {
    if (this.state.closed || this.state.closing) return Promise.reject(new Error('Journal is closing'))
    const checkpoint = (async () => {
      while (this.running) await this.running
      if (this.state.failed) throw new Error('Journal write failed')
      await this.io.sync()
    })()
    this.checkpoints.add(checkpoint)
    void checkpoint.then(() => this.checkpoints.delete(checkpoint), () => this.checkpoints.delete(checkpoint))
    return checkpoint
  }

  async close(timeoutMs: number): Promise<JournalStatus> {
    this.state.closing = true
    this.closingPromise ??= (async () => {
      while (this.running) await this.running
      await Promise.allSettled(this.checkpoints)
      try { if (!this.state.failed) await this.io.sync() }
      catch { this.state.failed = true; this.warn('journal-sync-failed') }
      finally {
        try { await this.io.close() }
        catch { this.state.failed = true; this.warn('journal-close-failed') }
        this.state.closed = true
      }
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        this.state.timedOut = true
        this.state.dropped += this.queue.length
        this.pendingBytes -= this.queue.reduce((bytes, line) => bytes + Buffer.byteLength(line), 0)
        this.queue = []
        this.warn('journal-close-timeout')
        resolve()
      }, timeoutMs)
    })
    await Promise.race([this.closingPromise, timeout])
    clearTimeout(timer)
    // If a write is still in flight, its owner closes the handle only after it settles.
    return this.status()
  }
}
