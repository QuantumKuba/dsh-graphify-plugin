import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config } from '../src/config.ts'
import { GraphifyMcpClient } from '../src/client.ts'
import { createGraphifyToolDefinitions, getPrefixedToolName } from '../src/tools.ts'
import { createGraphifyPromptSection } from '../src/prompt.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(__dirname, 'fixtures', 'sample-project')
const serverPath = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs')

describe('Compact Tool Mode and Dynamic Prefixing', () => {
  it('registers only 6 high-value tools in compact mode', () => {
    const config = Config({
      command: process.execPath,
      args: [serverPath],
      toolMode: 'compact',
    })
    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [serverPath],
      cwd: fixtureDir,
    })

    const tools = createGraphifyToolDefinitions(client, config)
    assert.equal(tools.length, 6)

    const names = tools.map((t) => t.name)
    assert.deepEqual(names.sort(), [
      'get_neighbors',
      'get_node',
      'graphify_resource',
      'graphify_status',
      'query_graph',
      'shortest_path',
    ].sort())
  })

  it('registers full 14-tool surface in full mode', () => {
    const config = Config({
      command: process.execPath,
      args: [serverPath],
      toolMode: 'full',
    })
    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [serverPath],
      cwd: fixtureDir,
    })

    const tools = createGraphifyToolDefinitions(client, config)
    assert.equal(tools.length, 14)
    assert.ok(tools.some((t) => t.name === 'god_nodes'))
    assert.ok(tools.some((t) => t.name === 'get_community'))
    assert.ok(tools.some((t) => t.name === 'list_prs'))
  })

  it('handles toolPrefix consistently without double-prefixing', () => {
    // Empty prefix
    assert.equal(getPrefixedToolName('query_graph', ''), 'query_graph')
    assert.equal(getPrefixedToolName('graphify_status', ''), 'graphify_status')

    // Standard plugin prefix
    assert.equal(getPrefixedToolName('query_graph', 'graphify_'), 'graphify_query_graph')
    assert.equal(getPrefixedToolName('graphify_status', 'graphify_'), 'graphify_status')
    assert.equal(getPrefixedToolName('graphify_resource', 'graphify_'), 'graphify_resource')

    // Custom multi-character prefix
    assert.equal(getPrefixedToolName('query_graph', 'kg_'), 'kg_query_graph')
    assert.equal(getPrefixedToolName('graphify_status', 'kg_'), 'kg_graphify_status')

    // Arbitrary single-letter prefix
    assert.equal(getPrefixedToolName('query_graph', 'g'), 'gquery_graph')
    assert.equal(getPrefixedToolName('get_node', 'g'), 'gget_node')
    assert.equal(getPrefixedToolName('graphify_status', 'g'), 'ggraphify_status')

    const config = Config({
      toolPrefix: 'graphify_',
      toolMode: 'compact',
    })
    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [serverPath],
      cwd: fixtureDir,
    })
    const tools = createGraphifyToolDefinitions(client, config)
    const names = tools.map((t) => t.name)

    assert.ok(names.includes('graphify_query_graph'))
    assert.ok(names.includes('graphify_get_node'))
    assert.ok(names.includes('graphify_status'))
    assert.ok(!names.includes('graphify_graphify_status'))
  })

  it('generates prompt decision policy reflecting prefixed names and compact mode', () => {
    const config = Config({
      toolPrefix: 'graphify_',
      toolMode: 'compact',
    })
    const section = createGraphifyPromptSection(null, config)
    const text = typeof section.text === 'function' ? section.text({}) : section.text

    assert.ok(text.includes('graphify_query_graph'))
    assert.ok(text.includes('graphify_get_node'))
    assert.ok(text.includes('graphify_status'))
    assert.ok(text.includes('Decision Policy: When to use Graphify'))
    assert.ok(text.includes('Authoritative Source Principle'))
    // In compact mode, specialist PR and god_node tools are omitted from prompt
    assert.ok(!text.includes('god_nodes'))
    assert.ok(!text.includes('list_prs'))
  })
})
