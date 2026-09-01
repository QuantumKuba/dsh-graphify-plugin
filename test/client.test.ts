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
})
