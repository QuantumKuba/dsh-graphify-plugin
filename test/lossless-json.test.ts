import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { toLosslessJson } from '../src/lossless-json.ts'
import { Config } from '../src/config.ts'
import { GraphifyMcpClient } from '../src/client.ts'
import { ProjectResolver } from '../src/project-resolver.ts'
import { createGraphifyToolDefinitions } from '../src/tools.ts'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(__dirname, 'fixtures', 'sample-project')
const serverPath = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs')

function createTestToolRuntime() {
  const ctx = new Context()
  ;(ctx as any).systemPrompt = { tools: () => {} }
  return new ToolRuntime(ctx)
}

describe('Lossless JSON serialization & tool output contract', () => {
  it('strips undefined properties from object hierarchies', () => {
    const input = {
      a: 1,
      b: undefined,
      nested: {
        c: 'test',
        d: undefined,
        deep: {
          e: null,
          f: undefined,
        },
      },
    }

    // Direct input fails snapshotJsonValue
    assert.equal(snapshotJsonValue(input), undefined)

    const sanitized = toLosslessJson(input)
    assert.deepEqual(sanitized, {
      a: 1,
      nested: {
        c: 'test',
        deep: {
          e: null,
        },
      },
    })
    assert.notEqual(snapshotJsonValue(sanitized), undefined)
  })

  it('normalizes negative zero (-0) to positive zero (0)', () => {
    const input = { val: -0 }
    assert.equal(snapshotJsonValue(input), undefined) // DSH rejects -0

    const sanitized = toLosslessJson(input)
    assert.equal(Object.is(sanitized.val, 0), true)
    assert.equal(Object.is(sanitized.val, -0), false)
    assert.notEqual(snapshotJsonValue(sanitized), undefined)
  })

  it('normalizes NaN and Infinity to null', () => {
    const input = { nan: NaN, inf: Infinity, negInf: -Infinity }
    assert.equal(snapshotJsonValue(input), undefined)

    const sanitized = toLosslessJson(input)
    assert.deepEqual(sanitized, { nan: null, inf: null, negInf: null })
    assert.notEqual(snapshotJsonValue(sanitized), undefined)
  })

  it('handles circular references gracefully without throwing', () => {
    const circular: Record<string, unknown> = { name: 'circular' }
    circular.self = circular

    const result = toLosslessJson(circular)
    assert.ok(result)
    assert.equal(result.isError, true)
    assert.notEqual(snapshotJsonValue(result), undefined)
  })

  it('executes graphify_status in DSH ToolRuntime without ToolOutputError (clean/existing graph)', async () => {
    const config = Config({
      command: process.execPath,
      args: [serverPath],
      cwd: fixtureDir,
    })
    const client = new GraphifyMcpClient(config)
    const resolver = new ProjectResolver(config)
    const project = resolver.resolve({ explicitPath: fixtureDir })

    const runtime = createTestToolRuntime()
    const definitions = createGraphifyToolDefinitions(client, config, project, resolver)

    for (const def of definitions) {
      runtime.register(def as any)
    }

    try {
      const execResult = (await runtime.execute({
        callId: 'call_test_status_1' as any,
        name: 'graphify_status',
        arguments: {},
        signal: new AbortController().signal,
      })) as { isError: boolean; content: Array<{ text: string }>; value?: unknown }

      assert.equal(execResult.isError, false)
      assert.ok(execResult.content && execResult.content.length > 0)
      assert.ok(!execResult.content[0].text.includes('value is not lossless JSON'))
      assert.notEqual(snapshotJsonValue(execResult.value), undefined)
    } finally {
      await client.dispose()
    }
  })

  it('executes graphify_status in DSH ToolRuntime for workspace with missing graph without ToolOutputError', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-missing-status-'))
    const config = Config({
      command: process.execPath,
      args: [serverPath],
      cwd: tempDir,
      allowExternalProjects: true,
    })
    const client = new GraphifyMcpClient(config)
    const resolver = new ProjectResolver(config)
    const project = resolver.resolve({ explicitPath: tempDir })

    const runtime = createTestToolRuntime()
    const definitions = createGraphifyToolDefinitions(client, config, project, resolver)

    for (const def of definitions) {
      runtime.register(def as any)
    }

    try {
      await client.init()
      const execResult = (await runtime.execute({
        callId: 'call_test_status_missing' as any,
        name: 'graphify_status',
        arguments: { project_path: tempDir },
        signal: new AbortController().signal,
      })) as { isError: boolean; content: Array<{ text: string }>; value?: any }

      assert.equal(execResult.isError, false)
      assert.ok(!execResult.content[0].text.includes('value is not lossless JSON'))
      assert.equal(execResult.value.overall, 'missing')
      assert.equal(execResult.value.graphExists, false)
      assert.equal(execResult.value.graphPath, undefined)
      assert.notEqual(snapshotJsonValue(execResult.value), undefined)
    } finally {
      await client.dispose()
      try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {}
    }
  })

  it('executes query_graph in DSH ToolRuntime without ToolOutputError', async () => {
    const config = Config({
      command: process.execPath,
      args: [serverPath],
      cwd: fixtureDir,
    })
    const client = new GraphifyMcpClient(config)
    const resolver = new ProjectResolver(config)
    const project = resolver.resolve({ explicitPath: fixtureDir })

    const runtime = createTestToolRuntime()
    const definitions = createGraphifyToolDefinitions(client, config, project, resolver)

    for (const def of definitions) {
      runtime.register(def as any)
    }

    try {
      const execResult = (await runtime.execute({
        callId: 'call_test_query_1' as any,
        name: 'query_graph',
        arguments: { question: 'authentication' },
        signal: new AbortController().signal,
      })) as { isError: boolean; content: Array<{ text: string }>; value?: unknown }

      assert.equal(execResult.isError, false)
      assert.ok(!execResult.content[0].text.includes('value is not lossless JSON'))
      assert.notEqual(snapshotJsonValue(execResult.value), undefined)
    } finally {
      await client.dispose()
    }
  })

  it('executes graphify_capabilities in DSH ToolRuntime without ToolOutputError', async () => {
    const config = Config({
      command: process.execPath,
      args: [serverPath],
      cwd: fixtureDir,
    })
    const client = new GraphifyMcpClient(config)
    const resolver = new ProjectResolver(config)
    const project = resolver.resolve({ explicitPath: fixtureDir })

    const runtime = createTestToolRuntime()
    const definitions = createGraphifyToolDefinitions(client, config, project, resolver)

    for (const def of definitions) {
      runtime.register(def as any)
    }

    try {
      const execResult = (await runtime.execute({
        callId: 'call_test_capabilities_1' as any,
        name: 'graphify_capabilities',
        arguments: {},
        signal: new AbortController().signal,
      })) as { isError: boolean; content: Array<{ text: string }>; value?: unknown }

      assert.equal(execResult.isError, false)
      assert.ok(!execResult.content[0].text.includes('value is not lossless JSON'))
      assert.notEqual(snapshotJsonValue(execResult.value), undefined)
    } finally {
      await client.dispose()
    }
  })
})
