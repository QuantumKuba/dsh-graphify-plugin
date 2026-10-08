import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config } from '../src/config.ts'
import { GraphifyMcpClient } from '../src/client.ts'
import { createGraphifyToolDefinitions, formatNavigationResult, getPrefixedToolName } from '../src/tools.ts'
import { createGraphifyPromptSection } from '../src/prompt.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(__dirname, 'fixtures', 'sample-project')
const serverPath = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs')

describe('Compact Tool Mode and Dynamic Prefixing', () => {
  it('registers one task-level navigation tool in compact mode', () => {
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
    assert.deepEqual(tools.map((tool) => tool.name), ['find_code'])
  })

  it('registers task-level navigation and the full 15-tool surface in full mode', () => {
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
    assert.equal(tools.length, 16)
    assert.ok(tools.some((t) => t.name === 'find_code'))
    assert.ok(tools.some((t) => t.name === 'god_nodes'))
    assert.ok(tools.some((t) => t.name === 'get_community'))
    assert.ok(tools.some((t) => t.name === 'list_prs'))
    assert.ok(tools.some((t) => t.name === 'graphify_project_resource'))
    assert.ok(tools.some((t) => t.name === 'graphify_resource'))
  })

  it('handles toolPrefix consistently without double-prefixing', () => {
    // Empty prefix
    assert.equal(getPrefixedToolName('query_graph', ''), 'query_graph')
    assert.equal(getPrefixedToolName('find_code', 'graphify_'), 'find_code')
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

    assert.deepEqual(names, ['find_code'])
  })

  it('generates prompt decision policy reflecting prefixed names and compact mode', () => {
    const config = Config({
      toolPrefix: 'graphify_',
      toolMode: 'compact',
    })
    const section = createGraphifyPromptSection(null, config)
    const text = typeof section.text === 'function' ? section.text({}) : section.text

    assert.ok(text.includes('find_code'))
    assert.ok(text.includes('whole question'))
    assert.ok(text.includes('Do not list directories'))
    assert.ok(!text.includes('graphify_query_graph'))
    assert.ok(!text.includes('graphify_status'))
    assert.ok(!text.includes('god_nodes'))
    assert.ok(!text.includes('list_prs'))
  })

  it('ranks source locations ahead of tests and keeps a bounded relationship sample', () => {
    const result = formatNavigationResult([
      'Graph: graph.json',
      'NODE res.send.js [src=test/res.send.js loc=L1 community=response.js]',
      'NODE .send() [src=lib/response.js loc=L110 community=response.js]',
      'NODE response.js [src=lib/response.js loc=L1 community=response.js]',
      'EDGE response.js --contains [EXTRACTED]--> .send() at=lib/response.js:L110',
    ].join('\n'))
    assert.match(result, /^Candidate source locations/)
    assert.ok(result.indexOf('lib/response.js:L110') < result.indexOf('test/res.send.js:L1'))
    assert.match(result, /Recorded relationships \(incomplete\)/)
    assert.doesNotMatch(result, /community=/)
  })

  it('caps bounded graph results at the configured budget', async () => {
    const config = Config({
      command: process.execPath,
      args: [serverPath],
      resultTokenBudget: 600,
    })
    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [serverPath],
      cwd: fixtureDir,
    })
    const query = createGraphifyToolDefinitions(client, config).find((tool) => tool.name === 'find_code')!

    const result = await query.execute(
      { question: 'Context' },
      { signal: new AbortController().signal }
    ) as { text: string }

    assert.match(result.text, /query_graph/)
    assert.match(result.text, /"depth":1/)
    assert.match(result.text, /"token_budget":600/)
    await client.dispose()
  })
})
