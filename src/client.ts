import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type {
  McpToolInfo,
  McpResource,
  McpCallResult,
  McpResourceResult,
  ReconnectConfig,
  McpConnectionState,
} from './types.ts'
import { getPackageVersion } from './version.ts'
import type { RuntimeResolution } from './server-process.ts'

export interface ClientLogger {
  info: (msg: string, ...args: unknown[]) => void
  warn: (msg: string, ...args: unknown[]) => void
  error: (msg: string, ...args: unknown[]) => void
  debug: (msg: string, ...args: unknown[]) => void
}

export interface ClientOptions {
  command?: string
  args?: string[]
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
  reconnect?: ReconnectConfig
  logger?: ClientLogger
  resolveRuntime?: () => RuntimeResolution
}

export interface ServerExitInfo {
  code: number | null
  signal: string | null
  stderr: string
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
export class GraphifyMcpClient {
  private client: Client | null = null
  private transport: StdioClientTransport | null = null
  private state: McpConnectionState = 'disconnected'
  private generation = 0
  private initPromise: Promise<void> | null = null
  private stderrBuffer: string[] = []
  private stderrBufferBytes = 0
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private healthyTimer: NodeJS.Timeout | null = null
  private isDisposed = false

  private readonly command?: string
  private readonly args?: string[]
  private readonly resolveRuntime?: () => RuntimeResolution
  private readonly cwd: string
  private readonly env: Record<string, string>
  private readonly defaultTimeoutMs: number
  private readonly reconnectConfig: Required<ReconnectConfig>
  private readonly logger?: ClientLogger

  private readonly exitListeners = new Set<(exit: ServerExitInfo) => void>()
  private readonly stateListeners = new Set<(state: McpConnectionState) => void>()
  private readonly toolsChangedListeners = new Set<(tools: McpToolInfo[]) => void>()

  constructor(options: ClientOptions) {
    this.command = options.command
    this.args = options.args
    this.resolveRuntime = options.resolveRuntime
    this.cwd = options.cwd
    this.env = options.env ?? (process.env as Record<string, string>)
    this.defaultTimeoutMs = options.timeoutMs ?? 60000
    this.logger = options.logger

    this.reconnectConfig = {
      enabled: options.reconnect?.enabled ?? true,
      initialDelayMs: options.reconnect?.initialDelayMs ?? 500,
      maxDelayMs: options.reconnect?.maxDelayMs ?? 30000,
      maxAttempts: options.reconnect?.maxAttempts ?? 10,
    }
  }

  /** Current connection state. */
  getConnectionState(): McpConnectionState {
    return this.state
  }

  /** Current reconnect attempt number (0 when connected or not reconnecting). */
  getReconnectAttempts(): number {
    return this.reconnectAttempts
  }

  /** Maximum reconnect attempts configured. */
  getMaxReconnectAttempts(): number {
    return this.reconnectConfig.maxAttempts
  }

