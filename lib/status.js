import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { checkGraphFreshness } from "./freshness.js";
import { getRuntimeInfo, DEFAULT_GRAPHIFY_VERSION } from "./server-process.js";
import { getPackageVersion } from "./version.js";
/**
 * Collects a comprehensive status report for Graphify in the given project/session.
 * Non-destructive and fault-tolerant: failure of any individual metric does not fail
 * the entire diagnostic response.
 */
export async function collectGraphifyStatus(project, client, config, options) {
    const runtime = getRuntimeInfo(config);
    let mcpState = client.getConnectionState();
    // Proactively probe MCP connectivity if requested and currently disconnected
    if (options?.probe && mcpState === 'disconnected') {
        try {
            await client.init();
            mcpState = client.getConnectionState();
        }
        catch {
            mcpState = client.getConnectionState();
        }
    }
    const recentStderr = client.getRecentStderr();
    const freshness = checkGraphFreshness(project);
    // 1. Graph metrics
    let nodeCount = null;
    let edgeCount = null;
    let communityCount = null;
    let lastModified = null;
    if (project.hasGraph && project.graphJsonPath) {
        try {
            const stat = fs.statSync(project.graphJsonPath);
            lastModified = stat.mtime.toISOString();
            // Avoid reading multi-gigabyte files entirely into memory
            if (stat.size < 50 * 1024 * 1024) {
                const raw = fs.readFileSync(project.graphJsonPath, 'utf8');
                const data = JSON.parse(raw);
                if (Array.isArray(data.nodes)) {
                    nodeCount = data.nodes.length;
                    const communities = new Set();
                    for (const node of data.nodes) {
                        if (typeof node.community === 'number') {
                            communities.add(node.community);
                        }
                    }
                    communityCount = communities.size;
                }
                if (Array.isArray(data.links)) {
                    edgeCount = data.links.length;
                }
                else if (Array.isArray(data.edges)) {
                    edgeCount = data.edges.length;
                }
            }
        }
        catch {
            // Diagnostic metric degradation handled gracefully
        }
    }
    // 2. Git status
    let git = null;
    try {
        const headRes = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
            cwd: project.projectRoot,
            encoding: 'utf8',
            timeout: 2000,
        });
        if (headRes.status === 0 && headRes.stdout.trim()) {
            const head = headRes.stdout.trim();
            const branchRes = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
                cwd: project.projectRoot,
                encoding: 'utf8',
                timeout: 2000,
            });
            const branch = branchRes.status === 0 ? branchRes.stdout.trim() : null;
            const dirtyRes = spawnSync('git', ['status', '--porcelain'], {
                cwd: project.projectRoot,
                encoding: 'utf8',
                timeout: 2000,
            });
            const isDirty = dirtyRes.status === 0 ? dirtyRes.stdout.trim().length > 0 : null;
            git = {
                head,
                branch,
                isDirty,
            };
        }
    }
    catch {
        // Git not available or not a git repository
    }
    // 3. Compute overall status with strict semantic guarantees.
    // Active MCP connection is stronger evidence than runtime.source; a connected
    // server is reachable regardless of how its binary was resolved.
    let overall = 'unknown';
    if (mcpState === 'error') {
        overall = 'error';
    }
    else if (runtime.source === 'unknown') {
        overall = 'unavailable';
    }
    else if (mcpState === 'connecting' || mcpState === 'reconnecting') {
        overall = 'unavailable';
    }
    else if (!project.hasGraph) {
        overall = 'missing';
    }
    else if (mcpState === 'connected') {
        if (freshness.state === 'stale') {
            overall = 'stale';
        }
        else if (freshness.state === 'fresh') {
            overall = 'healthy';
        }
        else {
            overall = 'unknown';
        }
    }
    else if (mcpState === 'disconnected') {
        overall = 'unprobed';
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
            reconnectAttempts: client.getReconnectAttempts(),
            maxReconnectAttempts: client.getMaxReconnectAttempts(),
            recentStderr: recentStderr || undefined,
        },
    };
}
/**
 * Formats a GraphifyStatusResult into a clear, scannable text summary for models and humans.
 */
