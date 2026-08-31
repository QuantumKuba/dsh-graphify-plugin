import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as GraphifyPlugin from '../src/index.ts'
import type { ToolDefinition, PromptSection } from '../src/types.ts'
import type { CommandDefinition } from '../src/commands.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(__dirname, 'fixtures', 'sample-project')

describe('Graphify Plugin Integration', () => {
  it('mounts plugin, registers all tools, prompt section, and slash command', async () => {
    const ctx = new Context()

    const registeredTools = new Map<string, ToolDefinition>()
    const registeredSections = new Map<string, PromptSection>()
    const registeredCommands = new Map<string, CommandDefinition>()

    ctx.provide('tools')
    ctx.tools = {
      register(def: ToolDefinition) {
        registeredTools.set(def.name, def)
        return () => {
          registeredTools.delete(def.name)
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

    // Mount Graphify plugin and await fiber activation
    const fiber = await ctx.plugin(GraphifyPlugin, {
      cwd: fixtureDir,
      autoDetect: true,
      enablePromptSection: true,
    })

    try {
      // 1. Verify prompt section registration
      assert.ok(registeredSections.has('graphify:guidance'))
      const promptSec = registeredSections.get('graphify:guidance')!
      assert.equal(promptSec.order, 250)
      const promptText = typeof promptSec.text === 'function' ? promptSec.text({}) : promptSec.text
      assert.ok(promptText.includes('Graphify Knowledge Graph'))
      assert.ok(promptText.includes('query_graph'))

      // 2. Verify all 10 tools are registered
      assert.equal(registeredTools.size, 10)
      const expectedTools = [
        'query_graph',
        'get_node',
        'get_neighbors',
        'get_community',
        'god_nodes',
        'graph_stats',
        'shortest_path',
        'list_prs',
        'get_pr_impact',
        'triage_prs',
      ]
      for (const name of expectedTools) {
        assert.ok(registeredTools.has(name), `Missing tool: ${name}`)
      }

      // 3. Verify /graphify slash command registration
      assert.ok(registeredCommands.has('graphify'))
      const cmd = registeredCommands.get('graphify')!
      assert.equal(cmd.name, 'graphify')

      // 4. Test executing graph_stats tool
      const statsTool = registeredTools.get('graph_stats')!
      const statsExecResult = (await statsTool.execute({}, { signal: new AbortController().signal })) as {
        text: string
        isError?: boolean
      }
      assert.equal(statsExecResult.isError, false)
      assert.ok(statsExecResult.text.includes('Nodes:'))
      const renderedBlocks = statsTool.output.render({}, statsExecResult)
      assert.ok(renderedBlocks.length > 0)
      assert.equal(renderedBlocks[0].type, 'text')

      // 5. Test executing god_nodes tool
      const godTool = registeredTools.get('god_nodes')!
      const godResult = (await godTool.execute({ top_n: 5 }, { signal: new AbortController().signal })) as {
        text: string
        isError?: boolean
      }
      assert.equal(godResult.isError, false)
      assert.ok(godResult.text.includes('God nodes'))

      // 6. Test executing shortest_path tool
      const pathTool = registeredTools.get('shortest_path')!
      const pathResult = (await pathTool.execute(
        { source: 'Events', target: 'Context' },
        { signal: new AbortController().signal }
      )) as { text: string; isError?: boolean }
      assert.equal(pathResult.isError, false)
      assert.ok(pathResult.text.length > 0)

      // 7. Test executing query_graph tool
      const queryTool = registeredTools.get('query_graph')!
      const queryResult = (await queryTool.execute(
        { question: 'What is Cordis?' },
        { signal: new AbortController().signal }
      )) as { text: string; isError?: boolean }
      assert.equal(queryResult.isError, false)
      assert.ok(queryResult.text.length > 0)

      // 8. Test executing get_node tool
      const nodeTool = registeredTools.get('get_node')!
      const nodeResult = (await nodeTool.execute(
        { label: 'Context' },
        { signal: new AbortController().signal }
      )) as { text: string; isError?: boolean }
      assert.equal(nodeResult.isError, false)
      assert.ok(nodeResult.text.length > 0)

      // 9. Test executing get_neighbors tool
      const neighborsTool = registeredTools.get('get_neighbors')!
      const neighborsResult = (await neighborsTool.execute(
        { label: 'Context' },
        { signal: new AbortController().signal }
      )) as { text: string; isError?: boolean }
      assert.equal(neighborsResult.isError, false)
      assert.ok(neighborsResult.text.length > 0)

      // 10. Test executing get_community tool
      const commTool = registeredTools.get('get_community')!
      const commResult = (await commTool.execute(
        { community_id: 0 },
        { signal: new AbortController().signal }
      )) as { text: string; isError?: boolean }
      assert.equal(commResult.isError, false)
      assert.ok(commResult.text.length > 0)
    } finally {
      // 11. Test graceful disposal and unregistration
      await fiber.dispose()
      assert.equal(registeredTools.size, 0, 'All tools should be unregistered upon plugin disposal')
      assert.equal(registeredSections.size, 0, 'Prompt section should be unregistered upon plugin disposal')
      assert.equal(registeredCommands.size, 0, 'Slash command should be unregistered upon plugin disposal')
    }
  })

  it('supports toolPrefix and disabled prompt section', async () => {
    const ctx = new Context()
    const registeredTools = new Map<string, ToolDefinition>()
    const registeredSections = new Map<string, PromptSection>()

    ctx.provide('tools')
    ctx.tools = {
      register(def: ToolDefinition) {
        registeredTools.set(def.name, def)
        return () => registeredTools.delete(def.name)
      },
    }

    ctx.provide('systemPrompt')
    ctx.systemPrompt = {
      section(sec: PromptSection) {
        registeredSections.set(sec.name, sec)
        return () => registeredSections.delete(sec.name)
      },
    }

    const fiber = await ctx.plugin(GraphifyPlugin, {
      cwd: fixtureDir,
      toolPrefix: 'kg_',
      enablePromptSection: false,
    })

    try {
      assert.equal(registeredSections.size, 0)
      assert.ok(registeredTools.has('kg_query_graph'))
      assert.ok(registeredTools.has('kg_graph_stats'))
    } finally {
      await fiber.dispose()
    }
  })
})
