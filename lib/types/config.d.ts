import Schema from '@deepseek-ai/schemastery';
/**
 * Configuration for the DeepSeek Harness Graphify Plugin.
 */
export interface Config {
    /**
     * MCP server executable. Set this with `args` to bypass automatic Graphify
     * runtime discovery.
     */
    command: string;
    /**
     * Arguments passed to a configured MCP server executable.
     */
    args: string[];
    /**
     * Optional Graphify package version used when automatic discovery falls back
     * to uv. Pin a release for reproducible deployments; omit for uv's latest
     * compatible release.
     */
    graphifyVersion?: string;
    /** Optional Graphify CLI executable for the `/graphify` command. */
    cliCommand?: string;
    /** Arguments preceding Graphify's build or update operation. */
    cliArgs: string[];
    /**
     * Optional explicit path to graph.json.
     * If omitted, the plugin automatically detects graphify-out/graph.json in the workspace.
     */
    graphPath?: string;
    /**
     * Automatically detect Graphify graphs in the workspace/cwd and parent directories.
     * Defaults to true.
     */
    autoDetect: boolean;
    /**
     * Register a system prompt guidance section instructing the model on Graphify usage.
     * Defaults to true.
     */
    enablePromptSection: boolean;
    /**
     * Per-tool-call execution timeout in milliseconds.
     * Defaults to 60000 ms (1 minute).
     */
    timeoutMs: number;
    /**
     * Optional prefix for registered tool names (e.g. 'graphify_' or '').
     * Defaults to '' (keeps native tool names like query_graph, get_node).
     */
    toolPrefix: string;
    /**
     * Tool surface mode.
     * - 'full': Registers the complete Graphify tool surface (all 10 native tools, doctor, and escape hatches).
     * - 'compact': Registers a focused 6-tool surface tailored for smaller local models (20B-30B class).
     * Defaults to 'full'.
     */
    toolMode: 'compact' | 'full';
    /**
     * Freshness monitoring and auto-update configuration.
     */
    freshness: {
        /**
         * Freshness evaluation mode:
         * - 'off': Never check or warn about freshness.
         * - 'warn': Warn when the graph is likely stale without rebuilding.
         * - 'auto': Automatically trigger incremental graph updates before queries when stale.
         * Defaults to 'warn'.
         */
        mode: 'off' | 'warn' | 'auto';
        /** Maximum duration in milliseconds to await an incremental graph update. */
        updateTimeoutMs: number;
    };
    /**
     * Connection resilience and reconnection policy for Graphify MCP subprocess.
     */
    reconnect: {
        /** Enable automatic reconnection after lost connection (default true). */
        enabled: boolean;
        /** Initial reconnect delay in milliseconds (default 500). */
        initialDelayMs: number;
        /** Maximum delay between reconnect attempts in milliseconds (default 30000). */
        maxDelayMs: number;
        /** Maximum consecutive reconnect attempts before giving up (default 10). */
        maxAttempts: number;
    };
    /**
     * Working directory for the Graphify subprocess.
     * Defaults to the active project root or process.cwd().
     */
    cwd?: string;
    /**
     * Allow model-invoked Graphify tools to operate on projects outside the active DSH session workspace.
     * Defaults to false for security in marketplace deployments.
     */
    allowExternalProjects: boolean;
}
export declare const Config: Schema<Config>;
/**
 * Validates a resolved configuration object, throwing actionable errors if
 * any parameters are invalid or out of bounds.
 */
export declare function validateConfig(config: Config): void;
