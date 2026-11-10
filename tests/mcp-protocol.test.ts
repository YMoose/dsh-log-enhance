import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { analysisTools } from '../src/mcp/tools.js'
import { McpStdioServer, runMcpStdioServer } from '../src/mcp/protocol.js'
import { SessionStore } from '../src/mcp/session-store.js'
import { legacySession, primarySession, withSessionRoot } from './mcp-fixtures.js'

const SERVER = { serverName: 'dsh-log-enhance', serverVersion: 'test' }

function server(store: SessionStore): McpStdioServer {
  return new McpStdioServer({ ...SERVER, tools: analysisTools(), store })
}

test('initialize negotiates the client version or falls back to newest', async () => {
  await withSessionRoot([primarySession()], async root => {
    const s = server(new SessionStore(root))
    const echoed = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    assert.equal((echoed?.result as { protocolVersion: string }).protocolVersion, '2024-11-05')
    const unknown = await s.handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
    assert.equal((unknown?.result as { protocolVersion: string }).protocolVersion, '2025-06-18')
    assert.equal((echoed?.result as { serverInfo: { name: string } }).serverInfo.name, 'dsh-log-enhance')
  })
})

test('notifications answer nothing; unknown methods answer -32601; garbage answers -32700', async () => {
  await withSessionRoot([primarySession()], async root => {
    const s = server(new SessionStore(root))
    assert.equal(await s.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined)
    const missing = await s.handleMessage({ jsonrpc: '2.0', id: 7, method: 'resources/list' })
    assert.equal(missing?.error?.code, -32601)
    const batch = await s.handleMessage([{ jsonrpc: '2.0', id: 8, method: 'ping' }])
    assert.equal(batch?.error?.code, -32600)
  })
})

test('tools/list exposes the seven analysis tools with schemas', async () => {
  await withSessionRoot([primarySession()], async root => {
    const s = server(new SessionStore(root))
    const response = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tools = (response?.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name)
    assert.deepEqual(tools, [
      'list-sessions', 'get-session-summary', 'list-events', 'get-event-detail',
      'list-collaborations', 'get-token-bill', 'query-events',
    ])
  })
})

test('tool failures become isError results and the server keeps answering', async () => {
  await withSessionRoot([primarySession()], async root => {
    const s = server(new SessionStore(root))
    const failed = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get-session-summary', arguments: { session_id: 'missing' } } })
    assert.equal((failed?.result as { isError?: boolean }).isError, true)
    const unknownTool = await s.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope' } })
    assert.equal((unknownTool?.result as { isError?: boolean }).isError, true)
    const stillAlive = await s.handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' })
    assert.deepEqual(stillAlive?.result, {})
  })
})

test('stdio loop survives a garbage line and answers everything in order', async () => {
  await withSessionRoot([primarySession()], async root => {
    const input = new PassThrough()
    const output = new PassThrough()
    const done = runMcpStdioServer(input, output, { ...SERVER, tools: analysisTools(), store: new SessionStore(root) })
    const lines: string[] = []
    output.on('data', chunk => {
      for (const piece of chunk.toString('utf8').split('\n')) {
        if (piece !== '') lines.push(piece)
      }
    })
    input.write('this is not json\n')
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'ping' })}\n`)
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/list' })}\n`)
    input.end()
    await done
    assert.equal(lines.length, 3)
    assert.equal(JSON.parse(lines[0] as string).error.code, -32700)
    assert.equal(JSON.parse(lines[1] as string).id, 41)
    const tools = JSON.parse(lines[2] as string).result.tools as unknown[]
    assert.equal(tools.length, 7)
  })
})

interface Child {
  stdin: { write(chunk: string): void, end(): void }
  send(message: unknown): void
  nextLine(): Promise<Record<string, unknown>>
  close(): Promise<void>
}

