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

  it('verifies upstream tool schemas have no breaking drift', async (context) => {
    if (process.env.GRAPHIFY_E2E !== '1') {
      context.skip('set GRAPHIFY_E2E=1 after installing graphifyy[mcp]')
      return
    }

    const { compareToolSchemas } = await import('../src/schema-drift.ts')
    const { createGraphifyToolDefinitions } = await import('../src/tools.ts')

    const config = Config({ command: 'auto' })
    const resolved = resolveGraphifyCommand(config, graphPath)
    const client = new GraphifyMcpClient({ ...resolved, cwd: fixtureDir, timeoutMs: 30_000 })
    try {
      const upstreamTools = await client.listTools()
      const nativeTools = createGraphifyToolDefinitions(client, config)
      const report = compareToolSchemas(nativeTools, upstreamTools)
      console.log(report.summary)
      assert.equal(report.hasBreakingDrift, false, `Breaking drift detected:\n${report.summary}`)
    } finally {
      await client.dispose()
    }
  })

  it('validates dirty indexing, incremental update, and false-fresh refusal with real Graphify CLI', async (context) => {
    if (process.env.GRAPHIFY_E2E !== '1') {
      context.skip('set GRAPHIFY_E2E=1 after installing graphifyy[mcp]')
      return
    }

    const { spawnSync } = await import('node:child_process')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const { Context } = await import('@deepseek-ai/cordis')
    const { registerGraphifyCommand } = await import('../src/commands.ts')
    const { createGraphifyToolDefinitions } = await import('../src/tools.ts')
    const {
      readGraphifyIndexMetadata,
      checkGraphFreshness,
      evaluateAutoUpdateEligibility,
    } = await import('../src/freshness.ts')
    const typeModule = await import('../src/types.ts')

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-real-e2e-'))
    const graphJson = path.join(tempDir, 'graphify-out', 'graph.json')

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

    // Create initial repo with a python file and a markdown file
    fs.writeFileSync(path.join(tempDir, 'calc.py'), 'def add(a, b):\n    return a + b\n')
    fs.writeFileSync(path.join(tempDir, 'notes.md'), '# Calculator Notes\nExplains calc.py\n')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tempDir })

    // Dirty working tree before build: edit calc.py to B
    fs.writeFileSync(path.join(tempDir, 'calc.py'), 'def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n')

    const config = Config({ command: 'auto', cliCommand: 'graphify' })
    const ctx = new Context()
    let command: CommandDefinition | undefined
    ctx.provide('commands')
    ctx.commands = { register(def: CommandDefinition) { command = def; return () => {} } }
    registerGraphifyCommand(ctx, config, tempDir)

    try {
      // 1. Build graph from dirty working tree using real /graphify build .
      const buildRes = await command!.handler({
        rawInput: 'build . --no-viz --no-cluster --code-only',
        agent: { session: { header: { cwd: tempDir } } },
        signal: new AbortController().signal,
      })
      assert.equal(buildRes.kind, 'success', `Build failed: ${buildRes.kind === 'error' ? buildRes.text : ''}`)
      assert.ok(fs.existsSync(graphJson))

      const project = {
        projectRoot: tempDir,
        graphJsonPath: graphJson,
        graphDir: path.dirname(graphJson),
        hasGraph: true,
        mtimeMs: fs.statSync(graphJson).mtimeMs,
      }

      // Checkpoint must be v3 and FRESH on dirty working tree
      const meta = readGraphifyIndexMetadata(tempDir, graphJson)
      assert.ok(meta)
      assert.equal(meta.version, 3)
      assert.equal(checkGraphFreshness(project).state, 'fresh')

      // 2. Perform safe code-only modification: add multiply function to calc.py
      fs.writeFileSync(
        path.join(tempDir, 'calc.py'),
        'def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n\ndef mul(a, b):\n    return a * b\n'
      )
      assert.equal(checkGraphFreshness(project).state, 'stale')
      const elig = evaluateAutoUpdateEligibility(project)
      assert.equal(elig.kind, 'eligible')

      // 3. Run incremental update with real Graphify
      const updateRes = await command!.handler({
        rawInput: 'update . --no-cluster',
        agent: { session: { header: { cwd: tempDir } } },
        signal: new AbortController().signal,
      })
      assert.equal(updateRes.kind, 'success')
      assert.ok(!updateRes.text?.includes('Note:'))

      // Must be fresh again after valid code update
      project.mtimeMs = fs.statSync(graphJson).mtimeMs
      assert.equal(checkGraphFreshness(project).state, 'fresh')

      // 4. Test querying the real graph via MCP client
      const resolvedMcp = resolveGraphifyCommand(config, graphJson)
      const client = new GraphifyMcpClient({ ...resolvedMcp, cwd: tempDir, timeoutMs: 30_000 })
      try {
        await client.init()
        const tools = createGraphifyToolDefinitions(client, config)
        const queryTool = tools.find((t) => t.name === 'query_graph')!
        const queryRes = (await queryTool.execute(
          { question: 'add' },
          { signal: new AbortController().signal, agent: { session: { header: { cwd: tempDir } } } }
        )) as any
        assert.equal(queryRes.isError ?? false, false)
        assert.ok(queryRes.text.length > 0)
      } finally {
        await client.dispose()
      }

      // 5. Modify semantic document notes.md
      fs.writeFileSync(path.join(tempDir, 'notes.md'), '# Updated Calculator Notes\nNew architecture.\n')
      assert.equal(checkGraphFreshness(project).state, 'stale')
      const docElig = evaluateAutoUpdateEligibility(project)
      assert.equal(docElig.kind, 'requires-full-refresh')

      // 6. Run /graphify update . -> must succeed as command but REFUSE to advance freshness checkpoint
      const docUpdateRes = await command!.handler({
        rawInput: 'update . --no-cluster',
        agent: { session: { header: { cwd: tempDir } } },
        signal: new AbortController().signal,
      })
      assert.equal(docUpdateRes.kind, 'success')
      assert.match(docUpdateRes.text || '', /Semantic or unsupported source changes were detected/i)
      assert.match(docUpdateRes.text || '', /Freshness checkpoint was not advanced/i)

      // Graph must remain STALE (no false-fresh!)
      assert.equal(checkGraphFreshness(project).state, 'stale')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
