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

/**
 * Compares known native Graphify tool schemas against the upstream tools/list result.
 * Distinguishes between informational additions (new optional tools or parameters) and
 * breaking drift affecting native first-class tool contracts.
 */
export function compareToolSchemas(
  nativeTools: readonly ToolDefinition[],
  upstreamTools: readonly McpToolInfo[]
): SchemaDriftReport {
  const differences: SchemaDifference[] = []

  // Filter out plugin-owned local extension tools that don't exist upstream
  const pluginLocalTools = new Set([
    'graphify_status',
    'graphify_capabilities',
    'graphify_call',
    'graphify_resource',
  ])

  const nativeMap = new Map<string, ToolDefinition>()
  for (const tool of nativeTools) {
    if (!pluginLocalTools.has(tool.name)) {
      nativeMap.set(tool.name, tool)
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
      }
    }

    for (const propName of Object.keys(nativeProps)) {
      if (!(propName in upstreamProps)) {
        // Ignore plugin's internal parameter injection (project_path) if upstream handles it via cwd/session
        if (propName === 'project_path') continue

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
