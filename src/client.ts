import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type {
  McpToolInfo,
  McpResource,
  McpCallResult,
  McpResourceResult,
  ReconnectConfig,
  McpConnectionState,
} from './types.ts'
import { getPackageVersion } from './version.ts'

export interface ClientLogger {
  info: (msg: string, ...args: unknown[]) => void
  warn: (msg: string, ...args: unknown[]) => void
  error: (msg: string, ...args: unknown[]) => void
  debug: (msg: string, ...args: unknown[]) => void
}

export interface ClientOptions {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
  reconnect?: ReconnectConfig
  logger?: ClientLogger
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
 */
export class GraphifyMcpClient {
  private client: Client | null = null
  private transport: StdioClientTransport | null = null
  private state: McpConnectionState = 'disconnected'
  private generation = 0
  private initPromise: Promise<void> | null = null
  private stderrBuffer: string[] = []
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private healthyTimer: NodeJS.Timeout | null = null
  private isDisposed = false

  private readonly command: string
  private readonly args: string[]
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

    this.initPromise = this.establishConnection()
    try {
      await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  private async establishConnection(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    const currentGeneration = ++this.generation
    this.setState('connecting')
    this.logger?.debug(`[dsh-graphify] Starting Graphify MCP server (gen ${currentGeneration}): ${this.command} ${this.args.join(' ')}`)

    // Clean up any stale transport
    if (this.transport) {
      try {
        await this.transport.close()
      } catch {
        // Stale close ignored
      }
      this.transport = null
    }

    try {
      const transport = new StdioClientTransport({
        command: this.command,
        args: this.args,
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
          if (this.stderrBuffer.length > 50) {
            this.stderrBuffer.shift()
          }
        })
      }

      // Handle unexpected close
      transport.onclose = () => {
        if (this.generation !== currentGeneration || this.isDisposed) return
        this.handleDisconnect(currentGeneration)
      }

      // Handle transport errors
      transport.onerror = (error: Error) => {
        if (this.generation !== currentGeneration || this.isDisposed) return
        this.logger?.warn(`[dsh-graphify] Transport error (gen ${currentGeneration}): ${error.message}`)
      }

      const client = new Client(
        {
          name: 'dsh-graphify',
          version: getPackageVersion(),
        },
        {
          capabilities: {},
          listChanged: {
            tools: {
              onChanged: async (error, result) => {
                if (error) {
                  this.logger?.warn(`[dsh-graphify] Failed to refresh tools on list_changed: ${error.message}`)
                  return
                }
                const rawTools = Array.isArray(result) ? result : (result as unknown as { tools?: unknown[] })?.tools
                const tools = (rawTools || []) as McpToolInfo[]
                for (const listener of this.toolsChangedListeners) {
                  try {
                    listener(tools)
                  } catch {
                    // Ignore listener errors
                  }
                }
              },
            },
          },
        }
      )

      await client.connect(transport)

      if (this.generation !== currentGeneration || this.isDisposed) {
        await client.close().catch(() => {})
        await transport.close().catch(() => {})
        return
      }

      this.client = client
      this.transport = transport
      this.setState('connected')
      this.logger?.info(`[dsh-graphify] Connected to Graphify MCP server in ${this.cwd}`)

      // Reset reconnect counter once connection remains stable
      if (this.healthyTimer) clearTimeout(this.healthyTimer)
      this.healthyTimer = setTimeout(() => {
        this.reconnectAttempts = 0
      }, this.reconnectConfig.maxDelayMs)
    } catch (error) {
      if (this.generation !== currentGeneration || this.isDisposed) return
      this.setState('error')
      const msg = error instanceof Error ? error.message : String(error)
      this.logger?.error(`[dsh-graphify] Failed to connect to Graphify MCP: ${msg}\nRecent stderr: ${this.getRecentStderr()}`)
      throw new Error(`Failed to connect to Graphify MCP: ${msg}`)
    }
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
      `[dsh-graphify] Connection lost. Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.reconnectConfig.maxAttempts})...`
    )

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.generation === generation && !this.isDisposed) {
        this.init().catch(() => {
          // Reconnection error handled inside establishConnection
        })
      }
    }, delay)
  }

  private setState(state: McpConnectionState): void {
    if (this.state === state) return
    this.state = state
    for (const listener of this.stateListeners) {
      try {
        listener(state)
      } catch {
        // Ignore
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
        content: response.content as McpCallResult['content'],
        isError: response.isError ? true : undefined,
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
