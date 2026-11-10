import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as plugin from '../../src/index.js'
import { project, readJournal } from '../../src/query.js'

// The testkit Context never provides `mcpManager`, so `mcp.enabled: true`
// exercises the degradation paths against the real resolution machinery.
const standaloneScript = fileURLToPath(new URL('../../src/mcp/standalone.js', import.meta.url))

function messages(ctx: Context, type: 'warn' | 'info'): string[] {
  return ctx.logger.buffer.filter(entry => entry.type === type).map(entry => entry.args.map(String).join(' '))
}

interface Harness {
  ctx: Context
  directory: string
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-enhance-mcp-'))
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  return { ctx, directory }
}

/** One journaled inbox message, proving observation survives whatever MCP mounting did. */
async function assertObservationAlive(harnessCtx: Context, directory: string, fiber: { dispose(): Promise<void> }) {
  const agent = await harnessCtx.agentLoop.create(SessionId('B'))
  agent.send(createUserMessage({
    content: [{ type: 'text', text: 'PRIVATE' }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('A') },
  }), 'next-turn', false)
  await fiber.dispose()
  const report = await project(readJournal(directory))
  assert.equal(report.messages.length, 1)
  assert.deepEqual(report.messages[0]?.stages, ['accepted'])
}

test('a host without mcpManager applies with a warning while observation continues', async () => {
  const { ctx, directory } = await harness()
  try {
    const fiber = await ctx.plugin(plugin, { directory, mcp: { enabled: true } })
    const warns = messages(ctx, 'warn').filter(text => text.includes('dsh-log-enhance:'))
    assert.equal(warns.length, 1)
    assert.match(warns[0]!, /^dsh-log-enhance: MCP analysis server not mounted:/)
    // The context proxy refuses the service read, so the recorded reason names mcpManager.
    assert.match(warns[0]!, /mcpManager/)
    assert.ok(!messages(ctx, 'info').some(text => text.includes('MCP analysis server registered')))
    await assertObservationAlive(ctx, directory, fiber)
  } finally {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a provided mcpManager receives the standalone stdio registration and dispose on unload', async () => {
  const { ctx, directory } = await harness()
  const sessionRoot = join(directory, 'session-storage')
  const registrations: Array<{ name: string; entry: unknown }> = []
  let disposals = 0
  const unprovide = ctx.provide('mcpManager', {
    register(name: string, entry: unknown) {
      registrations.push({ name, entry })
      return () => { disposals += 1 }
    },
  })
  try {
    assert.ok(existsSync(standaloneScript), 'the registered entry must point at the built standalone server')
    const fiber = await ctx.plugin(plugin, {
      directory,
      mcp: { enabled: true, serverName: 'obs-analysis', sessionRoot },
    })
    assert.deepEqual(registrations, [{
      name: 'obs-analysis',
      entry: {
        transport: 'stdio',
        command: process.execPath,
        args: [standaloneScript, '--root', sessionRoot],
        env: {},
        cwd: '',
        startupTimeoutMs: 15_000,
      },
    }])
    assert.ok(messages(ctx, 'info').some(text => text.includes('MCP analysis server registered as "obs-analysis"')))
    assert.ok(!messages(ctx, 'warn').some(text => text.includes('dsh-log-enhance:')))
    await assertObservationAlive(ctx, directory, fiber)
    assert.equal(disposals, 1, 'unloading the plugin must call the disposer returned by register')
  } finally {
    unprovide()
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('the default registration names the package server and the harness session root', async () => {
  const { ctx, directory } = await harness()
  const registrations: Array<{ name: string; entry: unknown }> = []
  const unprovide = ctx.provide('mcpManager', {
    register(name: string, entry: unknown) {
      registrations.push({ name, entry })
      return () => {}
    },
  })
  try {
    const fiber = await ctx.plugin(plugin, { directory, mcp: { enabled: true } })
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0]?.name, 'dsh-log-enhance')
    const entry = registrations[0]!.entry as { args: string[] }
    assert.deepEqual(entry.args.slice(1), ['--root', join(homedir(), '.dsh', 'sessions')])
    await assertObservationAlive(ctx, directory, fiber)
  } finally {
    unprovide()
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a register that throws degrades to a warning while observation continues', async () => {
  const { ctx, directory } = await harness()
  let disposals = 0
  const unprovide = ctx.provide('mcpManager', {
    register(): () => void {
      throw new Error('mcp-manager: server "obs-analysis" is already configured or registered')
    },
  })
  try {
    const fiber = await ctx.plugin(plugin, { directory, mcp: { enabled: true, serverName: 'obs-analysis' } })
    const warns = messages(ctx, 'warn').filter(text => text.includes('dsh-log-enhance:'))
    assert.equal(warns.length, 1)
    assert.match(warns[0]!, /^dsh-log-enhance: MCP analysis server not mounted:/)
    assert.match(warns[0]!, /already configured or registered/)
    await assertObservationAlive(ctx, directory, fiber)
    assert.equal(disposals, 0, 'a refused registration leaves nothing to dispose')
  } finally {
    unprovide()
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
