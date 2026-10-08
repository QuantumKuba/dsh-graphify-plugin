import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { boundResultText } from '../src/result-budget.ts'
import { Config, validateConfig } from '../src/config.ts'
import { createGraphifyToolDefinitions } from '../src/tools.ts'
import type { GraphifyMcpClient } from '../src/client.ts'

describe('Model-visible result limits', () => {
  it('keeps short results and bounds long Unicode results with an explicit notice', () => {
    assert.equal(boundResultText('src/router.ts:42', 256), 'src/router.ts:42')
    for (const text of ['x'.repeat(9000), '😀'.repeat(9000), '节点\n'.repeat(9000)]) {
      const result = boundResultText(text, 256)
      assert.ok(result.length <= 256)
      assert.match(result, /Truncated/)
      assert.ok(result.isWellFormed())
    }
  })

  it('rejects invalid deployment limits', () => {
    for (const resultMaxChars of [0, 255, 1.5, Infinity, NaN]) {
      assert.throws(() => validateConfig(Config({ resultMaxChars })), /resultMaxChars/)
    }
  })

  it('bounds get_node, paths and escape calls even when upstream ignores budgets, preserving raw metadata', async () => {
    const text = 'NODE Layer.match [src=lib/router/layer.js loc=L110]\n' + 'edge\n'.repeat(3000)
    const client = {
      callTool: async () => ({ content: [{ type: 'text', text }] }),
    } as unknown as GraphifyMcpClient
    const tools = createGraphifyToolDefinitions(client, Config({ toolMode: 'full', resultMaxChars: 256, freshness: { mode: 'off' } }))
    for (const name of ['query_graph', 'get_node', 'get_neighbors', 'shortest_path', 'graphify_call']) {
      const result = await tools.find(t => t.name === name)!.execute(
        { name: 'get_node', label: 'Layer.match' }, { signal: new AbortController().signal }
      ) as { text: string; meta: { content: { text: string }[] } }
      assert.ok(result.text.length <= 256)
      assert.match(result.text, /lib\/router\/layer.js/)
      assert.match(result.text, /Truncated/)
      assert.equal(result.meta.content[0].text, text)
    }
  })

  it('keeps compact controls focused and full mode operational overrides available', () => {
    const client = {} as GraphifyMcpClient
    const compact = createGraphifyToolDefinitions(client, Config({}))
    const full = createGraphifyToolDefinitions(client, Config({ toolMode: 'full' }))
    assert.deepEqual(compact.map(tool => tool.name), ['find_code'])
    assert.deepEqual(Object.keys(compact[0].parameters?.properties || {}), ['question'])
    assert.ok(full.find(t => t.name === 'query_graph')?.parameters?.properties?.project_path)
    const serialize = (tools: typeof compact) => JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters })))
    assert.ok(serialize(compact).length < 500, 'Compact schema regression budget')
  })

  it('recovers qualified symbol misses once in the same project and preserves uncertainty', async () => {
    const calls: { name: string; args: Record<string, unknown>; signal: unknown }[] = []
    const signal = new AbortController().signal
    const client = {
      callTool: async (name: string, args: Record<string, unknown>, signal: unknown) => {
        calls.push({ name, args, signal })
        return { content: [{ type: 'text', text: name === 'get_node'
          ? "No node matching 'layer.match' found."
          : 'NODE .match() [src=lib/router/layer.js loc=L110]' }] }
      },
    } as unknown as GraphifyMcpClient
    const node = createGraphifyToolDefinitions(client, Config({ toolMode: 'full', freshness: { mode: 'off' } })).find(t => t.name === 'get_node')!
    const result = await node.execute({ label: 'Layer.match' }, { signal }) as { text: string }
    assert.equal(result.text, "No node matching 'layer.match' found.\nSearch candidates (not an exact match; verify in source):\nNODE .match() [src=lib/router/layer.js loc=L110]")
    assert.deepEqual(calls.map(c => c.name), ['get_node', 'query_graph'])
    assert.equal(calls[1].args.project_path, calls[0].args.project_path)
    assert.equal(calls[1].args.depth, 1)
    assert.equal(calls[1].args.token_budget, 800)
    assert.equal(calls[1].signal, signal)
  })

  it('does not retry errors, exact matches or unknown upstream response formats', async () => {
    for (const response of [
      { text: "No node matching 'x' found.", isError: true },
      { text: 'NODE x [src=x.ts loc=L1]', isError: false },
      { text: 'Unknown response', isError: false },
    ]) {
      let calls = 0
      const client = { callTool: async () => { calls++; return { content: [{ type: 'text', text: response.text }], isError: response.isError } } } as unknown as GraphifyMcpClient
      const node = createGraphifyToolDefinitions(client, Config({ toolMode: 'full', freshness: { mode: 'off' } })).find(t => t.name === 'get_node')!
      const result = await node.execute({ label: 'x' }, { signal: new AbortController().signal }) as { text: string }
      assert.equal(calls, 1)
      assert.equal(result.text, response.text)
    }
  })
})
