import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Config } from '../src/config.ts'
import { parseGraphifyCommand, registerGraphifyCommand, type CommandDefinition } from '../src/commands.ts'
import { terminateChildProcess } from '../src/server-process.ts'
import {
  writeGraphifyIndexMetadata,
  readGraphifyIndexMetadata,
  checkGraphFreshness,
} from '../src/freshness.ts'
import type { ResolvedProject } from '../src/types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(__dirname, 'fixtures', 'sample-project')
const cliPath = path.join(__dirname, 'fixtures', 'fake-graphify-cli.mjs')

describe('/graphify command', () => {
  it('resolves paths from the receiving session root', () => {
    assert.deepEqual(parseGraphifyCommand('update docs --force', fixtureDir), {
      operation: 'update',
      projectRoot: path.join(fixtureDir, 'docs'),
      flags: ['--force'],
    })
    assert.deepEqual(parseGraphifyCommand('build . --code-only --no-viz', fixtureDir), {
      operation: 'build',
      projectRoot: fixtureDir,
      flags: ['--code-only', '--no-viz'],
    })
    assert.throws(() => parseGraphifyCommand('query auth flow', fixtureDir), /Queries belong/i)
    assert.throws(() => parseGraphifyCommand('update . --invalid-flag', fixtureDir), /Only --force, --no-cluster, --code-only, and --no-viz/i)
    assert.equal(
      parseGraphifyCommand('build "project with spaces"', fixtureDir).projectRoot,
      path.join(fixtureDir, 'project with spaces')
    )
  })

  it('uses the invocation agent cwd instead of the DSH host cwd', async () => {
    const ctx = new Context()
    let command: CommandDefinition | undefined
    ctx.provide('commands')
    ctx.commands = { register(definition: CommandDefinition) { command = definition; return () => {} } }
    const config = Config({ cliCommand: process.execPath, cliArgs: [cliPath] })
    registerGraphifyCommand(ctx, config, '/incorrect-host-root')
    const result = await command!.handler({
      rawInput: 'update . --no-cluster',
      agent: { session: { header: { cwd: fixtureDir } } },
      signal: new AbortController().signal,
    })
    assert.equal(result.kind, 'success')
    assert.match(result.text || '', new RegExp(`update",\\"${fixtureDir.replaceAll('/', '\\/')}\\"`))
  })

  it('terminates child process and quiesces when command is cancelled', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cmd-cancel-'))
    const pidFile = path.join(tempDir, 'child.pid')
    const sleeperScript = path.join(tempDir, 'sleeper.mjs')
    fs.writeFileSync(
      sleeperScript,
      `
import fs from 'node:fs'
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
setInterval(() => {}, 1000)
      `.trim()
    )

    const ctx = new Context()
    let command: CommandDefinition | undefined
    ctx.provide('commands')
    ctx.commands = { register(definition: CommandDefinition) { command = definition; return () => {} } }
    const config = Config({ cliCommand: process.execPath, cliArgs: [sleeperScript] })
    registerGraphifyCommand(ctx, config, tempDir)

    const controller = new AbortController()
    const promise = command!.handler({
      rawInput: 'build .',
      agent: { session: { header: { cwd: tempDir } } },
      signal: controller.signal,
    })

    // Wait for child to write its PID
    for (let i = 0; i < 20 && !fs.existsSync(pidFile); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(fs.existsSync(pidFile), 'Child should start and write PID')
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
    assert.ok(pid > 0)

    // Abort the command
    controller.abort()
    const result = await promise
    assert.equal(result.kind, 'error')
    assert.match(result.text, /cancelled/i)

    // Verify child process is dead
    let isAlive = true
    try {
      process.kill(pid, 0)
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'ESRCH') isAlive = false
    }
    assert.equal(isAlive, false, 'Child process must be dead after cancellation')

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('escalates from SIGTERM to SIGKILL when process is stubborn', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stubborn-'))
    const pidFile = path.join(tempDir, 'stubborn.pid')
    const stubbornPath = path.join(__dirname, 'fixtures', 'stubborn-process.mjs')

    const child = spawn(process.execPath, [stubbornPath], {
      env: { ...process.env, PID_FILE: pidFile },
      stdio: 'ignore',
    })

    for (let i = 0; i < 20 && !fs.existsSync(pidFile); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
    assert.ok(pid > 0)

    // Terminate with a short 100ms grace period to trigger SIGKILL escalation
    await terminateChildProcess(child, 100)

    let isAlive = true
    try {
      process.kill(pid, 0)
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'ESRCH') isAlive = false
    }
    assert.equal(isAlive, false, 'Stubborn process must be killed via SIGKILL')

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('does not resolve prematurely when child.killed is true before termination', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quiescence-'))
    const pidFile = path.join(tempDir, 'quiescence.pid')
    const stubbornPath = path.join(__dirname, 'fixtures', 'stubborn-process.mjs')

    const child = spawn(process.execPath, [stubbornPath], {
      env: { ...process.env, PID_FILE: pidFile },
      stdio: 'ignore',
    })

    for (let i = 0; i < 20 && !fs.existsSync(pidFile); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
    assert.ok(pid > 0)

    // Pre-kill with SIGTERM (ignored by stubborn-process). This sets child.killed = true.
    child.kill('SIGTERM')
    assert.equal(child.killed, true, 'child.killed should be true after signal delivery')
    assert.equal(child.exitCode, null, 'child should still be running')

    // terminateChildProcess must NOT resolve immediately just because child.killed === true.
    // It must wait for actual process exit/close (which requires SIGKILL escalation).
    const termPromise = terminateChildProcess(child, 150)
    const earlyCheck = await Promise.race([
      termPromise.then(() => 'premature-resolve'),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 50)),
    ])
    assert.equal(earlyCheck, 'still-pending', 'terminateChildProcess must wait for close, not resolve on child.killed')

    // Await full termination after SIGKILL
    await termPromise

    let isAlive = true
    try {
      process.kill(pid, 0)
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'ESRCH') isAlive = false
    }
    assert.equal(isAlive, false, 'Child must be dead after terminateChildProcess resolves')

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('/graphify update after only .ts change advances freshness checkpoint to fresh', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cmd-ts-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: '1' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const a = 1')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    // Write initial v3 metadata
    const initialMeta = writeGraphifyIndexMetadata(tempDir, graphJson)!
    assert.equal(initialMeta.version, 3)

    // Modify app.ts (code change only)
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const a = 2')

    // Mock CLI script simulating successful code-only update
    const mockCli = path.join(tempDir, 'mock-update.mjs')
    fs.writeFileSync(
      mockCli,
      `
import fs from 'node:fs'
fs.writeFileSync(${JSON.stringify(graphJson)}, JSON.stringify({ nodes: [{ id: '1' }, { id: '2' }], links: [] }))
process.exit(0)
      `.trim()
    )

    const ctx = new Context()
    let command: CommandDefinition | undefined
    ctx.provide('commands')
    ctx.commands = { register(def: CommandDefinition) { command = def; return () => {} } }
    const config = Config({ cliCommand: process.execPath, cliArgs: [mockCli] })
    registerGraphifyCommand(ctx, config, tempDir)

    try {
      const res = await command!.handler({
        rawInput: 'update .',
        agent: { session: { header: { cwd: tempDir } } },
        signal: new AbortController().signal,
      })
      assert.equal(res.kind, 'success')
      assert.ok(!res.text?.includes('Warning:'))
      assert.ok(!res.text?.includes('Note:'))

      const updatedMeta = readGraphifyIndexMetadata(tempDir, graphJson)
      assert.ok(updatedMeta)
      assert.equal(updatedMeta.version, 3)
      assert.notEqual(updatedMeta.indexedAt, initialMeta.indexedAt)

      const project: ResolvedProject = {
        projectRoot: tempDir,
        graphJsonPath: graphJson,
        graphDir,
        hasGraph: true,
        mtimeMs: fs.statSync(graphJson).mtimeMs,
      }
      assert.equal(checkGraphFreshness(project).state, 'fresh')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('/graphify update after .md change succeeds but does NOT advance freshness checkpoint', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cmd-md-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: '1' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# Initial Doc')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    const initialMeta = writeGraphifyIndexMetadata(tempDir, graphJson)!

    // Modify README.md (semantic document change)
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# Modified Doc')

    const mockCli = path.join(tempDir, 'mock-update.mjs')
    fs.writeFileSync(mockCli, 'process.exit(0)')

    const ctx = new Context()
    let command: CommandDefinition | undefined
    ctx.provide('commands')
    ctx.commands = { register(def: CommandDefinition) { command = def; return () => {} } }
    const config = Config({ cliCommand: process.execPath, cliArgs: [mockCli] })
    registerGraphifyCommand(ctx, config, tempDir)

    try {
      const res = await command!.handler({
        rawInput: 'update .',
        agent: { session: { header: { cwd: tempDir } } },
        signal: new AbortController().signal,
      })
      assert.equal(res.kind, 'success')
      assert.match(res.text || '', /Semantic or unsupported source changes were detected/i)
      assert.match(res.text || '', /Freshness checkpoint was not advanced/i)

      const metaAfter = readGraphifyIndexMetadata(tempDir, graphJson)!
      assert.equal(metaAfter.indexedAt, initialMeta.indexedAt, 'Metadata must NOT have been updated')

      const project: ResolvedProject = {
        projectRoot: tempDir,
        graphJsonPath: graphJson,
        graphDir,
        hasGraph: true,
        mtimeMs: fs.statSync(graphJson).mtimeMs,
      }
      assert.equal(checkGraphFreshness(project).state, 'stale')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('/graphify update after mixed .ts + .md does NOT advance freshness checkpoint', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cmd-mixed-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: '1' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const a = 1')
    fs.writeFileSync(path.join(tempDir, 'spec.md'), '# Spec')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    const initialMeta = writeGraphifyIndexMetadata(tempDir, graphJson)!

    // Modify both code and doc
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const a = 2')
    fs.writeFileSync(path.join(tempDir, 'spec.md'), '# Updated Spec')

    const mockCli = path.join(tempDir, 'mock-update.mjs')
    fs.writeFileSync(mockCli, 'process.exit(0)')

    const ctx = new Context()
    let command: CommandDefinition | undefined
    ctx.provide('commands')
    ctx.commands = { register(def: CommandDefinition) { command = def; return () => {} } }
    const config = Config({ cliCommand: process.execPath, cliArgs: [mockCli] })
    registerGraphifyCommand(ctx, config, tempDir)

    try {
      const res = await command!.handler({
        rawInput: 'update .',
        agent: { session: { header: { cwd: tempDir } } },
        signal: new AbortController().signal,
      })
      assert.equal(res.kind, 'success')
      assert.match(res.text || '', /Semantic or unsupported source changes were detected/i)

      const metaAfter = readGraphifyIndexMetadata(tempDir, graphJson)!
      assert.equal(metaAfter.indexedAt, initialMeta.indexedAt)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('/graphify update with legacy metadata does not advance checkpoint until full rebuild', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cmd-legacy-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: '1' }], links: [] }))

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const a = 1')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    // Write legacy v2 metadata (no indexedPaths)
    const metaPath = path.join(graphDir, '.dsh-graphify-index.json')
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        version: 2,
        indexedAt: new Date(Date.now() - 3600000).toISOString(),
        graphPath: graphJson,
        graphMtimeMs: fs.statSync(graphJson).mtimeMs,
        git: {
          head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tempDir, encoding: 'utf8' }).stdout.trim(),
          tree: spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: tempDir, encoding: 'utf8' }).stdout.trim(),
          workingTreeFingerprint: 'legacy-fingerprint',
        },
      })
    )

    // Modify app.ts
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const a = 2')

    const mockCli = path.join(tempDir, 'mock-update.mjs')
    fs.writeFileSync(mockCli, 'process.exit(0)')

    const ctx = new Context()
    let command: CommandDefinition | undefined
    ctx.provide('commands')
    ctx.commands = { register(def: CommandDefinition) { command = def; return () => {} } }
    const config = Config({ cliCommand: process.execPath, cliArgs: [mockCli] })
    registerGraphifyCommand(ctx, config, tempDir)

    try {
      const res = await command!.handler({
        rawInput: 'update .',
        agent: { session: { header: { cwd: tempDir } } },
        signal: new AbortController().signal,
      })
      assert.equal(res.kind, 'success')
      assert.match(res.text || '', /predates source-state tracking/i)

      const metaAfter = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      assert.equal(metaAfter.version, 2, 'Metadata must remain legacy v2, not upgraded on incremental update')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('full /graphify build writes v3 metadata representing current source state even with semantic changes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cmd-build-'))
    const graphDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')

    spawnSync('git', ['init'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: tempDir })
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const a = 1')
    fs.writeFileSync(path.join(tempDir, 'guide.md'), '# Guide')
    spawnSync('git', ['add', '.'], { cwd: tempDir })
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir })

    const mockCli = path.join(tempDir, 'mock-build.mjs')
    fs.writeFileSync(
      mockCli,
      `
import fs from 'node:fs'
fs.writeFileSync(${JSON.stringify(graphJson)}, JSON.stringify({ nodes: [{ id: 'app' }, { id: 'guide' }], links: [] }))
process.exit(0)
      `.trim()
    )

    const ctx = new Context()
    let command: CommandDefinition | undefined
    ctx.provide('commands')
    ctx.commands = { register(def: CommandDefinition) { command = def; return () => {} } }
    const config = Config({ cliCommand: process.execPath, cliArgs: [mockCli] })
    registerGraphifyCommand(ctx, config, tempDir)

    try {
      const res = await command!.handler({
        rawInput: 'build .',
        agent: { session: { header: { cwd: tempDir } } },
        signal: new AbortController().signal,
      })
      assert.equal(res.kind, 'success')

      const meta = readGraphifyIndexMetadata(tempDir, graphJson)
      assert.ok(meta)
      assert.equal(meta.version, 3)

      const project: ResolvedProject = {
        projectRoot: tempDir,
        graphJsonPath: graphJson,
        graphDir,
        hasGraph: true,
        mtimeMs: fs.statSync(graphJson).mtimeMs,
      }
      assert.equal(checkGraphFreshness(project).state, 'fresh')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
