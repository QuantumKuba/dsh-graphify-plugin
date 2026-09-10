import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compareToolSchemas, getCanonicalGraphifyName } from '../src/schema-drift.ts'
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

  it('correctly maps prefixed native tools to upstream without false drift', () => {
    const prefixedNativeTools: ToolDefinition[] = baseNativeTools.map((tool) => ({
      ...tool,
      name: `graphify_${tool.name}`,
    }))

    const upstream: McpToolInfo[] = [
      {
        name: 'query_graph',
        inputSchema: {
          type: 'object',
          properties: { question: { type: 'string' }, depth: { type: 'integer' } },
          required: ['question'],
        },
      },
      {
        name: 'get_node',
        inputSchema: {
          type: 'object',
          properties: { label: { type: 'string' } },
          required: ['label'],
        },
      },
    ]

    const report = compareToolSchemas(prefixedNativeTools, upstream)
    assert.equal(report.hasBreakingDrift, false)
    assert.equal(report.breakingCount, 0)
  })

  it('detects breaking and informational enum changes', () => {
    const nativeToolsWithEnum: ToolDefinition[] = [
      {
        name: 'query_graph',
        description: 'Search graph',
        parameters: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['ast', 'semantic', 'hybrid'] },
          },
        },
        output: { schema: {}, render: () => [] },
        execute: () => Promise.resolve({}),
      },
    ]

    // Upstream dropped 'hybrid' (breaking change for callers relying on hybrid)
    const upstreamDroppedEnum: McpToolInfo[] = [
      {
        name: 'query_graph',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['ast', 'semantic'] },
          },
        },
      },
    ]

    const breakingReport = compareToolSchemas(nativeToolsWithEnum, upstreamDroppedEnum)
    assert.equal(breakingReport.hasBreakingDrift, true)
    const breakingDiff = breakingReport.differences.find((d) => d.kind === 'enum_changed')
    assert.ok(breakingDiff)
    assert.equal(breakingDiff?.severity, 'breaking')

    // Upstream added 'neural' (informational extension)
    const upstreamAddedEnum: McpToolInfo[] = [
      {
        name: 'query_graph',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['ast', 'semantic', 'hybrid', 'neural'] },
          },
        },
      },
    ]

    const infoReport = compareToolSchemas(nativeToolsWithEnum, upstreamAddedEnum)
    assert.equal(infoReport.hasBreakingDrift, false)
    const infoDiff = infoReport.differences.find((d) => d.kind === 'enum_changed')
    assert.ok(infoDiff)
    assert.equal(infoDiff?.severity, 'informational')
  })

  it('flags project_path removal as breaking drift', () => {
    const nativeWithProjectPath: ToolDefinition[] = [
      {
        name: 'query_graph',
        description: 'Search graph',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            project_path: { type: 'string' },
          },
        },
        output: { schema: {}, render: () => [] },
        execute: () => Promise.resolve({}),
      },
    ]

    const upstreamWithoutProjectPath: McpToolInfo[] = [
      {
        name: 'query_graph',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string' },
          },
        },
      },
    ]

    const report = compareToolSchemas(nativeWithProjectPath, upstreamWithoutProjectPath)
    assert.equal(report.hasBreakingDrift, true)
    const diff = report.differences.find((d) => d.detail.includes('project_path'))
    assert.ok(diff)
    assert.equal(diff?.kind, 'argument_removed')
    assert.equal(diff?.severity, 'breaking')
  })

  it('canonicalizes arbitrary prefix variants (g, abc, kg_, graphify_) and excludes plugin-local tools', () => {
    const prefixes = ['', 'graphify_', 'kg_', 'g', 'abc_']

    for (const prefix of prefixes) {
      // Upstream tools should resolve to their canonical names
      assert.equal(getCanonicalGraphifyName(`${prefix}query_graph`), 'query_graph')
      assert.equal(getCanonicalGraphifyName(`${prefix}get_node`), 'get_node')
      assert.equal(getCanonicalGraphifyName(`${prefix}get_neighbors`), 'get_neighbors')
      assert.equal(getCanonicalGraphifyName(`${prefix}get_community`), 'get_community')
      assert.equal(getCanonicalGraphifyName(`${prefix}god_nodes`), 'god_nodes')
      assert.equal(getCanonicalGraphifyName(`${prefix}graph_stats`), 'graph_stats')
      assert.equal(getCanonicalGraphifyName(`${prefix}shortest_path`), 'shortest_path')
      assert.equal(getCanonicalGraphifyName(`${prefix}list_prs`), 'list_prs')
      assert.equal(getCanonicalGraphifyName(`${prefix}get_pr_impact`), 'get_pr_impact')
      assert.equal(getCanonicalGraphifyName(`${prefix}triage_prs`), 'triage_prs')

      // Plugin-local tools must return null (excluded from drift checks)
      assert.equal(getCanonicalGraphifyName(`${prefix}graphify_status`), null)
      assert.equal(getCanonicalGraphifyName(`${prefix}graphify_capabilities`), null)
      assert.equal(getCanonicalGraphifyName(`${prefix}graphify_call`), null)
      assert.equal(getCanonicalGraphifyName(`${prefix}graphify_resource`), null)
      assert.equal(getCanonicalGraphifyName(`${prefix}graphify_project_resource`), null)
    }
  })

  it('detects enum added upstream as breaking restriction and enum removed upstream as informational widening', () => {
    // Case 1: Native has unconstrained string, upstream adds enum restriction -> breaking
    const unconstrainedNative: ToolDefinition[] = [
      {
        name: 'query_graph',
        description: 'Search',
        parameters: {
          type: 'object',
          properties: {
            strategy: { type: 'string' }, // unconstrained string
          },
        },
        output: { schema: {}, render: () => [] },
        execute: () => Promise.resolve({}),
      },
    ]
    const upstreamWithEnumRestriction: McpToolInfo[] = [
      {
        name: 'query_graph',
        inputSchema: {
          type: 'object',
          properties: {
            strategy: { type: 'string', enum: ['bfs', 'dfs'] },
          },
        },
      },
    ]

    const reportBreaking = compareToolSchemas(unconstrainedNative, upstreamWithEnumRestriction)
    assert.equal(reportBreaking.hasBreakingDrift, true)
    const breakingDiff = reportBreaking.differences.find((d) => d.kind === 'enum_changed')
    assert.ok(breakingDiff)
    assert.equal(breakingDiff?.severity, 'breaking')
    assert.match(breakingDiff?.detail || '', /Enum constraint added/)

    // Case 2: Native has enum restriction, upstream removes enum -> informational widening
    const reportWidening = compareToolSchemas(upstreamWithEnumRestriction.map((u) => ({
      name: u.name,
      description: '',
      parameters: u.inputSchema as any,
      output: { schema: {}, render: () => [] },
      execute: () => Promise.resolve({}),
    })), [
      {
        name: 'query_graph',
        inputSchema: {
          type: 'object',
          properties: {
            strategy: { type: 'string' }, // enum removed upstream
          },
        },
      },
    ])

    assert.equal(reportWidening.hasBreakingDrift, false)
    const wideningDiff = reportWidening.differences.find((d) => d.kind === 'enum_changed')
    assert.ok(wideningDiff)
    assert.equal(wideningDiff?.severity, 'informational')
    assert.match(wideningDiff?.detail || '', /Enum constraint removed/)
  })
})