  /** Register a callback for connection state changes. */
  onConnectionStateChange(listener: (state: McpConnectionState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** Register a callback for unexpected child process exits. */
  onExit(listener: (exit: ServerExitInfo) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /** Register a callback for server-initiated tool list changes. */
  onToolsChanged(listener: (tools: McpToolInfo[]) => void): () => void {
    this.toolsChangedListeners.add(listener)
    return () => this.toolsChangedListeners.delete(listener)
  }

  /**
   * Initializes the MCP connection and completes protocol handshake using the official MCP SDK.
   *
   * This is the public entry point for explicit first-time connection. On failure, it throws
   * to the caller without scheduling automatic retries. Use for initial handshakes only.
   *
   * When called during an active reconnect backoff, expedites the next attempt within the
   * existing state machine rather than starting a parallel connection that would kill recovery.
   */
  async init(): Promise<void> {
    if (this.isDisposed) {
      throw new Error('GraphifyMcpClient has been disposed')
    }
    if (this.state === 'connected' && this.client) {
      return
    }
    if (this.initPromise) {
      return this.initPromise
    }

    // If reconnecting, expedite the next attempt within the existing state machine
    // rather than starting a parallel connection that would cancel the recovery chain.
    if (this.state === 'reconnecting' && this.reconnectConfig.enabled) {
      return this.awaitReconnect()
    }

    this.initPromise = this.establishConnection()
    try {
      await this.initPromise
    } catch (err) {
      if (!this.isDisposed) {
        if ((err as { isRuntimeUnavailable?: boolean })?.isRuntimeUnavailable) {
          this.setState('disconnected')
        } else {
          this.setState('error')
        }
      }
      throw err
    } finally {
      this.initPromise = null
    }
  }

  /**
   * Joins an in-progress reconnect lifecycle: cancels the backoff timer to expedite the
   * next attempt, then waits for the state machine to reach `connected` or a terminal state.
   */
  private awaitReconnect(): Promise<void> {
    if (this.isDisposed) {
      return Promise.reject(new Error('GraphifyMcpClient has been disposed'))
    }
    if (this.state === 'connected' && this.client) {
      return Promise.resolve()
    }

    return new Promise<void>((resolve, reject) => {
      // Cancel the pending backoff timer so the next attempt fires immediately
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
        // Fire the attempt immediately within the existing state machine
        this.reconnectAttempt(this.generation)
      }

      const cleanup = this.onConnectionStateChange((state) => {
        if (state === 'connected') {
          cleanup()
          resolve()
        } else if (state === 'error' || state === 'disposed') {
          cleanup()
          reject(new Error(`Reconnect ended with state: ${state}`))
        }
        // 'reconnecting' is intermediate — keep waiting
      })
    })
  }

  private async establishConnection(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    let effectiveCommand = this.command
    let effectiveArgs = this.args

    if (this.resolveRuntime) {
      const resolution = this.resolveRuntime()
      if (!resolution.available) {
        this.logger?.warn?.(`[dsh-graphify] Runtime resolution unavailable: ${resolution.reason}`)
        const err = new Error(`Graphify is unavailable: ${resolution.reason}\n${resolution.remediation}`)
        ;(err as unknown as { isRuntimeUnavailable?: boolean }).isRuntimeUnavailable = true
        throw err
      }
      effectiveCommand = resolution.command
      effectiveArgs = resolution.args
    }

    if (!effectiveCommand || !effectiveArgs) {
      throw new Error('Graphify MCP client has no executable command configured or resolved.')
    }

    const currentGeneration = ++this.generation
    if (this.state !== 'reconnecting') {
      this.setState('connecting')
    }
    this.logger?.debug(`[dsh-graphify] Starting Graphify MCP server (gen ${currentGeneration}): ${effectiveCommand} ${effectiveArgs.join(' ')}`)

    // Clean up any stale transport
    if (this.transport) {
      try {
        await this.transport.close()
      } catch {
        // Stale close ignored
      }
      this.transport = null
    }

    let transport: StdioClientTransport | null = null
    let client: Client | null = null
    let handshakeComplete = false

    try {
      transport = new StdioClientTransport({
        command: effectiveCommand,
        args: effectiveArgs,
        cwd: this.cwd,
        env: this.env,
        stderr: 'pipe',
      })

      // Capture stderr for actionable diagnostics
      const stderrStream = transport.stderr as unknown as { on?: (event: string, cb: (chunk: Buffer | string) => void) => void }
      if (stderrStream && typeof stderrStream.on === 'function') {
        stderrStream.on('data', (chunk: Buffer | string) => {
          const text = chunk.toString()
          this.stderrBuffer.push(text)
          this.stderrBufferBytes += text.length
          // Enforce 50-chunk and 64 KB aggregate limits
          while (this.stderrBuffer.length > 50 || this.stderrBufferBytes > 65536) {
            const dropped = this.stderrBuffer.shift()
            if (dropped) this.stderrBufferBytes -= dropped.length
            else break
          }
        })
      }

      // Handle unexpected close only after handshake is established
      transport.onclose = () => {
        if (this.generation !== currentGeneration || this.isDisposed || !handshakeComplete) return
        this.handleDisconnect(currentGeneration)
      }

      // Handle transport errors
      transport.onerror = (error: Error) => {
        if (this.generation !== currentGeneration || this.isDisposed) return
        this.logger?.warn(`[dsh-graphify] Transport error (gen ${currentGeneration}): ${error.message}`)
      }

      client = new Client(
        {
          name: 'dsh-graphify',
          version: getPackageVersion(),
        },
        {
          capabilities: {},
        }
      )

      await client.connect(transport)

      if (this.generation !== currentGeneration || this.isDisposed) {
        await client.close().catch(() => {})
        await transport.close().catch(() => {})
        return
      }

      handshakeComplete = true
      this.client = client
      this.transport = transport
      this.setState('connected')
      this.logger?.info(`[dsh-graphify] Connected to Graphify MCP server in ${this.cwd}`)

      // Subscribe to server-initiated tool list changes via the MCP SDK notification protocol
      client.setNotificationHandler(
        ToolListChangedNotificationSchema,
        async () => {
          if (this.generation !== currentGeneration || this.isDisposed) return
          if (this.toolsChangedListeners.size === 0) return
          try {
            const tools = await this.listTools()
            for (const listener of this.toolsChangedListeners) {
              try { listener(tools) } catch { /* ignore listener errors */ }
            }
          } catch {
            // Notification-driven refresh failures are non-fatal
          }
        }
      )

      // Reset reconnect counter once connection remains stable
      if (this.healthyTimer) clearTimeout(this.healthyTimer)
      this.healthyTimer = setTimeout(() => {
        this.reconnectAttempts = 0
      }, this.reconnectConfig.maxDelayMs)
    } catch (error) {
      if (client) {
        try {
          await client.close()
        } catch {
          // Ignore close error on failed handshake
        }
      }
      if (transport) {
        try {
          await transport.close()
        } catch {
          // Ignore close error on failed handshake
        }
      }
      this.client = null
      this.transport = null

      if (this.generation !== currentGeneration || this.isDisposed) return
      const msg = error instanceof Error ? error.message : String(error)
      this.logger?.error(`[dsh-graphify] Failed to connect to Graphify MCP: ${msg}\nRecent stderr: ${this.getRecentStderr()}`)
      throw new Error(`Failed to connect to Graphify MCP: ${msg}`)
    }
  }

  /**
   * Attempts a single reconnection. On failure, schedules the next retry if budget remains.
   * Never throws — reconnect failures are logged and retried, not propagated to callers.
   *
   * This is the internal reconnect path, distinct from `init()` which is the explicit
   * caller-facing API that throws on failure.
   */
  private async reconnectAttempt(triggerGeneration: number): Promise<void> {
    if (this.isDisposed || this.generation !== triggerGeneration) return

    try {
      await this.establishConnection()
      // establishConnection succeeded — state is now 'connected'
    } catch (err) {
      if ((err as { isRuntimeUnavailable?: boolean })?.isRuntimeUnavailable) {
        this.setState('disconnected')
        return
      }
      // establishConnection failed — state is now 'error'
      // Schedule next retry if budget remains and we haven't been disposed/superseded
      if (this.isDisposed || this.generation !== triggerGeneration + 1) return
      this.scheduleReconnect(this.generation)
    }
  }

  /**
   * Schedules the next reconnect attempt with exponential backoff.
   * Returns without scheduling if budget is exhausted or client is disposed.
   */
  private scheduleReconnect(currentGeneration: number): void {
    if (this.isDisposed) return

    if (this.reconnectAttempts >= this.reconnectConfig.maxAttempts) {
      this.setState('error')
      this.logger?.error(
        `[dsh-graphify] Reconnect failed after ${this.reconnectAttempts} consecutive attempts. Will not retry automatically until next invocation.`
      )
      return
    }

    this.reconnectAttempts++
    const delay = Math.min(
      this.reconnectConfig.initialDelayMs * Math.pow(2, this.reconnectAttempts - 1),
      this.reconnectConfig.maxDelayMs
    )

    this.setState('reconnecting')
    this.logger?.warn(
      `[dsh-graphify] Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts}/${this.reconnectConfig.maxAttempts})...`
    )

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.isDisposed) {
        this.reconnectAttempt(currentGeneration)
      }
    }, delay)
  }

