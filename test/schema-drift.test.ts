import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compareToolSchemas } from '../src/schema-drift.ts'
import type { ToolDefinition, McpToolInfo } from '../src/types.ts'

describe('Schema Drift Detection', () => {
  const baseNativeTools: ToolDefinition[] = [
    {
      name: 'query_graph',
      description: 'Search graph',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          depth: { type: 'integer' },
        },
        required: ['question'],
      },
      output: { schema: {}, render: () => [] },
      execute: () => Promise.resolve({}),
    },
    {
      name: 'get_node',
      description: 'Get node',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string' },
        },
        required: ['label'],
      },
      output: { schema: {}, render: () => [] },
      execute: () => Promise.resolve({}),
    },
  ]

  it('reports no drift when upstream matches native tools', () => {
    const upstream: McpToolInfo[] = [
      {
        name: 'query_graph',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            depth: { type: 'integer' },
          },
          required: ['question'],
        },
      },
      {
        name: 'get_node',
        inputSchema: {
          type: 'object',
          properties: {
            label: { type: 'string' },
          },
          required: ['label'],
        },
      },
    ]

    const report = compareToolSchemas(baseNativeTools, upstream)
    assert.equal(report.hasBreakingDrift, false)
    assert.equal(report.breakingCount, 0)
    assert.equal(report.informationalCount, 0)
  })

  it('flags newly added upstream tools as informational', () => {
    const upstream: McpToolInfo[] = [
      {
        name: 'query_graph',
        inputSchema: { type: 'object', properties: { question: { type: 'string' }, depth: { type: 'integer' } }, required: ['question'] },
      },
      {
        name: 'get_node',
        inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
      },
      {
        name: 'future_semantic_search',
        description: 'New tool in newer Graphify',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ]

    const report = compareToolSchemas(baseNativeTools, upstream)
    assert.equal(report.hasBreakingDrift, false)
    assert.equal(report.informationalCount, 1)
    assert.equal(report.differences[0].kind, 'tool_added')
    assert.equal(report.differences[0].severity, 'informational')
  })

  it('flags missing native tool as breaking drift', () => {
    const upstream: McpToolInfo[] = [
      {
        name: 'query_graph',
        inputSchema: { type: 'object', properties: { question: { type: 'string' }, depth: { type: 'integer' } }, required: ['question'] },
      },
      // get_node is missing
    ]

    const report = compareToolSchemas(baseNativeTools, upstream)
    assert.equal(report.hasBreakingDrift, true)
    assert.equal(report.breakingCount, 1)
    assert.equal(report.differences[0].kind, 'tool_removed')
    assert.equal(report.differences[0].severity, 'breaking')
  })

  it('flags new required parameter on existing tool as breaking drift', () => {
    const upstream: McpToolInfo[] = [
      {
        name: 'query_graph',
        inputSchema: {
          type: 'object',
          properties: { question: { type: 'string' }, depth: { type: 'integer' } },
          required: ['question', 'depth'], // depth is now required!
        },
      },
      {
        name: 'get_node',
        inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
      },
    ]

    const report = compareToolSchemas(baseNativeTools, upstream)
    assert.equal(report.hasBreakingDrift, true)
    assert.ok(report.differences.some((d) => d.kind === 'required_argument_changed' && d.severity === 'breaking'))
  })

  it('flags argument type changes as breaking drift', () => {
    const upstream: McpToolInfo[] = [
      {
        name: 'query_graph',
        inputSchema: {
          type: 'object',
          properties: { question: { type: 'string' }, depth: { type: 'string' } }, // depth changed from integer to string!
          required: ['question'],
        },
      },
      {
        name: 'get_node',
        inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
      },
    ]

    const report = compareToolSchemas(baseNativeTools, upstream)
    assert.equal(report.hasBreakingDrift, true)
    assert.ok(report.differences.some((d) => d.kind === 'type_changed' && d.severity === 'breaking'))
  })
})
