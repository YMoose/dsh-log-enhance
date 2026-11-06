import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolve } from 'node:path'
import { Journal } from './journal.js'
import { Observer } from './observer.js'

export const name = 'dsh-log-enhance'
export const inject = ['sessions', 'agents', 'tools']

export interface Config {
  directory?: string
  maxEntries?: number
  indexTtlMs?: number
  maxPendingBytes?: number
  maxQueuedRecords?: number
  shutdownTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  directory: z.string().default('.dsh-log-enhance'),
  maxEntries: z.number().default(4096),
  indexTtlMs: z.number().default(3_600_000),
  maxPendingBytes: z.number().default(4 * 1024 * 1024),
  maxQueuedRecords: z.number().default(4096),
  shutdownTimeoutMs: z.number().default(2000),
})

function settings(config: Config): Required<Config> {
  const result = {
    directory: config.directory ?? '.dsh-log-enhance', maxEntries: config.maxEntries ?? 4096,
    indexTtlMs: config.indexTtlMs ?? 3_600_000, maxPendingBytes: config.maxPendingBytes ?? 4 * 1024 * 1024,
    maxQueuedRecords: config.maxQueuedRecords ?? 4096, shutdownTimeoutMs: config.shutdownTimeoutMs ?? 2000,
  }
  if (typeof result.directory !== 'string' || !result.directory.trim()) throw new Error('directory must be nonempty')
  for (const [key, value] of Object.entries(result)) {
    if (key !== 'directory' && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)) {
      throw new Error(`${key} must be a positive integer no greater than 2147483647`)
    }
  }
  return result
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const options = settings(config)
  const journal = await Journal.open(resolve(options.directory), options.maxPendingBytes, options.maxQueuedRecords,
    code => ctx.logger.warn(`dsh-log-enhance: ${code}`))
  const observer = new Observer(record => journal.enqueue(record), options.maxEntries, options.indexTtlMs)
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    ctx.effect(() => async () => {
      clearInterval(timer)
      observer.stop()
      const status = await journal.close(options.shutdownTimeoutMs)
      if (status.dropped || status.failed || status.timedOut) {
        ctx.logger.warn(`dsh-log-enhance: written=${status.written} dropped=${status.dropped} failed=${status.failed} timedOut=${status.timedOut}`)
      }
    })
    ctx.on('session/event', (session, event) => observer.run(() => observer.sessionEvent(session, event)))
    ctx.on('tools/pre-execute', (exec, next) => {
      observer.run(() => observer.beforeTool(exec))
      return next()
    })
    ctx.on('tools/result', (exec, result) => { observer.run(() => observer.toolResult(exec, result)); return undefined })
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (message.source.kind === 'agent-message') observer.run(() => observer.inboxInserted(agent, message.id))
    })
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      if (message.source.kind === 'agent-message') observer.run(() => observer.inboxClaimed(agent, message.id, turn))
    })
    ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      if (message.source.kind === 'agent-message') observer.run(() => observer.inboxDiscarded(agent, message.id))
    })
    timer = setInterval(() => observer.run(() => observer.sweep()), Math.min(options.indexTtlMs, 60_000))
    timer.unref()
  } catch (error) {
    clearInterval(timer)
    observer.stop()
    await journal.close(options.shutdownTimeoutMs)
    throw error
  }
}
