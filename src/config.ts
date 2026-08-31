import Schema from '@deepseek-ai/schemastery'

/**
 * Configuration for the DeepSeek Harness Graphify Plugin.
 */
export interface Config {
  /**
   * Executable or command used to run Graphify.
   * Defaults to 'graphify', with automatic resolution fallback to python3 -m graphify.
   */
  command: string

  /**
   * Arguments passed to the Graphify executable to run the MCP server.
   * Defaults to ['serve', '--transport', 'stdio'].
   */
  args: string[]

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
   * Stable namespace / server name for Graphify integration.
   * Defaults to 'graphify'.
   */
  serverName: string

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
  command: Schema.string().default('graphify').description('Graphify CLI executable command'),
  args: Schema.array(Schema.string()).default(['serve', '--transport', 'stdio']).description('Arguments to launch Graphify MCP server'),
  graphPath: Schema.string().description('Explicit absolute or relative path to graph.json'),
  autoDetect: Schema.boolean().default(true).description('Automatically detect graphify-out/graph.json in workspace'),
  enablePromptSection: Schema.boolean().default(true).description('Register system prompt guidance for Graphify tools'),
  timeoutMs: Schema.number().default(60000).description('Per-tool-call timeout in milliseconds'),
  serverName: Schema.string().default('graphify').description('Stable identifier for the Graphify server'),
  toolPrefix: Schema.string().default('').description('Optional prefix for registered tool names'),
  cwd: Schema.string().description('Explicit working directory for Graphify subprocess'),
})
