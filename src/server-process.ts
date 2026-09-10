import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { Config } from './config.ts'
import type { GraphifyCommandRequest } from './commands.ts'

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

  const installedMcp = findCommand('graphify-mcp')
  if (installedMcp) {
    const args: string[] = []
    if (graphPath) {
      args.push(graphPath)
    }
    return { command: installedMcp, args }
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
      'Graphify is unavailable. Install `graphifyy[mcp]` with uv or pipx, or configure command and args for `graphify-mcp` or `python -m graphify.serve`.'
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

/**
 * Inspects and returns diagnostic information regarding the resolved Graphify runtime.
 */
export function getRuntimeInfo(config: Config): {
  command: string
  source: 'installed' | 'python' | 'uv' | 'custom' | 'unknown'
  version?: string
} {
  if (config.command !== 'auto') {
    return { command: config.command, source: 'custom' }
  }

  const installedMcp = findCommand('graphify-mcp')
  if (installedMcp) {
    return { command: installedMcp, source: 'installed' }
  }

  const installedPython = findInstalledGraphifyPython()
  if (installedPython) {
    return { command: installedPython, source: 'python' }
  }

  if (isCommandAvailable('uv')) {
    return {
      command: 'uv',
      source: 'uv',
      version: config.graphifyVersion,
    }
  }

  return { command: 'auto', source: 'unknown' }
}

function isCommandAvailable(cmd: string): boolean {
  return findCommand(cmd) !== undefined
}

function findCommand(cmd: string): string | undefined {
  try {
    const paths = (process.env.PATH || '').split(path.delimiter)
    const extensions = process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
      : ['']

    for (const p of paths) {
      if (!p) continue
      for (const ext of extensions) {
        const full = path.join(p, `${cmd}${ext.toLowerCase()}`)
        if (fs.existsSync(full)) {
          try {
            const stat = fs.statSync(full)
            if (stat.isFile()) return full
          } catch {
            // Ignore stat errors
          }
        }
        if (ext && fs.existsSync(path.join(p, `${cmd}${ext.toUpperCase()}`))) {
          return path.join(p, `${cmd}${ext.toUpperCase()}`)
        }
      }
    }
  } catch {
    // Ignore stat errors
  }
  return undefined
}

/**
 * Gracefully terminates a child process using SIGTERM, escalating to SIGKILL
 * after a grace period if the process has not yet exited.
 * Resolves when the process closes or immediately if already dead/closed.
 */
export function terminateChildProcess(
  child: ChildProcess,
  graceMs = 1500
): Promise<void> {
  return new Promise((resolve) => {
    // If the child has already exited, resolve immediately
    if (typeof child.exitCode === 'number' || typeof child.signalCode === 'string' || child.killed) {
      resolve()
      return
    }

    let resolved = false
    let killTimer: NodeJS.Timeout | null = null

    const finish = () => {
      if (resolved) return
      resolved = true
      if (killTimer) {
        clearTimeout(killTimer)
        killTimer = null
      }
      resolve()
    }

    child.once('close', finish)
    child.once('error', finish)

    try {
      child.kill('SIGTERM')
    } catch {
      finish()
      return
    }

    killTimer = setTimeout(() => {
      if (!resolved) {
        try {
          child.kill('SIGKILL')
        } catch {
          // Ignore
        }
      }
    }, graceMs)
  })
}