async function spawnServer(root: string): Promise<Child> {
  const child = spawn(process.execPath, [join('dist-test', 'src', 'mcp', 'standalone.js'), '--root', root], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: process.cwd(),
  })
  let buffer = ''
  const pending: Array<(line: string) => void> = []
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8')
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const resolve = pending.shift()
      if (resolve !== undefined) resolve(line)
      newline = buffer.indexOf('\n')
    }
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
  const nextLine = async (): Promise<Record<string, unknown>> => {
    const line = await new Promise<string>((resolve, reject) => {
      pending.push(resolve)
      setTimeout(() => reject(new Error(`timed out waiting for server response; stderr: ${stderr}`)), 5000)
    })
    return JSON.parse(line) as Record<string, unknown>
  }
  let closed = false
  const close = (): Promise<void> => {
    if (closed) return Promise.resolve()
    closed = true
    return new Promise((resolve, reject) => {
      child.on('exit', code => {
        if (code === 0) resolve()
        else reject(new Error(`server exited with ${String(code)}; stderr: ${stderr}`))
      })
      child.stdin.end()
    })
  }
  return {
    stdin: child.stdin,
    send: message => { child.stdin.write(`${JSON.stringify(message)}\n`) },
    nextLine,
    close,
  }
}

test('standalone server speaks MCP end to end over real stdio', async () => {
  await withSessionRoot([primarySession(), legacySession()], async root => {
    const child = await spawnServer(root)
    try {
      child.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } })
      const init = await child.nextLine()
      assert.equal((init['result'] as { serverInfo: { name: string } }).serverInfo.name, 'dsh-log-enhance')
      child.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      child.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      const list = await child.nextLine()
      assert.equal(((list['result'] as { tools: unknown[] }).tools).length, 7)
      child.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list-sessions', arguments: {} } })
      const sessions = JSON.parse(((await child.nextLine())['result'] as { content: Array<{ text: string }> }).content[0]?.text ?? '')
      assert.equal(sessions.total, 2)
      assert.equal(sessions.sessions[0]?.session_id, 'session-aaaa-1111')
      child.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get-token-bill', arguments: { session_id: '-1111', group_by: 'step' } } })
      const bill = JSON.parse(((await child.nextLine())['result'] as { content: Array<{ text: string }> }).content[0]?.text ?? '')
      assert.equal(bill.totals.billedInputTokens, 2405)
      // Malformed line, then a bad query: both answered, process survives.
      child.stdin.write('{{{ not json\n')
      const parseError = await child.nextLine()
      assert.equal((parseError['error'] as { code: number }).code, -32700)
      child.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get-event-detail', arguments: { session_id: '-1111', seq: 4 } } })
      const detail = JSON.parse(((await child.nextLine())['result'] as { content: Array<{ text: string }> }).content[0]?.text ?? '')
      assert.equal(detail.event.type, 'tool/call')
      await child.close()
    } finally {
      await child.close().catch(() => {})
    }
  })
})

test('a UTF-8 character split across chunk boundaries still parses its line', async () => {
  await withSessionRoot([primarySession()], async root => {
    const input = new PassThrough()
    const output = new PassThrough()
    const done = runMcpStdioServer(input, output, { ...SERVER, tools: analysisTools(), store: new SessionStore(root) })
    const lines: string[] = []
    output.on('data', chunk => {
      for (const piece of chunk.toString('utf8').split('\n')) {
        if (piece !== '') lines.push(piece)
      }
    })
    const payload = `${JSON.stringify({
      jsonrpc: '2.0', id: 99, method: 'tools/call',
      params: { name: 'query-events', arguments: { session_id: 'session-aaaa-1111', filter: { 'data.name': '发送消息' } } },
    })}\n`
    const bytes = Buffer.from(payload, 'utf8')
    // Cut one byte into the 3-byte character 发: the two halves are invalid UTF-8 on their own.
    const cut = bytes.indexOf(Buffer.from('发', 'utf8')) + 1
    assert.ok(cut > 0 && cut < bytes.length - 1)
    input.write(bytes.subarray(0, cut))
    input.write(bytes.subarray(cut))
    input.end()
    await done
    assert.equal(lines.length, 1)
    const response = JSON.parse(lines[0] as string) as { id?: number, error?: { code: number } }
    assert.equal(response.id, 99)
    assert.equal(response.error, undefined)
  })
})
