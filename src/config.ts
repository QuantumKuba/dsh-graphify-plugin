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
   * Working directory for the Graphify subprocess.
   * Defaults to the active project root or process.cwd().
   */
  cwd?: string
}

export const Config: Schema<Config> = Schema.object({
  command: Schema.string().default('auto').description('MCP server executable, or auto to discover Graphify'),
  args: Schema.array(Schema.string()).default([]).description('Arguments for a configured MCP server executable'),
  graphifyVersion: Schema.string().description('Pinned graphifyy version for uv fallback, for example 0.9.50'),
  cliCommand: Schema.string().description('Graphify CLI executable for the direct command'),
  cliArgs: Schema.array(Schema.string()).default([]).description('Arguments preceding the direct Graphify operation'),
  graphPath: Schema.string().description('Explicit absolute or relative path to graph.json'),
  autoDetect: Schema.boolean().default(true).description('Automatically detect graphify-out/graph.json in workspace'),
  enablePromptSection: Schema.boolean().default(true).description('Register system prompt guidance for Graphify tools'),
  timeoutMs: Schema.number().default(60000).description('Per-tool-call timeout in milliseconds'),
  toolPrefix: Schema.string().default('').description('Optional prefix for registered tool names'),
  cwd: Schema.string().description('Explicit working directory for Graphify subprocess'),
})
