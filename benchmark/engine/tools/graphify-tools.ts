import path from 'node:path'
import { GraphifyMcpClient } from '../../../src/client.ts'
import { resolveGraphifyCommand } from '../../../src/server-process.ts'
import { Config } from '../../../src/config.ts'

export interface GraphifyTools {
  query_graph: (args: { question: string; depth?: number; token_budget?: number }) => Promise<{ text: string; error?: string }>
  get_node: (args: { node_id: string }) => Promise<{ text: string; error?: string }>
  get_neighbors: (args: { node_id: string; direction?: 'in' | 'out' | 'both' }) => Promise<{ text: string; error?: string }>
  shortest_path: (args: { source: string; target: string }) => Promise<{ text: string; error?: string }>
  graphify_status: () => Promise<{ text: string; error?: string }>
  god_nodes: (args?: { limit?: number }) => Promise<{ text: string; error?: string }>
  destroy: () => Promise<void>
}

/**
 * Creates live Graphify tools connecting to the target repository's knowledge graph.
 */
export async function createGraphifyTools(targetRepoDir: string): Promise<GraphifyTools> {
  const graphJsonPath = path.join(targetRepoDir, 'graphify-out', 'graph.json')
  const config = Config({ command: 'auto' })
  const resolved = resolveGraphifyCommand(config, graphJsonPath)

  const client = new GraphifyMcpClient({
    ...resolved,
    cwd: targetRepoDir,
    timeoutMs: 30_000,
  })

  await client.init()

  const safeCall = async (toolName: string, args: Record<string, unknown> = {}) => {
    try {
      const res = await client.callTool(toolName, args)
      const text = res.content?.map((c) => c.text || '').join('\n') || ''
      return { text, error: res.isError ? 'TOOL_ERROR' : undefined }
    } catch (err) {
      return { text: `Error calling ${toolName}: ${String(err)}`, error: 'CALL_FAILED' }
    }
  }

  return {
    query_graph: (args) => safeCall('query_graph', args),
    get_node: (args) => safeCall('get_node', args),
    get_neighbors: (args) => safeCall('get_neighbors', args),
    shortest_path: (args) => safeCall('shortest_path', args),
    graphify_status: () => safeCall('graphify_status', {}),
    god_nodes: (args = {}) => safeCall('god_nodes', args),
    destroy: async () => {
      await client.dispose()
    },
  }
}
