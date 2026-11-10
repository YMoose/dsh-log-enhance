#!/usr/bin/env node
/**
 * Standalone MCP analysis server entry point (bin `dsh-log-enhance-mcp`).
 *
 * Serves the seven analysis tools over stdio against a DSH session storage
 * root, for any MCP client. Reads only; never touches running sessions.
 * The session root resolves from `--root <dir>`, else `DSH_SESSIONS_ROOT`,
 * else `~/.dsh/sessions` (the harness default location).
 *
 * @module dsh-log-enhance/mcp/standalone
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { runMcpStdioServer } from './protocol.js'
import { SessionStore } from './session-store.js'
import { analysisTools } from './tools.js'
import { PACKAGE_VERSION } from '../version.js'

const SERVER_NAME = 'dsh-log-enhance'
const SERVER_VERSION = PACKAGE_VERSION

const HELP = `Usage: dsh-log-enhance-mcp [--root <session-storage-dir>]

Serves read-only analysis tools for DSH session logs over the MCP stdio
transport. Session root resolution: --root, then DSH_SESSIONS_ROOT, then
~/.dsh/sessions.
`

function parseRoot(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue
    if (arg === '--root') {
      const value = argv[index + 1]
      if (value === undefined || value === '') {
        process.stderr.write('--root requires a directory argument\n')
        process.exit(2)
      }
      return value
    }
    if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length)
      if (value === '') {
        process.stderr.write('--root requires a directory argument\n')
        process.exit(2)
      }
      return value
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(HELP)
      process.exit(0)
    }
  }
  return undefined
}

function defaultRoot(): string {
  const fromEnv = process.env['DSH_SESSIONS_ROOT']
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh', 'sessions')
}

function main(): void {
  const root = parseRoot(process.argv.slice(2)) ?? defaultRoot()
  const store = new SessionStore(root)
  // Diagnostics go to stderr only; stdout belongs to the protocol.
  const onError = (message: string): void => {
    process.stderr.write(`${SERVER_NAME}: ${message}\n`)
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      process.exit(0)
    })
  }
  runMcpStdioServer(process.stdin, process.stdout, {
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    tools: analysisTools(),
    store,
    instructions: 'Read-only analysis of DSH session logs. Start with list-sessions, then '
      + 'get-session-summary, and drill into list-events / get-event-detail as needed. '
      + 'session_id accepts a unique id suffix.',
    onError,
  }).then(() => {
    process.exit(0)
  }, error => {
    onError(`server loop failed: ${String(error)}`)
    process.exit(1)
  })
}

main()
