import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GraphifyMcpClient } from '../src/client.ts'
import { resolveGraphifyCommand } from '../src/server-process.ts'
import { Config } from '../src/config.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(__dirname, 'fixtures', 'sample-project')

describe('GraphifyMcpClient', () => {
  const config = Config({ cwd: fixtureDir })
  const graphPath = path.join(fixtureDir, 'graphify-out', 'graph.json')
  const { command, args } = resolveGraphifyCommand(config, graphPath, fixtureDir)

  it('resolves correct command and arguments', () => {
    assert.ok(command)
    assert.ok(Array.isArray(args))
  })

  it('initializes, lists tools, and executes graph_stats', async () => {
    const client = new GraphifyMcpClient({
      command,
      args,
      cwd: fixtureDir,
      timeoutMs: 30000,
    })

    try {
      await client.init()
      const tools = await client.listTools()
      assert.ok(tools.length >= 7, `Expected at least 7 tools, got ${tools.length}`)

      const toolNames = tools.map((t) => t.name)
      assert.ok(toolNames.includes('query_graph'))
      assert.ok(toolNames.includes('get_node'))
      assert.ok(toolNames.includes('god_nodes'))
      assert.ok(toolNames.includes('graph_stats'))

      // Call graph_stats tool
      const result = await client.callTool('graph_stats', {
        project_path: fixtureDir,
      })

      assert.equal(result.isError, false)
      assert.ok(result.content && result.content.length > 0)
      const text = result.content[0].text || ''
      assert.ok(text.includes('Nodes: 2778') || text.includes('Nodes:'))
      assert.ok(text.includes('Edges: 3446') || text.includes('Edges:'))
    } finally {
      await client.dispose()
    }
  })

  it('executes query_graph tool', async () => {
    const client = new GraphifyMcpClient({
      command,
      args,
      cwd: fixtureDir,
      timeoutMs: 30000,
    })

    try {
      const result = await client.callTool('query_graph', {
        question: 'Cordis plugins',
        project_path: fixtureDir,
        token_budget: 1000,
      })

      assert.equal(result.isError, false)
      assert.ok(result.content && result.content.length > 0)
      const text = result.content[0].text || ''
      assert.ok(text.length > 0)
    } finally {
      await client.dispose()
    }
  })

  it('handles cancellation via AbortSignal', async () => {
    const client = new GraphifyMcpClient({
      command,
      args,
      cwd: fixtureDir,
      timeoutMs: 30000,
    })

    try {
      const ac = new AbortController()
      ac.abort()

      await assert.rejects(
        async () => {
          await client.callTool('query_graph', { question: 'test' }, ac.signal)
        },
        /aborted/i
      )
    } finally {
      await client.dispose()
    }
  })
})

