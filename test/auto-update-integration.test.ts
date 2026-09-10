import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Config } from '../src/config.ts'
import { GraphifyMcpClient } from '../src/client.ts'
import { createGraphifyToolDefinitions } from '../src/tools.ts'
import {
  checkGraphFreshness,
  writeGraphifyIndexMetadata,
  ProjectUpdateCoalescer,
} from '../src/freshness.ts'
import type { ResolvedProject } from '../src/types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serverPath = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs')

describe('Auto-Update and Freshness Integration', () => {
  it('automatically triggers update on stale graph, restores freshness, and skips second update', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auto-update-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: '1' }], links: [] }))

    // Initialize git repo
    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'file.ts'), 'export const a = 1')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'initial'], { cwd: tempDir })

    // Write initial index metadata
    writeGraphifyIndexMetadata(tempDir, graphJson)

    // Verify initially fresh
    const initialProject: ResolvedProject = {
      projectRoot: tempDir,
      graphJsonPath: graphJson,
      graphDir,
      hasGraph: true,
      mtimeMs: fs.statSync(graphJson).mtimeMs,
    }
    assert.equal(checkGraphFreshness(initialProject).state, 'fresh')

    // Modify a tracked file to induce staleness
    fs.writeFileSync(path.join(tempDir, 'file.ts'), 'export const a = 2')
    assert.equal(checkGraphFreshness(initialProject).state, 'stale')

    // Create a mock CLI that updates graph.json
    const mockCliPath = path.join(tempDir, 'mock-cli.mjs')
    let cliInvocations = 0
    const invocationLog = path.join(tempDir, 'cli.log')
    fs.writeFileSync(
      mockCliPath,
      `
import fs from 'node:fs'
fs.appendFileSync(${JSON.stringify(invocationLog)}, 'invoked\\n')
process.exit(0)
      `.trim()
    )

    const config = Config({
      cliCommand: process.execPath,
      cliArgs: [mockCliPath],
      command: process.execPath,
      args: [serverPath],
      toolMode: 'compact',
      freshness: { mode: 'auto', updateTimeoutMs: 5000 },
    })

    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [serverPath],
      cwd: tempDir,
    })

    const tools = createGraphifyToolDefinitions(client, config)
    const queryTool = tools.find((t) => t.name === 'query_graph')!

    const execContext = {
      signal: new AbortController().signal,
      agent: { session: { header: { cwd: tempDir } } },
    }

    try {
      await client.init()

      // First query: detects staleness, triggers auto-update via coalescer
      const res1 = (await queryTool.execute({ question: 'what is a?' }, execContext)) as any
      assert.ok(res1.text)

      // Verify mock CLI was invoked
      assert.ok(fs.existsSync(invocationLog))
      const log1 = fs.readFileSync(invocationLog, 'utf8').trim().split('\n')
      assert.equal(log1.length, 1, 'Coalescer should have executed CLI exactly once')

      // Second query: graph is now fresh, should NOT trigger another update
      const res2 = (await queryTool.execute({ question: 'what is a again?' }, execContext)) as any
      assert.ok(res2.text)

      const log2 = fs.readFileSync(invocationLog, 'utf8').trim().split('\n')
      assert.equal(log2.length, 1, 'Second query on fresh graph should not invoke CLI again')
    } finally {
      await client.dispose()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('prevents self-invalidation for custom graph paths inside repository', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-self-inval-'))
    const customOutDir = path.join(tempDir, 'docs', 'graph-data')
    fs.mkdirSync(customOutDir, { recursive: true })
    const customGraphPath = path.join(customOutDir, 'graph.json')
    fs.writeFileSync(customGraphPath, JSON.stringify({ nodes: [], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'main.ts'), 'export const main = true')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'commit'], { cwd: tempDir })

    try {
      writeGraphifyIndexMetadata(tempDir, customGraphPath)

      const project: ResolvedProject = {
        projectRoot: tempDir,
        graphJsonPath: customGraphPath,
        graphDir: customOutDir,
        hasGraph: true,
        mtimeMs: fs.statSync(customGraphPath).mtimeMs,
      }

      // Check 1: fresh
      const check1 = checkGraphFreshness(project)
      assert.equal(check1.state, 'fresh')

      // Simulate output files written by Graphify inside its output dir
      fs.writeFileSync(path.join(customOutDir, 'GRAPH_REPORT.md'), '# Report')
      fs.writeFileSync(path.join(customOutDir, 'stats.json'), '{}')

      // Check 2: must still be fresh (custom graph output files excluded from fingerprint)
      const check2 = checkGraphFreshness(project)
      assert.equal(check2.state, 'fresh')

      // Check 3: repeated checks remain fresh
      const check3 = checkGraphFreshness(project)
      assert.equal(check3.state, 'fresh')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
