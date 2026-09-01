import { GraphifyServerProcess } from './server-process.ts'
import type { McpToolInfo, McpResource, McpCallResult, McpResourceResult, JsonRpcResponse } from './types.ts'

export interface ClientOptions {
  command: string
  args: string[]
  cwd: string
  timeoutMs?: number
}

/**
 * MCP Client for communicating with the Graphify MCP Server.
 */
export class GraphifyMcpClient {
  private process: GraphifyServerProcess
  private isInitialized = false
  private initPromise: Promise<void> | null = null

  constructor(options: ClientOptions) {
    this.process = new GraphifyServerProcess(
      options.command,
      options.args,
      options.cwd,
      options.timeoutMs ?? 60000
    )
    this.process.onExit(() => {
      this.isInitialized = false
      this.initPromise = null
    })
  }

  /**
   * Initializes the MCP connection and completes the protocol handshake.
   */
  async init(): Promise<void> {
    if (this.isInitialized) return
    if (this.initPromise) return this.initPromise

    const initialization = (async () => {
      this.process.start()

      const { promise } = this.process.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'dsh-graphify',
          version: '0.1.0',
        },
      })

      const response = await promise
      if (response.error) {
        throw new Error(`MCP initialize error: ${response.error.message} (code ${response.error.code})`)
      }

      this.process.notify('notifications/initialized', {})
      this.isInitialized = true
    })()
    this.initPromise = initialization

    try {
      await initialization
    } catch (error) {
      this.isInitialized = false
      this.initPromise = null
      await this.process.stop().catch(() => undefined)
      throw error
    }

    return initialization
  }

  /**
   * Lists all tools exposed by the Graphify MCP server.
   */
  async listTools(): Promise<McpToolInfo[]> {
    await this.init()

    const { promise } = this.process.send('tools/list', {})
    const response = await promise

    if (response.error) {
      throw new Error(`Failed to list tools: ${response.error.message}`)
    }

    const result = response.result as { tools?: McpToolInfo[] }
    return result?.tools || []
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
    await this.init()

    if (signal?.aborted) {
      throw new Error('Tool call aborted by signal')
    }

    const { id, promise } = this.process.send(
      'tools/call',
      {
        name,
        arguments: args,
      },
      timeoutMs
    )

    let abortHandler: (() => void) | undefined

    if (signal) {
      abortHandler = () => {
        this.process.cancel(id, `Tool call ${name} cancelled`)
      }
      signal.addEventListener('abort', abortHandler, { once: true })
    }

    try {
      const response: JsonRpcResponse = await promise
      if (response.error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error from Graphify (${response.error.code}): ${response.error.message}`,
            },
          ],
        }
      }

      return (response.result as McpCallResult) || { content: [] }
    } catch (err) {
      if (signal?.aborted) {
        throw new Error(`Tool call ${name} cancelled`)
      }
      throw err
    } finally {
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler)
      }
    }
  }

  /** Lists Graphify MCP resources, including reports and graph analyses. */
  async listResources(): Promise<McpResource[]> {
    await this.init()
    const { promise } = this.process.send('resources/list', {})
    const response = await promise
    if (response.error) {
      throw new Error(`Failed to list Graphify resources: ${response.error.message}`)
    }
    const result = response.result as { resources?: McpResource[] }
    return result?.resources || []
  }

  /** Reads one Graphify MCP resource by its URI. */
  async readResource(uri: string, signal?: AbortSignal, timeoutMs?: number): Promise<McpResourceResult> {
    await this.init()
    if (signal?.aborted) throw new Error('Resource read aborted by signal')

    const { id, promise } = this.process.send('resources/read', { uri }, timeoutMs)
    const abortHandler = () => this.process.cancel(id, `Resource read ${uri} cancelled`)
    signal?.addEventListener('abort', abortHandler, { once: true })

    try {
      const response = await promise
      if (response.error) {
        throw new Error(`Failed to read Graphify resource: ${response.error.message}`)
      }
      return (response.result as McpResourceResult) || { contents: [] }
    } finally {
      signal?.removeEventListener('abort', abortHandler)
    }
  }

  /**
   * Returns recent stderr output from the child process.
   */
  getRecentStderr(): string {
    return this.process.getRecentStderr()
  }

  /**
   * Disposes the client and stops the server process with full quiescence.
   */
  async dispose(): Promise<void> {
    this.isInitialized = false
    this.initPromise = null
    await this.process.stop()
  }
}
