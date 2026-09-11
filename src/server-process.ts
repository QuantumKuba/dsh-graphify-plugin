import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, type ChildProcess } from 'node:child_process'
import type { Config } from './config.ts'
import type { GraphifyCommandRequest } from './commands.ts'

/** Tested default Graphify version pinned for reproducible marketplace deployments. */
export const DEFAULT_GRAPHIFY_VERSION = '0.9.57'

/** Command used to start a local Graphify process. */
export interface GraphifyCommand {
  readonly command: string
  readonly args: string[]
}

export interface RuntimeResolutionAvailable {
  readonly available: true
  readonly command: string
  readonly args: string[]
  readonly source: 'installed' | 'python' | 'uv' | 'custom'
  readonly version?: string
}

export interface RuntimeResolutionUnavailable {
  readonly available: false
  readonly reason: string
  readonly remediation: string
}

/** Structured result from attempting to discover the Graphify MCP server runtime. */
export type RuntimeResolution = RuntimeResolutionAvailable | RuntimeResolutionUnavailable

export interface CliRuntimeResolutionAvailable {
  readonly available: true
  readonly command: string
  readonly args: string[]
  readonly source: 'installed' | 'uv' | 'custom'
}

export interface CliRuntimeResolutionUnavailable {
  readonly available: false
  readonly reason: string
  readonly remediation: string
}

/** Structured result from attempting to discover the Graphify CLI runtime. */
export type CliRuntimeResolution = CliRuntimeResolutionAvailable | CliRuntimeResolutionUnavailable

/**
 * Resolves diagnostic and launch information for the Graphify MCP runtime without throwing.
 * Gracefully reports `available: false` when Graphify is not yet installed.
 */
export function resolveGraphifyRuntime(
  config: Config,
  graphPath?: string
): RuntimeResolution {
  if (config.command !== 'auto') {
    const args = [...config.args]
    if (graphPath && !args.includes('--graph') && !args.includes(graphPath)) {
      args.push('--graph', graphPath)
    }
    if (
      (config.command.startsWith('/') || config.command.startsWith('./') || config.command.startsWith('../')) &&
      !fs.existsSync(config.command)
    ) {
      return {
        available: false,
        reason: `Configured Graphify command does not exist: "${config.command}".`,
        remediation: 'Verify the path specified in `command` in your cordis.yml configuration.',
      }
    }
    return { available: true, command: config.command, args, source: 'custom' }
  }

  const installedMcp = findCommand('graphify-mcp')
  if (installedMcp) {
    const args: string[] = []
    if (graphPath) {
      args.push(graphPath)
    }
    return {
      available: true,
      command: installedMcp,
      args,
      source: 'installed',
      version: getDetectedGraphifyVersion(),
    }
  }

  const installedPython = findInstalledGraphifyPython()
  if (installedPython) {
    const args = ['-m', 'graphify.serve']
    if (graphPath) {
      args.push(graphPath)
    }
    return {
      available: true,
      command: installedPython,
      args,
      source: 'python',
      version: getDetectedGraphifyVersion(),
    }
  }

  if (isCommandAvailable('uv')) {
    const version = config.graphifyVersion || DEFAULT_GRAPHIFY_VERSION
    const packageSpec = `graphifyy[mcp]==${version}`
    const args = ['run', '--with', packageSpec, '-m', 'graphify.serve']
    if (graphPath) {
      args.push(graphPath)
    }
    return {
      available: true,
      command: 'uv',
      args,
      source: 'uv',
      version,
    }
  }

  return {
    available: false,
    reason: 'Graphify runtime is not installed and uv is not available on PATH.',
    remediation: `Install Graphify with:\n  uv tool install 'graphifyy[mcp]==${DEFAULT_GRAPHIFY_VERSION}'\nor configure \`command\` in cordis.yml.`,
  }
}

/**
 * Resolves the command and arguments to launch the Graphify MCP server.
 * Throws an actionable error if the runtime is unavailable.
 */
