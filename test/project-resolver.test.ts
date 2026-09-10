import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { Config } from '../src/config.ts'
import { ProjectResolver } from '../src/project-resolver.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(__dirname, 'fixtures', 'sample-project')

describe('ProjectResolver (session-scoped resolution)', () => {
  it('resolves explicit project_path argument with highest precedence', () => {
    const config = Config({ cwd: '/configured/fallback' })
    const resolver = new ProjectResolver(config)

    const resolved = resolver.resolve({
      explicitPath: fixtureDir,
      agentCwd: '/some/unrelated/session/cwd',
    })

    assert.equal(resolved.projectRoot, fixtureDir)
    assert.equal(resolved.hasGraph, true)
    assert.ok(resolved.graphJsonPath?.endsWith('graph.json'))
  })

  it('resolves calling agent session cwd before configured fallback', () => {
    const config = Config({ cwd: '/configured/fallback' })
    const resolver = new ProjectResolver(config)

    const resolved = resolver.resolve({
      toolContext: {
        signal: new AbortController().signal,
        agent: { session: { header: { cwd: fixtureDir } } },
      },
    })

    assert.equal(resolved.projectRoot, fixtureDir)
    assert.equal(resolved.hasGraph, true)
  })

  it('isolates simultaneous sessions in different workspaces without cross-talk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-b-'))
    try {
      const config = Config({})
      const resolver = new ProjectResolver(config)

      // Session A in fixtureDir (has graph)
      const sessionA = resolver.resolve({
        toolContext: {
          signal: new AbortController().signal,
          agent: { session: { header: { cwd: fixtureDir } } },
        },
      })

      // Session B in empty tempDir (no graph)
      const sessionB = resolver.resolve({
        toolContext: {
          signal: new AbortController().signal,
          agent: { session: { header: { cwd: tempDir } } },
        },
      })

      // Ensure Session A got its graph and paths
      assert.equal(sessionA.projectRoot, fixtureDir)
      assert.equal(sessionA.hasGraph, true)
      assert.ok(sessionA.graphJsonPath !== null)

      // Ensure Session B is completely isolated and did not inherit Session A's graph
      assert.equal(sessionB.projectRoot, tempDir)
      assert.equal(sessionB.hasGraph, false)
      assert.equal(sessionB.graphJsonPath, null)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('caches resolved metadata and revalidates when graph changes or on invalidate', () => {
    const config = Config({})
    const resolver = new ProjectResolver(config)

    const first = resolver.resolve({ explicitPath: fixtureDir })
    const second = resolver.resolve({ explicitPath: fixtureDir })
    assert.equal(first, second, 'Should return cached project metadata for identical path')

    // Invalidate project
    resolver.invalidate(fixtureDir)
    const third = resolver.resolve({ explicitPath: fixtureDir })
    assert.equal(third.projectRoot, fixtureDir)
    assert.equal(third.hasGraph, true)
  })
})
