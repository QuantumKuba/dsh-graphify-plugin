/**
 * Type definitions for DeepSeek Harness Graphify Plugin.
 */

/** Content block structure for DSH model responses and results. */
export interface ContentBlock {
  type: 'text'
  text: string
}

/** Information about a detected Graphify graph and workspace. */
export interface DetectedGraph {
  /** Root directory of the project containing the graph. */
  readonly projectRoot: string
  /** Absolute path to the graph.json file. */
  readonly graphJsonPath: string
  /** Absolute path to the graphify-out directory. */
  readonly graphDir: string
  /** Absolute path to GRAPH_REPORT.md if present. */
  readonly reportPath?: string
  /** Absolute path to graphify-out/wiki/index.md if present. */
  readonly wikiIndexPath?: string
  /** Whether the graph.json file exists and is readable. */
  readonly hasGraph: boolean
}

/** JSON Schema representation for tool parameters and output. */
export interface JsonSchemaNode {
  type?: string
  description?: string
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  items?: JsonSchemaNode
  enum?: (string | number | boolean | null)[]
  default?: unknown
  additionalProperties?: boolean
  [key: string]: unknown
}

/** Tool output contract for DSH tool execution. */
export interface ToolOutputDefinition {
  /** Lossless JSON schema enforced for canonical output. */
  schema: JsonSchemaNode
  /** Pure projection from tool arguments and canonical JSON value to content blocks. */
  render: (args: unknown, value: unknown) => ContentBlock[]
  /** Optional presentation metadata projection for UI persistence. */
  presentationMeta?: (args: unknown, value: unknown) => unknown
}

/** Tool execution context provided by the DSH pipeline. */
export interface ToolRunContext {
  /** Cooperative cancellation signal. */
  signal: AbortSignal
  /** Unique call identity. */
  callId?: string
  /** Opaque execution token. */
  token?: symbol
  /** Calling agent instance if available. */
  agent?: unknown
  /** Defer additional context into the agent turn. */
  deferContext?: (context: unknown) => void
  /** Mark successful result as terminal for the turn. */
  concludeTurn?: () => void
}

/** DSH Tool Definition contract. */
export interface ToolDefinition {
  /** Model-visible tool name. */
  name: string
  /** Model-facing description. */
  description?: string
  /** JSON Schema parameters object or DSL spec. */
  parameters?: JsonSchemaNode
  /** Output contract. */
  output: ToolOutputDefinition
  /** Execute callback returning canonical JSON value. */
  execute: (args: unknown, exec: ToolRunContext) => Promise<unknown>
  /** Cooperative timeout budget in milliseconds. */
  timeoutMs?: number
}

/** Prompt section registration contract. */
export interface PromptSection {
  /** Unique section name (e.g. 'graphify:guidance'). */
  name: string
  /** Placement order (ascending). */
  order: number
  /** Static text or dynamic text generator. */
  text: string | ((context: unknown) => string)
}

/** MCP Tool description from tools/list. */
export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: JsonSchemaNode
}

/** MCP JSON-RPC 2.0 Request. */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, unknown>
}

/** MCP JSON-RPC 2.0 Response. */
export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

/** MCP JSON-RPC 2.0 Notification. */
export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

/** Result returned by an MCP tools/call request. */
export interface McpCallResult {
  content?: Array<{
    type: 'text' | 'image' | 'resource'
    text?: string
    data?: string
    mimeType?: string
    [key: string]: unknown
  }>
  isError?: boolean
  [key: string]: unknown
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    effect: (callback: () => unknown) => () => void
    inject: (deps: string[], callback: (ctx: Context) => void) => () => void
    tools: {
      register: (tool: ToolDefinition) => () => void
      execute?: (input: unknown) => Promise<unknown>
      [key: string]: unknown
    }
    systemPrompt: {
      section: (section: PromptSection) => () => void
      [key: string]: unknown
    }
  }
}
