import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
// Test loading from built lib distribution
import * as GraphifyBuiltPlugin from '../lib/index.js'
import type { ToolDefinition, PromptSection } from '../lib/types/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(__dirname, 'fixtures', 'sample-project')
const serverPath = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs')

describe('Built Library Distribution', () => {
  it('loads built plugin and executes tools successfully', async () => {
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

    const fiber = await ctx.plugin(GraphifyBuiltPlugin, {
      cwd: fixtureDir,
      command: process.execPath,
      args: [serverPath],
      autoDetect: true,
      enablePromptSection: true,
    })

    try {
      assert.equal(registeredTools.size, 13)
      assert.ok(registeredSections.has('graphify:guidance'))

      const statsTool = registeredTools.get('graph_stats')!
      const result = (await statsTool.execute({}, { signal: new AbortController().signal })) as {
        text: string
        isError?: boolean
      }
      assert.equal(result.isError, false)
      assert.ok(result.text.includes('graph_stats'))
    } finally {
      await fiber.dispose()
      assert.equal(registeredTools.size, 0)
      assert.equal(registeredSections.size, 0)
    }
  })
})
