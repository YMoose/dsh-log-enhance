import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Journal } from './journal.js'
import { Observer } from './observer.js'

export const name = 'dsh-log-enhance'
export const inject = ['sessions', 'agents', 'tools']

export interface McpConfig {
  enabled?: boolean
  serverName?: string
  sessionRoot?: string
}

export interface Config {
  directory?: string
  maxEntries?: number
  indexTtlMs?: number
  maxPendingBytes?: number
  maxQueuedRecords?: number
  shutdownTimeoutMs?: number
  mcp?: McpConfig
}

export const Config: z<Config> = z.object({
  directory: z.string().default('.dsh-log-enhance'),
  maxEntries: z.number().default(4096),
  indexTtlMs: z.number().default(3_600_000),
  maxPendingBytes: z.number().default(4 * 1024 * 1024),
  maxQueuedRecords: z.number().default(4096),
  shutdownTimeoutMs: z.number().default(2000),
  mcp: z.object({
    enabled: z.boolean().default(false),
    serverName: z.string().default('dsh-log-enhance'),
    sessionRoot: z.string().default(''),
  }).default({ enabled: false, serverName: 'dsh-log-enhance', sessionRoot: '' }),
})

function settings(config: Config): Required<Omit<Config, 'mcp'>> & { mcp: Required<McpConfig> } {
  const result = {
    directory: config.directory ?? '.dsh-log-enhance', maxEntries: config.maxEntries ?? 4096,
    indexTtlMs: config.indexTtlMs ?? 3_600_000, maxPendingBytes: config.maxPendingBytes ?? 4 * 1024 * 1024,
    maxQueuedRecords: config.maxQueuedRecords ?? 4096, shutdownTimeoutMs: config.shutdownTimeoutMs ?? 2000,
    mcp: {
      enabled: config.mcp?.enabled ?? false,
      serverName: config.mcp?.serverName ?? 'dsh-log-enhance',
      sessionRoot: config.mcp?.sessionRoot ?? '',
    },
  }
  if (typeof result.directory !== 'string' || !result.directory.trim()) throw new Error('directory must be nonempty')
  for (const [key, value] of Object.entries(result)) {
    if (key !== 'directory' && key !== 'mcp' && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)) {
      throw new Error(`${key} must be a positive integer no greater than 2147483647`)
    }
  }
  if (typeof result.mcp.serverName !== 'string' || !result.mcp.serverName.trim()) throw new Error('mcp.serverName must be nonempty')
  return result
}

/** One stdio server entry for `ctx.mcpManager.register` (upstream contract, `dsh-mcp-manager`). */
interface McpRegistration {
  transport: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  startupTimeoutMs: number
}

/**
 * Mount the analysis MCP server when configured. Isolation contract: the
 * server is a separate stdio process owned by the host's MCP client, and any
 * failure here — missing service, missing build output, name conflict — only
 * logs a warning and leaves observation and journaling untouched.
 */
function mountAnalysisServer(ctx: Context, mcp: Required<McpConfig>): void {
  try {
    const script = fileURLToPath(new URL('./mcp/standalone.js', import.meta.url))
    if (!existsSync(script)) throw new Error(`analysis server entry not built: ${script}`)
    const manager = (ctx as Context & {
      mcpManager?: { register(name: string, entry: McpRegistration): () => void }
    }).mcpManager
    if (manager === undefined) throw new Error('mcpManager service is not available in this host')
    const sessionRoot = mcp.sessionRoot.trim() === '' ? join(homedir(), '.dsh', 'sessions') : mcp.sessionRoot
    const dispose = manager.register(mcp.serverName, {
      transport: 'stdio',
      command: process.execPath,
      args: [script, '--root', sessionRoot],
      env: {},
      cwd: '',
      startupTimeoutMs: 15_000,
    })
    ctx.effect(() => () => dispose())
    ctx.logger.info(`dsh-log-enhance: MCP analysis server registered as "${mcp.serverName}" (root ${sessionRoot})`)
  } catch (error) {
    ctx.logger.warn(`dsh-log-enhance: MCP analysis server not mounted: ${String(error)}`)
  }
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
    if (options.mcp.enabled) mountAnalysisServer(ctx, options.mcp)
    timer = setInterval(() => observer.run(() => observer.sweep()), Math.min(options.indexTtlMs, 60_000))
    timer.unref()
  } catch (error) {
    clearInterval(timer)
    observer.stop()
    await journal.close(options.shutdownTimeoutMs)
    throw error
  }
}
