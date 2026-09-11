/** Plugin-local tool suffixes — these exist only in dsh-graphify and do not correspond to upstream Graphify MCP tools. */
const PLUGIN_LOCAL_SUFFIXES = [
    'graphify_status',
    'graphify_capabilities',
    'graphify_call',
    'graphify_resource',
    'graphify_project_resource',
];
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
];
/**
 * Resolves the canonical Graphify tool name from a potentially prefixed DSH tool name.
 * Returns null if the tool is a plugin-local utility that does not exist upstream.
 *
 * Handles arbitrary prefix lengths by checking whether the tool name, after stripping
 * the prefix, matches a canonical upstream tool name or a plugin-local suffix.
 */
export function getCanonicalGraphifyName(toolName) {
    // Exact match against plugin-local suffixes (covers both unprefixed and
    // prefix-coincidental matches like 'graphify_status' with prefix 'graphify_')
    for (const local of PLUGIN_LOCAL_SUFFIXES) {
        if (toolName === local)
            return null;
    }
    // Exact match against canonical upstream names
    for (const canonical of CANONICAL_GRAPHIFY_TOOLS) {
        if (toolName === canonical)
            return canonical;
    }
    // The tool name has some prefix. Try stripping progressively to find a
    // canonical or plugin-local match. We try all possible prefix lengths.
    // Guard: reject if the prefix itself ends with a canonical name, since
    // that indicates a collision (e.g. "get_node_query_graph" should NOT
    // resolve to "query_graph" when "get_node" is also canonical).
    for (const canonical of CANONICAL_GRAPHIFY_TOOLS) {
        if (toolName.endsWith(canonical) && toolName.length > canonical.length) {
            const prefix = toolName.slice(0, -canonical.length);
            const hasCollision = CANONICAL_GRAPHIFY_TOOLS.some(c => prefix.endsWith(c) || prefix.endsWith(c + '_'));
            if (!hasCollision)
                return canonical;
        }
    }
    for (const local of PLUGIN_LOCAL_SUFFIXES) {
        if (toolName.endsWith(local) && toolName.length > local.length) {
            return null;
        }
    }
    return toolName;
}
/**
 * Compares known native Graphify tool schemas against the upstream tools/list result.
 * Distinguishes between informational additions (new optional tools or parameters) and
 * breaking drift affecting native first-class tool contracts.
 *
 * Normalizes tool prefixes before comparing so configured prefixes do not cause false drifts.
 */
export function compareToolSchemas(nativeTools, upstreamTools) {
    const differences = [];
    const nativeMap = new Map();
    for (const tool of nativeTools) {
        const canonical = getCanonicalGraphifyName(tool.name);
        if (canonical) {
            nativeMap.set(canonical, tool);
        }
    }
    const upstreamMap = new Map();
    for (const tool of upstreamTools) {
        upstreamMap.set(tool.name, tool);
    }
    // 1. Check for removed tools (breaking)
    for (const [name] of nativeMap) {
        if (!upstreamMap.has(name)) {
            differences.push({
                tool: name,
                kind: 'tool_removed',
                severity: 'breaking',
                detail: `Native tool '${name}' is missing from upstream tools/list.`,
            });
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
            });
        }
    }
    // 3. Diff argument schemas for common tools
    for (const [name, nativeDef] of nativeMap) {
        const upstream = upstreamMap.get(name);
        if (!upstream)
            continue;
        const nativeParams = (nativeDef.parameters || {});
        const upstreamSchema = (upstream.inputSchema || {});
        const nativeProps = (nativeParams.properties || {});
        const upstreamProps = (upstreamSchema.properties || {});
        const nativeRequired = new Set(nativeParams.required || []);
        const upstreamRequired = new Set(upstreamSchema.required || []);
        // Check required arguments changes
        for (const req of upstreamRequired) {
            if (!nativeRequired.has(req)) {
                differences.push({
                    tool: name,
                    kind: 'required_argument_changed',
                    severity: 'breaking',
                    detail: `Argument '${req}' is required upstream but was not required natively.`,
                });
            }
        }
        for (const req of nativeRequired) {
            if (!upstreamRequired.has(req)) {
                differences.push({
                    tool: name,
                    kind: 'required_argument_changed',
                    severity: 'informational',
                    detail: `Argument '${req}' is no longer required upstream.`,
                });
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
                });
            }
            else {
                // Compare types
                const nativeType = nativeProps[propName]?.type;
                const upstreamType = upstreamProps[propName]?.type;
                if (nativeType && upstreamType && nativeType !== upstreamType) {
                    differences.push({
                        tool: name,
                        kind: 'type_changed',
                        severity: 'breaking',
                        detail: `Argument '${propName}' in '${name}' changed type from '${String(nativeType)}' to '${String(upstreamType)}'.`,
                    });
                }
                // Compare enums with correct breaking/informational semantics:
                // - native has enum, upstream removes values → breaking (restriction violation)
                // - native has enum, upstream adds values → informational (extension)
                // - native has no enum, upstream adds enum → breaking (new restriction)
                // - native has enum, upstream removes enum → informational (widening)
                const nativeEnum = nativeProps[propName]?.enum;
                const upstreamEnum = upstreamProps[propName]?.enum;
                if (Array.isArray(nativeEnum) && !Array.isArray(upstreamEnum)) {
                    // Enum removed upstream: widening — informational
                    differences.push({
                        tool: name,
                        kind: 'enum_changed',
                        severity: 'informational',
                        detail: `Enum constraint removed from argument '${propName}' in tool '${name}' (values now unrestricted).`,
                    });
                }
                else if (!Array.isArray(nativeEnum) && Array.isArray(upstreamEnum)) {
                    // Enum added upstream: new restriction — breaking
                    differences.push({
                        tool: name,
                        kind: 'enum_changed',
                        severity: 'breaking',
                        detail: `Enum constraint added to argument '${propName}' in tool '${name}' (restricted to: ${upstreamEnum.map(String).join(', ')}).`,
                    });
                }
                else if (Array.isArray(nativeEnum) && Array.isArray(upstreamEnum)) {
                    const nativeEnumSet = new Set(nativeEnum);
                    const upstreamEnumSet = new Set(upstreamEnum);
                    for (const val of nativeEnumSet) {
                        if (!upstreamEnumSet.has(val)) {
                            differences.push({
                                tool: name,
                                kind: 'enum_changed',
                                severity: 'breaking',
                                detail: `Enum value '${String(val)}' in argument '${propName}' for tool '${name}' is no longer supported upstream.`,
                            });
                        }
                    }
                    for (const val of upstreamEnumSet) {
                        if (!nativeEnumSet.has(val)) {
                            differences.push({
                                tool: name,
                                kind: 'enum_changed',
                                severity: 'informational',
                                detail: `New upstream enum value '${String(val)}' added to argument '${propName}' for tool '${name}'.`,
                            });
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
                });
            }
        }
    }
    const breakingCount = differences.filter((d) => d.severity === 'breaking').length;
    const informationalCount = differences.filter((d) => d.severity === 'informational').length;
    const hasBreakingDrift = breakingCount > 0;
    const summary = [
        `Schema drift analysis: ${breakingCount} breaking difference(s), ${informationalCount} informational addition(s).`,
        ...differences.map((d) => `  [${d.severity.toUpperCase()}] ${d.tool}: ${d.detail}`),
    ].join('\n');
    return {
        differences,
        breakingCount,
        informationalCount,
        hasBreakingDrift,
        summary,
    };
}