  private handleDisconnect(generation: number): void {
    if (this.healthyTimer) {
      clearTimeout(this.healthyTimer)
      this.healthyTimer = null
    }

    this.client = null
    this.transport = null

    const exitInfo: ServerExitInfo = {
      code: null,
      signal: null,
      stderr: this.getRecentStderr(),
    }
    for (const listener of this.exitListeners) {
      try {
        listener(exitInfo)
      } catch {
        // Ignore listener errors
      }
    }

    if (!this.reconnectConfig.enabled || this.isDisposed) {
      this.setState('disconnected')
      return
    }

    this.scheduleReconnect(generation)
  }

  private setState(state: McpConnectionState): void {
    if (this.state === state) return
    this.state = state
    for (const listener of this.stateListeners) {
      try {
        listener(state)
      } catch {
        // Ignore listener errors
      }
    }
  }

  /**
   * Lists all tools exposed by the Graphify MCP server.
   */
  async listTools(): Promise<McpToolInfo[]> {
    await this.init()
    if (!this.client) throw new Error('Graphify MCP client is not connected')

    const response = await this.client.listTools()
    return (response.tools || []) as McpToolInfo[]
  }

  /**
   * Calls a Graphify MCP tool with argument validation, cancellation, and error handling.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<McpCallResult> {
    if (signal?.aborted) {
      throw new Error('Tool call aborted by signal')
    }

    await this.init()
    if (!this.client) throw new Error('Graphify MCP client is not connected')

    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs

    try {
      const response = await this.client.callTool(
        {
          name,
          arguments: args,
        },
        undefined,
        {
          signal,
          timeout: effectiveTimeout,
        }
      )

      return {
        ...response,
        content: response.content as McpCallResult['content'],
        ...(response.isError ? { isError: true } : {}),
      }
    } catch (err) {
      if (signal?.aborted) {
        throw new Error(`Tool call ${name} cancelled`)
      }
      const message = err instanceof Error ? err.message : String(err)
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error executing ${name}: ${message}`,
          },
        ],
      }
    }
  }

  /**
   * Lists Graphify MCP resources, including reports and graph analyses.
   */
  async listResources(): Promise<McpResource[]> {
    await this.init()
    if (!this.client) throw new Error('Graphify MCP client is not connected')

    const response = await this.client.listResources()
    return (response.resources || []) as McpResource[]
  }

