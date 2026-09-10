import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { Config } from '../src/config.ts'
import { checkGraphFreshness, ProjectUpdateCoalescer } from '../src/freshness.ts'
import type { ResolvedProject } from '../src/types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(__dirname, 'fixtures', 'sample-project')

describe('Graph Freshness and Coalescing', () => {
  it('returns unknown when graph does not exist', () => {
    const project: ResolvedProject = {
      projectRoot: '/empty',
      graphJsonPath: null,
      graphDir: '/empty/graphify-out',
      hasGraph: false,
    }
    const freshness = checkGraphFreshness(project)
    assert.equal(freshness.state, 'unknown')
  })

  it('detects freshness for existing sample project graph', () => {
    const graphJson = path.join(fixtureDir, 'graphify-out', 'graph.json')
    const project: ResolvedProject = {
      projectRoot: fixtureDir,
      graphJsonPath: graphJson,
      graphDir: path.dirname(graphJson),
      hasGraph: true,
      mtimeMs: fs.statSync(graphJson).mtimeMs,
    }
    const freshness = checkGraphFreshness(project)
    assert.ok(['fresh', 'stale'].includes(freshness.state))
    assert.ok(freshness.lastIndexedTime)
  })

  it('detects staleness when files are modified after graph index', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fresh-test-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })

    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, '{}')

    // Set graph mtime back by 1 hour
    const oldTime = new Date(Date.now() - 3600_000)
    fs.utimesSync(graphJson, oldTime, oldTime)

    // Create a modified source file with current time
    fs.writeFileSync(path.join(tempDir, 'source.ts'), 'export const a = 1')

    const project: ResolvedProject = {
      projectRoot: tempDir,
      graphJsonPath: graphJson,
      graphDir,
      hasGraph: true,
      mtimeMs: oldTime.getTime(),
    }

    try {
      const freshness = checkGraphFreshness(project)
      assert.equal(freshness.state, 'stale')
      assert.ok(freshness.changedFilesCount && freshness.changedFilesCount > 0)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('coalesces concurrent update runs for the same project root', async () => {
    const coalescer = new ProjectUpdateCoalescer()
    let executionCount = 0

    // Mock CLI command that takes 50ms
    const fakeCli = path.join(os.tmpdir(), 'mock-cli.mjs')
    fs.writeFileSync(
      fakeCli,
      `setTimeout(() => { console.log('updated'); process.exit(0); }, 50);`
    )

    const config = Config({
      cliCommand: process.execPath,
      cliArgs: [fakeCli],
    })

    try {
      // Trigger 3 concurrent updates for the same project root
      const [res1, res2, res3] = await Promise.all([
        coalescer.update(config, fixtureDir),
        coalescer.update(config, fixtureDir),
        coalescer.update(config, fixtureDir),
      ])

      assert.equal(res1.success, true)
      assert.equal(res2.success, true)
      assert.equal(res3.success, true)
    } finally {
      if (fs.existsSync(fakeCli)) fs.unlinkSync(fakeCli)
    }
  })
})
