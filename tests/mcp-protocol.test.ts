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

test('filtered event pages cover every match exactly once, including generic queries', async () => {
  await withSessionRoot([{
    sessionId: 'session-sparse-pages',
    batches: [[
      { type: 'alpha', seq: 0, data: { turn: 1 } },
      { type: 'beta', seq: 1, data: { turn: 1 } },
      { type: 'alpha', seq: 2, data: { turn: 1 } },
      { type: 'gamma', seq: 3, data: { turn: 2 } },
      { type: 'alpha', seq: 4, data: { turn: 2 } },
      { type: 'alpha', seq: 5, data: { turn: 2 } },
    ]],
  }], async root => {
    const s = server(new SessionStore(root))
    const collectSeqs = async (name: string, initialArguments: Record<string, unknown>): Promise<number[]> => {
      const seqs: number[] = []
      let args: Record<string, unknown> = { ...initialArguments, max_results: 1 }
      for (;;) {
        const response = await s.handleMessage({ jsonrpc: '2.0', id: seqs.length + 1, method: 'tools/call', params: { name, arguments: args } })
        const result = response?.result as { isError?: boolean, content: Array<{ text: string }> }
        assert.equal(result.isError, undefined, result.content[0]?.text)
        const page = JSON.parse(result.content[0]?.text ?? '') as {
          next_after_seq?: number
          rows: Array<{ seq: number }>
        }
        seqs.push(...page.rows.map(row => row.seq))
        if (page.next_after_seq === undefined) return seqs
        args = { ...args, after_seq: page.next_after_seq }
      }
    }
    assert.deepEqual(await collectSeqs('list-events', {
      session_id: 'session-sparse-pages', type: 'alpha', turn: 2,
    }), [4, 5])
    assert.deepEqual(await collectSeqs('query-events', {
      session_id: 'session-sparse-pages', filter: { type: 'alpha' },
    }), [0, 2, 4, 5])
  })
})

test('get-token-bill rejects a group_by outside turn/step instead of silently defaulting', async () => {
  await withSessionRoot([primarySession()], async root => {
    const s = server(new SessionStore(root))
    const call = async (groupBy: unknown): Promise<{ isError?: boolean, content?: Array<{ text: string }> }> =>
      (await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get-token-bill', arguments: { session_id: '-1111', group_by: groupBy } } }))?.result as { isError?: boolean, content?: Array<{ text: string }> }
    for (const bad of ['banana', 3, null]) {
      const rejected = await call(bad)
      assert.equal(rejected.isError, true)
      assert.match(rejected.content?.[0]?.text ?? '', /"group_by" must be one of: "turn", "step"/)
    }
    const valid = await call('turn')
    assert.equal(valid.isError, undefined)
    const defaulted = await call(undefined)
    assert.equal(defaulted.isError, undefined)
  })
})

test('list-sessions distinguishes a missing storage root from an empty one', async () => {
  await withSessionRoot([primarySession()], async root => {
    const answer = async (store: SessionStore): Promise<Record<string, unknown>> => {
      const response = await server(store).handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list-sessions', arguments: {} } })
      return JSON.parse(((response?.result as { content: Array<{ text: string }> }).content[0]?.text ?? '{}')) as Record<string, unknown>
    }
    const existing = await answer(new SessionStore(root))
    assert.equal(existing.root_exists, true)
    assert.equal(existing.total, 1)
    const missing = await answer(new SessionStore(join(root, 'no-such-root')))
    assert.equal(missing.root_exists, false)
    assert.equal(missing.total, 0)
    assert.deepEqual(missing.sessions, [])
  })
})

test('list-sessions survives a session whose createdAt is missing or malformed', async () => {
  // A single corrupt header must not hide every healthy session behind it: before
  // the fix `new Date(header.createdAt).toISOString()` threw a RangeError for the
  // whole listing, so `list-sessions` returned an isError result and listed nothing.
  await withSessionRoot([
    primarySession(),
    { sessionId: 'session-no-createdat', batches: [[{ type: 'turn/start', seq: 0, data: { turn: 1 } }]], header: { createdAt: undefined } },
    { sessionId: 'session-bad-createdat', batches: [[{ type: 'turn/start', seq: 0, data: { turn: 1 } }]], header: { createdAt: 'not-a-number' } },
  ], async root => {
    const response = await server(new SessionStore(root))
      .handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list-sessions', arguments: {} } })
    const result = response?.result as { isError?: boolean, content: Array<{ text: string }> }
    assert.equal(result.isError, undefined, result.content[0]?.text)
    const page = JSON.parse(result.content[0]?.text ?? '{}') as {
      total: number
      sessions: Array<{ session_id: string, created_at: string }>
    }
    assert.equal(page.total, 3)
    const healthy = page.sessions.find(row => row.session_id === 'session-aaaa-1111')
    assert.equal(healthy?.created_at, new Date(1_700_000_500_000).toISOString())
    for (const id of ['session-no-createdat', 'session-bad-createdat']) {
      assert.equal(page.sessions.find(row => row.session_id === id)?.created_at, 'unknown')
    }
    // Malformed creation times sort last, so a real newest-first ordering survives.
    assert.equal(page.sessions[0]?.session_id, 'session-aaaa-1111')
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
      let settled = false
      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return
        settled = true
        if (code === 0) resolve()
        else reject(new Error(`server exited with ${String(code ?? signal)}; stderr: ${stderr}`))
      }
      // The child can observe EOF before this cleanup runs (for example when a
      // test runner supplies a short-lived stdin pipe). Check exitCode after
      // installing the listener so cleanup never waits for an event that was
      // already emitted.
      child.once('exit', finish)
      if (child.exitCode !== null) finish(child.exitCode, child.signalCode)
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
