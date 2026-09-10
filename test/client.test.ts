import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GraphifyMcpClient } from '../src/client.ts'
import { Config } from '../src/config.ts'
import { resolveGraphifyCommand } from '../src/server-process.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(__dirname, 'fixtures', 'sample-project')
const serverPath = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs')
const flakyServerPath = path.join(__dirname, 'fixtures', 'fake-mcp-server-flaky.mjs')

function waitForState(client: GraphifyMcpClient, targetState: string, timeoutMs = 5000): Promise<void> {
  if (client.getConnectionState() === targetState) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for state '${targetState}', current state is '${client.getConnectionState()}'`))
    }, timeoutMs)
    const cleanup = client.onConnectionStateChange((state) => {
      if (state === targetState) {
        clearTimeout(timer)
        cleanup()
        resolve()
      }
    })
  })
}

function createClient() {
  return new GraphifyMcpClient({
    command: process.execPath,
    args: [serverPath],
    cwd: fixtureDir,
    timeoutMs: 5_000,
  })
}

describe('GraphifyMcpClient', () => {
  it('uses a configured server command without changing its arguments', () => {
    const config = Config({ command: process.execPath, args: [serverPath] })
    assert.deepEqual(resolveGraphifyCommand(config), { command: process.execPath, args: [serverPath] })
  })

  it('discovers graphify-mcp or python runtime when auto command is specified', () => {
    const config = Config({ command: 'auto' })
    const graphPath = path.join(fixtureDir, 'graphify-out', 'graph.json')
    const resolved = resolveGraphifyCommand(config, graphPath)
    assert.ok(resolved.command.length > 0)
    if (resolved.command.includes('graphify-mcp')) {
      assert.deepEqual(resolved.args, [graphPath])
    }
  })

  it('initializes, discovers tools and resources, and calls the server', async () => {
    const client = createClient()
    try {
      await client.init()
      assert.deepEqual((await client.listTools()).map((tool) => tool.name), ['query_graph', 'graph_stats', 'future_tool'])
      assert.deepEqual((await client.listResources()).map((resource) => resource.uri), ['graphify://report'])
      const result = await client.callTool('graph_stats', { project_path: fixtureDir })
      assert.equal(result.isError, undefined)
      assert.match(result.content?.[0].text || '', /graph_stats/)
      const resource = await client.readResource('graphify://report')
      assert.equal(resource.contents[0].text, '# Graph Report')
    } finally {
      await client.dispose()
    }
  })

  it('rejects an already aborted tool call', async () => {
    const client = createClient()
    try {
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(() => client.callTool('query_graph', {}, controller.signal), /aborted/i)
    } finally {
      await client.dispose()
    }
  })

  it('tracks connection state transitions and handles clean disposal', async () => {
    const states: string[] = []
    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [serverPath],
      cwd: fixtureDir,
      timeoutMs: 5_000,
    })
    client.onConnectionStateChange((state) => states.push(state))

    assert.equal(client.getConnectionState(), 'disconnected')
    await client.init()
    assert.equal(client.getConnectionState(), 'connected')

    await client.dispose()
    assert.equal(client.getConnectionState(), 'disposed')
    assert.ok(states.includes('connecting'))
    assert.ok(states.includes('connected'))
    assert.ok(states.includes('disposed'))
  })

  it('triggers reconnect backoff on unexpected process exit', async () => {
    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [serverPath],
      cwd: fixtureDir,
      reconnect: {
        enabled: true,
        initialDelayMs: 50,
        maxDelayMs: 200,
        maxAttempts: 3,
      },
    })

    try {
      await client.init()
      assert.equal(client.getConnectionState(), 'connected')

      let exitTriggered = false
      client.onExit(() => {
        exitTriggered = true
      })

      // Simulate unexpected process exit by closing the internal transport
      const transport = (client as unknown as { transport: { close: () => Promise<void> } }).transport
      await transport.close()

      // Give a brief tick for the onclose handler and reconnect timer to engage
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(exitTriggered, true)
      assert.ok(['reconnecting', 'connected'].includes(client.getConnectionState()))
    } finally {
      await client.dispose()
    }
  })

  it('cleans up resources and throws when handshake fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handshake-fail-'))
    const pidFile = path.join(tempDir, 'child.pid')
    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: ['-e', `import('node:fs').then(fs => { fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stderr.write("Fatal crash\\n"); process.exit(1); })`],
      cwd: fixtureDir,
      timeoutMs: 2_000,
      reconnect: { enabled: false },
    })

    try {
      await assert.rejects(() => client.init(), /Failed to connect|Connection closed|Fatal crash/i)
      assert.notEqual(client.getConnectionState(), 'connected')
      // Ensure internal references are torn down
      const internals = client as unknown as { client: unknown; transport: unknown; reconnectTimer: unknown }
      assert.equal(internals.client, null)
      assert.equal(internals.transport, null)
      assert.equal(internals.reconnectTimer, null)

      // Verify child process is dead
      assert.ok(fs.existsSync(pidFile), 'Child should have written PID before exiting')
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
      assert.ok(pid > 0)
      let isAlive = true
      try {
        process.kill(pid, 0)
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'ESRCH') isAlive = false
      }
      assert.equal(isAlive, false, 'Child process must be dead after handshake failure')
    } finally {
      await client.dispose()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('disposes cleanly during reconnect backoff without leaking timers', async () => {
    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [serverPath],
      cwd: fixtureDir,
      reconnect: {
        enabled: true,
        initialDelayMs: 500,
        maxDelayMs: 1000,
        maxAttempts: 3,
      },
    })

    try {
      await client.init()
      assert.equal(client.getConnectionState(), 'connected')

      // Trigger reconnect
      const transport = (client as unknown as { transport: { close: () => Promise<void> } }).transport
      await transport.close()

      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(client.getConnectionState(), 'reconnecting')

      await client.dispose()
      assert.equal(client.getConnectionState(), 'disposed')
    } finally {
      await client.dispose()
    }
  })

  it('retries reconnect after failed handshakes and eventually reconnects', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphify-reconnect-retry-'))
    const attemptFile = path.join(tempDir, 'attempt.txt')
    const triggerFile = path.join(tempDir, 'trigger.txt')

    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [flakyServerPath],
      cwd: fixtureDir,
      env: {
        ...process.env,
        FAIL_COUNT: '2',
        ATTEMPT_FILE: attemptFile,
        TRIGGER_FILE: triggerFile,
      } as Record<string, string>,
      reconnect: {
        enabled: true,
        initialDelayMs: 20,
        maxDelayMs: 50,
        maxAttempts: 5,
      },
    })

    try {
      // 1. Initial connection succeeds because triggerFile does not exist
      await client.init()
      assert.equal(client.getConnectionState(), 'connected')

      // 2. Enable failure mode: the next 2 process attempts will fail
      fs.writeFileSync(triggerFile, 'fail')

      // 3. Trigger unexpected disconnect
      const transport = (client as unknown as { transport: { close: () => Promise<void> } }).transport
      await transport.close()

      // 4. Wait for client to reconnect (should fail 2 times, succeed on 3rd)
      await waitForState(client, 'connected', 5000)
      assert.equal(client.getConnectionState(), 'connected')

      // 5. Verify the tool calls still succeed after reconnect
      const result = await client.callTool('query_graph', {})
      assert.equal(result.isError, undefined)
    } finally {
      await client.dispose()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('exhausts reconnect budget after maxAttempts consecutive failures', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphify-reconnect-exhaust-'))
    const attemptFile = path.join(tempDir, 'attempt.txt')
    const triggerFile = path.join(tempDir, 'trigger.txt')

    const maxAttempts = 3
    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [flakyServerPath],
      cwd: fixtureDir,
      env: {
        ...process.env,
        FAIL_COUNT: '99', // will always fail
        ATTEMPT_FILE: attemptFile,
        TRIGGER_FILE: triggerFile,
      } as Record<string, string>,
      reconnect: {
        enabled: true,
        initialDelayMs: 15,
        maxDelayMs: 30,
        maxAttempts,
      },
    })

    try {
      await client.init()
      assert.equal(client.getConnectionState(), 'connected')

      // Enable persistent failure
      fs.writeFileSync(triggerFile, 'fail')

      // Trigger disconnect
      const transport = (client as unknown as { transport: { close: () => Promise<void> } }).transport
      await transport.close()

      // Wait for client to enter final error state after exhausting attempts
      await waitForState(client, 'error', 5000)
      assert.equal(client.getConnectionState(), 'error')
      assert.equal(client.getReconnectAttempts(), maxAttempts)

      // Verify no further attempts are scheduled by waiting past delay
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(client.getConnectionState(), 'error')
      assert.equal(client.getReconnectAttempts(), maxAttempts)
    } finally {
      await client.dispose()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('resets reconnect attempt counter after stable connected period', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphify-reconnect-reset-'))
    const attemptFile = path.join(tempDir, 'attempt.txt')
    const triggerFile = path.join(tempDir, 'trigger.txt')

    const maxDelayMs = 40
    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [flakyServerPath],
      cwd: fixtureDir,
      env: {
        ...process.env,
        FAIL_COUNT: '1', // 1 failure then succeeds
        ATTEMPT_FILE: attemptFile,
        TRIGGER_FILE: triggerFile,
      } as Record<string, string>,
      reconnect: {
        enabled: true,
        initialDelayMs: 15,
        maxDelayMs,
        maxAttempts: 5,
      },
    })

    try {
      await client.init()
      assert.equal(client.getConnectionState(), 'connected')

      fs.writeFileSync(triggerFile, 'fail')
      const transport = (client as unknown as { transport: { close: () => Promise<void> } }).transport
      await transport.close()

      await waitForState(client, 'connected', 5000)
      assert.equal(client.getConnectionState(), 'connected')
      // Immediately after reconnecting, attempts is > 0
      assert.ok(client.getReconnectAttempts() > 0)

      // Wait for stable timer (maxDelayMs + safety margin)
      await new Promise((resolve) => setTimeout(resolve, maxDelayMs + 60))
      assert.equal(client.getReconnectAttempts(), 0)
    } finally {
      await client.dispose()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('disposes during failed reconnect attempt without scheduling further retries', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphify-reconnect-dispose-'))
    const attemptFile = path.join(tempDir, 'attempt.txt')
    const triggerFile = path.join(tempDir, 'trigger.txt')

    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [flakyServerPath],
      cwd: fixtureDir,
      env: {
        ...process.env,
        FAIL_COUNT: '99',
        ATTEMPT_FILE: attemptFile,
        TRIGGER_FILE: triggerFile,
      } as Record<string, string>,
      reconnect: {
        enabled: true,
        initialDelayMs: 20,
        maxDelayMs: 50,
        maxAttempts: 10,
      },
    })

    try {
      await client.init()
      assert.equal(client.getConnectionState(), 'connected')

      fs.writeFileSync(triggerFile, 'fail')
      const transport = (client as unknown as { transport: { close: () => Promise<void> } }).transport
      await transport.close()

      // Wait until it enters reconnecting
      await waitForState(client, 'reconnecting', 2000)

      // Dispose while reconnecting/attempting
      await client.dispose()
      assert.equal(client.getConnectionState(), 'disposed')

      // Record attempt count
      let attemptsAtDispose = 0
      if (fs.existsSync(attemptFile)) {
        attemptsAtDispose = parseInt(fs.readFileSync(attemptFile, 'utf8').trim(), 10) || 0
      }

      // Wait past retry delay and verify no new attempts happened
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(client.getConnectionState(), 'disposed')

      let attemptsAfterWait = 0
      if (fs.existsSync(attemptFile)) {
        attemptsAfterWait = parseInt(fs.readFileSync(attemptFile, 'utf8').trim(), 10) || 0
      }
      assert.ok(attemptsAfterWait <= attemptsAtDispose + 1)
    } finally {
      await client.dispose()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('recovers and executes tool calls made during reconnect backoff', async () => {
    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [serverPath],
      cwd: fixtureDir,
      reconnect: {
        enabled: true,
        initialDelayMs: 200,
        maxDelayMs: 500,
        maxAttempts: 5,
      },
    })

    try {
      await client.init()
      assert.equal(client.getConnectionState(), 'connected')

      // Break connection to enter reconnecting backoff
      const transport = (client as unknown as { transport: { close: () => Promise<void> } }).transport
      await transport.close()

      // Wait until client transitions to reconnecting
      await waitForState(client, 'reconnecting', 2000)
      assert.equal(client.getConnectionState(), 'reconnecting')

      // While reconnecting, call a tool. This invokes init() -> awaitReconnect()
      // which expedites reconnection and completes the tool call.
      const result = await client.callTool('query_graph', { question: 'hello' })
      assert.ok(result.content?.[0]?.text?.includes('query_graph'))
      assert.equal(client.getConnectionState(), 'connected')
    } finally {
      await client.dispose()
    }
  })

  it('survives failed expedited reconnect handshake and successfully recovers on subsequent retry', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphify-expedite-fail-'))
    const attemptFile = path.join(tempDir, 'attempt.txt')
    const triggerFile = path.join(tempDir, 'trigger.txt')

    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [flakyServerPath],
      cwd: fixtureDir,
      env: {
        ...process.env,
        FAIL_COUNT: '1',
        ATTEMPT_FILE: attemptFile,
        TRIGGER_FILE: triggerFile,
      } as Record<string, string>,
      reconnect: {
        enabled: true,
        initialDelayMs: 25,
        maxDelayMs: 60,
        maxAttempts: 5,
      },
    })

    try {
      // 1. Initial connection succeeds (no trigger file)
      await client.init()
      assert.equal(client.getConnectionState(), 'connected')

      // 2. Arm failure for the next attempt
      fs.writeFileSync(triggerFile, 'fail')

      // 3. Drop transport to enter reconnecting backoff
      const transport = (client as unknown as { transport: { close: () => Promise<void> } }).transport
      await transport.close()

      await waitForState(client, 'reconnecting', 2000)
      assert.equal(client.getConnectionState(), 'reconnecting')

      // 4. While reconnecting, call a tool. This expedites reconnect immediately via awaitReconnect().
      // That expedited attempt (attempt 1) will fail because FAIL_COUNT='1'.
      // The client must not die or throw away its retry chain; it must stay in reconnecting,
      // schedule attempt 2 via backoff timer, and succeed on attempt 2!
      const result = await client.callTool('query_graph', { question: 'hello after failure' })
      assert.ok(result.content?.[0]?.text?.includes('query_graph'))
      assert.equal(client.getConnectionState(), 'connected')

      // Subsequent tool call must also succeed
      const result2 = await client.callTool('query_graph', { question: 'second query' })
      assert.ok(result2.content?.[0]?.text?.includes('query_graph'))
    } finally {
      await client.dispose()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('fires onToolsChanged listener when server sends tools/list_changed notification', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tools-notify-'))
    const notifyServerScript = path.join(tempDir, 'notify-server.mjs')
    fs.writeFileSync(
      notifyServerScript,
      `
import readline from 'node:readline'
let tools = [{ name: 'tool_v1', inputSchema: { type: 'object' } }]
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  if (req.method === 'notifications/initialized' || req.method === 'notifications/cancelled') return
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'test', version: '1.0' } } })
    return
  }
  if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools } })
    return
  }
  if (req.method === 'tools/call') {
    tools.push({ name: 'tool_v2', inputSchema: { type: 'object' } })
    send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'ok' }] } })
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    return
  }
})
      `.trim()
    )

    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [notifyServerScript],
      cwd: fixtureDir,
      timeoutMs: 3000,
    })

    try {
      await client.init()
      assert.equal(client.getConnectionState(), 'connected')

      let notifiedTools: any[] | null = null
      const unsubscribe = client.onToolsChanged((tools) => {
        notifiedTools = tools
      })

      // Initial tools list
      const initialTools = await client.listTools()
      assert.equal(initialTools.length, 1)
      assert.equal(initialTools[0].name, 'tool_v1')

      // Trigger the tool call that causes the server to emit notifications/tools/list_changed
      await client.callTool('trigger', {})

      // Wait briefly for notification dispatch
      for (let i = 0; i < 20 && !notifiedTools; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      assert.ok(notifiedTools, 'Listener should have been invoked with updated tools')
      assert.equal(notifiedTools.length, 2)
      assert.ok(notifiedTools.some((t: any) => t.name === 'tool_v2'))

      unsubscribe()
    } finally {
      await client.dispose()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