export function resolveGraphifyCommand(
  config: Config,
  graphPath?: string,
): GraphifyCommand {
  const res = resolveGraphifyRuntime(config, graphPath)
  if (!res.available) {
    throw new Error(`${res.reason} ${res.remediation}`)
  }
  return { command: res.command, args: res.args }
}

/**
 * Resolves diagnostic and launch information for the Graphify CLI runtime without throwing.
 */
export function resolveGraphifyCliRuntime(
  config: Config,
  request: GraphifyCommandRequest
): CliRuntimeResolution {
  const operation = request.operation === 'update' ? ['update'] : []
  if (config.cliCommand) {
    return {
      available: true,
      command: config.cliCommand,
      args: [...config.cliArgs, ...operation, request.projectRoot, ...request.flags],
      source: 'custom',
    }
  }

  const installed = findCommand('graphify')
  if (installed) {
    return {
      available: true,
      command: installed,
      args: [...operation, request.projectRoot, ...request.flags],
      source: 'installed',
    }
  }

  if (isCommandAvailable('uv')) {
    const version = config.graphifyVersion || DEFAULT_GRAPHIFY_VERSION
    const packageSpec = `graphifyy==${version}`
    return {
      available: true,
      command: 'uv',
      args: ['run', '--with', packageSpec, 'graphify', ...operation, request.projectRoot, ...request.flags],
      source: 'uv',
    }
  }

  return {
    available: false,
    reason: 'Graphify CLI is not installed and uv is not available on PATH.',
    remediation: `Install Graphify with:\n  uv tool install 'graphifyy[mcp]==${DEFAULT_GRAPHIFY_VERSION}'\nor configure \`cliCommand\` in cordis.yml.`,
  }
}

/** Resolves the CLI used by the direct build and update command. */
export function resolveGraphifyCliCommand(config: Config, request: GraphifyCommandRequest): GraphifyCommand {
  const res = resolveGraphifyCliRuntime(config, request)
  if (!res.available) {
    throw new Error(`${res.reason} ${res.remediation}`)
  }
  return { command: res.command, args: res.args }
}

/** Probes for installed Graphify version via `graphify --version`. */
export function getDetectedGraphifyVersion(): string | undefined {
  const executable = findCommand('graphify') || findCommand('graphify-mcp')
  if (!executable) return undefined
  try {
    const res = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 1000 })
    if (res.status === 0 && res.stdout) {
      const match = /(\d+\.\d+\.\d+)/.exec(res.stdout)
      if (match) return match[1]
    }
  } catch {
    // Ignore version probe errors
  }
  return undefined
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
  const resolution = resolveGraphifyRuntime(config)
  if (resolution.available) {
    return {
      command: resolution.command,
      source: resolution.source,
      version: resolution.version,
    }
  }

  return {
    command: config.command !== 'auto' ? config.command : 'auto',
    source: 'unknown',
  }
}

export function isCommandAvailable(cmd: string): boolean {
  return findCommand(cmd) !== undefined
}

export function findCommand(cmd: string): string | undefined {
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
 * Resolves when the child process has confirmed closed/exited, or immediately
 * if the process is already dead.
 */
export function terminateChildProcess(
  child: ChildProcess,
  graceMs = 1500
): Promise<void> {
  return new Promise((resolve) => {
    // If the child has already exited, resolve immediately
    if (typeof child.exitCode === 'number' || typeof child.signalCode === 'string') {
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
      child.removeListener('close', finish)
      child.removeListener('exit', finish)
      child.removeListener('error', finish)
      resolve()
    }

    child.once('close', finish)
    child.once('exit', finish)
    child.once('error', finish)

    // Re-check exit status in case child exited right before listeners attached
    if (typeof child.exitCode === 'number' || typeof child.signalCode === 'string') {
      finish()
      return
    }

    // Only send SIGTERM if a termination signal has not already been sent
    if (!child.killed) {
      try {
        child.kill('SIGTERM')
      } catch {
        // Signal error (e.g. process already dead ESRCH); wait for close or timeout
      }
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

