import type { McpToolInfo, McpResource, McpCallResult, McpResourceResult, ReconnectConfig, McpConnectionState } from './types.ts';
import type { RuntimeResolution } from './server-process.ts';
export interface ClientLogger {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
    debug: (msg: string, ...args: unknown[]) => void;
}
export interface ClientOptions {
    command?: string;
    args?: string[];
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    reconnect?: ReconnectConfig;
    logger?: ClientLogger;
    resolveRuntime?: () => RuntimeResolution;
}
export interface ServerExitInfo {
    code: number | null;
    signal: string | null;
    stderr: string;
}
/**
 * High-resilience MCP client for communicating with Graphify via the official MCP SDK.
 *
 * Implements bounded exponential backoff reconnection, generational subprocess safety,
 * cooperative cancellation, request timeouts, and diagnostic stderr buffering.
 *
 * Reconnect state machine:
 *   unexpected disconnect → attempt = 1 → wait backoff → connect
 *     ├── success → connected → reset retry counter after stable period
 *     └── failure → attempts < maxAttempts?
 *           ├── yes → schedule another reconnect (increment attempt)
 *           └── no → final error state, no further automatic attempts
 *
 * A failed reconnect handshake schedules the next retry if budget remains.
 * An explicit `init()` failure (first connection) throws to the caller without retry.
 */
export declare class GraphifyMcpClient {
    private client;
    private transport;
    private state;
    private generation;
    private initPromise;
    private stderrBuffer;
    private stderrBufferBytes;
    private reconnectAttempts;
    private reconnectTimer;
    private healthyTimer;
    private isDisposed;
    private readonly command?;
    private readonly args?;
    private readonly resolveRuntime?;
    private readonly cwd;
    private readonly env;
    private readonly defaultTimeoutMs;
    private readonly reconnectConfig;
    private readonly logger?;
    private readonly exitListeners;
    private readonly stateListeners;
    private readonly toolsChangedListeners;
    constructor(options: ClientOptions);
    /** Current connection state. */
    getConnectionState(): McpConnectionState;
    /** Current reconnect attempt number (0 when connected or not reconnecting). */
    getReconnectAttempts(): number;
    /** Maximum reconnect attempts configured. */
    getMaxReconnectAttempts(): number;
    /** Register a callback for connection state changes. */
    onConnectionStateChange(listener: (state: McpConnectionState) => void): () => void;
    /** Register a callback for unexpected child process exits. */
    onExit(listener: (exit: ServerExitInfo) => void): () => void;
    /** Register a callback for server-initiated tool list changes. */
    onToolsChanged(listener: (tools: McpToolInfo[]) => void): () => void;
    /**
     * Initializes the MCP connection and completes protocol handshake using the official MCP SDK.
     *
     * This is the public entry point for explicit first-time connection. On failure, it throws
     * to the caller without scheduling automatic retries. Use for initial handshakes only.
     *
     * When called during an active reconnect backoff, expedites the next attempt within the
     * existing state machine rather than starting a parallel connection that would kill recovery.
     */
    init(): Promise<void>;
    /**
     * Joins an in-progress reconnect lifecycle: cancels the backoff timer to expedite the
     * next attempt, then waits for the state machine to reach `connected` or a terminal state.
     */
    private awaitReconnect;
    private establishConnection;
    /**
     * Attempts a single reconnection. On failure, schedules the next retry if budget remains.
     * Never throws — reconnect failures are logged and retried, not propagated to callers.
     *
     * This is the internal reconnect path, distinct from `init()` which is the explicit
     * caller-facing API that throws on failure.
     */
    private reconnectAttempt;
    /**
     * Schedules the next reconnect attempt with exponential backoff.
     * Returns without scheduling if budget is exhausted or client is disposed.
     */
    private scheduleReconnect;
    private handleDisconnect;
    private setState;
    /**
     * Lists all tools exposed by the Graphify MCP server.
     */
    listTools(): Promise<McpToolInfo[]>;
    /**
     * Calls a Graphify MCP tool with argument validation, cancellation, and error handling.
     */
    callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<McpCallResult>;
    /**
     * Lists Graphify MCP resources, including reports and graph analyses.
     */
    listResources(): Promise<McpResource[]>;
    /**
     * Reads one Graphify MCP resource by its URI.
     */
    readResource(uri: string, signal?: AbortSignal, timeoutMs?: number): Promise<McpResourceResult>;
    /**
     * Returns recent stderr output from the child process.
     */
    getRecentStderr(): string;
    /**
     * Disposes the client and stops the server process with full quiescence.
     */
    dispose(): Promise<void>;
}
