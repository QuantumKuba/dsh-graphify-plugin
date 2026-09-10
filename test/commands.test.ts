import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Config } from '../src/config.ts'
import { parseGraphifyCommand, registerGraphifyCommand, type CommandDefinition } from '../src/commands.ts'
import { terminateChildProcess } from '../src/server-process.ts'

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
})
