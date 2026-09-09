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
    assert.ok(resolved.command.includes('graphify-mcp') || resolved.command.includes('python'), 'Command should resolve to graphify-mcp or python')
    const client = new GraphifyMcpClient({ ...resolved, cwd: fixtureDir, timeoutMs: 30_000 })
    try {
      const tools = await client.listTools()
      const toolNames = tools.map((tool) => tool.name)
      const expectedTools = [
        'query_graph',
        'get_node',
        'get_neighbors',
        'get_community',
        'god_nodes',
        'graph_stats',
        'shortest_path',
        'list_prs',
        'get_pr_impact',
        'triage_prs',
      ]
      for (const name of expectedTools) {
        assert.ok(toolNames.includes(name), `Missing Graphify tool: ${name}`)
      }

      const godNodesTool = tools.find((tool) => tool.name === 'god_nodes')
      assert.ok(godNodesTool, 'god_nodes tool not found')
      const godProps = godNodesTool.inputSchema?.properties as Record<string, unknown> | undefined
      assert.ok(godProps && 'exclude_hubs_percentile' in godProps, 'god_nodes should have exclude_hubs_percentile')

      const resources = await client.listResources()
      const resourceUris = resources.map((r) => r.uri)
      const expectedUris = [
        'graphify://report',
        'graphify://stats',
        'graphify://god-nodes',
        'graphify://surprises',
        'graphify://audit',
        'graphify://questions',
      ]
      for (const uri of expectedUris) {
        assert.ok(resourceUris.includes(uri), `Missing Graphify resource: ${uri}`)
      }

      // Test reading a resource
      const report = await client.readResource('graphify://report')
      assert.ok(report.contents.length > 0, 'Resource report should have content')

      // Test calling god_nodes with exclude_hubs_percentile
      const godCall = await client.callTool('god_nodes', { top_n: 5, exclude_hubs_percentile: 90 })
      assert.equal(godCall.isError ?? false, false)
      assert.ok(godCall.content && godCall.content.length > 0)
    } finally {
      await client.dispose()
    }
  })
})
