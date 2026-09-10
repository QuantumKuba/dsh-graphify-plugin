import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Config } from '../src/config.ts'
import { GraphifyMcpClient } from '../src/client.ts'
import { createGraphifyToolDefinitions } from '../src/tools.ts'
import { registerGraphifyCommand } from '../src/commands.ts'
import {
  checkGraphFreshness,
  writeGraphifyIndexMetadata,
  readGraphifyIndexMetadata,
  evaluateAutoUpdateEligibility,
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

  it('keeps graph stale and skips auto-update when non-code semantic files change (architecture.md)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-semantic-stale-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: '1' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'file.ts'), 'export const a = 1')
    fs.writeFileSync(path.join(tempDir, 'architecture.md'), '# Initial Architecture')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'initial'], { cwd: tempDir })

    const initialMeta = writeGraphifyIndexMetadata(tempDir, graphJson)!
    assert.ok(initialMeta)

    const project: ResolvedProject = {
      projectRoot: tempDir,
      graphJsonPath: graphJson,
      graphDir,
      hasGraph: true,
      mtimeMs: fs.statSync(graphJson).mtimeMs,
    }
    assert.equal(checkGraphFreshness(project).state, 'fresh')

    // Modify semantic doc file
    fs.writeFileSync(path.join(tempDir, 'architecture.md'), '# Revised Architecture')
    assert.equal(checkGraphFreshness(project).state, 'stale')

    const mockCliPath = path.join(tempDir, 'mock-cli.mjs')
    const invocationLog = path.join(tempDir, 'cli.log')
    fs.writeFileSync(
      mockCliPath,
      `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(invocationLog)}, 'invoked\\n')\nprocess.exit(0)\n`
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

      const res = (await queryTool.execute({ question: 'what is a?' }, execContext)) as any
      // Stale notice returned detailing non-code files requiring full refresh
      assert.match(res.text, /Notice: Graph is stale/i)
      assert.match(res.text, /non-code/i)
      assert.match(res.text, /architecture\.md/i)

      // CLI must NOT have been invoked
      assert.equal(fs.existsSync(invocationLog), false, 'Auto-updater must not be invoked for semantic changes')

      // Metadata on disk must NOT have advanced
      const currentMeta = readGraphifyIndexMetadata(tempDir, graphJson)!
      assert.equal(currentMeta.git?.workingTreeFingerprint, initialMeta.git?.workingTreeFingerprint)

      // Graph must remain stale
      assert.equal(checkGraphFreshness(project).state, 'stale')
    } finally {
      await client.dispose()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('keeps graph stale and skips auto-update when mixed code and non-code files change', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mixed-stale-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: '1' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'file.ts'), 'export const a = 1')
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# Readme')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'initial'], { cwd: tempDir })

    const initialMeta = writeGraphifyIndexMetadata(tempDir, graphJson)!

    // Modify both code and readme
    fs.writeFileSync(path.join(tempDir, 'file.ts'), 'export const a = 2')
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# Readme v2')

    const mockCliPath = path.join(tempDir, 'mock-cli.mjs')
    const invocationLog = path.join(tempDir, 'cli.log')
    fs.writeFileSync(
      mockCliPath,
      `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(invocationLog)}, 'invoked\\n')\nprocess.exit(0)\n`
    )

    const config = Config({
      cliCommand: process.execPath,
      cliArgs: [mockCliPath],
      command: process.execPath,
      args: [serverPath],
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
      const res = (await queryTool.execute({ question: 'query' }, execContext)) as any
      assert.match(res.text, /Notice: Graph is stale/i)
      assert.match(res.text, /README\.md/i)
      assert.equal(fs.existsSync(invocationLog), false, 'Coalescer must not run on mixed change set')
    } finally {
      await client.dispose()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('keeps graph stale and skips auto-update when unknown source types are added or modified', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unknown-stale-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: '1' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'main.ts'), 'export const a = 1')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'initial'], { cwd: tempDir })

    writeGraphifyIndexMetadata(tempDir, graphJson)

    // Add untracked unknown file type
    fs.writeFileSync(path.join(tempDir, 'script.xyz'), 'echo hello')

    const mockCliPath = path.join(tempDir, 'mock-cli.mjs')
    const invocationLog = path.join(tempDir, 'cli.log')
    fs.writeFileSync(
      mockCliPath,
      `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(invocationLog)}, 'invoked\\n')\nprocess.exit(0)\n`
    )

    const config = Config({
      cliCommand: process.execPath,
      cliArgs: [mockCliPath],
      command: process.execPath,
      args: [serverPath],
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
      const res = (await queryTool.execute({ question: 'query' }, execContext)) as any
      assert.match(res.text, /Notice: Graph is stale/i)
      assert.match(res.text, /script\.xyz/i)
      assert.equal(fs.existsSync(invocationLog), false, 'Unknown extension must not trigger auto-update')
    } finally {
      await client.dispose()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('correctly handles code and non-code file renames and deletions', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rename-del-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'foo.ts'), 'export const foo = 1')
    fs.writeFileSync(path.join(tempDir, 'bar.ts'), 'export const bar = 2')
    fs.writeFileSync(path.join(tempDir, 'doc.md'), '# Doc')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'initial'], { cwd: tempDir })

    writeGraphifyIndexMetadata(tempDir, graphJson)

    const project: ResolvedProject = {
      projectRoot: tempDir,
      graphJsonPath: graphJson,
      graphDir,
      hasGraph: true,
      mtimeMs: fs.statSync(graphJson).mtimeMs,
    }

    try {
      // Case 1: Delete code file (bar.ts) -> eligible
      fs.unlinkSync(path.join(tempDir, 'bar.ts'))
      const elig1 = evaluateAutoUpdateEligibility(project)
      assert.equal(elig1.kind, 'eligible')

      // Restore bar.ts
      spawnSync('git', ['checkout', 'bar.ts'], { cwd: tempDir })

      // Case 2: Delete semantic file (doc.md) -> requires-full-refresh
      fs.unlinkSync(path.join(tempDir, 'doc.md'))
      const elig2 = evaluateAutoUpdateEligibility(project)
      assert.equal(elig2.kind, 'requires-full-refresh')
      assert.match(elig2.reason, /doc\.md/)

      // Restore doc.md
      spawnSync('git', ['checkout', 'doc.md'], { cwd: tempDir })

      // Case 3: Rename code file foo.ts -> baz.ts -> eligible
      fs.renameSync(path.join(tempDir, 'foo.ts'), path.join(tempDir, 'baz.ts'))
      const elig3 = evaluateAutoUpdateEligibility(project)
      assert.equal(elig3.kind, 'eligible')

      // Restore foo.ts
      spawnSync('git', ['checkout', '.'], { cwd: tempDir })
      fs.rmSync(path.join(tempDir, 'baz.ts'), { force: true })

      // Case 4: Rename doc.md -> doc.txt -> requires-full-refresh
      fs.renameSync(path.join(tempDir, 'doc.md'), path.join(tempDir, 'doc.txt'))
      const elig4 = evaluateAutoUpdateEligibility(project)
      assert.equal(elig4.kind, 'requires-full-refresh')

      // Restore doc.md
      spawnSync('git', ['checkout', '.'], { cwd: tempDir })
      fs.rmSync(path.join(tempDir, 'doc.txt'), { force: true })

      // Case 5: Rename foo.ts -> foo.md -> requires-full-refresh
      fs.renameSync(path.join(tempDir, 'foo.ts'), path.join(tempDir, 'foo.md'))
      const elig5 = evaluateAutoUpdateEligibility(project)
      assert.equal(elig5.kind, 'requires-full-refresh')

      // Restore foo.ts
      spawnSync('git', ['checkout', '.'], { cwd: tempDir })
      fs.rmSync(path.join(tempDir, 'foo.md'), { force: true })

      // Case 6: Rename doc.md -> doc.ts -> requires-full-refresh (old was semantic doc)
      fs.renameSync(path.join(tempDir, 'doc.md'), path.join(tempDir, 'doc.ts'))
      const elig6 = evaluateAutoUpdateEligibility(project)
      assert.equal(elig6.kind, 'requires-full-refresh')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('rejects auto-update for custom graphPath and preserves metadata invariance across canonical /graphify updates', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-custom-reject-'))
    const customGraphDir = path.join(tempDir, 'custom-out')
    fs.mkdirSync(customGraphDir, { recursive: true })
    const customGraphPath = path.join(customGraphDir, 'graph.json')
    fs.writeFileSync(customGraphPath, JSON.stringify({ nodes: [{ id: 'custom' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'index.ts'), 'export const x = 1')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'initial'], { cwd: tempDir })

    // Write initial metadata beside custom graph
    const initialCustomMeta = writeGraphifyIndexMetadata(tempDir, customGraphPath)!

    // Modify index.ts to induce staleness
    fs.writeFileSync(path.join(tempDir, 'index.ts'), 'export const x = 2')

    const mockCliPath = path.join(tempDir, 'mock-cli.mjs')
    const invocationLog = path.join(tempDir, 'cli.log')
    fs.writeFileSync(
      mockCliPath,
      `
import fs from 'node:fs'
import path from 'node:path'
fs.appendFileSync(${JSON.stringify(invocationLog)}, 'invoked\\n')
// When Graphify runs build/update, it writes to canonical graphify-out/graph.json
const canDir = path.join(${JSON.stringify(tempDir)}, 'graphify-out')
fs.mkdirSync(canDir, { recursive: true })
fs.writeFileSync(path.join(canDir, 'graph.json'), JSON.stringify({ nodes: [{ id: 'canonical' }], links: [] }))
process.exit(0)
      `.trim()
    )

    const config = Config({
      cliCommand: process.execPath,
      cliArgs: [mockCliPath],
      command: process.execPath,
      args: [serverPath],
      graphPath: 'custom-out/graph.json',
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

      // 1. Query tool on custom graphPath: update should be rejected (unsupported-target)
      const res1 = (await queryTool.execute({ question: 'query' }, execContext)) as any
      assert.match(res1.text, /Notice: Graph is stale/i)
      assert.match(res1.text, /not the canonical project graph/i)
      assert.equal(fs.existsSync(invocationLog), false, 'Updater must not be invoked for custom graphPath')

      // Custom metadata must NOT have advanced
      const customMetaAfter = readGraphifyIndexMetadata(tempDir, customGraphPath)!
      assert.equal(customMetaAfter.git?.workingTreeFingerprint, initialCustomMeta.git?.workingTreeFingerprint)

      // 2. Now run /graphify update command
      const ctx = new Context()
      ctx.provide('commands')
      let registeredCommand: any
      ctx.commands = { register(def: any) { registeredCommand = def; return () => {} } }
      registerGraphifyCommand(ctx, config, tempDir)

      const cmdResult = await registeredCommand.handler({
        rawInput: 'update .',
        agent: { session: { header: { cwd: tempDir } } },
        signal: new AbortController().signal,
      })
      assert.equal(cmdResult.kind, 'success')

      // Canonical graph was created and canonical metadata recorded beside it
      const canonicalGraphPath = path.join(tempDir, 'graphify-out', 'graph.json')
      assert.ok(fs.existsSync(canonicalGraphPath))
      const canonicalMeta = readGraphifyIndexMetadata(tempDir, canonicalGraphPath)
      assert.ok(canonicalMeta, 'Canonical graph must have metadata')

      // But configured custom graph metadata was NOT updated and custom graph remains stale!
      const customMetaFinal = readGraphifyIndexMetadata(tempDir, customGraphPath)!
      assert.equal(customMetaFinal.git?.workingTreeFingerprint, initialCustomMeta.git?.workingTreeFingerprint)
    } finally {
      await client.dispose()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('supports full multi-turn coding agent workflow with accurate updates and query freshness', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workflow-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: 'init' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'A.ts'), 'export const A = 1')
    fs.writeFileSync(path.join(tempDir, 'B.ts'), 'export const B = 1')
    fs.writeFileSync(path.join(tempDir, 'C.ts'), 'export const C = 1')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'initial'], { cwd: tempDir })

    writeGraphifyIndexMetadata(tempDir, graphJson)

    const mockCliPath = path.join(os.tmpdir(), `dsh-mock-cli-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
    const invocationLog = path.join(os.tmpdir(), `dsh-cli-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
    fs.writeFileSync(
      mockCliPath,
      `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(invocationLog)}, 'update\\n')\nprocess.exit(0)\n`
    )

    const config = Config({
      cliCommand: process.execPath,
      cliArgs: [mockCliPath],
      command: process.execPath,
      args: [serverPath],
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

      // Turn 1: Agent edits B.ts
      fs.writeFileSync(path.join(tempDir, 'B.ts'), 'export const B = 2')

      // Query 1: graph is stale -> auto-updates B -> fresh
      const res1 = (await queryTool.execute({ question: 'inspect B' }, execContext)) as any
      assert.ok(res1.text)
      assert.ok(!res1.text.includes('Notice: Graph is stale'))

      let log = fs.readFileSync(invocationLog, 'utf8').trim().split('\n')
      assert.equal(log.length, 1, 'Turn 1 update should have executed once')

      // Turn 2: Agent stages changes (git add B.ts) -> still fresh -> query executes without update
      spawnSync('git', ['add', 'B.ts'], { cwd: tempDir })
      const res2 = (await queryTool.execute({ question: 'inspect B again' }, execContext)) as any
      assert.ok(res2.text)
      assert.ok(!res2.text.includes('Notice: Graph is stale'))

      log = fs.readFileSync(invocationLog, 'utf8').trim().split('\n')
      assert.equal(log.length, 1, 'Turn 2 query on staged fresh graph should not invoke updater')

      // Turn 3: Agent edits C.ts -> stale -> query triggers update -> fresh
      fs.writeFileSync(path.join(tempDir, 'C.ts'), 'export const C = 2')
      const res3 = (await queryTool.execute({ question: 'inspect C' }, execContext)) as any
      assert.ok(res3.text)
      assert.ok(!res3.text.includes('Notice: Graph is stale'))

      log = fs.readFileSync(invocationLog, 'utf8').trim().split('\n')
      assert.equal(log.length, 2, 'Turn 3 update should have executed exactly once')
    } finally {
      await client.dispose()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
