import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from './config.ts'
import type { GraphifyCommandRequest } from './commands.ts'
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './types.ts'

interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void
  reject: (error: Error) => void
  timer?: NodeJS.Timeout
}

/** Child-process termination details retained for actionable MCP diagnostics. */
export interface GraphifyServerExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
}

/** Command used to start a local Graphify process. */
export interface GraphifyCommand {
  readonly command: string
  readonly args: string[]
}

/**
 * Resolves the command and arguments to launch the Graphify MCP server.
 */
export function resolveGraphifyCommand(
  config: Config,
  graphPath?: string,
): GraphifyCommand {
  if (config.command !== 'auto') {
    const args = [...config.args]
    if (graphPath && !args.includes('--graph') && !args.includes(graphPath)) {
      args.push('--graph', graphPath)
    }
    return { command: config.command, args }
  }

  const installedPython = findInstalledGraphifyPython()
  if (installedPython) {
    const args = ['-m', 'graphify.serve']
    if (graphPath) {
      args.push(graphPath)
    }
    return { command: installedPython, args }
  }

  if (!isCommandAvailable('uv')) {
    throw new Error(
      'Graphify is unavailable. Install `graphifyy[mcp]` with uv or pipx, or configure command and args for `python -m graphify.serve`.'
    )
  }

  const packageSpec = config.graphifyVersion
    ? `graphifyy[mcp]==${config.graphifyVersion}`
    : 'graphifyy[mcp]'
  const args = ['run', '--with', packageSpec, '-m', 'graphify.serve']
  if (graphPath) {
    args.push(graphPath)
  }
  return { command: 'uv', args }
}

/** Resolves the CLI used by the direct build and update command. */
export function resolveGraphifyCliCommand(config: Config, request: GraphifyCommandRequest): GraphifyCommand {
  const operation = request.operation === 'update' ? ['update'] : []
  if (config.cliCommand) {
    return {
      command: config.cliCommand,
      args: [...config.cliArgs, ...operation, request.projectRoot, ...request.flags],
    }
  }

  const installed = findCommand('graphify')
  if (installed) {
    return {
      command: installed,
      args: [...operation, request.projectRoot, ...request.flags],
    }
  }

  if (!isCommandAvailable('uv')) {
    throw new Error('Graphify CLI is unavailable. Install `graphifyy` with uv or pipx, or configure cliCommand.')
  }

  const packageSpec = config.graphifyVersion ? `graphifyy==${config.graphifyVersion}` : 'graphifyy'
  return {
    command: 'uv',
    args: ['run', '--with', packageSpec, 'graphify', ...operation, request.projectRoot, ...request.flags],
  }
}

/** Resolves the interpreter behind an installed Graphify console script. */
function findInstalledGraphifyPython(): string | undefined {
  const executable = findCommand('graphify')
  if (!executable) return undefined

  try {
    const firstLine = fs.readFileSync(executable, 'utf8').split(/\r?\n/, 1)[0]
    const match = /^#!(.+)$/.exec(firstLine)
    if (match && fs.existsSync(match[1])) {
      return match[1]
    }
  } catch {
    // A non-script launcher falls through to the uv fallback.
  }

  return undefined
}

function isCommandAvailable(cmd: string): boolean {
  return findCommand(cmd) !== undefined
}

function findCommand(cmd: string): string | undefined {
  try {
    const paths = (process.env.PATH || '').split(path.delimiter)
    for (const p of paths) {
      const full = path.join(p, cmd)
      if (fs.existsSync(full)) {
        return full
      }
    }
  } catch {
    // Ignore stat errors
  }
  return undefined
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
  private readonly exitListeners = new Set<(exit: GraphifyServerExit) => void>()

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

    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.exitPromise = new Promise<void>((resolve) => {
      this.child?.once('close', (code, signal) => {
        const exit: GraphifyServerExit = {
          code,
          signal,
          stderr: this.getRecentStderr(),
        }
        this.cleanupPending(new Error(this.describeExit(exit)))
        this.child = null
        for (const listener of this.exitListeners) listener(exit)
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

  /** Subscribe to unexpected and intentional child exits. */
  onExit(listener: (exit: GraphifyServerExit) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
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

  /** Cancels a request locally and notifies an MCP server that supports cancellation. */
  cancel(id: number | string, reason: string): void {
    const pending = this.pending.get(id)
    if (pending) {
      this.pending.delete(id)
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.notify('notifications/cancelled', { requestId: id, reason })
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
          if (child.exitCode === null && child.signalCode === null) {
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

  private describeExit(exit: GraphifyServerExit): string {
    const status = exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 'unknown'}`
    const stderr = exit.stderr.trim()
    return stderr
      ? `Graphify MCP server exited with ${status}: ${stderr}`
      : `Graphify MCP server exited with ${status}`
  }
}