  /**
   * Reads one Graphify MCP resource by its URI.
   */
  async readResource(
    uri: string,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<McpResourceResult> {
    if (signal?.aborted) throw new Error('Resource read aborted by signal')

    await this.init()
    if (!this.client) throw new Error('Graphify MCP client is not connected')

    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs

    try {
      const response = await this.client.readResource(
        { uri },
        {
          signal,
          timeout: effectiveTimeout,
        }
      )

      return {
        contents: (response.contents || []) as McpResourceResult['contents'],
      }
    } catch (err) {
      if (signal?.aborted) throw new Error(`Resource read ${uri} cancelled`)
      throw err
    }
  }

  /**
   * Returns recent stderr output from the child process.
   */
  getRecentStderr(): string {
    return this.stderrBuffer.join('')
  }

  /**
   * Disposes the client and stops the server process with full quiescence.
   */
  async dispose(): Promise<void> {
    this.isDisposed = true
    this.generation++
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.healthyTimer) {
      clearTimeout(this.healthyTimer)
      this.healthyTimer = null
    }

    this.setState('disposed')

    const transport = this.transport
    const client = this.client
    this.transport = null
    this.client = null

    try {
      if (client) await client.close().catch(() => {})
    } finally {
      if (transport) await transport.close().catch(() => {})
    }
  }
}
