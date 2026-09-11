/** Content block structure for DSH model responses and results. */
export interface ContentBlock {
    type: 'text';
    text: string;
}
/** Information about a detected Graphify graph and workspace. */
export interface DetectedGraph {
    /** Root directory of the project containing the graph. */
    readonly projectRoot: string;
    /** Absolute path to the graph.json file. */
    readonly graphJsonPath: string;
    /** Absolute path to the graphify-out directory. */
    readonly graphDir: string;
    /** Absolute path to GRAPH_REPORT.md if present. */
    readonly reportPath?: string;
    /** Absolute path to graphify-out/wiki/index.md if present. */
    readonly wikiIndexPath?: string;
    /** Whether the graph.json file exists and is readable. */
    readonly hasGraph: boolean;
}
/** JSON Schema representation for tool parameters and output. */
export interface JsonSchemaNode {
    type?: string;
    description?: string;
    properties?: Record<string, JsonSchemaNode>;
    required?: string[];
    items?: JsonSchemaNode;
    enum?: (string | number | boolean | null)[];
    default?: unknown;
    additionalProperties?: boolean;
    [key: string]: unknown;
}
/** Tool output contract for DSH tool execution. */
export interface ToolOutputDefinition {
    /** Lossless JSON schema enforced for canonical output. */
    schema: JsonSchemaNode;
    /** Pure projection from tool arguments and canonical JSON value to content blocks. */
    render: (args: unknown, value: unknown) => ContentBlock[];
    /** Optional presentation metadata projection for UI persistence. */
    presentationMeta?: (args: unknown, value: unknown) => unknown;
}
/** Tool execution context provided by the DSH pipeline. */
export interface ToolRunContext {
    /** Cooperative cancellation signal. */
    signal: AbortSignal;
    /** Unique call identity. */
    callId?: string;
    /** Opaque execution token. */
    token?: symbol;
    /** Calling agent instance if available. */
    agent?: {
        readonly session: {
            readonly header: {
                readonly cwd?: string;
            };
        };
    };
    /** Defer additional context into the agent turn. */
    deferContext?: (context: unknown) => void;
    /** Mark successful result as terminal for the turn. */
    concludeTurn?: () => void;
}
/** DSH Tool Definition contract. */
export interface ToolDefinition {
    /** Model-visible tool name. */
    name: string;
    /** Model-facing description. */
    description?: string;
    /** JSON Schema parameters object or DSL spec. */
    parameters?: JsonSchemaNode;
    /** Output contract. */
    output: ToolOutputDefinition;
    /** Execute callback returning canonical JSON value. */
    execute: (args: unknown, exec: ToolRunContext) => Promise<unknown>;
    /** Cooperative timeout budget in milliseconds. */
    timeoutMs?: number;
}
/** Prompt section registration contract. */
export interface PromptSection {
    /** Unique section name (e.g. 'graphify:guidance'). */
    name: string;
    /** Placement order (ascending). */
    order: number;
    /** Static text or dynamic text generator. */
    text: string | ((context: unknown) => string);
}
/** MCP Tool description from tools/list. */
export interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: JsonSchemaNode;
}
/** Graphify MCP resource advertised through `resources/list`. */
export interface McpResource {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
}
/** Result returned by an MCP tools/call request. */
export interface McpCallResult {
    content?: Array<{
        type: 'text' | 'image' | 'resource';
        text?: string;
        data?: string;
        mimeType?: string;
        [key: string]: unknown;
    }>;
    isError?: boolean;
    [key: string]: unknown;
}
/** Result returned by Graphify's `resources/read` MCP request. */
export interface McpResourceResult {
    contents: Array<{
        uri?: string;
        mimeType?: string;
        text?: string;
        blob?: string;
    }>;
}
/** Automatic reconnect policy for Graphify MCP connection. */
export interface ReconnectConfig {
    /** Reconnect automatically after a lost connection (default true). */
    enabled?: boolean;
    /** First reconnect delay in milliseconds (default 500). */
    initialDelayMs?: number;
    /** Backoff ceiling in milliseconds (default 30000). */
    maxDelayMs?: number;
    /** Consecutive failed attempts before giving up (default 10). */
    maxAttempts?: number;
}
/** Resolved project identity and graph paths for a DSH session. */
export interface ResolvedProject {
    /** Canonical project root directory. */
    readonly projectRoot: string;
    /** Absolute path to graph.json or null if missing. */
    readonly graphJsonPath: string | null;
    /** Absolute path to graphify-out directory. */
    readonly graphDir: string;
    /** Absolute path to GRAPH_REPORT.md if present. */
    readonly reportPath?: string;
    /** Absolute path to graphify-out/wiki/index.md if present. */
    readonly wikiIndexPath?: string;
    /** Whether graph.json exists and is readable. */
    readonly hasGraph: boolean;
    /** Last modification timestamp of graph.json in milliseconds if present. */
    readonly mtimeMs?: number;
}
/** Mode governing tool surface exposure. */
export type ToolMode = 'compact' | 'full';
/** Mode governing graph freshness detection and remediation. */
export type FreshnessMode = 'off' | 'warn' | 'auto';
/** Freshness evaluation state. */
export type FreshnessState = 'fresh' | 'stale' | 'unknown';
/** Detailed graph freshness information. */
export interface GraphFreshnessInfo {
    readonly state: FreshnessState;
    readonly reason?: string;
    readonly changedFilesCount?: number;
    readonly changedFilesSample?: string[];
    readonly lastIndexedTime?: string;
    readonly strategy?: 'metadata' | 'git-heuristic' | 'filesystem-heuristic';
    readonly metadataVersion?: number;
    readonly baselineAvailable?: boolean;
    readonly isCanonicalTarget?: boolean;
    readonly autoUpdateEligible?: boolean;
    readonly autoUpdateBlockReason?: string;
}
/** Overall operational status of Graphify for a project/session. */
export type GraphifyOverallStatus = 'healthy' | 'stale' | 'missing' | 'unavailable' | 'error' | 'unprobed' | 'unknown';
/** MCP connection states. */
export type McpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'disposed';
/** Structured result returned by the `graphify_status` doctor tool. */
export interface GraphifyStatusResult {
    readonly overall: GraphifyOverallStatus;
    readonly projectRoot: string;
    readonly graphPath: string | null;
    readonly graphExists: boolean;
    readonly nodeCount: number | null;
    readonly edgeCount: number | null;
    readonly communityCount: number | null;
    readonly lastModified: string | null;
    readonly git: {
        readonly head: string | null;
        readonly isDirty: boolean | null;
        readonly branch?: string | null;
    } | null;
    readonly freshness: GraphFreshnessInfo;
    readonly runtime: {
        readonly command: string;
        readonly version?: string;
        readonly source: 'installed' | 'python' | 'uv' | 'custom' | 'unknown';
    };
    readonly mcp: {
        readonly state: McpConnectionState;
        /** Current consecutive reconnect attempt number (0 when not reconnecting). */
        readonly reconnectAttempts?: number;
        /** Maximum reconnect attempts configured. */
        readonly maxReconnectAttempts?: number;
        readonly recentStderr?: string;
        readonly error?: string;
    };
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        tools: {
            register: (tool: ToolDefinition) => () => void;
            execute?: (input: unknown) => Promise<unknown>;
            [key: string]: unknown;
        };
        systemPrompt: {
            section: (section: PromptSection) => () => void;
            [key: string]: unknown;
        };
    }
}
