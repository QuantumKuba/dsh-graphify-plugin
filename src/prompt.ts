import type { Context } from '@deepseek-ai/cordis'
import type { PromptSection, DetectedGraph, ResolvedProject } from './types.ts'
import type { Config } from './config.ts'
import { getPrefixedToolName } from './tools.ts'
import { ProjectResolver } from './project-resolver.ts'

/**
 * Creates the Graphify decision policy prompt section for coding agents.
 *
 * Formulates a clear decision workflow (when to query, when to read source, when to stop),
 * dynamically honoring configured tool prefixes, compact/full tool modes, and project status.
 */
export function createGraphifyPromptSection(
  _detectedGraph?: DetectedGraph | ResolvedProject | null,
  config?: Config,
  _resolver?: ProjectResolver
): PromptSection {
  const prefix = config?.toolPrefix || ''
  const isCompact = config?.toolMode === 'compact'

  const findTool = getPrefixedToolName('find_code', prefix)
  const queryTool = getPrefixedToolName('query_graph', prefix)
  const nodeTool = getPrefixedToolName('get_node', prefix)
  const neighborsTool = getPrefixedToolName('get_neighbors', prefix)
  const pathTool = getPrefixedToolName('shortest_path', prefix)
  const statusTool = getPrefixedToolName('graphify_status', prefix)
  const projectResourceTool = getPrefixedToolName('graphify_project_resource', prefix)

  return {
    name: 'graphify:guidance',
    order: 250,
    text: () => {
      if (isCompact) {
        return [
          '## Graphify navigation',
          '',
          `If relevant source paths are unknown, call \`${findTool}\` once with the whole question. Then inspect only promising source locations and continue with filesystem tools.`,
          'Do not list directories before this call or repeat graph lookup after paths are found. If results are missing or irrelevant, use targeted filesystem search. Source is authoritative.',
        ].join('\n')
      }

      const lines: string[] = [
        '## Graphify navigation',
        '',
        `Unknown file: use \`${nodeTool}\` for a known symbol, otherwise \`${queryTool}\` once (depth 1-2). A familiar symbol is not a verified path.`,
        `Read returned source locations, expanding as needed. Stop graph lookup once located. Empty or irrelevant result: use targeted filesystem search.`,
        `For impact use \`${neighborsTool}\` with a relation filter; verify edge direction and callers in source. Missing edges do not prove absence. \`${pathTool}\` traces connections, not execution order.`,
        `Call \`${statusTool}\` only after a missing, stale, or failed graph result, not before every query.`,
        'Use filesystem tools directly when the exact path is supplied or already verified in this session. Source is authoritative.',
      ]

      const godTool = getPrefixedToolName('god_nodes', prefix)
      const commTool = getPrefixedToolName('get_community', prefix)
      const prImpactTool = getPrefixedToolName('get_pr_impact', prefix)
      lines.push(
        `Use \`${godTool}\` for hubs, \`${commTool}\` for module boundaries, and \`${prImpactTool}\` or \`${getPrefixedToolName('list_prs', prefix)}\` for pull-request impact.`,
        `Use \`${projectResourceTool}\` only when a pre-generated report or wiki is specifically needed.`
      )

      return lines.join('\n')
    },
  }
}

/**
 * Registers the Graphify prompt section on ctx.systemPrompt if available.
 */
export function registerGraphifyPrompt(
  ctx: Context,
  detectedGraph?: DetectedGraph | ResolvedProject | null,
  config?: Config,
  resolver?: ProjectResolver
): () => void {
  if (!ctx.systemPrompt || typeof ctx.systemPrompt.section !== 'function') {
    return () => {}
  }

  const section = createGraphifyPromptSection(detectedGraph, config, resolver)
  return ctx.systemPrompt.section(section)
}
