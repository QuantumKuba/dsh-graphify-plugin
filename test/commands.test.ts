import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Config } from '../src/config.ts'
import { parseGraphifyCommand, registerGraphifyCommand, type CommandDefinition } from '../src/commands.ts'

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
    assert.throws(() => parseGraphifyCommand('query auth flow', fixtureDir), /Queries belong/i)
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
})
