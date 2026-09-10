import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from './config.ts'
import type {
  ResolvedProject,
  GraphifyStatusResult,
  GraphifyOverallStatus,
} from './types.ts'
import type { GraphifyMcpClient } from './client.ts'
import { checkGraphFreshness } from './freshness.ts'
import { getRuntimeInfo } from './server-process.ts'

/**
 * Collects a comprehensive status report for Graphify in the given project/session.
 * Non-destructive and fault-tolerant: failure of any individual metric does not fail
 * the entire diagnostic response.
 */
export function collectGraphifyStatus(
  project: ResolvedProject,
  client: GraphifyMcpClient,
  config: Config
): GraphifyStatusResult {
  const runtime = getRuntimeInfo(config)
  const mcpState = client.getConnectionState()
  const recentStderr = client.getRecentStderr()
  const freshness = checkGraphFreshness(project)

  // 1. Graph metrics
  let nodeCount: number | null = null
  let edgeCount: number | null = null
  let communityCount: number | null = null
  let lastModified: string | null = null

  if (project.hasGraph && project.graphJsonPath) {
    try {
      const stat = fs.statSync(project.graphJsonPath)
      lastModified = stat.mtime.toISOString()

      // Avoid reading multi-gigabyte files entirely into memory
      if (stat.size < 50 * 1024 * 1024) {
        const raw = fs.readFileSync(project.graphJsonPath, 'utf8')
        const data = JSON.parse(raw) as {
          nodes?: Array<{ community?: number }>
          links?: unknown[]
          edges?: unknown[]
        }
        if (Array.isArray(data.nodes)) {
          nodeCount = data.nodes.length
          const communities = new Set<number>()
          for (const node of data.nodes) {
            if (typeof node.community === 'number') {
              communities.add(node.community)
            }
          }
          communityCount = communities.size
        }
        if (Array.isArray(data.links)) {
          edgeCount = data.links.length
        } else if (Array.isArray(data.edges)) {
          edgeCount = data.edges.length
        }
      }
    } catch {
      // Diagnostic metric degradation handled gracefully
    }
  }

  // 2. Git status
  let git: GraphifyStatusResult['git'] = null
  try {
    const headRes = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: project.projectRoot,
      encoding: 'utf8',
      timeout: 2000,
    })
    if (headRes.status === 0 && headRes.stdout.trim()) {
      const head = headRes.stdout.trim()
      const branchRes = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: project.projectRoot,
        encoding: 'utf8',
        timeout: 2000,
      })
      const branch = branchRes.status === 0 ? branchRes.stdout.trim() : null

      const dirtyRes = spawnSync('git', ['status', '--porcelain'], {
        cwd: project.projectRoot,
        encoding: 'utf8',
        timeout: 2000,
      })
      const isDirty = dirtyRes.status === 0 ? dirtyRes.stdout.trim().length > 0 : null

      git = {
        head,
        branch,
        isDirty,
      }
    }
  } catch {
    // Git not available or not a git repository
  }

  // 3. Compute overall status
  let overall: GraphifyOverallStatus = 'unknown'

  if (mcpState === 'error') {
    overall = 'error'
  } else if (!project.hasGraph) {
    overall = 'missing'
  } else if (runtime.source === 'unknown' && mcpState !== 'connected') {
    overall = 'unavailable'
  } else if (freshness.state === 'stale') {
    overall = 'stale'
  } else if (project.hasGraph && (mcpState === 'connected' || mcpState === 'disconnected')) {
    overall = 'healthy'
  }

  return {
    overall,
    projectRoot: project.projectRoot,
    graphPath: project.graphJsonPath,
    graphExists: project.hasGraph,
    nodeCount,
    edgeCount,
    communityCount,
    lastModified,
    git,
    freshness,
    runtime,
    mcp: {
      state: mcpState,
      recentStderr: recentStderr || undefined,
    },
  }
}

/**
 * Formats a GraphifyStatusResult into a clear, scannable text summary for models and humans.
 */
export function formatGraphifyStatus(status: GraphifyStatusResult): string {
  const badge = status.overall.toUpperCase()
  const lines: string[] = [`Graphify Status: ${badge}`]

  lines.push(`• Project Root: ${status.projectRoot}`)

  if (status.graphExists && status.graphPath) {
    const counts: string[] = []
    if (status.nodeCount !== null) counts.push(`${status.nodeCount.toLocaleString()} nodes`)
    if (status.edgeCount !== null) counts.push(`${status.edgeCount.toLocaleString()} edges`)
    if (status.communityCount !== null) counts.push(`${status.communityCount} communities`)
    const countsStr = counts.length > 0 ? ` (${counts.join(', ')})` : ''
    lines.push(`• Knowledge Graph: ${status.graphPath}${countsStr}`)
  } else {
    lines.push('• Knowledge Graph: MISSING (graphify-out/graph.json not found)')
  }

  if (status.lastModified) {
    lines.push(`• Last Indexed: ${status.lastModified}`)
  }

  lines.push(`• Graph Freshness: ${status.freshness.state.toUpperCase()}${status.freshness.reason ? ` - ${status.freshness.reason}` : ''}`)

  if (status.freshness.changedFilesSample && status.freshness.changedFilesSample.length > 0) {
    lines.push(`  Changed files: ${status.freshness.changedFilesSample.join(', ')}${(status.freshness.changedFilesCount ?? 0) > 5 ? ' ...' : ''}`)
  }

  if (status.git) {
    const dirty = status.git.isDirty ? 'dirty working tree' : 'clean'
    const branch = status.git.branch ? ` (${status.git.branch})` : ''
    lines.push(`• Git Repository: commit ${status.git.head}${branch}, ${dirty}`)
  }

  lines.push(`• Runtime: ${status.runtime.command} [${status.runtime.source}]`)
  lines.push(`• MCP State: ${status.mcp.state}`)

  if (status.mcp.recentStderr) {
    const trimmed = status.mcp.recentStderr.trim()
    if (trimmed) {
      lines.push(`• Diagnostics (recent stderr): ${trimmed.split('\n').slice(-3).join(' ')}`)
    }
  }

  // Actionable advice
  lines.push('')
  if (status.overall === 'missing') {
    lines.push('Recommendation: Run `/graphify` or `graphify .` in the project root to generate the knowledge graph.')
  } else if (status.overall === 'stale') {
    lines.push('Recommendation: Run `/graphify update` or `graphify update .` to sync recent code modifications into the graph.')
  } else if (status.overall === 'error' || status.overall === 'unavailable') {
    lines.push('Recommendation: Verify Graphify installation with `uv tool install "graphifyy[mcp]"` or configure `command` in cordis.yml.')
  } else {
    lines.push('Graph is usable and ready for architectural and dependency queries.')
  }

  return lines.join('\n')
}
