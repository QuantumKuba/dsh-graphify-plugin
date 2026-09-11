import { getPrefixedToolName } from "./tools.js";
/**
 * Creates the Graphify decision policy prompt section for coding agents.
 *
 * Formulates a clear decision workflow (when to query, when to read source, when to stop),
 * dynamically honoring configured tool prefixes, compact/full tool modes, and project status.
 */
export function createGraphifyPromptSection(_detectedGraph, config, _resolver) {
    const prefix = config?.toolPrefix || '';
    const isCompact = config?.toolMode === 'compact';
    const queryTool = getPrefixedToolName('query_graph', prefix);
    const nodeTool = getPrefixedToolName('get_node', prefix);
    const neighborsTool = getPrefixedToolName('get_neighbors', prefix);
    const pathTool = getPrefixedToolName('shortest_path', prefix);
    const statusTool = getPrefixedToolName('graphify_status', prefix);
    const projectResourceTool = getPrefixedToolName('graphify_project_resource', prefix);
    return {
        name: 'graphify:guidance',
        order: 250,
        text: () => {
            const lines = [
                '## Graphify Knowledge Graph & Decision Policy',
                '',
                'This workspace provides access to a local Graphify knowledge graph for structural navigation, dependency analysis, and architecture exploration.',
                '',
                '### Decision Policy: When to use Graphify',
                `- High-level architecture or concept discovery: use \`${queryTool}\` (BFS for broad context, DFS for deep traces).`,
                `- Exact symbol or interface details: use \`${nodeTool}\` with symbol label or ID.`,
                `- Direct callers, callees, or dependencies: use \`${neighborsTool}\`.`,
                `- Relationship or call path between two modules: use \`${pathTool}\`.`,
                `- Graph usability, freshness, or git sync status: use \`${statusTool}\`.`,
            ];
            if (!isCompact) {
                const godTool = getPrefixedToolName('god_nodes', prefix);
                const commTool = getPrefixedToolName('get_community', prefix);
                const prImpactTool = getPrefixedToolName('get_pr_impact', prefix);
                lines.push(`- Core abstractions and high-degree hub nodes: use \`${godTool}\`.`, `- Cluster and module boundaries: use \`${commTool}\`.`, `- Pull request review & blast radius: use \`${prImpactTool}\` or \`${getPrefixedToolName('list_prs', prefix)}\`.`);
            }
            lines.push(`- Pre-generated reports and audits: use \`${projectResourceTool}\` (e.g. \`resource: 'report'\` or \`resource: 'wiki'\`).`, '', '### Authoritative Source Principle', '1. **Navigation first, source files authoritative**: Use Graphify to pinpoint relevant directories and files, then read the actual source files for implementation details.', '2. **Never edit blind**: Do NOT modify code based solely on graph descriptions without reading the real source file.', '3. **Stop querying early**: Once you locate the relevant code or have enough evidence, proceed directly with file inspection or edits. Avoid redundant graph queries.', '4. **Trivial tasks**: For simple single-file edits or obvious locations, use direct filesystem tools rather than Graphify.');
            lines.push('', '### Session Reports & Diagnostics', `- Use \`${statusTool}\` to inspect graph status, report locations, and freshness for the active workspace.`, `- When available in the workspace, refer to \`graphify-out/GRAPH_REPORT.md\` and \`graphify-out/wiki/index.md\` for structural overviews.`);
            return lines.join('\n');
        },
    };
}
/**
 * Registers the Graphify prompt section on ctx.systemPrompt if available.
 */
export function registerGraphifyPrompt(ctx, detectedGraph, config, resolver) {
    if (!ctx.systemPrompt || typeof ctx.systemPrompt.section !== 'function') {
        return () => { };
    }
    const section = createGraphifyPromptSection(detectedGraph, config, resolver);
    return ctx.systemPrompt.section(section);
}
