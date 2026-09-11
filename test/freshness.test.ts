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
  checkFilesystemRecursiveFreshness,
  evaluateAutoUpdateEligibility,
  performPostUpdateValidation,
  getChangedSourceInventory,
  hashFileContent,
  computeWorkingTreeFingerprint,
  captureIndexedPathStates,
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
      assert.equal(meta.version, 3)
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

  it('recognizes a freshly indexed clean Git repository as fresh', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clean-git-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, '{}')

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'content')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'commit1'], { cwd: tempDir })

    try {
      writeGraphifyIndexMetadata(tempDir, graphJson)
      const project: ResolvedProject = {
        projectRoot: tempDir,
        graphJsonPath: graphJson,
        graphDir,
        hasGraph: true,
        mtimeMs: fs.statSync(graphJson).mtimeMs,
      }
      const freshness = checkGraphFreshness(project)
      assert.equal(freshness.state, 'fresh')
      assert.equal(freshness.strategy, 'metadata')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('recognizes a dirty working tree as fresh when indexed with v2 fingerprint', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dirty-fresh-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, '{}')

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'initial')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'initial'], { cwd: tempDir })

    // Modify file without committing — working tree is dirty
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'uncommitted work in progress')

    try {
      // Indexing occurs on the dirty working tree
      writeGraphifyIndexMetadata(tempDir, graphJson)
      const meta = readGraphifyIndexMetadata(tempDir)
      assert.ok(meta?.git?.workingTreeFingerprint, 'Expected workingTreeFingerprint in v2 metadata')

      const project: ResolvedProject = {
        projectRoot: tempDir,
        graphJsonPath: graphJson,
        graphDir,
        hasGraph: true,
        mtimeMs: fs.statSync(graphJson).mtimeMs,
      }

      // Despite being dirty, freshness is fresh because fingerprint matches
      const freshness = checkGraphFreshness(project)
      assert.equal(freshness.state, 'fresh')
      assert.match(freshness.reason, /working tree fingerprint/i)

      // Now make another uncommitted change
      fs.writeFileSync(path.join(tempDir, 'file.txt'), 'subsequent uncommitted modification')
      const modifiedFreshness = checkGraphFreshness(project)
      assert.equal(modifiedFreshness.state, 'stale')
      assert.match(modifiedFreshness.reason, /Working tree changed since graph was indexed/i)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('detects newly added untracked source file as stale in dirty repository', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-untracked-stale-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, '{}')

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'base.txt'), 'base')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'base'], { cwd: tempDir })

    try {
      writeGraphifyIndexMetadata(tempDir, graphJson)
      const project: ResolvedProject = {
        projectRoot: tempDir,
        graphJsonPath: graphJson,
        graphDir,
        hasGraph: true,
        mtimeMs: fs.statSync(graphJson).mtimeMs,
      }
      assert.equal(checkGraphFreshness(project).state, 'fresh')

      // Add a brand new untracked file
      fs.writeFileSync(path.join(tempDir, 'new-feature.ts'), 'export const feat = true')
      const staleCheck = checkGraphFreshness(project)
      assert.equal(staleCheck.state, 'stale')
      assert.match(staleCheck.reason, /Working tree changed/i)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('detects branch switch as stale via durable metadata', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-branch-stale-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, '{}')

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'init')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    try {
      writeGraphifyIndexMetadata(tempDir, graphJson)
      const project: ResolvedProject = {
        projectRoot: tempDir,
        graphJsonPath: graphJson,
        graphDir,
        hasGraph: true,
        mtimeMs: fs.statSync(graphJson).mtimeMs,
      }
      assert.equal(checkGraphFreshness(project).state, 'fresh')

      // Switch to a new branch
      spawnSync('git', ['checkout', '-b', 'feat-branch'], { cwd: tempDir })
      const branchCheck = checkGraphFreshness(project)
      assert.equal(branchCheck.state, 'stale')
      assert.match(branchCheck.reason, /branch changed/i)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('maintains backward compatibility with v1 metadata schema', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-v1-compat-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, '{}')

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'content')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tempDir, encoding: 'utf8' }).stdout.trim()
    const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: tempDir, encoding: 'utf8' }).stdout.trim()
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tempDir, encoding: 'utf8' }).stdout.trim()

    // Manually write v1 metadata (no workingTreeFingerprint)
    const v1Meta = {
      version: 1,
      indexedAt: new Date().toISOString(),
      graphPath: graphJson,
      graphMtimeMs: fs.statSync(graphJson).mtimeMs,
      git: {
        head,
        tree,
        branch,
      },
    }
    fs.writeFileSync(path.join(graphDir, '.dsh-graphify-index.json'), JSON.stringify(v1Meta, null, 2))

    try {
      const meta = readGraphifyIndexMetadata(tempDir)
      assert.ok(meta)
      assert.equal(meta.version, 1)

      const project: ResolvedProject = {
        projectRoot: tempDir,
        graphJsonPath: graphJson,
        graphDir,
        hasGraph: true,
        mtimeMs: fs.statSync(graphJson).mtimeMs,
      }

      // When working tree is clean, v1 reports fresh
      assert.equal(checkGraphFreshness(project).state, 'fresh')

      // In v1, any dirty change causes staleness (fallback to porcelain)
      fs.writeFileSync(path.join(tempDir, 'file.txt'), 'dirty-v1')
      const dirtyCheck = checkGraphFreshness(project)
      assert.equal(dirtyCheck.state, 'stale')
      assert.match(dirtyCheck.reason, /uncommitted.*modified|uncommitted/i)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('correctly reads and writes metadata for custom graph paths', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-custom-graph-'))
    const customGraphDir = path.join(tempDir, 'custom', 'nested')
    fs.mkdirSync(customGraphDir, { recursive: true })
    const customGraphPath = path.join(customGraphDir, 'my-graph.json')
    fs.writeFileSync(customGraphPath, '{}')

    try {
      writeGraphifyIndexMetadata(tempDir, customGraphPath)
      const metaPath = path.join(customGraphDir, '.dsh-graphify-index.json')
      assert.ok(fs.existsSync(metaPath), 'Metadata should be written beside custom graph')

      const meta = readGraphifyIndexMetadata(tempDir, customGraphPath)
      assert.ok(meta)
      assert.equal(meta.graphPath, path.relative(tempDir, customGraphPath))

      const project: ResolvedProject = {
        projectRoot: tempDir,
        graphJsonPath: customGraphPath,
        graphDir: customGraphDir,
        hasGraph: true,
        mtimeMs: fs.statSync(customGraphPath).mtimeMs,
      }
      const freshness = checkGraphFreshness(project)
      assert.ok(['fresh', 'unknown'].includes(freshness.state))
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('reports unknown with honest explanation when filesystem scan is truncated', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-truncation-'))
    const graphMtimeMs = Date.now()

    // Create 10 files
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(tempDir, `file_${i}.txt`), `content ${i}`)
      const past = new Date(graphMtimeMs - 10000)
      fs.utimesSync(path.join(tempDir, `file_${i}.txt`), past, past)
    }

    try {
      // Scan with maxFiles = 3 (less than total files)
      const result = checkFilesystemRecursiveFreshness(tempDir, graphMtimeMs, 3)
      assert.equal(result.state, 'unknown')
      assert.match(result.reason, /Scanned 3 files without finding changes/i)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('detects staleness when an untracked file is modified with identical byte size', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-untracked-samesize-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, '{}')

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'committed.txt'), 'committed')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    // Create untracked file
    const untrackedPath = path.join(tempDir, 'untracked.ts')
    fs.writeFileSync(untrackedPath, 'const a = 100;') // length 14 bytes

    try {
      writeGraphifyIndexMetadata(tempDir, graphJson)
      const project: ResolvedProject = {
        projectRoot: tempDir,
        graphJsonPath: graphJson,
        graphDir,
        hasGraph: true,
        mtimeMs: fs.statSync(graphJson).mtimeMs,
      }
      assert.equal(checkGraphFreshness(project).state, 'fresh')

      // Modify untracked file with EXACT SAME byte length (14 bytes) but different content
      fs.writeFileSync(untrackedPath, 'const b = 200;') // length 14 bytes
      const staleCheck = checkGraphFreshness(project)
      assert.equal(staleCheck.state, 'stale')
      assert.match(staleCheck.reason, /Working tree changed/i)

      // Re-index metadata should restore freshness
      writeGraphifyIndexMetadata(tempDir, graphJson)
      assert.equal(checkGraphFreshness(project).state, 'fresh')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('excludes custom graph path directory from working-tree fingerprinting to prevent self-invalidation', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-custom-fresh-'))
    const customGraphDir = path.join(tempDir, 'custom-output')
    fs.mkdirSync(customGraphDir, { recursive: true })
    const customGraphPath = path.join(customGraphDir, 'graph.json')
    fs.writeFileSync(customGraphPath, '{}')

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'code.ts'), 'export const a = 1')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    try {
      // Write metadata beside custom graph
      writeGraphifyIndexMetadata(tempDir, customGraphPath)
      const project: ResolvedProject = {
        projectRoot: tempDir,
        graphJsonPath: customGraphPath,
        graphDir: customGraphDir,
        hasGraph: true,
        mtimeMs: fs.statSync(customGraphPath).mtimeMs,
      }

      // Initial check must be fresh
      assert.equal(checkGraphFreshness(project).state, 'fresh')

      // Modifying/writing files inside custom-output should NOT make the working tree stale
      fs.writeFileSync(path.join(customGraphDir, 'extra.txt'), 'extra output from graphify')
      assert.equal(checkGraphFreshness(project).state, 'fresh')

      // But modifying code outside custom-output DOES trigger staleness
      fs.writeFileSync(path.join(tempDir, 'code.ts'), 'export const a = 2')
      assert.equal(checkGraphFreshness(project).state, 'stale')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('preserves freshness across git staging state transitions (git add / git reset)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-staging-invar-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, '{}')

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'file.ts'), 'export const a = 1')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    const project: ResolvedProject = {
      projectRoot: tempDir,
      graphJsonPath: graphJson,
      graphDir,
      hasGraph: true,
      mtimeMs: fs.statSync(graphJson).mtimeMs,
    }

    try {
      // 1. Modify file in working tree (unstaged)
      fs.writeFileSync(path.join(tempDir, 'file.ts'), 'export const a = 2')

      // Checkpoint metadata while file is modified and unstaged
      writeGraphifyIndexMetadata(tempDir, graphJson)
      assert.equal(checkGraphFreshness(project).state, 'fresh')

      // 2. Stage the modification (git add file.ts) -> must still be FRESH
      spawnSync('git', ['add', 'file.ts'], { cwd: tempDir })
      assert.equal(checkGraphFreshness(project).state, 'fresh')

      // 3. Unstage the modification (git reset file.ts) -> must still be FRESH
      spawnSync('git', ['reset', 'HEAD', 'file.ts'], { cwd: tempDir })
      assert.equal(checkGraphFreshness(project).state, 'fresh')

      // 4. Stage again, then modify file further -> must be STALE
      spawnSync('git', ['add', 'file.ts'], { cwd: tempDir })
      fs.writeFileSync(path.join(tempDir, 'file.ts'), 'export const a = 3')
      assert.equal(checkGraphFreshness(project).state, 'stale')

      // 5. Restore file back to indexed bytes (export const a = 2) -> must be FRESH
      fs.writeFileSync(path.join(tempDir, 'file.ts'), 'export const a = 2')
      assert.equal(checkGraphFreshness(project).state, 'fresh')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('detects dirty .md indexed at B and reverted to HEAD A as STALE with auto-update blocked (no false-fresh)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-md-revert-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: 'arch' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

    // HEAD contains architecture.md = A
    fs.writeFileSync(path.join(tempDir, 'architecture.md'), '# Architecture A')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'commit A'], { cwd: tempDir })

    // User edits architecture.md = B
    fs.writeFileSync(path.join(tempDir, 'architecture.md'), '# Architecture B')

    // Graphify indexes at dirty state B
    writeGraphifyIndexMetadata(tempDir, graphJson)

    const project: ResolvedProject = {
      projectRoot: tempDir,
      graphJsonPath: graphJson,
      graphDir,
      hasGraph: true,
      mtimeMs: fs.statSync(graphJson).mtimeMs,
    }

    try {
      // At this point, working tree is B, indexed state is B -> FRESH
      assert.equal(checkGraphFreshness(project).state, 'fresh')

      // User now reverts architecture.md back to A (matching HEAD A on disk, but differing from graph B!)
      fs.writeFileSync(path.join(tempDir, 'architecture.md'), '# Architecture A')

      // MUST NOT be marked FRESH! Git diff against HEAD is empty, but baseline diff against indexed state B is dirty!
      const freshness = checkGraphFreshness(project)
      assert.equal(freshness.state, 'stale', 'Reverting dirty semantic file must be STALE')

      // Auto-update must NOT run because architecture.md is a non-code semantic doc
      const eligibility = evaluateAutoUpdateEligibility(project)
      assert.equal(eligibility.kind, 'requires-full-refresh')
      if (eligibility.kind === 'requires-full-refresh') {
        assert.ok(eligibility.unsupportedSources.some((s) => s.path === 'architecture.md'))
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('keeps dirty .ts indexed at B fresh when unchanged, and stale/eligible when modified or reverted', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ts-dirty-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: 'app' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

    // HEAD contains app.ts = A
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const val = "A"')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'commit A'], { cwd: tempDir })

    // User modifies app.ts = B
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const val = "B"')

    // Graph indexed with dirty app.ts = B
    writeGraphifyIndexMetadata(tempDir, graphJson)

    const project: ResolvedProject = {
      projectRoot: tempDir,
      graphJsonPath: graphJson,
      graphDir,
      hasGraph: true,
      mtimeMs: fs.statSync(graphJson).mtimeMs,
    }

    try {
      // 1. Unchanged after indexing -> remains FRESH
      assert.equal(checkGraphFreshness(project).state, 'fresh')

      // 2. Changed to C -> STALE and eligible for code-only incremental update
      fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const val = "C"')
      assert.equal(checkGraphFreshness(project).state, 'stale')
      const eligC = evaluateAutoUpdateEligibility(project)
      assert.equal(eligC.kind, 'eligible')

      // 3. Reverted to HEAD A -> STALE and eligible for code-only incremental update
      fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const val = "A"')
      assert.equal(checkGraphFreshness(project).state, 'stale')
      const eligA = evaluateAutoUpdateEligibility(project)
      assert.equal(eligA.kind, 'eligible')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('detects dirty .md indexed at B and modified to C as STALE requiring full refresh', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-md-mod-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: 'doc' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

    fs.writeFileSync(path.join(tempDir, 'doc.md'), 'version A')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'commit A'], { cwd: tempDir })

    fs.writeFileSync(path.join(tempDir, 'doc.md'), 'version B')
    writeGraphifyIndexMetadata(tempDir, graphJson)

    const project: ResolvedProject = {
      projectRoot: tempDir,
      graphJsonPath: graphJson,
      graphDir,
      hasGraph: true,
      mtimeMs: fs.statSync(graphJson).mtimeMs,
    }

    try {
      assert.equal(checkGraphFreshness(project).state, 'fresh')

      fs.writeFileSync(path.join(tempDir, 'doc.md'), 'version C')
      assert.equal(checkGraphFreshness(project).state, 'stale')
      const elig = evaluateAutoUpdateEligibility(project)
      assert.equal(elig.kind, 'requires-full-refresh')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('preserves freshness for untracked files when unchanged, and detects changes/deletions accurately', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-untracked-flow-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: '1' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'tracked.ts'), 'export const x = 1')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    // Untracked ts and untracked md
    fs.writeFileSync(path.join(tempDir, 'untracked.ts'), 'export const u = 1')
    fs.writeFileSync(path.join(tempDir, 'untracked.md'), '# Notes')

    writeGraphifyIndexMetadata(tempDir, graphJson)

    const project: ResolvedProject = {
      projectRoot: tempDir,
      graphJsonPath: graphJson,
      graphDir,
      hasGraph: true,
      mtimeMs: fs.statSync(graphJson).mtimeMs,
    }

    try {
      // 1. Unchanged untracked files -> FRESH
      assert.equal(checkGraphFreshness(project).state, 'fresh')

      // 2. Modifying untracked .ts -> STALE, eligible
      fs.writeFileSync(path.join(tempDir, 'untracked.ts'), 'export const u = 2')
      assert.equal(checkGraphFreshness(project).state, 'stale')
      const eligTs = evaluateAutoUpdateEligibility(project)
      assert.equal(eligTs.kind, 'eligible')

      // Restore untracked.ts
      fs.writeFileSync(path.join(tempDir, 'untracked.ts'), 'export const u = 1')
      assert.equal(checkGraphFreshness(project).state, 'fresh')

      // 3. Deleting untracked .md -> STALE, requires full refresh (cannot AST-update deleted doc)
      fs.unlinkSync(path.join(tempDir, 'untracked.md'))
      assert.equal(checkGraphFreshness(project).state, 'stale')
      const eligDel = evaluateAutoUpdateEligibility(project)
      assert.equal(eligDel.kind, 'requires-full-refresh')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('tracks deleted files at index time and detects when they are restored or modified', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-deletion-flow-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'deleted-later.ts'), 'export const d = 1')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    // Delete file on disk before indexing
    fs.unlinkSync(path.join(tempDir, 'deleted-later.ts'))

    // Index metadata records deletion state
    writeGraphifyIndexMetadata(tempDir, graphJson)

    const project: ResolvedProject = {
      projectRoot: tempDir,
      graphJsonPath: graphJson,
      graphDir,
      hasGraph: true,
      mtimeMs: fs.statSync(graphJson).mtimeMs,
    }

    try {
      // While deleted, working tree matches indexed state -> FRESH
      assert.equal(checkGraphFreshness(project).state, 'fresh')

      // Restoring file on disk -> STALE
      fs.writeFileSync(path.join(tempDir, 'deleted-later.ts'), 'export const d = 1')
      assert.equal(checkGraphFreshness(project).state, 'stale')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('handles filenames containing spaces, unicode, and special characters safely', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unicode-filenames-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

    const spaceFile = 'my file with spaces.ts'
    const unicodeFile = 'módulo-🚀-test.ts'
    fs.writeFileSync(path.join(tempDir, spaceFile), 'export const s = 1')
    fs.writeFileSync(path.join(tempDir, unicodeFile), 'export const u = 1')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    // Modify both in working tree
    fs.writeFileSync(path.join(tempDir, spaceFile), 'export const s = 2')
    fs.writeFileSync(path.join(tempDir, unicodeFile), 'export const u = 2')

    writeGraphifyIndexMetadata(tempDir, graphJson)

    const project: ResolvedProject = {
      projectRoot: tempDir,
      graphJsonPath: graphJson,
      graphDir,
      hasGraph: true,
      mtimeMs: fs.statSync(graphJson).mtimeMs,
    }

    try {
      assert.equal(checkGraphFreshness(project).state, 'fresh')

      // Modify one file
      fs.writeFileSync(path.join(tempDir, spaceFile), 'export const s = 3')
      assert.equal(checkGraphFreshness(project).state, 'stale')

      const inventory = getChangedSourceInventory(tempDir, readGraphifyIndexMetadata(tempDir, graphJson), graphJson)
      assert.equal(inventory.complete, true)
      assert.ok(inventory.files.some((f) => f.path === spaceFile))
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('legacy metadata and missing metadata fail safe and refuse to bootstrap to FRESH via auto-update', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-legacy-safe-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'guide.md'), '# Initial')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    const project: ResolvedProject = {
      projectRoot: tempDir,
      graphJsonPath: graphJson,
      graphDir,
      hasGraph: true,
      mtimeMs: fs.statSync(graphJson).mtimeMs,
    }

    try {
      // 1. No metadata present at all: eligibility must be 'unknown'
      const noMetaElig = evaluateAutoUpdateEligibility(project)
      assert.equal(noMetaElig.kind, 'unknown')
      assert.match(noMetaElig.reason, /run a full graph rebuild/i)

      // 2. v1 metadata present: eligibility must be 'unknown'
      const metaPath = path.join(graphDir, '.dsh-graphify-index.json')
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          version: 1,
          indexedAt: new Date().toISOString(),
          graphPath: graphJson,
          graphMtimeMs: Date.now(),
          git: { head: 'aaa', tree: 'bbb' },
        })
      )
      const v1Elig = evaluateAutoUpdateEligibility(project)
      assert.equal(v1Elig.kind, 'unknown')
      assert.match(v1Elig.reason, /predates source-state tracking/i)

      // 3. v2 metadata present: eligibility must be 'unknown'
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          version: 2,
          indexedAt: new Date().toISOString(),
          graphPath: graphJson,
          graphMtimeMs: Date.now(),
          git: { head: 'aaa', tree: 'bbb', workingTreeFingerprint: 'v2-fp' },
        })
      )
      const v2Elig = evaluateAutoUpdateEligibility(project)
      assert.equal(v2Elig.kind, 'unknown')
      assert.match(v2Elig.reason, /predates source-state tracking/i)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('post-update validation rejects non-Graphify JSON and accepts coherent Graphify graphs', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-val-test-'))
    const graphJson = path.join(tempDir, 'graph.json')

    try {
      // 1. Non-existent file
      assert.equal(performPostUpdateValidation(tempDir, path.join(tempDir, 'nonexistent.json')), false)

      // 2. Empty file
      fs.writeFileSync(graphJson, '')
      assert.equal(performPostUpdateValidation(tempDir, graphJson), false)

      // 3. Empty object {}
      fs.writeFileSync(graphJson, '{}')
      assert.equal(performPostUpdateValidation(tempDir, graphJson), false)

      // 4. Random parseable JSON
      fs.writeFileSync(graphJson, JSON.stringify({ hello: 'world' }))
      assert.equal(performPostUpdateValidation(tempDir, graphJson), false)

      // 5. Array instead of object
      fs.writeFileSync(graphJson, JSON.stringify([1, 2, 3]))
      assert.equal(performPostUpdateValidation(tempDir, graphJson), false)

      // 6. Object with nodes that is not an array
      fs.writeFileSync(graphJson, JSON.stringify({ nodes: 'not-array', links: [] }))
      assert.equal(performPostUpdateValidation(tempDir, graphJson), false)

      // 7. Object with nodes array but neither links nor edges array
      fs.writeFileSync(graphJson, JSON.stringify({ nodes: [], somethingElse: true }))
      assert.equal(performPostUpdateValidation(tempDir, graphJson), false)

      // 8. Valid Graphify graph with nodes and links
      fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: '1' }], links: [] }))
      assert.equal(performPostUpdateValidation(tempDir, graphJson), true)

      // 9. Valid Graphify graph with nodes and edges
      fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: '1' }], edges: [] }))
      assert.equal(performPostUpdateValidation(tempDir, graphJson), true)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('coalescer isolates caller-level cancellation so aborting caller A does not kill update for caller B', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-coalesce-caller-'))
    const graphJson = path.join(tempDir, 'graphify-out', 'graph.json')

    const fakeChild = new EventEmitter() as any
    fakeChild.stdout = new EventEmitter()
    fakeChild.stderr = new EventEmitter()
    fakeChild.kill = () => {}

    const customSpawn = () => fakeChild
    const coalescer = new ProjectUpdateCoalescer({ spawn: customSpawn as any })
    const config = Config({})

    const controllerA = new AbortController()
    const controllerB = new AbortController()

    // Caller A starts update
    const promiseA = coalescer.update(config, tempDir, controllerA.signal, graphJson)

    // Caller B coalesces on same update
    const promiseB = coalescer.update(config, tempDir, controllerB.signal, graphJson)

    // Caller A aborts
    controllerA.abort()

    const resA = await promiseA
    assert.equal(resA.success, false)
    assert.match(resA.error || '', /cancelled by signal/i)

    // Child finishes successfully for caller B
    fakeChild.emit('close', 0, null)

    const resB = await promiseB
    assert.equal(resB.success, true)

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('git diff failure during baseline capture prevents trusted baseline and auto-update', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-diff-fail-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: 'app' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const a = 1')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    // Working tree modification
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const a = 2')

    // Mock spawnSync to fail when 'diff' command is issued
    const originalSpawnSync = spawnSync
    const mockSpawnSync: typeof spawnSync = ((cmd: string, args?: readonly string[], opts?: any) => {
      if (cmd === 'git' && args && args[0] === 'diff') {
        return { status: 1, stdout: '', stderr: 'git diff simulated failure', error: new Error('diff error') } as any
      }
      return originalSpawnSync(cmd, args as any, opts)
    }) as any

    try {
      const meta = writeGraphifyIndexMetadata(tempDir, graphJson, { spawnSync: mockSpawnSync })
      assert.ok(meta, 'Metadata object should be written')
      assert.equal(meta.git?.baselineComplete, false, 'baselineComplete must NOT be true on git diff failure')

      const project: ResolvedProject = {
        projectRoot: tempDir,
        graphJsonPath: graphJson,
        graphDir,
        hasGraph: true,
        mtimeMs: fs.statSync(graphJson).mtimeMs,
      }
      const freshness = checkGraphFreshness(project)
      assert.notEqual(freshness.state, 'fresh', 'Graph with incomplete baseline must never report FRESH')
      assert.equal(freshness.state, 'stale')
      assert.equal(freshness.baselineAvailable, false)

      const eligibility = evaluateAutoUpdateEligibility(project)
      assert.notEqual(eligibility.kind, 'eligible', 'Auto-update must not be eligible with incomplete baseline')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('git ls-files failure during baseline capture prevents trusted baseline and auto-update', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ls-fail-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: 'app' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const a = 1')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    // Untracked file
    fs.writeFileSync(path.join(tempDir, 'new.ts'), 'export const b = 2')

    const originalSpawnSync = spawnSync
    const mockSpawnSync: typeof spawnSync = ((cmd: string, args?: readonly string[], opts?: any) => {
      if (cmd === 'git' && args && args[0] === 'ls-files') {
        return { status: 1, stdout: '', stderr: 'git ls-files simulated failure', error: new Error('ls-files error') } as any
      }
      return originalSpawnSync(cmd, args as any, opts)
    }) as any

    try {
      const meta = writeGraphifyIndexMetadata(tempDir, graphJson, { spawnSync: mockSpawnSync })
      assert.ok(meta)
      assert.equal(meta.git?.baselineComplete, false, 'baselineComplete must NOT be true on git ls-files failure')

      const project: ResolvedProject = {
        projectRoot: tempDir,
        graphJsonPath: graphJson,
        graphDir,
        hasGraph: true,
        mtimeMs: fs.statSync(graphJson).mtimeMs,
      }
      const freshness = checkGraphFreshness(project)
      assert.notEqual(freshness.state, 'fresh')
      assert.equal(freshness.baselineAvailable, false)

      const eligibility = evaluateAutoUpdateEligibility(project)
      assert.notEqual(eligibility.kind, 'eligible')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('tracked dirty file hash failure prevents trusted baseline and auto-update', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tracked-hash-fail-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: 'app' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const a = 1')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const a = 2')

    // Injected hashFileContent that fails for app.ts
    const mockHash = (filePath: string) => {
      if (filePath.endsWith('app.ts')) return undefined
      return hashFileContent(filePath)
    }

    try {
      const meta = writeGraphifyIndexMetadata(tempDir, graphJson, { hashFileContent: mockHash })
      assert.ok(meta)
      assert.equal(meta.git?.baselineComplete, false, 'baselineComplete must be false on tracked file hash failure')

      const project: ResolvedProject = {
        projectRoot: tempDir,
        graphJsonPath: graphJson,
        graphDir,
        hasGraph: true,
        mtimeMs: fs.statSync(graphJson).mtimeMs,
      }
      const freshness = checkGraphFreshness(project)
      assert.notEqual(freshness.state, 'fresh')
      assert.equal(freshness.baselineAvailable, false)

      const eligibility = evaluateAutoUpdateEligibility(project)
      assert.notEqual(eligibility.kind, 'eligible')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('untracked file hash failure prevents trusted baseline and auto-update', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-untracked-hash-fail-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: 'app' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const a = 1')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    fs.writeFileSync(path.join(tempDir, 'untracked.ts'), 'export const u = 100')

    const mockHash = (filePath: string) => {
      if (filePath.endsWith('untracked.ts')) return undefined
      return hashFileContent(filePath)
    }

    try {
      const meta = writeGraphifyIndexMetadata(tempDir, graphJson, { hashFileContent: mockHash })
      assert.ok(meta)
      assert.equal(meta.git?.baselineComplete, false, 'baselineComplete must be false on untracked file hash failure')

      const project: ResolvedProject = {
        projectRoot: tempDir,
        graphJsonPath: graphJson,
        graphDir,
        hasGraph: true,
        mtimeMs: fs.statSync(graphJson).mtimeMs,
      }
      const freshness = checkGraphFreshness(project)
      assert.notEqual(freshness.state, 'fresh')
      assert.equal(freshness.baselineAvailable, false)

      const eligibility = evaluateAutoUpdateEligibility(project)
      assert.notEqual(eligibility.kind, 'eligible')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('adversarial regression: hash failure during indexing followed by revert to clean HEAD never becomes false FRESH', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adv-revert-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: 'doc' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    // HEAD semantic file = A
    fs.writeFileSync(path.join(tempDir, 'doc.md'), 'Content A')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    // Working file modified to B
    fs.writeFileSync(path.join(tempDir, 'doc.md'), 'Content B')

    // Simulate hash failure for B during baseline capture
    const mockHash = (filePath: string) => {
      if (filePath.endsWith('doc.md')) return undefined
      return hashFileContent(filePath)
    }

    // Graph indexed from B with simulated hash failure
    const meta = writeGraphifyIndexMetadata(tempDir, graphJson, { hashFileContent: mockHash })
    assert.ok(meta)
    assert.equal(meta.git?.baselineComplete, false, 'Baseline must be incomplete')

    // Revert file to A -> working tree is now clean relative to HEAD A
    spawnSync('git', ['checkout', '--', 'doc.md'], { cwd: tempDir })
    assert.equal(fs.readFileSync(path.join(tempDir, 'doc.md'), 'utf8'), 'Content A')

    const project: ResolvedProject = {
      projectRoot: tempDir,
      graphJsonPath: graphJson,
      graphDir,
      hasGraph: true,
      mtimeMs: fs.statSync(graphJson).mtimeMs,
    }

    // Must NOT become FRESH because the indexed baseline was incomplete!
    const freshness = checkGraphFreshness(project)
    assert.notEqual(freshness.state, 'fresh', 'Must NOT become false FRESH after reverting when baseline was incomplete')
    assert.equal(freshness.state, 'stale')
    assert.match(freshness.reason, /incomplete or untrusted source-state baseline/i)

    const eligibility = evaluateAutoUpdateEligibility(project)
    assert.notEqual(eligibility.kind, 'eligible')
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('symlink unchanged preserves freshness, while retargeting to equal-content file is detected as STALE', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-symlink-test-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: 'link' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

    // Create target A and target B with IDENTICAL contents
    fs.writeFileSync(path.join(tempDir, 'target-a.ts'), 'export const x = 42\n')
    fs.writeFileSync(path.join(tempDir, 'target-b.ts'), 'export const x = 42\n')

    // Create symlink pointing to target-a.ts
    const linkPath = path.join(tempDir, 'link.ts')
    fs.symlinkSync('target-a.ts', linkPath)

    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    // Checkpoint clean working tree
    const meta = writeGraphifyIndexMetadata(tempDir, graphJson)
    assert.ok(meta)
    assert.equal(meta.git?.baselineComplete, true)

    const project: ResolvedProject = {
      projectRoot: tempDir,
      graphJsonPath: graphJson,
      graphDir,
      hasGraph: true,
      mtimeMs: fs.statSync(graphJson).mtimeMs,
    }

    // 1. Unchanged symlink -> FRESH
    const freshCheck = checkGraphFreshness(project)
    assert.equal(freshCheck.state, 'fresh', 'Unchanged symlink must report FRESH')

    // 2. Retarget symlink to target-b.ts (target contents are 100% byte-identical!)
    fs.unlinkSync(linkPath)
    fs.symlinkSync('target-b.ts', linkPath)

    // Symlink target contents are unchanged, but symlink identity changed! Must be STALE!
    const staleCheck = checkGraphFreshness(project)
    assert.equal(staleCheck.state, 'stale', 'Retargeted symlink must be detected as STALE despite identical target content')

    const inventory = getChangedSourceInventory(tempDir, meta, graphJson)
    assert.equal(inventory.complete, true)
    const linkChange = inventory.files.find(f => f.path === 'link.ts')
    assert.ok(linkChange, 'Inventory must detect link.ts as changed')
    assert.equal(linkChange.status, 'modified')

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('outside-root symlink fails closed and does not establish trusted baseline', () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-outside-symlink-'))
    const tempDir = path.join(parentDir, 'repo')
    fs.mkdirSync(tempDir)
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: 'link' }], links: [] }))

    // Create outside target file in parentDir
    const outsideTarget = path.join(parentDir, 'outside.ts')
    fs.writeFileSync(outsideTarget, 'export const outside = true\n')

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const a = 1')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    // Create untracked symlink escaping projectRoot
    const linkPath = path.join(tempDir, 'outside-link.ts')
    fs.symlinkSync('../outside.ts', linkPath)

    // hashFileContent on outside-root symlink must return undefined
    const hash = hashFileContent(linkPath, tempDir)
    assert.equal(hash, undefined, 'hashFileContent must return undefined for outside-root symlink')

    // Baseline capture must fail closed
    const baseline = captureIndexedPathStates(tempDir)
    assert.equal(baseline.complete, false, 'Baseline capture must fail closed with outside-root symlink')

    const meta = writeGraphifyIndexMetadata(tempDir, graphJson)
    assert.ok(meta)
    assert.equal(meta.git?.baselineComplete, false)

    const project: ResolvedProject = {
      projectRoot: tempDir,
      graphJsonPath: graphJson,
      graphDir,
      hasGraph: true,
      mtimeMs: fs.statSync(graphJson).mtimeMs,
    }
    assert.notEqual(checkGraphFreshness(project).state, 'fresh')

    fs.rmSync(parentDir, { recursive: true, force: true })
  })

  it('cleans up temporary metadata files on write failure while leaving existing metadata untouched', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-temp-cleanup-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: 'app' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const a = 1')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    // Write initial valid metadata
    const initialMeta = writeGraphifyIndexMetadata(tempDir, graphJson)
    assert.ok(initialMeta)
    const metaPath = path.join(graphDir, '.dsh-graphify-index.json')
    const initialContent = fs.readFileSync(metaPath, 'utf8')

    // Temporarily mock fs.renameSync to throw an error
    const originalRename = fs.renameSync
    let renameAttempted = false
    ;(fs as any).renameSync = () => {
      renameAttempted = true
      throw new Error('simulated disk failure on rename')
    }

    try {
      const failedWrite = writeGraphifyIndexMetadata(tempDir, graphJson)
      assert.equal(failedWrite, null, 'Failed write must return null')
      assert.equal(renameAttempted, true, 'Rename must have been attempted')

      // Existing metadata must remain completely untouched
      const currentContent = fs.readFileSync(metaPath, 'utf8')
      assert.equal(currentContent, initialContent, 'Existing metadata must not be corrupted or overwritten')

      // No stray .tmp files left in graphDir
      const remainingFiles = fs.readdirSync(graphDir)
      const tmpFiles = remainingFiles.filter(f => f.includes('.tmp'))
      assert.equal(tmpFiles.length, 0, `No temporary files should remain, found: ${tmpFiles.join(', ')}`)
    } finally {
      fs.renameSync = originalRename
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
