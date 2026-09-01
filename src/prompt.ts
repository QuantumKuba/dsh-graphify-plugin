import type { Context } from '@deepseek-ai/cordis'
import type { PromptSection, DetectedGraph } from './types.ts'

/**
 * Creates the Graphify system prompt guidance section.
 */
export function createGraphifyPromptSection(detectedGraph: DetectedGraph | null): PromptSection {
  return {
    name: 'graphify:guidance',
    order: 250,
    text: () => {
      let base = `## Graphify Knowledge Graph

This workspace has access to a Graphify knowledge graph with god nodes, community structures, and cross-file relationships.

When navigating, understanding architecture, or planning changes:
- Use \`query_graph\` to perform BFS/DFS traversals for natural language questions and concept exploration.
- Use \`god_nodes\` to discover central architectural abstractions and high-degree hub nodes.
- Use \`shortest_path\` to trace direct dependency and call relationships between two symbols or files.
- Use \`get_neighbors\` and \`get_node\` for detailed inspection of specific nodes and their connections.
- Use \`get_community\` to inspect module members and architectural cluster boundaries.
- Use \`list_prs\`, \`get_pr_impact\`, and \`triage_prs\` when reviewing GitHub pull requests and assessing blast radius.
- Use \`graphify_resource\` for the report, confidence audit, and other Graphify resources.
- Use \`graphify_capabilities\` before \`graphify_call\` when a newer Graphify version exposes a tool without a dedicated DSH definition.

Rules:
- Query the graph before performing large unindexed codebase sweeps when investigating architecture.
- If \`project_path\` is omitted, the graph tools resolve against the calling session’s project directory.`

      if (detectedGraph?.reportPath) {
        base += `\n- A detailed report is available at \`${detectedGraph.reportPath}\`.`
      }
      if (detectedGraph?.wikiIndexPath) {
        base += `\n- Structured wiki index is available at \`${detectedGraph.wikiIndexPath}\`.`
      }

      return base
    },
  }
}

/**
 * Registers the Graphify prompt section on ctx.systemPrompt if available.
 */
export function registerGraphifyPrompt(
  ctx: Context,
  detectedGraph: DetectedGraph | null
): () => void {
  if (!ctx.systemPrompt || typeof ctx.systemPrompt.section !== 'function') {
    return () => {}
  }

  const section = createGraphifyPromptSection(detectedGraph)
  return ctx.systemPrompt.section(section)
}
