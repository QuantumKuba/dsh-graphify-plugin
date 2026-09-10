import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { Config } from '../src/config.ts'
import { GraphifyMcpClient } from '../src/client.ts'
import { ProjectResolver } from '../src/project-resolver.ts'
import { collectGraphifyStatus, formatGraphifyStatus } from '../src/status.ts'
import { writeGraphifyIndexMetadata } from '../src/freshness.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(__dirname, 'fixtures', 'sample-project')
const serverPath = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs')

describe('graphify_status doctor tool', () => {
  it('collects and formats healthy status for fixture project with graph', async () => {
    const config = Config({
      command: process.execPath,
      args: [serverPath],
      cwd: fixtureDir,
    })
    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [serverPath],
      cwd: fixtureDir,
    })
    const resolver = new ProjectResolver(config)

    try {
      await client.init()
      const project = resolver.resolve({ explicitPath: fixtureDir })

      // Write matching metadata to ensure freshness is clean
      writeGraphifyIndexMetadata(fixtureDir)

      const status = await collectGraphifyStatus(project, client, config)

      assert.equal(status.overall, 'healthy')
      assert.equal(status.projectRoot, fixtureDir)
      assert.equal(status.graphExists, true)
      assert.ok(status.nodeCount && status.nodeCount > 0)
      assert.ok(status.edgeCount && status.edgeCount > 0)
      assert.equal(status.mcp.state, 'connected')

      const formatted = formatGraphifyStatus(status)
      assert.ok(formatted.includes('Graphify Status: HEALTHY'))
      assert.ok(formatted.includes('Graph is verified, connected, and ready'))
    } finally {
      const metaPath = path.join(fixtureDir, 'graphify-out', '.dsh-graphify-index.json')
      if (fs.existsSync(metaPath)) {
        try { fs.unlinkSync(metaPath) } catch {}
      }
      await client.dispose()
    }
  })

  it('reports unprobed when MCP client has not been initialized and probe=false', async () => {
    const config = Config({
      command: process.execPath,
      args: [serverPath],
      cwd: fixtureDir,
    })
    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [serverPath],
      cwd: fixtureDir,
    })
    const resolver = new ProjectResolver(config)

    try {
      const project = resolver.resolve({ explicitPath: fixtureDir })
      const status = await collectGraphifyStatus(project, client, config, { probe: false })

      assert.equal(status.overall, 'unprobed')
      assert.equal(status.mcp.state, 'disconnected')

      const formatted = formatGraphifyStatus(status)
      assert.ok(formatted.includes('Graphify Status: UNPROBED'))
      assert.ok(!formatted.includes('Graph is verified, connected, and ready'))
      assert.ok(formatted.includes('MCP server has not been probed yet'))
    } finally {
      await client.dispose()
    }
  })

  it('reports error when MCP server connection fails', async () => {
    const config = Config({
      command: 'non_existent_executable_12345',
      cwd: fixtureDir,
    })
    const client = new GraphifyMcpClient({
      command: 'non_existent_executable_12345',
      args: [],
      cwd: fixtureDir,
    })
    const resolver = new ProjectResolver(config)

    try {
      const project = resolver.resolve({ explicitPath: fixtureDir })
      const status = await collectGraphifyStatus(project, client, config, { probe: true })

      assert.equal(status.overall, 'error')
      assert.equal(status.mcp.state, 'error')

      const formatted = formatGraphifyStatus(status)
      assert.ok(formatted.includes('Graphify Status: ERROR'))
      assert.ok(!formatted.includes('Graph is verified, connected, and ready'))
      assert.ok(formatted.includes('Recommendation: Graphify MCP server encountered an error'))
    } finally {
      await client.dispose()
    }
  })

  it('collects missing status when graph.json is absent', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-no-graph-'))
    const config = Config({ cwd: tempDir })
    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [serverPath],
      cwd: tempDir,
    })
    const resolver = new ProjectResolver(config)

    try {
      const project = resolver.resolve({ explicitPath: tempDir })
      const status = await collectGraphifyStatus(project, client, config)

      assert.equal(status.overall, 'missing')
      assert.equal(status.graphExists, false)
      assert.equal(status.nodeCount, null)

      const formatted = formatGraphifyStatus(status)
      assert.ok(formatted.includes('Graphify Status: MISSING'))
      assert.ok(formatted.includes('Recommendation: Graph is missing'))
    } finally {
      await client.dispose()
    }
  })

  it('reports stale status when graph is stale despite active MCP connection', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stale-status-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: '1' }], links: [] }), 'utf8')

    // Set graph mtime to past
    const past = new Date(Date.now() - 60000)
    fs.utimesSync(graphJson, past, past)

    // Create a modified file newer than graph
    fs.writeFileSync(path.join(tempDir, 'modified.ts'), 'export const x = 1', 'utf8')

    const config = Config({
      command: process.execPath,
      args: [serverPath],
      cwd: tempDir,
    })
    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [serverPath],
      cwd: tempDir,
    })
    const resolver = new ProjectResolver(config)

    try {
      await client.init()
      const project = resolver.resolve({ explicitPath: tempDir })
      const status = await collectGraphifyStatus(project, client, config)

      assert.equal(status.overall, 'stale')
      assert.equal(status.mcp.state, 'connected')

      const formatted = formatGraphifyStatus(status)
      assert.ok(formatted.includes('Graphify Status: STALE'))
      assert.ok(formatted.includes('Recommendation: Graph is stale'))
      assert.ok(!formatted.includes('Graph is verified, connected, and ready'))
    } finally {
      await client.dispose()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
