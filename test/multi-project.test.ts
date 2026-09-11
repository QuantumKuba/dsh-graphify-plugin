import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { Config } from '../src/config.ts'
import { GraphifyMcpClient } from '../src/client.ts'
import { createGraphifyToolDefinitions } from '../src/tools.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serverPath = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs')

describe('Multi-Project Resource Isolation', () => {
  it('isolates graphify_project_resource calls across concurrent sessions without leakage', async () => {
    const tempDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proj-a-'))
    const tempDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proj-b-'))

    const graphDirA = path.join(tempDirA, 'graphify-out')
    const graphDirB = path.join(tempDirB, 'graphify-out')
    fs.mkdirSync(graphDirA, { recursive: true })
    fs.mkdirSync(graphDirB, { recursive: true })
    fs.mkdirSync(path.join(graphDirA, 'wiki'), { recursive: true })
    fs.mkdirSync(path.join(graphDirB, 'wiki'), { recursive: true })

    fs.writeFileSync(path.join(graphDirA, 'graph.json'), JSON.stringify({ nodes: [1, 2], links: [1] }))
    fs.writeFileSync(path.join(graphDirB, 'graph.json'), JSON.stringify({ nodes: [1, 2, 3, 4], links: [1, 2, 3] }))

    fs.writeFileSync(path.join(graphDirA, 'GRAPH_REPORT.md'), '# Architecture Report for Project Alpha\nConfidential A')
    fs.writeFileSync(path.join(graphDirB, 'GRAPH_REPORT.md'), '# Architecture Report for Project Beta\nConfidential B')

    fs.writeFileSync(path.join(graphDirA, 'wiki', 'index.md'), '# Wiki Alpha')
    fs.writeFileSync(path.join(graphDirB, 'wiki', 'index.md'), '# Wiki Beta')

    const config = Config({
      command: process.execPath,
      args: [serverPath],
      toolMode: 'full',
    })
    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [serverPath],
      cwd: tempDirA,
    })

    const tools = createGraphifyToolDefinitions(client, config)
    const resourceTool = tools.find((t) => t.name === 'graphify_project_resource')
    assert.ok(resourceTool, 'graphify_project_resource must be registered')

    try {
      // 1. Session A reads report
      const execA = {
        signal: new AbortController().signal,
        agent: { session: { header: { cwd: tempDirA } } },
      }
      const resultA = await resourceTool.execute({ resource: 'report' }, execA)
      assert.match(resultA.text, /Architecture Report for Project Alpha/)
      assert.match(resultA.text, /Confidential A/)
      assert.ok(!resultA.text.includes('Beta'))

      // 2. Session B reads report
      const execB = {
        signal: new AbortController().signal,
        agent: { session: { header: { cwd: tempDirB } } },
      }
      const resultB = await resourceTool.execute({ resource: 'report' }, execB)
      assert.match(resultB.text, /Architecture Report for Project Beta/)
      assert.match(resultB.text, /Confidential B/)
      assert.ok(!resultB.text.includes('Alpha'))

      // 3. Session A reads wiki
      const wikiA = await resourceTool.execute({ resource: 'wiki' }, execA)
      assert.match(wikiA.text, /Wiki Alpha/)

      // 4. Session B reads wiki
      const wikiB = await resourceTool.execute({ resource: 'wiki' }, execB)
      assert.match(wikiB.text, /Wiki Beta/)

      // 5. Stats isolation
      const statsA = await resourceTool.execute({ resource: 'stats' }, execA)
      assert.match(statsA.text, /Nodes: 2/)
      assert.match(statsA.text, /Edges: 1/)

      const statsB = await resourceTool.execute({ resource: 'stats' }, execB)
      assert.match(statsB.text, /Nodes: 4/)
      assert.match(statsB.text, /Edges: 3/)

      // 6. Explicit project_path outside session workspace is blocked by default (allowExternalProjects: false)
      const blockedResult = await resourceTool.execute({ resource: 'report', project_path: tempDirB }, execA)
      assert.equal(blockedResult.isError, true)
      assert.match(blockedResult.text, /Access to external project path.*is blocked/i)

      // 6b. With allowExternalProjects: true, external project_path is permitted
      const externalConfig = Config({
        command: process.execPath,
        args: [serverPath],
        toolMode: 'full',
        allowExternalProjects: true,
      })
      const externalTools = createGraphifyToolDefinitions(client, externalConfig)
      const externalResourceTool = externalTools.find((t) => t.name === 'graphify_project_resource')!
      const overrideResult = await externalResourceTool.execute({ resource: 'report', project_path: tempDirB }, execA)
      assert.match((overrideResult as { text: string }).text, /Architecture Report for Project Beta/)

      // 7. Unknown resource type returns error
      const unknownResult = await resourceTool.execute({ resource: 'unsupported_resource' }, execA)
      assert.equal(unknownResult.isError, true)
      assert.match(unknownResult.text, /Unknown resource type: unsupported_resource/i)
    } finally {
      await client.dispose()
      fs.rmSync(tempDirA, { recursive: true, force: true })
      fs.rmSync(tempDirB, { recursive: true, force: true })
    }
  })

  it('rejects symlink traversals escaping the graph directory boundary and non-regular files', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-symlink-test-'))
    const outsideSecret = path.join(tempDir, 'outside-secret.txt')
    fs.writeFileSync(outsideSecret, 'SUPER_SECRET_TOKEN')

    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    fs.writeFileSync(path.join(graphDir, 'graph.json'), JSON.stringify({ nodes: [], links: [] }))

    // 1. File symlink: GRAPH_REPORT.md -> outsideSecret
    const reportLink = path.join(graphDir, 'GRAPH_REPORT.md')
    fs.symlinkSync(outsideSecret, reportLink)

    const config = Config({
      command: process.execPath,
      args: [serverPath],
      toolMode: 'full',
    })
    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [serverPath],
      cwd: tempDir,
    })

    const tools = createGraphifyToolDefinitions(client, config)
    const resourceTool = tools.find((t) => t.name === 'graphify_project_resource')!

    const execContext = {
      signal: new AbortController().signal,
      agent: { session: { header: { cwd: tempDir } } },
    }

    try {
      // Should reject report pointing outside graphDir
      const reportRes = await resourceTool.execute({ resource: 'report' }, execContext)
      assert.equal(reportRes.isError, true)
      assert.match(reportRes.text, /escapes graph directory boundary/i)
      assert.ok(!reportRes.text.includes('SUPER_SECRET_TOKEN'))

      // 2. Directory symlink: wiki/ points to outside directory containing index.md
      const outsideWiki = path.join(tempDir, 'outside-wiki')
      fs.mkdirSync(outsideWiki, { recursive: true })
      fs.writeFileSync(path.join(outsideWiki, 'index.md'), 'Outside Wiki Content')
      fs.symlinkSync(outsideWiki, path.join(graphDir, 'wiki'))

      const wikiRes = await resourceTool.execute({ resource: 'wiki' }, execContext)
      assert.equal(wikiRes.isError, true)
      assert.match(wikiRes.text, /escapes graph directory boundary/i)
      assert.ok(!wikiRes.text.includes('Outside Wiki Content'))

      // 3. Non-regular file: wiki/index.md is a directory instead of a file
      fs.rmSync(path.join(graphDir, 'wiki'), { recursive: true, force: true })
      fs.mkdirSync(path.join(graphDir, 'wiki', 'index.md'), { recursive: true })

      const dirRes = await resourceTool.execute({ resource: 'wiki' }, execContext)
      assert.equal(dirRes.isError, true)
      assert.match(dirRes.text, /not a regular file/i)

      // 4. Stats resource: symlinked graph.json escaping graphDir boundary
      const outsideGraph = path.join(tempDir, 'outside-graph.json')
      fs.writeFileSync(outsideGraph, JSON.stringify({ nodes: [1, 2], links: [] }))
      fs.unlinkSync(path.join(graphDir, 'graph.json'))
      fs.symlinkSync(outsideGraph, path.join(graphDir, 'graph.json'))

      const statsEscapeRes = await resourceTool.execute({ resource: 'stats' }, execContext)
      assert.equal(statsEscapeRes.isError, true)
      assert.match(statsEscapeRes.text, /escapes graph directory boundary/i)

      // 5. Stats resource: non-regular file (graph.json is a directory)
      fs.unlinkSync(path.join(graphDir, 'graph.json'))
      fs.mkdirSync(path.join(graphDir, 'graph.json'))

      const statsDirRes = await resourceTool.execute({ resource: 'stats' }, execContext)
      assert.equal(statsDirRes.isError, true)
      assert.match(statsDirRes.text, /not a regular file/i)
    } finally {
      await client.dispose()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
