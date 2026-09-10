import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Config } from '../src/config.ts'
import {
  checkGraphFreshness,
  ProjectUpdateCoalescer,
  writeGraphifyIndexMetadata,
  readGraphifyIndexMetadata,
} from '../src/freshness.ts'
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

  it('writes and reads durable graph index metadata', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-meta-test-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, '{"nodes":[],"edges":[]}')

    try {
      writeGraphifyIndexMetadata(tempDir, graphJson)
      const meta = readGraphifyIndexMetadata(tempDir)
      assert.ok(meta)
      assert.equal(meta.version, 1)
      assert.ok(Date.parse(meta.indexedAt) > 0)
      assert.ok(meta.graphMtimeMs > 0)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('detects staleness via durable metadata when git HEAD changes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-git-test-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, '{}')

    // Initialize git repo and make first commit
    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'file1.txt'), 'hello')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'initial'], { cwd: tempDir })

    try {
      writeGraphifyIndexMetadata(tempDir, graphJson)
      const project: ResolvedProject = {
        projectRoot: tempDir,
        graphJsonPath: graphJson,
        graphDir,
        hasGraph: true,
        mtimeMs: fs.statSync(graphJson).mtimeMs,
      }

      const initialFreshness = checkGraphFreshness(project)
      assert.equal(initialFreshness.state, 'fresh')
      assert.equal(initialFreshness.strategy, 'metadata')

      // Make a second commit to advance HEAD
      fs.writeFileSync(path.join(tempDir, 'file2.txt'), 'world')
      spawnSync('git', ['add', '.'], { cwd: tempDir })
      spawnSync('git', ['commit', '-m', 'second'], { cwd: tempDir })

      const staleFreshness = checkGraphFreshness(project)
      assert.equal(staleFreshness.state, 'stale')
      assert.equal(staleFreshness.strategy, 'metadata')
      assert.match(staleFreshness.reason, /git HEAD changed/i)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('detects nested file modifications in non-git directory ignoring venv and node_modules', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nongit-walk-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, '{}')

    const oldTime = new Date(Date.now() - 3600_000)
    fs.utimesSync(graphJson, oldTime, oldTime)

    // Deeply nested source file: src/a/b/c.ts
    const nestedDir = path.join(tempDir, 'src', 'a', 'b')
    fs.mkdirSync(nestedDir, { recursive: true })
    fs.writeFileSync(path.join(nestedDir, 'c.ts'), 'export const nested = true')

    // Ignored directories
    const nodeModulesDir = path.join(tempDir, 'node_modules', 'pkg')
    fs.mkdirSync(nodeModulesDir, { recursive: true })
    fs.writeFileSync(path.join(nodeModulesDir, 'index.js'), 'ignored')

    const venvDir = path.join(tempDir, '.venv', 'lib')
    fs.mkdirSync(venvDir, { recursive: true })
    fs.writeFileSync(path.join(venvDir, 'python.py'), 'ignored')

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
      assert.equal(freshness.strategy, 'filesystem-heuristic')
      assert.equal(freshness.changedFilesCount, 1)
      assert.ok(freshness.changedFilesSample?.some((f) => f.includes('c.ts')))
      assert.ok(!freshness.changedFilesSample?.some((f) => f.includes('node_modules') || f.includes('.venv')))
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('handles coalescer process spawning, isolation, and termination using injected spawnFn', async () => {
    let spawnCalls = 0
    const killedSignals: string[] = []

    const mockSpawn = (command: string, args: string[], options: any) => {
      spawnCalls++
      const child: any = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = (sig: string) => {
        killedSignals.push(sig)
        setTimeout(() => child.emit('close', 1, sig), 10)
        return true
      }

      // Simulate completion after delay
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from('graph updated'))
        child.emit('close', 0, null)
      }, 50)

      return child
    }

    const coalescer = new ProjectUpdateCoalescer({ spawn: mockSpawn as any })
    const config = Config({})

    // 3 concurrent calls for root1 should trigger only 1 spawn
    const root1 = '/mock/root1'
    const [p1, p2, p3] = await Promise.all([
      coalescer.update(config, root1),
      coalescer.update(config, root1),
      coalescer.update(config, root1),
    ])

    assert.equal(spawnCalls, 1)
    assert.equal(p1.success, true)
    assert.equal(p2.success, true)
    assert.equal(p3.success, true)

    // A different root triggers a separate spawn
    const root2 = '/mock/root2'
    const p4 = await coalescer.update(config, root2)
    assert.equal(spawnCalls, 2)
    assert.equal(p4.success, true)

    // Abort controller triggers termination and holds lock until close
    const abortSpawn = (command: string, args: string[], options: any) => {
      const child: any = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = (sig: string) => {
        killedSignals.push(sig)
        setTimeout(() => child.emit('close', 1, sig), 20)
        return true
      }
      return child
    }

    const abortCoalescer = new ProjectUpdateCoalescer({ spawn: abortSpawn as any })
    const controller = new AbortController()
    const abortPromise = abortCoalescer.update(config, root1, controller.signal)
    controller.abort()

    const abortResult = await abortPromise
    assert.equal(abortResult.success, false)
    assert.match(abortResult.error || '', /cancelled by signal/)
    assert.ok(killedSignals.includes('SIGTERM'))
  })
})
