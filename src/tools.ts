import type { Context } from '@deepseek-ai/cordis'
import type { GraphifyMcpClient } from './client.ts'
import type { Config } from './config.ts'
import type {
  DetectedGraph,
  ResolvedProject,
  ToolDefinition,
  ToolRunContext,
  ContentBlock,
  JsonSchemaNode,
  ToolMode,
} from './types.ts'
import { ProjectResolver } from './project-resolver.ts'
import { checkGraphFreshness, ProjectUpdateCoalescer } from './freshness.ts'
import { collectGraphifyStatus, formatGraphifyStatus } from './status.ts'

export interface GraphifyToolOutput {
  text: string
  isError?: boolean
  meta?: unknown
}

const COMMON_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Rendered text output from the Graphify knowledge graph' },
    isError: { type: 'boolean', description: 'Whether the operation resulted in an error' },
  },
  required: ['text'],
}

function renderOutput(_args: unknown, value: unknown): ContentBlock[] {
  if (value && typeof value === 'object' && 'text' in value) {
    const text = String((value as GraphifyToolOutput).text || '')
    return [{ type: 'text', text }]
  }
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

/**
 * Resolves the prefixed tool name consistently, preventing double-prefixing.
 * e.g. prefix 'graphify_' + 'query_graph' -> 'graphify_query_graph'
 *      prefix 'graphify_' + 'graphify_status' -> 'graphify_status'
 *      prefix '' + 'graphify_status' -> 'graphify_status'
 */
export function getPrefixedToolName(baseName: string, prefix: string): string {
  if (!prefix) return baseName
  if (baseName.startsWith(prefix)) return baseName
  return `${prefix}${baseName}`
}

/**
 * Creates Graphify's native tools, doctor tool, plus capability and resource accessors.
 */
export function createGraphifyToolDefinitions(
  client: GraphifyMcpClient,
  config: Config,
  detectedGraph?: DetectedGraph | ResolvedProject | null,
  customResolver?: ProjectResolver
): ToolDefinition[] {
  const prefix = config.toolPrefix || ''
  const resolver = customResolver ?? new ProjectResolver(config)
  const coalescer = new ProjectUpdateCoalescer()

  async function executeTool(
    rawName: string,
    rawArgs: Record<string, unknown>,
    execution?: ToolRunContext,
    isQueryTool = false
  ): Promise<GraphifyToolOutput> {
    const args = { ...rawArgs }
    const project = resolver.resolve({
      explicitPath: typeof args.project_path === 'string' ? args.project_path : undefined,
      toolContext: execution,
    })

    if (!args.project_path) {
      args.project_path = project.projectRoot
    }

    let stalenessNotice = ''

    // Handle freshness checks and auto-updates for query tools
    if (isQueryTool && project.hasGraph) {
      const freshnessMode = config.freshness?.mode ?? 'warn'
      if (freshnessMode === 'warn') {
        const freshness = checkGraphFreshness(project)
        if (freshness.state === 'stale') {
          stalenessNotice = `[Notice: Graph may be stale (${freshness.reason}). Real source files remain authoritative.]\n\n`
        }
      } else if (freshnessMode === 'auto') {
        const freshness = checkGraphFreshness(project)
        if (freshness.state === 'stale') {
          const updateRes = await coalescer.update(config, project.projectRoot, execution?.signal)
          if (updateRes.success) {
            resolver.invalidate(project.projectRoot)
          } else {
            stalenessNotice = `[Notice: Auto-update failed (${updateRes.error || updateRes.stderr.trim()}). Using current graph.]\n\n`
          }
        }
      }
    }

    try {
      const result = await client.callTool(rawName, args, execution?.signal, config.timeoutMs)
      const rawText = result.content?.map((c) => c.text || '').join('\n') || ''
      const text = stalenessNotice ? `${stalenessNotice}${rawText}` : rawText
      return {
        text,
        isError: result.isError || false,
        meta: result,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        text: `Error executing ${rawName}: ${message}`,
        isError: true,
      }
    }
  }

  const allDefinitions: ToolDefinition[] = [
    // 1. query_graph
    {
      name: getPrefixedToolName('query_graph', prefix),
      description: 'Search the knowledge graph using BFS or DFS. Returns relevant nodes and edges as text context.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Natural language question or keyword search' },
          mode: { type: 'string', enum: ['bfs', 'dfs'], default: 'bfs', description: 'bfs=broad context, dfs=trace a specific path' },
          depth: { type: 'integer', default: 3, description: 'Traversal depth (1-6)' },
          token_budget: { type: 'integer', default: 2000, description: 'Max output tokens' },
          context_filter: { type: 'array', items: { type: 'string' }, description: 'Optional explicit edge-context filter, e.g. ["call", "field"]' },
          project_path: { type: 'string', description: 'Absolute path to project directory. Defaults to workspace.' },
        },
        required: ['question'],
      },
      output: { schema: COMMON_OUTPUT_SCHEMA, render: renderOutput },
      timeoutMs: config.timeoutMs,
      execute: (args, exec) => executeTool('query_graph', (args as Record<string, unknown>) || {}, exec, true),
    },

    // 2. get_node
    {
      name: getPrefixedToolName('get_node', prefix),
      description: 'Get full details for a specific node by label or ID.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Node label or ID to look up' },
          project_path: { type: 'string', description: 'Absolute path to project directory. Defaults to workspace.' },
        },
        required: ['label'],
      },
      output: { schema: COMMON_OUTPUT_SCHEMA, render: renderOutput },
      timeoutMs: config.timeoutMs,
      execute: (args, exec) => executeTool('get_node', (args as Record<string, unknown>) || {}, exec, true),
    },

    // 3. get_neighbors
    {
      name: getPrefixedToolName('get_neighbors', prefix),
      description: 'Get all direct neighbors of a node with edge details.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Node label or ID' },
          relation_filter: { type: 'string', description: 'Optional filter by relation type' },
          token_budget: { type: 'integer', default: 2000, description: 'Max output tokens' },
          project_path: { type: 'string', description: 'Absolute path to project directory. Defaults to workspace.' },
        },
        required: ['label'],
      },
      output: { schema: COMMON_OUTPUT_SCHEMA, render: renderOutput },
      timeoutMs: config.timeoutMs,
      execute: (args, exec) => executeTool('get_neighbors', (args as Record<string, unknown>) || {}, exec, true),
    },

    // 4. shortest_path
    {
      name: getPrefixedToolName('shortest_path', prefix),
      description: 'Find the shortest path between two concepts in the knowledge graph.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source concept label or keyword' },
          target: { type: 'string', description: 'Target concept label or keyword' },
          max_hops: { type: 'integer', default: 8, description: 'Maximum hops to consider' },
          undirected: { type: 'boolean', default: false, description: 'Ignore stored edge direction when searching' },
          project_path: { type: 'string', description: 'Absolute path to project directory. Defaults to workspace.' },
        },
        required: ['source', 'target'],
      },
      output: { schema: COMMON_OUTPUT_SCHEMA, render: renderOutput },
      timeoutMs: config.timeoutMs,
      execute: (args, exec) => executeTool('shortest_path', (args as Record<string, unknown>) || {}, exec, true),
    },

    // 5. graphify_status (First-class doctor / health tool)
    {
      name: getPrefixedToolName('graphify_status', prefix),
      description: 'Inspect Graphify health, graph existence, freshness, node/edge counts, git synchronization, and MCP connectivity for this workspace.',
      parameters: {
        type: 'object',
        properties: {
          project_path: { type: 'string', description: 'Absolute path to project directory. Defaults to current session workspace.' },
        },
      },
      output: { schema: COMMON_OUTPUT_SCHEMA, render: renderOutput },
      timeoutMs: config.timeoutMs,
      execute: (_args, exec) => {
        const rawArgs = (_args as Record<string, unknown>) || {}
        const project = resolver.resolve({
          explicitPath: typeof rawArgs.project_path === 'string' ? rawArgs.project_path : undefined,
          toolContext: exec,
        })
        const status = collectGraphifyStatus(project, client, config)
        const text = formatGraphifyStatus(status)
        return Promise.resolve({
          text,
          isError: status.overall === 'error',
          meta: status,
        } satisfies GraphifyToolOutput)
      },
    },

    // 6. get_community
    {
      name: getPrefixedToolName('get_community', prefix),
      description: 'Get all nodes in a community by community ID.',
      parameters: {
        type: 'object',
        properties: {
          community_id: { type: 'integer', description: 'Community ID (0-indexed by size)' },
          token_budget: { type: 'integer', default: 2000, description: 'Max output tokens' },
          project_path: { type: 'string', description: 'Absolute path to project directory. Defaults to workspace.' },
        },
        required: ['community_id'],
      },
      output: { schema: COMMON_OUTPUT_SCHEMA, render: renderOutput },
      timeoutMs: config.timeoutMs,
      execute: (args, exec) => executeTool('get_community', (args as Record<string, unknown>) || {}, exec, true),
    },

    // 7. god_nodes
    {
      name: getPrefixedToolName('god_nodes', prefix),
      description: 'Return the most connected nodes - the core abstractions of the knowledge graph.',
      parameters: {
        type: 'object',
        properties: {
          top_n: { type: 'integer', default: 10, description: 'Number of top connected nodes to return' },
          exclude_hubs_percentile: {
            type: 'number',
            description: 'Suppress nodes whose degree exceeds this percentile (0-100) of the degree distribution, matching cluster() hub exclusion',
          },
          project_path: { type: 'string', description: 'Absolute path to project directory. Defaults to workspace.' },
        },
      },
      output: { schema: COMMON_OUTPUT_SCHEMA, render: renderOutput },
      timeoutMs: config.timeoutMs,
      execute: (args, exec) => executeTool('god_nodes', (args as Record<string, unknown>) || {}, exec, true),
    },

    // 8. graph_stats
    {
      name: getPrefixedToolName('graph_stats', prefix),
      description: 'Return summary statistics: node count, edge count, communities, confidence breakdown.',
      parameters: {
        type: 'object',
        properties: {
          project_path: { type: 'string', description: 'Absolute path to project directory. Defaults to workspace.' },
        },
      },
      output: { schema: COMMON_OUTPUT_SCHEMA, render: renderOutput },
      timeoutMs: config.timeoutMs,
      execute: (args, exec) => executeTool('graph_stats', (args as Record<string, unknown>) || {}, exec, true),
    },

    // 9. list_prs
    {
      name: getPrefixedToolName('list_prs', prefix),
      description: 'List open GitHub PRs with CI status, review state, and graph impact (which communities each PR touches, blast radius).',
      parameters: {
        type: 'object',
        properties: {
          base: { type: 'string', description: 'Base branch to filter PRs by (auto-detected if omitted)' },
          repo: { type: 'string', description: 'GitHub repo (owner/repo). Defaults to current repo.' },
          project_path: { type: 'string', description: 'Absolute path to project directory. Defaults to workspace.' },
        },
      },
      output: { schema: COMMON_OUTPUT_SCHEMA, render: renderOutput },
      timeoutMs: config.timeoutMs,
      execute: (args, exec) => executeTool('list_prs', (args as Record<string, unknown>) || {}, exec),
    },

    // 10. get_pr_impact
    {
      name: getPrefixedToolName('get_pr_impact', prefix),
      description: 'Get detailed graph impact for a specific PR: which files it changes, which knowledge-graph communities are affected, and how many nodes are touched.',
      parameters: {
        type: 'object',
        properties: {
          pr_number: { type: 'integer', description: 'PR number to analyze' },
          repo: { type: 'string', description: 'GitHub repo (owner/repo). Defaults to current repo.' },
          project_path: { type: 'string', description: 'Absolute path to project directory. Defaults to workspace.' },
        },
        required: ['pr_number'],
      },
      output: { schema: COMMON_OUTPUT_SCHEMA, render: renderOutput },
      timeoutMs: config.timeoutMs,
      execute: (args, exec) => executeTool('get_pr_impact', (args as Record<string, unknown>) || {}, exec),
    },

    // 11. triage_prs
    {
      name: getPrefixedToolName('triage_prs', prefix),
      description: 'Return all actionable open PRs with full graph impact data to reason about review priority, merge order, and conflict risk.',
      parameters: {
        type: 'object',
        properties: {
          base: { type: 'string', description: 'Base branch to filter PRs by (auto-detected if omitted)' },
          repo: { type: 'string', description: 'GitHub repo (owner/repo). Defaults to current repo.' },
          project_path: { type: 'string', description: 'Absolute path to project directory. Defaults to workspace.' },
        },
      },
      output: { schema: COMMON_OUTPUT_SCHEMA, render: renderOutput },
      timeoutMs: config.timeoutMs,
      execute: (args, exec) => executeTool('triage_prs', (args as Record<string, unknown>) || {}, exec),
    },

    // 12. graphify_resource
    {
      name: getPrefixedToolName('graphify_resource', prefix),
      description: 'Read a Graphify MCP resource, including reports and analyses. Use graphify_capabilities to list resource URIs.',
      parameters: {
        type: 'object',
        properties: { uri: { type: 'string', description: 'Exact Graphify MCP resource URI.' } },
        required: ['uri'],
      },
      output: { schema: COMMON_OUTPUT_SCHEMA, render: renderOutput },
      timeoutMs: config.timeoutMs,
      execute: async (args, exec) => {
        const uri = (args as { uri: string }).uri
        try {
          const resource = await client.readResource(uri, exec.signal, config.timeoutMs)
          return {
            text: resource.contents.map((content) => content.text || content.blob || '').join('\n'),
            meta: resource,
          } satisfies GraphifyToolOutput
        } catch (error) {
          return { text: `Error reading Graphify resource: ${String(error)}`, isError: true }
        }
      },
    },

    // 13. graphify_capabilities
    {
      name: getPrefixedToolName('graphify_capabilities', prefix),
      description: 'List the Graphify MCP tools and resources supplied by the installed Graphify version.',
      parameters: { type: 'object', properties: {} },
      output: { schema: COMMON_OUTPUT_SCHEMA, render: renderOutput },
      timeoutMs: config.timeoutMs,
      execute: async (_args) => {
        try {
          const [tools, resources] = await Promise.all([client.listTools(), client.listResources()])
          return {
            text: JSON.stringify({ tools, resources }, null, 2),
            meta: { tools, resources },
          } satisfies GraphifyToolOutput
        } catch (error) {
          return { text: `Error listing Graphify capabilities: ${String(error)}`, isError: true }
        }
      },
    },

    // 14. graphify_call
    {
      name: getPrefixedToolName('graphify_call', prefix),
      description: 'Call an installed Graphify MCP tool that is not natively exposed by this plugin. Use graphify_capabilities first.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact Graphify MCP tool name.' },
          arguments: { type: 'object', description: 'Arguments matching the tool schema.' },
        },
        required: ['name'],
      },
      output: { schema: COMMON_OUTPUT_SCHEMA, render: renderOutput },
      timeoutMs: config.timeoutMs,
      execute: (args, exec) => {
        const input = (args as { name: string; arguments?: Record<string, unknown> }) || { name: '' }
        return executeTool(input.name, input.arguments || {}, exec)
      },
    },
  ]

  // Filter tools based on toolMode
  const toolMode: ToolMode = config.toolMode || 'full'
  if (toolMode === 'compact') {
    const compactToolBaseNames = new Set([
      'query_graph',
      'get_node',
      'get_neighbors',
      'shortest_path',
      'graphify_status',
      'graphify_resource',
    ])
    return allDefinitions.filter((def) => {
      // Find matching base name
      for (const base of compactToolBaseNames) {
        if (def.name === getPrefixedToolName(base, prefix)) {
          return true
        }
      }
      return false
    })
  }

  return allDefinitions
}

/**
 * Registers all configured Graphify tools into ctx.tools and returns a combined unregister disposer.
 */
export function registerGraphifyTools(
  ctx: Context,
  client: GraphifyMcpClient,
  config: Config,
  detectedGraph?: DetectedGraph | ResolvedProject | null,
  resolver?: ProjectResolver
): () => void {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    return () => {}
  }

  const definitions = createGraphifyToolDefinitions(client, config, detectedGraph, resolver)
  const disposers: Array<() => void> = []

  for (const def of definitions) {
    const unregister = ctx.tools.register(def)
    if (typeof unregister === 'function') {
      disposers.push(unregister)
    }
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // Ignore unregister errors
      }
    }
  }
}