export function formatGraphifyStatus(status) {
    const badge = status.overall.toUpperCase();
    const lines = [`Graphify Status: ${badge}`];
    lines.push(`• Plugin: dsh-graphify v${getPackageVersion()}`);
    lines.push(`• Project Root: ${status.projectRoot}`);
    if (status.graphExists && status.graphPath) {
        const counts = [];
        if (status.nodeCount !== null)
            counts.push(`${status.nodeCount.toLocaleString()} nodes`);
        if (status.edgeCount !== null)
            counts.push(`${status.edgeCount.toLocaleString()} edges`);
        if (status.communityCount !== null)
            counts.push(`${status.communityCount} communities`);
        const countsStr = counts.length > 0 ? ` (${counts.join(', ')})` : '';
        lines.push(`• Knowledge Graph: ${status.graphPath}${countsStr}`);
    }
    else {
        lines.push('• Knowledge Graph: MISSING (graphify-out/graph.json not found)');
    }
    if (status.lastModified) {
        lines.push(`• Last Indexed: ${status.lastModified}`);
    }
    lines.push(`• Graph Freshness: ${status.freshness.state.toUpperCase()}${status.freshness.reason ? ` - ${status.freshness.reason}` : ''}`);
    if (status.freshness.strategy) {
        lines.push(`  Inspection Strategy: ${status.freshness.strategy}`);
    }
    if (status.freshness.metadataVersion !== undefined) {
        const baselineStr = status.freshness.baselineAvailable ? 'per-path baseline available' : 'legacy baseline (requires full rebuild)';
        lines.push(`  Metadata: v${status.freshness.metadataVersion} (${baselineStr})`);
    }
    if (status.freshness.isCanonicalTarget === false) {
        lines.push('  Target: Custom non-canonical graph path');
    }
    if (status.freshness.autoUpdateBlockReason) {
        lines.push(`  Auto-Update Blocked: ${status.freshness.autoUpdateBlockReason}`);
    }
    if (status.freshness.changedFilesSample && status.freshness.changedFilesSample.length > 0) {
        lines.push(`  Changed files: ${status.freshness.changedFilesSample.join(', ')}${(status.freshness.changedFilesCount ?? 0) > 5 ? ' ...' : ''}`);
    }
    if (status.git) {
        const dirty = status.git.isDirty ? 'dirty working tree' : 'clean';
        const branch = status.git.branch ? ` (${status.git.branch})` : '';
        lines.push(`• Git Repository: commit ${status.git.head}${branch}, ${dirty}`);
    }
    const runtimeVer = status.runtime.version ? ` (v${status.runtime.version})` : '';
    lines.push(`• Runtime: ${status.runtime.command} [${status.runtime.source}]${runtimeVer}`);
    const reconnectInfo = status.mcp.state === 'reconnecting'
        ? ` (attempt ${status.mcp.reconnectAttempts}/${status.mcp.maxReconnectAttempts})`
        : '';
    lines.push(`• MCP State: ${status.mcp.state}${reconnectInfo}`);
    if (status.mcp.recentStderr) {
        const trimmed = status.mcp.recentStderr.trim();
        if (trimmed) {
            lines.push(`• Diagnostics (recent stderr): ${trimmed.split('\n').slice(-3).join(' ')}`);
        }
    }
    // Actionable advice strictly matching semantic health state
    lines.push('');
    if (status.overall === 'healthy') {
        lines.push('Graph is verified, connected, and ready for architectural and dependency queries.');
    }
    else if (status.overall === 'stale') {
        if (status.freshness.baselineAvailable === false) {
            lines.push('Recommendation: Graph is stale; freshness metadata predates source-state tracking. Run a full Graphify build (`/graphify build` or `graphify .`) to establish a trustworthy baseline.');
        }
        else if (status.freshness.autoUpdateEligible === false) {
            lines.push('Recommendation: Graph is stale with unsupported changes. Run a full Graphify build (`/graphify build` or `graphify .`) to refresh all source and semantic entities.');
        }
        else {
            lines.push('Recommendation: Graph is stale. Run `/graphify update` or `graphify update .` to sync recent code modifications into the graph.');
        }
    }
    else if (status.overall === 'missing') {
        lines.push('Recommendation: Graph is missing. Run `/graphify build` or `graphify .` in the project root to generate the knowledge graph.');
    }
    else if (status.overall === 'unprobed') {
        lines.push('Recommendation: MCP server has not been probed yet. Execute a query tool or probe connectivity to verify health.');
    }
    else if (status.overall === 'error') {
        lines.push('Recommendation: Graphify MCP server encountered an error. Check diagnostics above or verify Python/uv environment.');
    }
    else if (status.overall === 'unavailable') {
        if (status.mcp.state === 'reconnecting') {
            lines.push('Recommendation: MCP connection is recovering. Graphify will be available when reconnection succeeds.');
        }
        else {
            lines.push(`Recommendation: Graphify runtime is unavailable. Verify installation with \`uv tool install 'graphifyy[mcp]==${DEFAULT_GRAPHIFY_VERSION}'\` or configure \`command\` in cordis.yml.`);
        }
    }
    else {
        lines.push('Recommendation: Graph state is unknown. Inspect graphify-out/ and run `/graphify build` if needed.');
    }
    return lines.join('\n');
}
