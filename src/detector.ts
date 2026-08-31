import fs from 'node:fs'
import path from 'node:path'
import type { DetectedGraph } from './types.ts'

/**
 * Probes for an existing Graphify knowledge graph starting at searchDir
 * and traversing upward to ancestor directories.
 *
 * @param searchDir - Starting directory (defaults to process.cwd()).
 * @param customGraphPath - Optional explicit graph.json or graphify-out directory path.
 * @returns DetectedGraph information or null if no graph is found.
 */
export function detectGraph(
  searchDir: string = process.cwd(),
  customGraphPath?: string
): DetectedGraph | null {
  // 1. Explicit path given
  if (customGraphPath) {
    const resolved = path.resolve(searchDir, customGraphPath)
    try {
      const stats = fs.statSync(resolved)
      if (stats.isDirectory()) {
        const directJson = path.join(resolved, 'graph.json')
        const outJson = path.join(resolved, 'graphify-out', 'graph.json')
        if (fs.existsSync(directJson)) {
          return buildDetectedGraph(path.dirname(resolved), directJson, resolved)
        }
        if (fs.existsSync(outJson)) {
          return buildDetectedGraph(resolved, outJson, path.join(resolved, 'graphify-out'))
        }
      } else if (stats.isFile()) {
        const graphDir = path.dirname(resolved)
        const projectRoot = path.basename(graphDir) === 'graphify-out' ? path.dirname(graphDir) : graphDir
        return buildDetectedGraph(projectRoot, resolved, graphDir)
      }
    } catch {
      // Path does not exist or cannot be accessed
    }
  }

  // 2. Upward traversal from searchDir
  let current = path.resolve(searchDir)
  const root = path.parse(current).root

  while (current) {
    // Check <current>/graphify-out/graph.json
    const candidateOutDir = path.join(current, 'graphify-out')
    const candidateGraphJson = path.join(candidateOutDir, 'graph.json')
    if (fs.existsSync(candidateGraphJson)) {
      return buildDetectedGraph(current, candidateGraphJson, candidateOutDir)
    }

    // Check if current is already graphify-out/
    if (path.basename(current) === 'graphify-out') {
      const inOutJson = path.join(current, 'graph.json')
      if (fs.existsSync(inOutJson)) {
        return buildDetectedGraph(path.dirname(current), inOutJson, current)
      }
    }

    // Check if .graphify_root exists
    const candidateRootMarker = path.join(current, '.graphify_root')
    if (fs.existsSync(candidateRootMarker)) {
      const markerOutDir = path.join(current, 'graphify-out')
      const markerJson = path.join(markerOutDir, 'graph.json')
      return buildDetectedGraph(current, markerJson, markerOutDir)
    }

    if (current === root) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  return null
}

function buildDetectedGraph(projectRoot: string, graphJsonPath: string, graphDir: string): DetectedGraph {
  const reportPath = path.join(graphDir, 'GRAPH_REPORT.md')
  const wikiIndexPath = path.join(graphDir, 'wiki', 'index.md')
  const hasGraph = fs.existsSync(graphJsonPath)

  return {
    projectRoot,
    graphJsonPath,
    graphDir,
    reportPath: fs.existsSync(reportPath) ? reportPath : undefined,
    wikiIndexPath: fs.existsSync(wikiIndexPath) ? wikiIndexPath : undefined,
    hasGraph,
  }
}
