import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as GraphifyPlugin from '../src/index.ts'
import {
  createGraphifyToolDefinitions,
  registerGraphifyCommand,
  isPathContained,
  validateProjectPathAccess,
  DEFAULT_GRAPHIFY_VERSION,
  Config,
} from '../src/index.ts'
import type { ToolDefinition, PromptSection } from '../src/types.ts'
import type { CommandDefinition } from '../src/commands.ts'
import { GraphifyMcpClient } from '../src/client.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('Marketplace Startup & Resilience', () => {
  it('mounts gracefully when neither Graphify nor uv is available on PATH', async () => {
    const originalPath = process.env.PATH
    const emptyTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-marketplace-empty-'))
    let fiber: any

    try {
      // Simulate an environment where neither graphify nor uv is on PATH
      process.env.PATH = emptyTempDir

      const ctx = new Context()
      const registeredTools = new Map<string, ToolDefinition>()
      const registeredCommands = new Map<string, CommandDefinition>()
      const registeredSections = new Map<string, PromptSection>()

      ctx.provide('tools')
      ctx.tools = {
        register(tool: ToolDefinition) {
          registeredTools.set(tool.name, tool)
          return () => {
            registeredTools.delete(tool.name)
          }
        },
      }

      ctx.provide('systemPrompt')
      ctx.systemPrompt = {
        section(sec: PromptSection) {
          registeredSections.set(sec.name, sec)
          return () => {
            registeredSections.delete(sec.name)
          }
        },
      }

      ctx.provide('commands')
      ctx.commands = {
        register(cmd: CommandDefinition) {
          registeredCommands.set(cmd.name, cmd)
          return () => {
            registeredCommands.delete(cmd.name)
          }
        },
      }

      // 1. Plugin apply MUST NOT throw even though Graphify and uv are completely absent
      fiber = await ctx.plugin(GraphifyPlugin, { command: 'auto', cwd: emptyTempDir } as any)

        // 2. Tools, commands, and prompt guidance are all registered
        assert.ok(registeredTools.has('graphify_status'), 'graphify_status doctor tool must be registered')
        assert.ok(registeredTools.has('query_graph'), 'query_graph tool must be registered')
        assert.ok(registeredCommands.has('graphify'), '/graphify command must be registered')
        assert.ok(registeredSections.has('graphify:guidance'), 'guidance prompt section must be registered')

        // 3. graphify_status reports UNAVAILABLE with actionable remediation
        const statusTool = registeredTools.get('graphify_status')!
        const statusResult = (await statusTool.execute({ probe: true }, {
          signal: new AbortController().signal,
          agent: { session: { header: { cwd: emptyTempDir } } },
        })) as { overall: string; text: string; isError: boolean }

        assert.equal(statusResult.overall, 'unavailable', 'Overall status must be unavailable')
        assert.match(statusResult.text, /Graphify Status: UNAVAILABLE/)
        assert.match(statusResult.text, new RegExp(`uv tool install 'graphifyy\\[mcp\\]==${DEFAULT_GRAPHIFY_VERSION}'`))

        // 4. Invoking a Graphify tool returns an actionable error, not an unhandled rejection
        const queryTool = registeredTools.get('query_graph')!
        const queryResult = (await queryTool.execute({ question: 'architecture' }, {
          signal: new AbortController().signal,
          agent: { session: { header: { cwd: emptyTempDir } } },
        })) as { text: string; isError: boolean }

        assert.equal(queryResult.isError, true)
        assert.match(queryResult.text, /Graphify is unavailable/i)
        assert.match(queryResult.text, /uv tool install/i)

        // 5. Invoking /graphify returns an actionable error, never crashes DSH
        const command = registeredCommands.get('graphify')!
        const cmdResult = await command.handler({
          rawInput: 'build .',
          signal: new AbortController().signal,
          agent: { session: { header: { cwd: emptyTempDir } } },
        })

        assert.equal(cmdResult.kind, 'error')
        assert.match(cmdResult.text, /Graphify is not installed/i)
        assert.match(cmdResult.text, new RegExp(`uv tool install 'graphifyy\\[mcp\\]==${DEFAULT_GRAPHIFY_VERSION}'`))
      } finally {
        if (fiber) await fiber.dispose()
        process.env.PATH = originalPath
        fs.rmSync(emptyTempDir, { recursive: true, force: true })
      }
    })

    it('rediscovers runtime dynamically without requiring DSH restart once installed (Part T)', async () => {
      const originalPath = process.env.PATH
      const tempBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rediscover-bin-'))
      const tempProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rediscover-proj-'))

      let fiber: any
      try {
        // Initially, PATH points to empty directory
        process.env.PATH = tempBinDir

        const ctx = new Context()
        const registeredTools = new Map<string, ToolDefinition>()
        ctx.provide('tools')
        ctx.tools = {
          register(tool: ToolDefinition) {
            registeredTools.set(tool.name, tool)
            return () => registeredTools.delete(tool.name)
          },
        }
        ctx.provide('systemPrompt')
        ctx.systemPrompt = { section: () => () => {} }
        ctx.provide('commands')
        ctx.commands = { register: () => () => {} }

        fiber = await ctx.plugin(GraphifyPlugin, { command: 'auto', cwd: tempProjectDir } as any)

        // First check: status is unavailable
        const statusTool = registeredTools.get('graphify_status')!
        const firstStatus = (await statusTool.execute({}, {
          signal: new AbortController().signal,
          agent: { session: { header: { cwd: tempProjectDir } } },
        })) as { overall: string; text: string }
        assert.equal(firstStatus.overall, 'unavailable')

        // Simulate user installing Graphify by placing a mock graphify-mcp script in tempBinDir
        const mockMcpPath = path.join(tempBinDir, 'graphify-mcp')
        fs.writeFileSync(
          mockMcpPath,
          `#!/bin/sh\nexit 0\n`,
          { mode: 0o755 }
        )

        // Second check: runtime is rediscovered dynamically on next invocation!
        const secondStatus = (await statusTool.execute({ probe: false }, {
          signal: new AbortController().signal,
          agent: { session: { header: { cwd: tempProjectDir } } },
        })) as { overall: string; text: string }

        // Graph is missing in tempProjectDir, but runtime is now discovered (so overall is 'missing', not 'unavailable'!)
        assert.equal(secondStatus.overall, 'missing')
        assert.match(secondStatus.text, /Runtime: .*graphify-mcp \[installed\]/)
      } finally {
        if (fiber) await fiber.dispose()
        process.env.PATH = originalPath
        fs.rmSync(tempBinDir, { recursive: true, force: true })
        fs.rmSync(tempProjectDir, { recursive: true, force: true })
      }
  })
})

