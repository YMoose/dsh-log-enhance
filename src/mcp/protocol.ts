/**
 * Minimal MCP (Model Context Protocol) server for stdio transport, without
 * external dependencies. Speaks newline-delimited JSON-RPC 2.0 as the MCP
 * stdio transport defines: `initialize` with protocol-version negotiation,
 * `notifications/*` (no response), `ping`, `tools/list`, and `tools/call`.
 *
 * Crash containment is the design constraint: every incoming line is handled
 * inside its own try/catch, malformed input becomes a JSON-RPC error response,
 * and tool failures become `isError` results per the MCP tool contract — none
 * of them terminate the process. Only stdin closing or a signal does.
 *
 * @module dsh-log-enhance/mcp/protocol
 */

import type { Readable, Writable } from 'node:stream'
import type { SessionStore } from './session-store.js'
import type { ToolSpec } from './tools.js'
import { ToolError } from './tools.js'

/** Protocol versions this server can speak, newest first. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const JSON_RPC_VERSION = '2.0'

type JsonRpcId = number | string

interface JsonRpcRequest {
  readonly jsonrpc?: unknown
  readonly id?: unknown
  readonly method?: unknown
  readonly params?: unknown
}

interface JsonRpcResponse {
  readonly jsonrpc: typeof JSON_RPC_VERSION
  readonly id: JsonRpcId | null
  readonly result?: unknown
  readonly error?: { code: number, message: string, data?: unknown }
}

// JSON-RPC error codes used here.
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603

/** Marker so unknown methods map to -32601 rather than a generic fault. */
class NoSuchMethodError extends Error {}

export interface McpServerOptions {
  readonly serverName: string
  readonly serverVersion: string
  readonly tools: readonly ToolSpec[]
  readonly store: SessionStore
  /** Extra text shown to clients in `initialize` (tool usage guidance). */
  readonly instructions?: string
  /** Non-fatal diagnostics sink; protocol problems never throw past this. */
  readonly onError?: (message: string) => void
}

/**
 * One MCP stdio server over arbitrary streams. Build with the same options
 * and drive {@link handleMessage} directly in tests; production entry uses
 * {@link runMcpStdioServer}.
 */
export class McpStdioServer {
  private readonly toolByName: Map<string, ToolSpec>

  constructor(private readonly options: McpServerOptions) {
    this.toolByName = new Map(options.tools.map(tool => [tool.name, tool]))
  }

  /** Handle one decoded request or notification; returns the response to send, if any. */
  async handleMessage(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (Array.isArray(message)) {
      return errorResponse(null, INVALID_REQUEST, 'batching is not supported; send one message per line')
    }
    if (typeof message !== 'object' || message === null) {
      return errorResponse(null, INVALID_REQUEST, 'request must be a JSON-RPC object')
    }
    const request = message as JsonRpcRequest
    const method = request.method
    if (typeof method !== 'string') {
      return errorResponse(idOf(request), INVALID_REQUEST, 'missing "method"')
    }
    const id = idOf(request)
    if (id === null) {
      if (method.startsWith('notifications/')) return undefined
      return errorResponse(null, INVALID_REQUEST, `"${method}" carries no id and is not a notification`)
    }
    if (request.jsonrpc !== JSON_RPC_VERSION) {
      return errorResponse(id, INVALID_REQUEST, `"jsonrpc" must be "${JSON_RPC_VERSION}"`)
    }
    const params = asParams(request.params)
    try {
      const result = await this.dispatch(method, params)
      return { jsonrpc: JSON_RPC_VERSION, id, result }
    } catch (error) {
      if (error instanceof ToolError) {
        // Tool failures are results, not protocol errors, per the MCP tool contract.
        return {
          jsonrpc: JSON_RPC_VERSION,
          id,
          result: { content: [{ type: 'text', text: error.message }], isError: true },
        }
      }
      const text = error instanceof Error ? error.message : String(error)
      this.options.onError?.(`method ${method} failed: ${text}`)
      if (error instanceof NoSuchMethodError) return errorResponse(id, METHOD_NOT_FOUND, text)
      return errorResponse(id, INTERNAL_ERROR, `internal error in "${method}": ${text}`)
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const requested = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : undefined
        const protocolVersion = requested !== undefined && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0] as string
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.options.serverName, version: this.options.serverVersion },
          ...(this.options.instructions === undefined ? {} : { instructions: this.options.instructions }),
        }
      }
      case 'ping':
        return {}
      case 'tools/list':
        return {
          tools: this.options.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        }
      case 'tools/call': {
        const name = params['name']
        if (typeof name !== 'string') throw new ToolError('"name" must be a string')
        const tool = this.toolByName.get(name)
        if (tool === undefined) throw new ToolError(`unknown tool "${name}"`)
        const args = asParams(params['arguments'])
        const result = await tool.run(args, this.options.store)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      }
      default:
        throw new NoSuchMethodError(`method "${method}" is not implemented`)
    }
  }
}

function idOf(request: JsonRpcRequest): JsonRpcId | null {
  const id = request.id
  return typeof id === 'number' || typeof id === 'string' ? id : null
}

function asParams(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function errorResponse(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } }
}

/**
 * Run the server loop over the given streams until the input side ends.
 * Line handling is serialized in arrival order and each line is isolated:
 * a parse failure answers `-32700`, anything else answers `-32603` or an
 * `isError` tool result, and the loop keeps going.
 */
export async function runMcpStdioServer(input: Readable, output: Writable, options: McpServerOptions): Promise<void> {
  const server = new McpStdioServer(options)
  let writable = true
  const write = (response: JsonRpcResponse): void => {
    if (!writable) return
    try {
      output.write(`${JSON.stringify(response)}\n`)
    } catch (error) {
      writable = false
      options.onError?.(`write failed, dropping further responses: ${String(error)}`)
    }
  }
  const pending: string[] = []
  const onLine = (line: string): Promise<void> => {
    const trimmed = line.trim()
    if (trimmed === '') return Promise.resolve()
    let message: unknown
    try {
      message = JSON.parse(trimmed)
    } catch {
      write(errorResponse(null, PARSE_ERROR, 'invalid JSON line'))
      return Promise.resolve()
    }
    return server.handleMessage(message).then(response => {
      if (response !== undefined) write(response)
    })
  }
  return await new Promise<void>((resolve, reject) => {
    let chain: Promise<void> = Promise.resolve()
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      chain.then(() => resolve(), () => resolve())
    }
    input.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let start = 0
      for (let newline = text.indexOf('\n'); newline !== -1; newline = text.indexOf('\n', start)) {
        const line = pending.join('') + text.slice(start, newline)
        pending.length = 0
        chain = chain.then(() => onLine(line), () => onLine(line))
        start = newline + 1
      }
      pending.push(text.slice(start))
    })
    input.on('end', () => {
      const rest = pending.join('')
      pending.length = 0
      if (rest.trim() !== '') chain = chain.then(() => onLine(rest), () => onLine(rest))
      finish()
    })
    input.on('error', error => {
      options.onError?.(`input failed: ${String(error)}`)
      finish()
    })
    output.on('error', error => {
      writable = false
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}
