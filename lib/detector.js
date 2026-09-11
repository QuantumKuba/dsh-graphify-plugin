import fs from 'node:fs';
import path from 'node:path';
/**
 * Probes for an existing Graphify knowledge graph starting at searchDir
 * and traversing upward to ancestor directories.
 *
 * @param searchDir - Starting directory (defaults to process.cwd()).
 * @param customGraphPath - Optional explicit graph.json or graphify-out directory path.
 * @returns DetectedGraph information or null if no graph is found.
 */
export function detectGraph(searchDir = process.cwd(), customGraphPath) {
    // 1. Explicit path given
    if (customGraphPath) {
        const resolved = path.resolve(searchDir, customGraphPath);
        try {
            const stats = fs.statSync(resolved);
            let graphJsonPath;
            let graphDir;
            if (stats.isDirectory()) {
                const directJson = path.join(resolved, 'graph.json');
                const outJson = path.join(resolved, 'graphify-out', 'graph.json');
                if (fs.existsSync(directJson)) {
                    graphJsonPath = directJson;
                    graphDir = resolved;
                }
                else if (fs.existsSync(outJson)) {
                    graphJsonPath = outJson;
                    graphDir = path.join(resolved, 'graphify-out');
                }
            }
            else if (stats.isFile() && path.basename(resolved) === 'graph.json') {
                graphJsonPath = resolved;
                graphDir = path.dirname(resolved);
            }
            if (graphJsonPath && graphDir) {
                // Authoritative project root resolution order:
                // 1. .graphify_root marker beside graph.json, if valid and points to an existing directory
                // 2. Canonical layout inference (path.basename(graphDir) === 'graphify-out' -> path.dirname(graphDir))
                // 3. Calling session root (searchDir), when evidence binds the graph to that project for noncanonical custom outputs
                // 4. Fallback: graphDir
                let projectRoot;
                const markerRoot = readValidGraphifyRoot(graphDir);
                if (markerRoot) {
                    projectRoot = markerRoot;
                }
                else if (path.basename(graphDir) === 'graphify-out') {
                    projectRoot = path.dirname(graphDir);
                }
                else if (isBoundToSearchDir(searchDir, customGraphPath, graphJsonPath)) {
                    projectRoot = path.resolve(searchDir);
                }
                else {
                    projectRoot = graphDir;
                }
                return buildDetectedGraph(projectRoot, graphJsonPath, graphDir);
            }
        }
        catch {
            // Path does not exist or cannot be accessed
        }
    }
    // 2. Upward traversal from searchDir
    let current = path.resolve(searchDir);
    const root = path.parse(current).root;
    while (current) {
        // Check <current>/graphify-out/graph.json
        const candidateOutDir = path.join(current, 'graphify-out');
        const candidateGraphJson = path.join(candidateOutDir, 'graph.json');
        if (fs.existsSync(candidateGraphJson)) {
            const markerRoot = readValidGraphifyRoot(candidateOutDir);
            return buildDetectedGraph(markerRoot || current, candidateGraphJson, candidateOutDir);
        }
        // Check if current is already graphify-out/
        if (path.basename(current) === 'graphify-out') {
            const inOutJson = path.join(current, 'graph.json');
            if (fs.existsSync(inOutJson)) {
                const markerRoot = readValidGraphifyRoot(current);
                return buildDetectedGraph(markerRoot || path.dirname(current), inOutJson, current);
            }
        }
        if (current === root)
            break;
        const parent = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return null;
}
/**
 * Checks whether evidence exists binding an explicit graph path to the calling session root.
 * Only binds if resolvedGraphPath is physically contained within searchDir.
 */
function isBoundToSearchDir(searchDir, _customGraphPath, resolvedGraphPath) {
    if (!searchDir)
        return false;
    const resolvedSearchDir = path.resolve(searchDir);
    try {
        if (!fs.existsSync(resolvedSearchDir) || !fs.statSync(resolvedSearchDir).isDirectory()) {
            return false;
        }
    }
    catch {
        return false;
    }
    // Bound ONLY when resolvedGraphPath is physically located inside searchDir
    const rel = path.relative(resolvedSearchDir, resolvedGraphPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return true;
    }
    return false;
}
/** Reads Graphify's optional authoritative scan-root marker. */
export function readValidGraphifyRoot(graphDir) {
    const markerPath = path.join(graphDir, '.graphify_root');
    try {
        if (!fs.existsSync(markerPath))
            return undefined;
        const raw = fs.readFileSync(markerPath, 'utf8').replace(/^\uFEFF/, '').trim();
        if (!raw)
            return undefined;
        const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(graphDir, raw);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
            return candidate;
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
function buildDetectedGraph(projectRoot, graphJsonPath, graphDir) {
    const reportPath = path.join(graphDir, 'GRAPH_REPORT.md');
    const wikiIndexPath = path.join(graphDir, 'wiki', 'index.md');
    const hasGraph = fs.existsSync(graphJsonPath);
    return {
        projectRoot,
        graphJsonPath,
        graphDir,
        reportPath: fs.existsSync(reportPath) ? reportPath : undefined,
        wikiIndexPath: fs.existsSync(wikiIndexPath) ? wikiIndexPath : undefined,
        hasGraph,
    };
}
