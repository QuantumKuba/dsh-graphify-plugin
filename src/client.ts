import { GraphifyServerProcess } from './server-process.ts'
import type { McpToolInfo, McpCallResult, JsonRpcResponse } from './types.ts'

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
  }

  /**
   * Initializes the MCP connection and completes the protocol handshake.
   */
  async init(): Promise<void> {
    if (this.isInitialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
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

    return this.initPromise
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
        this.process.notify('notifications/cancelled', {
          requestId: id,
          reason: 'Tool execution aborted by caller',
        })
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
