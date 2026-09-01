import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config } from '../src/config.ts'
import { GraphifyMcpClient } from '../src/client.ts'
import { resolveGraphifyCommand } from '../src/server-process.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(__dirname, 'fixtures', 'sample-project')
const graphPath = path.join(fixtureDir, 'graphify-out', 'graph.json')

describe('Graphify release contract', () => {
  it('supports the documented MCP tools and resources', async (context) => {
    if (process.env.GRAPHIFY_E2E !== '1') {
      context.skip('set GRAPHIFY_E2E=1 after installing graphifyy[mcp]')
      return
    }

    const config = Config({ command: 'auto' })
    const resolved = resolveGraphifyCommand(config, graphPath)
    const client = new GraphifyMcpClient({ ...resolved, cwd: fixtureDir, timeoutMs: 30_000 })
    try {
      const toolNames = (await client.listTools()).map((tool) => tool.name)
      for (const name of ['query_graph', 'get_node', 'get_neighbors', 'get_community', 'god_nodes', 'graph_stats', 'shortest_path']) {
        assert.ok(toolNames.includes(name), `Missing Graphify tool: ${name}`)
      }
      assert.ok((await client.listResources()).some((resource) => resource.uri === 'graphify://report'))
    } finally {
      await client.dispose()
    }
  })
})