describe('Model-Controlled Project Path Security (Part F)', () => {
  it('enforces realpath containment and blocks external project access by default', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sec-root-'))
    const workspace = path.join(tempRoot, 'workspace')
    const subproject = path.join(workspace, 'packages', 'app')
    const externalRepo = path.join(tempRoot, 'private-repo')
    const siblingRepo = path.join(tempRoot, 'workspace-evil')

    fs.mkdirSync(workspace, { recursive: true })
    fs.mkdirSync(subproject, { recursive: true })
    fs.mkdirSync(externalRepo, { recursive: true })
    fs.mkdirSync(siblingRepo, { recursive: true })

    // Create a symlink inside workspace pointing to externalRepo
    const symlinkToExternal = path.join(workspace, 'symlink-escape')
    try {
      fs.symlinkSync(externalRepo, symlinkToExternal, 'dir')
    } catch {
      // Symlinks may not be supported on all environments
    }

    try {
      // 1. Path containment helper tests
      assert.equal(isPathContained(workspace, workspace), true, 'Same directory is contained')
      assert.equal(isPathContained(workspace, subproject), true, 'Child subproject is contained')
      assert.equal(isPathContained(workspace, externalRepo), false, 'External repo is not contained')
      assert.equal(isPathContained(workspace, siblingRepo), false, 'Prefix sibling (workspace-evil) is not contained')

      if (fs.existsSync(symlinkToExternal)) {
        assert.equal(
          isPathContained(workspace, symlinkToExternal),
          false,
          'Symlink escaping workspace boundary must be rejected by realpath containment'
        )
      }

      // 2. validateProjectPathAccess with allowExternalProjects: false (default)
      const defaultConfig = Config({ allowExternalProjects: false })
      const exec = {
        signal: new AbortController().signal,
        agent: { session: { header: { cwd: workspace } } },
      }

      // Inside workspace: allowed
      assert.doesNotThrow(() => validateProjectPathAccess(workspace, exec, defaultConfig))
      assert.doesNotThrow(() => validateProjectPathAccess(subproject, exec, defaultConfig))

      // External: rejected
      assert.throws(
        () => validateProjectPathAccess(externalRepo, exec, defaultConfig),
        /Access to external project path .* is blocked/
      )

      // Prefix collision: rejected
      assert.throws(
        () => validateProjectPathAccess(siblingRepo, exec, defaultConfig),
        /Access to external project path .* is blocked/
      )

      // 3. validateProjectPathAccess with allowExternalProjects: true (admin override)
      const overrideConfig = Config({ allowExternalProjects: true })
      assert.doesNotThrow(() => validateProjectPathAccess(externalRepo, exec, overrideConfig))
      assert.doesNotThrow(() => validateProjectPathAccess(siblingRepo, exec, overrideConfig))
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('blocks model tool calls trying to access external paths while allowing human slash commands', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tool-sec-'))
    const workspace = path.join(tempRoot, 'workspace')
    const externalProject = path.join(tempRoot, 'external-project')
    fs.mkdirSync(workspace, { recursive: true })
    fs.mkdirSync(externalProject, { recursive: true })

    const fakeServer = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs')
    const client = new GraphifyMcpClient({
      command: process.execPath,
      args: [fakeServer],
      cwd: workspace,
    })

    try {
      const config = Config({ allowExternalProjects: false })
      const tools = createGraphifyToolDefinitions(client, config)
      const queryTool = tools.find((t) => t.name === 'query_graph')!
      const statusTool = tools.find((t) => t.name === 'graphify_status')!

      const exec = {
        signal: new AbortController().signal,
        agent: { session: { header: { cwd: workspace } } },
      }

      // Model tool call with external project_path is blocked
      const queryResult = (await queryTool.execute(
        { question: 'test', project_path: externalProject },
        exec
      )) as { text: string; isError: boolean }

      assert.equal(queryResult.isError, true)
      assert.match(queryResult.text, /Access to external project path .* is blocked/i)

      // Status tool with external project_path is blocked
      const statusResult = (await statusTool.execute(
        { project_path: externalProject },
        exec
      )) as { text: string; isError: boolean }

      assert.equal(statusResult.isError, true)
      assert.match(statusResult.text, /Access to external project path .* is blocked/i)

      // Human /graphify command retains flexibility for explicit human actions
      const ctx = new Context()
      let registeredCmd: CommandDefinition | undefined
      ctx.provide('commands')
      ctx.commands = {
        register(cmd: CommandDefinition) {
          registeredCmd = cmd
          return () => {}
        },
      }
      registerGraphifyCommand(ctx, config, workspace)

      // Human command targeting externalProject is parsed and resolved without model project_path restriction
      assert.ok(registeredCmd)
    } finally {
      await client.dispose()
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
