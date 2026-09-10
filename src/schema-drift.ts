import type { ToolDefinition, McpToolInfo, JsonSchemaNode } from './types.ts'

export type DriftKind =
  | 'tool_added'
  | 'tool_removed'
  | 'argument_added'
  | 'argument_removed'
  | 'required_argument_changed'
  | 'type_changed'
  | 'enum_changed'

export type DriftSeverity = 'breaking' | 'informational'

export interface SchemaDifference {
  readonly tool: string
  readonly kind: DriftKind
  readonly severity: DriftSeverity
  readonly detail: string
}

export interface SchemaDriftReport {
  readonly differences: readonly SchemaDifference[]
  readonly breakingCount: number
  readonly informationalCount: number
  readonly hasBreakingDrift: boolean
  readonly summary: string
}

const PLUGIN_LOCAL_TOOLS = new Set([
  'graphify_status',
  'graphify_capabilities',
  'graphify_call',
  'graphify_resource',
])

const CANONICAL_GRAPHIFY_TOOLS = [
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
] as const

/**
 * Resolves the canonical Graphify tool name from a potentially prefixed DSH tool name.
 * Returns null if the tool is a plugin-local utility that does not exist upstream.
 */
export function getCanonicalGraphifyName(toolName: string): string | null {
  if (PLUGIN_LOCAL_TOOLS.has(toolName)) return null
  for (const local of PLUGIN_LOCAL_TOOLS) {
    if (toolName.endsWith(`_${local}`)) return null
  }

  for (const canonical of CANONICAL_GRAPHIFY_TOOLS) {
    if (toolName === canonical || toolName.endsWith(`_${canonical}`)) {
      return canonical
    }
  }

  return toolName
}

/**
 * Compares known native Graphify tool schemas against the upstream tools/list result.
 * Distinguishes between informational additions (new optional tools or parameters) and
 * breaking drift affecting native first-class tool contracts.
 *
 * Normalizes tool prefixes before comparing so configured prefixes do not cause false drifts.
 */
export function compareToolSchemas(
  nativeTools: readonly ToolDefinition[],
  upstreamTools: readonly McpToolInfo[]
): SchemaDriftReport {
  const differences: SchemaDifference[] = []

  const nativeMap = new Map<string, ToolDefinition>()
  for (const tool of nativeTools) {
    const canonical = getCanonicalGraphifyName(tool.name)
    if (canonical) {
      nativeMap.set(canonical, tool)
    }
  }

  const upstreamMap = new Map<string, McpToolInfo>()
  for (const tool of upstreamTools) {
    upstreamMap.set(tool.name, tool)
  }

  // 1. Check for removed tools (breaking)
  for (const [name] of nativeMap) {
    if (!upstreamMap.has(name)) {
      differences.push({
        tool: name,
        kind: 'tool_removed',
        severity: 'breaking',
        detail: `Native tool '${name}' is missing from upstream tools/list.`,
      })
    }
  }

  // 2. Check for added tools upstream (informational)
  for (const [name] of upstreamMap) {
    if (!nativeMap.has(name)) {
      differences.push({
        tool: name,
        kind: 'tool_added',
        severity: 'informational',
        detail: `New tool '${name}' found upstream. Accessible via graphify_call / graphify_capabilities.`,
      })
    }
  }

  // 3. Diff argument schemas for common tools
  for (const [name, nativeDef] of nativeMap) {
    const upstream = upstreamMap.get(name)
    if (!upstream) continue

    const nativeParams = (nativeDef.parameters || {}) as JsonSchemaNode
    const upstreamSchema = (upstream.inputSchema || {}) as JsonSchemaNode

    const nativeProps = (nativeParams.properties || {}) as Record<string, JsonSchemaNode>
    const upstreamProps = (upstreamSchema.properties || {}) as Record<string, JsonSchemaNode>

    const nativeRequired = new Set(nativeParams.required || [])
    const upstreamRequired = new Set(upstreamSchema.required || [])

    // Check required arguments changes
    for (const req of upstreamRequired) {
      if (!nativeRequired.has(req)) {
        differences.push({
          tool: name,
          kind: 'required_argument_changed',
          severity: 'breaking',
          detail: `Argument '${req}' is required upstream but was not required natively.`,
        })
      }
    }
    for (const req of nativeRequired) {
      if (!upstreamRequired.has(req)) {
        differences.push({
          tool: name,
          kind: 'required_argument_changed',
          severity: 'informational',
          detail: `Argument '${req}' is no longer required upstream.`,
        })
      }
    }

    // Check properties drift
    for (const propName of Object.keys(upstreamProps)) {
      if (!(propName in nativeProps)) {
        differences.push({
          tool: name,
          kind: 'argument_added',
          severity: 'informational',
          detail: `New optional argument '${propName}' added to upstream tool '${name}'.`,
        })
      } else {
        // Compare types
        const nativeType = nativeProps[propName]?.type
        const upstreamType = upstreamProps[propName]?.type
        if (nativeType && upstreamType && nativeType !== upstreamType) {
          differences.push({
            tool: name,
            kind: 'type_changed',
            severity: 'breaking',
            detail: `Argument '${propName}' in '${name}' changed type from '${String(nativeType)}' to '${String(upstreamType)}'.`,
          })
        }

        // Compare enums
        const nativeEnum = nativeProps[propName]?.enum
        const upstreamEnum = upstreamProps[propName]?.enum
        if (Array.isArray(nativeEnum) || Array.isArray(upstreamEnum)) {
          const nativeEnumSet = new Set(nativeEnum ?? [])
          const upstreamEnumSet = new Set(upstreamEnum ?? [])

          for (const val of nativeEnumSet) {
            if (!upstreamEnumSet.has(val)) {
              differences.push({
                tool: name,
                kind: 'enum_changed',
                severity: 'breaking',
                detail: `Enum value '${String(val)}' in argument '${propName}' for tool '${name}' is no longer supported upstream.`,
              })
            }
          }
          for (const val of upstreamEnumSet) {
            if (!nativeEnumSet.has(val)) {
              differences.push({
                tool: name,
                kind: 'enum_changed',
                severity: 'informational',
                detail: `New upstream enum value '${String(val)}' added to argument '${propName}' for tool '${name}'.`,
              })
            }
          }
        }
      }
    }

    // Check removed properties - do NOT ignore project_path
    for (const propName of Object.keys(nativeProps)) {
      if (!(propName in upstreamProps)) {
        differences.push({
          tool: name,
          kind: 'argument_removed',
          severity: 'breaking',
          detail: `Native argument '${propName}' removed from upstream tool '${name}'.`,
        })
      }
    }
  }

  const breakingCount = differences.filter((d) => d.severity === 'breaking').length
  const informationalCount = differences.filter((d) => d.severity === 'informational').length
  const hasBreakingDrift = breakingCount > 0

  const summary = [
    `Schema drift analysis: ${breakingCount} breaking difference(s), ${informationalCount} informational addition(s).`,
    ...differences.map((d) => `  [${d.severity.toUpperCase()}] ${d.tool}: ${d.detail}`),
  ].join('\n')

  return {
    differences,
    breakingCount,
    informationalCount,
    hasBreakingDrift,
    summary,
  }
}
