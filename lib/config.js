import Schema from '@deepseek-ai/schemastery';
export const Config = Schema.object({
    command: Schema.string().default('auto').description('MCP server executable, or auto to discover Graphify'),
    args: Schema.array(Schema.string()).default([]).description('Arguments for a configured MCP server executable'),
    graphifyVersion: Schema.string().description('Pinned graphifyy version for uv fallback, for example 0.9.57'),
    cliCommand: Schema.string().description('Graphify CLI executable for the direct command'),
    cliArgs: Schema.array(Schema.string()).default([]).description('Arguments preceding the direct Graphify operation'),
    graphPath: Schema.string().description('Explicit absolute or relative path to graph.json'),
    autoDetect: Schema.boolean().default(true).description('Automatically detect graphify-out/graph.json in workspace'),
    enablePromptSection: Schema.boolean().default(true).description('Register system prompt guidance for Graphify tools'),
    timeoutMs: Schema.number().default(60000).description('Per-tool-call timeout in milliseconds'),
    toolPrefix: Schema.string().default('').description('Optional prefix for registered tool names'),
    toolMode: Schema.union(['compact', 'full']).default('full').description('Tool surface mode: compact for local models, full for complete suite'),
    freshness: Schema.object({
        mode: Schema.union(['off', 'warn', 'auto']).default('warn').description('Graph freshness mode (off, warn, auto)'),
        updateTimeoutMs: Schema.number().default(120000).description('Max wait time for incremental graph update'),
    }).default({ mode: 'warn', updateTimeoutMs: 120000 }).description('Graph freshness monitoring and auto-update options'),
    reconnect: Schema.object({
        enabled: Schema.boolean().default(true).description('Enable automatic reconnection on unexpected exit'),
        initialDelayMs: Schema.number().default(500).description('Initial reconnect backoff delay in milliseconds'),
        maxDelayMs: Schema.number().default(30000).description('Maximum reconnect delay in milliseconds'),
        maxAttempts: Schema.number().default(10).description('Maximum consecutive reconnect attempts'),
    }).default({ enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 }).description('Connection resilience options'),
    cwd: Schema.string().description('Explicit working directory for Graphify subprocess'),
    allowExternalProjects: Schema.boolean().default(false).description('Allow model-invoked Graphify tools to operate on projects outside the active DSH session workspace'),
});
/**
 * Validates a resolved configuration object, throwing actionable errors if
 * any parameters are invalid or out of bounds.
 */
export function validateConfig(config) {
    if (config.allowExternalProjects !== undefined && typeof config.allowExternalProjects !== 'boolean') {
        throw new Error(`Invalid dsh-graphify configuration: allowExternalProjects must be a boolean, got ${config.allowExternalProjects}.`);
    }
    if (typeof config.timeoutMs !== 'number' || config.timeoutMs <= 0 || !Number.isFinite(config.timeoutMs)) {
        throw new Error(`Invalid dsh-graphify configuration: timeoutMs must be a positive number, got ${config.timeoutMs}.`);
    }
    if (config.toolMode !== 'compact' && config.toolMode !== 'full') {
        throw new Error(`Invalid dsh-graphify configuration: toolMode must be 'compact' or 'full', got '${config.toolMode}'.`);
    }
    if (config.freshness) {
        if (config.freshness.mode !== 'off' && config.freshness.mode !== 'warn' && config.freshness.mode !== 'auto') {
            throw new Error(`Invalid dsh-graphify configuration: freshness.mode must be 'off', 'warn', or 'auto', got '${config.freshness.mode}'.`);
        }
        if (typeof config.freshness.updateTimeoutMs !== 'number' || config.freshness.updateTimeoutMs <= 0 || !Number.isFinite(config.freshness.updateTimeoutMs)) {
            throw new Error(`Invalid dsh-graphify configuration: freshness.updateTimeoutMs must be a positive number, got ${config.freshness.updateTimeoutMs}.`);
        }
    }
    if (config.reconnect) {
        if (typeof config.reconnect.initialDelayMs !== 'number' || config.reconnect.initialDelayMs < 0 || !Number.isFinite(config.reconnect.initialDelayMs)) {
            throw new Error(`Invalid dsh-graphify configuration: reconnect.initialDelayMs must be non-negative, got ${config.reconnect.initialDelayMs}.`);
        }
        if (typeof config.reconnect.maxDelayMs !== 'number' || config.reconnect.maxDelayMs < 0 || !Number.isFinite(config.reconnect.maxDelayMs)) {
            throw new Error(`Invalid dsh-graphify configuration: reconnect.maxDelayMs must be non-negative, got ${config.reconnect.maxDelayMs}.`);
        }
        if (config.reconnect.maxDelayMs < config.reconnect.initialDelayMs) {
            throw new Error(`Invalid dsh-graphify configuration: reconnect.maxDelayMs (${config.reconnect.maxDelayMs}) must be >= reconnect.initialDelayMs (${config.reconnect.initialDelayMs}).`);
        }
        if (typeof config.reconnect.maxAttempts !== 'number' || !Number.isInteger(config.reconnect.maxAttempts) || config.reconnect.maxAttempts < 0) {
            throw new Error(`Invalid dsh-graphify configuration: reconnect.maxAttempts must be a non-negative integer, got ${config.reconnect.maxAttempts}.`);
        }
    }
}
