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
      const status = collectGraphifyStatus(project, client, config)

      assert.ok(['healthy', 'stale'].includes(status.overall))
      assert.equal(status.projectRoot, fixtureDir)
      assert.equal(status.graphExists, true)
      assert.ok(status.nodeCount && status.nodeCount > 0)
      assert.ok(status.edgeCount && status.edgeCount > 0)
      assert.equal(status.mcp.state, 'connected')

      const formatted = formatGraphifyStatus(status)
      assert.ok(formatted.includes('Graphify Status:'))
      assert.ok(formatted.includes(fixtureDir))
      assert.ok(formatted.includes('nodes'))
      assert.ok(formatted.includes('MCP State: connected'))
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
      const status = collectGraphifyStatus(project, client, config)

      assert.equal(status.overall, 'missing')
      assert.equal(status.graphExists, false)
      assert.equal(status.nodeCount, null)

      const formatted = formatGraphifyStatus(status)
      assert.ok(formatted.includes('Graphify Status: MISSING'))
      assert.ok(formatted.includes('Recommendation: Run `/graphify`'))
    } finally {
      await client.dispose()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
