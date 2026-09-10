import Schema from '@deepseek-ai/schemastery'

/**
 * Configuration for the DeepSeek Harness Graphify Plugin.
 */
export interface Config {
  /**
   * MCP server executable. Set this with `args` to bypass automatic Graphify
   * runtime discovery.
   */
  command: string

  /**
   * Arguments passed to a configured MCP server executable.
   */
  args: string[]

  /**
   * Optional Graphify package version used when automatic discovery falls back
   * to uv. Pin a release for reproducible deployments; omit for uv's latest
   * compatible release.
   */
  graphifyVersion?: string

  /** Optional Graphify CLI executable for the `/graphify` command. */
  cliCommand?: string

  /** Arguments preceding Graphify's build or update operation. */
  cliArgs: string[]

  /**
   * Optional explicit path to graph.json.
   * If omitted, the plugin automatically detects graphify-out/graph.json in the workspace.
   */
  graphPath?: string

  /**
   * Automatically detect Graphify graphs in the workspace/cwd and parent directories.
   * Defaults to true.
   */
  autoDetect: boolean

  /**
   * Register a system prompt guidance section instructing the model on Graphify usage.
   * Defaults to true.
   */
  enablePromptSection: boolean

  /**
   * Per-tool-call execution timeout in milliseconds.
   * Defaults to 60000 ms (1 minute).
   */
  timeoutMs: number

  /**
   * Optional prefix for registered tool names (e.g. 'graphify_' or '').
   * Defaults to '' (keeps native tool names like query_graph, get_node).
   */
  toolPrefix: string

  /**
   * Tool surface mode.
   * - 'full': Registers the complete Graphify tool surface (all 10 native tools, doctor, and escape hatches).
   * - 'compact': Registers a focused 6-tool surface tailored for smaller local models (20B-30B class).
   * Defaults to 'full'.
   */
  toolMode: 'compact' | 'full'

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
    mode: 'off' | 'warn' | 'auto'
    /** Maximum duration in milliseconds to await an incremental graph update. */
    updateTimeoutMs: number
  }

  /**
   * Connection resilience and reconnection policy for Graphify MCP subprocess.
   */
  reconnect: {
    /** Enable automatic reconnection after lost connection (default true). */
    enabled: boolean
    /** Initial reconnect delay in milliseconds (default 500). */
    initialDelayMs: number
    /** Maximum delay between reconnect attempts in milliseconds (default 30000). */
    maxDelayMs: number
    /** Maximum consecutive reconnect attempts before giving up (default 10). */
    maxAttempts: number
  }

  /**
   * Working directory for the Graphify subprocess.
   * Defaults to the active project root or process.cwd().
   */
  cwd?: string
}

export const Config: Schema<Config> = Schema.object({
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
})
