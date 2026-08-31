import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from './config.ts'
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './types.ts'

interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void
  reject: (error: Error) => void
  timer?: NodeJS.Timeout
}

/**
 * Resolves the command and arguments to launch the Graphify MCP server.
 */
export function resolveGraphifyCommand(
  config: Config,
  graphPath?: string,
  cwd: string = process.cwd()
): { command: string; args: string[] } {
  // If user supplied a custom command (other than the default 'graphify'), respect it.
  if (config.command && config.command !== 'graphify') {
    const args = [...config.args]
    if (graphPath && !args.includes('--graph') && !args.includes(graphPath)) {
      args.push('--graph', graphPath)
    }
    return { command: config.command, args }
  }

  // Check if uv is available
  const hasUv = isCommandAvailable('uv')
  if (hasUv) {
    const args = ['run', '--with', 'graphifyy', '--with', 'mcp', '-m', 'graphify.serve']
    if (graphPath) {
      args.push(graphPath)
    }
    return { command: 'uv', args }
  }

  // Check common Python/uv locations or fallback to python3
  const candidatePythons = [
    path.join(process.env.HOME || '', '.local/share/uv/tools/graphifyy/bin/python'),
    '/usr/local/bin/python3',
    '/usr/bin/python3',
    'python3',
  ]

  for (const py of candidatePythons) {
    if (py === 'python3' || fs.existsSync(py)) {
      const args = ['-m', 'graphify.serve']
      if (graphPath) {
        args.push(graphPath)
      }
      return { command: py, args }
    }
  }

  // Fallback to configured command
  const args = [...config.args]
  if (graphPath) {
    args.push(graphPath)
  }
  return { command: config.command || 'graphify', args }
}

function isCommandAvailable(cmd: string): boolean {
  try {
    const paths = (process.env.PATH || '').split(path.delimiter)
    for (const p of paths) {
      const full = path.join(p, cmd)
      if (fs.existsSync(full)) {
        return true
      }
    }
  } catch {
    // Ignore stat errors
  }
  return false
}

/**
 * Manages the Graphify MCP server child process over stdio.
 */
export class GraphifyServerProcess {
  private child: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<number | string, PendingRequest>()
  private isShuttingDown = false
  private exitPromise: Promise<void> | null = null
  private stderrBuffer: string[] = []
  private readonly command: string
  private readonly args: string[]
  private readonly cwd: string
  private readonly defaultTimeoutMs: number

  constructor(
    command: string,
    args: string[],
    cwd: string,
    defaultTimeoutMs: number = 60000
  ) {
    this.command = command
    this.args = args
    this.cwd = cwd
    this.defaultTimeoutMs = defaultTimeoutMs
  }

  /**
   * Starts the child process and binds stdio listeners.
   */
  start(): void {
    if (this.child) return

    this.isShuttingDown = false
    this.stderrBuffer = []

    // Scrub sensitive environment variables
    const scrubbedEnv = { ...process.env }
    for (const key of Object.keys(scrubbedEnv)) {
      if (/key|secret|token|password/i.test(key) && !/deepseek|graphify/i.test(key)) {
        delete scrubbedEnv[key]
      }
    }

    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: scrubbedEnv,
    })

    this.exitPromise = new Promise<void>((resolve) => {
      this.child?.once('close', () => {
        this.cleanupPending(new Error('Graphify MCP server process closed'))
        this.child = null
        resolve()
      })
    })

    this.child.on('error', (err) => {
      if (!this.isShuttingDown) {
        this.cleanupPending(new Error(`Graphify process error: ${err.message}`))
      }
    })

    this.child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.stderrBuffer.push(text)
      if (this.stderrBuffer.length > 50) {
        this.stderrBuffer.shift()
      }
    })

    if (this.child.stdout) {
      const rl = readline.createInterface({ input: this.child.stdout })
      rl.on('line', (line) => this.handleLine(line))
    }
  }

  /**
   * Sends a JSON-RPC request and awaits the response.
   */
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): { id: number; promise: Promise<JsonRpcResponse> } {
    if (!this.child || !this.child.stdin || this.child.killed) {
      throw new Error('Graphify MCP server process is not running')
    }

    const id = this.nextId++
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }

    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs

    const promise = new Promise<JsonRpcResponse>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      if (effectiveTimeout > 0 && Number.isFinite(effectiveTimeout)) {
        timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`Request ${method} (id: ${id}) timed out after ${effectiveTimeout}ms`))
        }, effectiveTimeout)
      }

      this.pending.set(id, { resolve, reject, timer })

      try {
        const payload = JSON.stringify(request) + '\n'
        this.child?.stdin?.write(payload, 'utf8', (err) => {
          if (err) {
            clearTimeout(timer)
            this.pending.delete(id)
            reject(err)
          }
        })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })

    return { id, promise }
  }

  /**
   * Sends a JSON-RPC notification (no response expected).
   */
  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.child || !this.child.stdin || this.child.killed) {
      return
    }

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    }

    try {
      this.child.stdin.write(JSON.stringify(notification) + '\n', 'utf8')
    } catch {
      // Fire-and-forget
    }
  }

  /**
   * Returns recent stderr logs for diagnostics.
   */
  getRecentStderr(): string {
    return this.stderrBuffer.join('')
  }

  /**
   * Gracefully terminates the process and waits for complete quiescence.
   */
  async stop(graceMs: number = 3000): Promise<void> {
    this.isShuttingDown = true
    if (!this.child) return

    const child = this.child
    const exitProm = this.exitPromise

    try {
      child.kill('SIGTERM')
    } catch {
      // Process may already be dead
    }

    let forceKillTimer: NodeJS.Timeout | undefined
    if (graceMs > 0) {
      forceKillTimer = setTimeout(() => {
        try {
          if (child && !child.killed) {
            child.kill('SIGKILL')
          }
        } catch {
          // Ignore
        }
      }, graceMs)
    }

    if (exitProm) {
      await exitProm
    }

    if (forceKillTimer) {
      clearTimeout(forceKillTimer)
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    try {
      const message = JSON.parse(trimmed) as JsonRpcResponse
      if (message.id !== undefined && this.pending.has(message.id)) {
        const req = this.pending.get(message.id)!
        this.pending.delete(message.id)
        if (req.timer) clearTimeout(req.timer)
        req.resolve(message)
      }
    } catch {
      // Non-JSON output from child stdout ignored
    }
  }

  private cleanupPending(error: Error): void {
    for (const [id, req] of this.pending.entries()) {
      if (req.timer) clearTimeout(req.timer)
      req.reject(error)
    }
    this.pending.clear()
  }
}
