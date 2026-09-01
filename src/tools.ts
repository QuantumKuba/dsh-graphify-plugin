import type { Context } from '@deepseek-ai/cordis'
import type { GraphifyMcpClient } from './client.ts'
import type { Config } from './config.ts'
import type { DetectedGraph, ToolDefinition, ToolRunContext, ContentBlock, JsonSchemaNode } from './types.ts'

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
 * Creates Graphify's native tools plus capability and resource accessors.
 */
export function createGraphifyToolDefinitions(
  client: GraphifyMcpClient,
  config: Config,
  detectedGraph: DetectedGraph | null
): ToolDefinition[] {
  const prefix = config.toolPrefix || ''
  const defaultProjectPath = detectedGraph?.projectRoot || config.cwd || process.cwd()

  async function executeTool(
    rawName: string,
    rawArgs: Record<string, unknown>,
    execution?: ToolRunContext
  ): Promise<GraphifyToolOutput> {
    const args = { ...rawArgs }
    const agentProjectPath = execution?.agent?.session.header.cwd
    if (!args.project_path) {
      args.project_path = agentProjectPath || defaultProjectPath
    }

    try {
      const result = await client.callTool(rawName, args, execution?.signal, config.timeoutMs)
      const text = result.content?.map((c) => c.text || '').join('\n') || ''
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

  const definitions: ToolDefinition[] = [
    {
      name: `${prefix}query_graph`,
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
      execute: (args, exec) => executeTool('query_graph', (args as Record<string, unknown>) || {}, exec),
    },
    {
      name: `${prefix}get_node`,
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
      execute: (args, exec) => executeTool('get_node', (args as Record<string, unknown>) || {}, exec),
    },
    {
      name: `${prefix}get_neighbors`,
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
      execute: (args, exec) => executeTool('get_neighbors', (args as Record<string, unknown>) || {}, exec),
    },
    {
      name: `${prefix}get_community`,
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
      execute: (args, exec) => executeTool('get_community', (args as Record<string, unknown>) || {}, exec),
    },
    {
      name: `${prefix}god_nodes`,
      description: 'Return the most connected nodes - the core abstractions of the knowledge graph.',
      parameters: {
        type: 'object',
        properties: {
          top_n: { type: 'integer', default: 10, description: 'Number of top connected nodes to return' },
          project_path: { type: 'string', description: 'Absolute path to project directory. Defaults to workspace.' },
        },
      },
      output: { schema: COMMON_OUTPUT_SCHEMA, render: renderOutput },
      timeoutMs: config.timeoutMs,
      execute: (args, exec) => executeTool('god_nodes', (args as Record<string, unknown>) || {}, exec),
    },
    {
      name: `${prefix}graph_stats`,
      description: 'Return summary statistics: node count, edge count, communities, confidence breakdown.',
      parameters: {
        type: 'object',
        properties: {
          project_path: { type: 'string', description: 'Absolute path to project directory. Defaults to workspace.' },
        },
      },
      output: { schema: COMMON_OUTPUT_SCHEMA, render: renderOutput },
      timeoutMs: config.timeoutMs,
      execute: (args, exec) => executeTool('graph_stats', (args as Record<string, unknown>) || {}, exec),
    },
    {
      name: `${prefix}shortest_path`,
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
      execute: (args, exec) => executeTool('shortest_path', (args as Record<string, unknown>) || {}, exec),
    },
    {
      name: `${prefix}list_prs`,
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
    {
      name: `${prefix}get_pr_impact`,
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
    {
      name: `${prefix}triage_prs`,
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
  ]

  definitions.push(
    {
      name: `${prefix}graphify_capabilities`,
      description: 'List the Graphify MCP tools and resources supplied by the installed Graphify version.',
      parameters: { type: 'object', properties: {} },
      output: { schema: COMMON_OUTPUT_SCHEMA, render: renderOutput },
      timeoutMs: config.timeoutMs,
      execute: async (_args, exec) => {
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
    {
      name: `${prefix}graphify_call`,
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
    {
      name: `${prefix}graphify_resource`,
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
    }
  )

  return definitions
}

/**
 * Registers all Graphify tools into ctx.tools and returns a combined unregister disposer.
 */
export function registerGraphifyTools(
  ctx: Context,
  client: GraphifyMcpClient,
  config: Config,
  detectedGraph: DetectedGraph | null
): () => void {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    return () => {}
  }

  const definitions = createGraphifyToolDefinitions(client, config, detectedGraph)
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
