import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GraphifyMcpClient } from '../src/client.ts'
import { Config } from '../src/config.ts'
import { resolveGraphifyCommand } from '../src/server-process.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(__dirname, 'fixtures', 'sample-project')
const serverPath = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs')

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
})
