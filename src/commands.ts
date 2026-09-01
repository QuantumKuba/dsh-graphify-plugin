import { spawn } from 'node:child_process'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import { resolveGraphifyCliCommand } from './server-process.ts'

export interface CommandInvocation {
  commandId?: unknown
  agent: {
    readonly session: {
      readonly header: {
        readonly cwd?: string
      }
    }
  }
  rawInput: string
  attachments?: readonly unknown[]
  signal: AbortSignal
}

export type CommandResult =
  | { kind: 'success'; text?: string; sourceEventSeq?: number }
  | { kind: 'error'; text: string }

export interface CommandDefinition {
  name: string
  description: string
  input?: { hint: string; images?: boolean }
  recordInput?: boolean
  handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

/** Parsed Graphify command supported by the direct DSH command surface. */
export interface GraphifyCommandRequest {
  readonly operation: 'build' | 'update'
  readonly projectRoot: string
  readonly flags: readonly string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    commands: {
      register: (def: CommandDefinition) => () => void
      [key: string]: unknown
    }
  }
}

/**
 * Parses `/graphify [build|update] [path] [--force|--no-cluster]` against the
 * receiving Session's project root.
 */
export function parseGraphifyCommand(rawInput: string, projectRoot: string): GraphifyCommandRequest {
  const tokens = tokenize(rawInput)
  const operation = tokens[0] === 'update' ? 'update' : 'build'
  const rest = operation === 'update' || tokens[0] === 'build' ? tokens.slice(1) : tokens
  const flags = rest.filter((token) => token.startsWith('-'))
  const paths = rest.filter((token) => !token.startsWith('-'))

  if (paths.length > 1) {
    throw new Error('Use one project path. Queries belong in Graphify tools, not `/graphify`.')
  }
  if (flags.some((flag) => !['--force', '--no-cluster'].includes(flag))) {
    throw new Error('Only --force and --no-cluster are accepted by `/graphify`.')
  }

  return {
    operation,
    projectRoot: paths[0] ? path.resolve(projectRoot, paths[0]) : projectRoot,
    flags,
  }
}

/** Splits the small command grammar while retaining quoted project paths. */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let token = ''
  let quote: '"' | "'" | undefined
  let escaping = false

  for (const character of input.trim()) {
    if (escaping) {
      token += character
      escaping = false
      continue
    }
    if (character === '\\') {
      escaping = true
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
      else token += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (token) tokens.push(token)
      token = ''
      continue
    }
    token += character
  }
  if (quote || escaping) throw new Error('The command has an unfinished quote or escape sequence.')
  if (token) tokens.push(token)
  return tokens
}

/** Registers the `/graphify` build and incremental-update command. */
export function registerGraphifyCommand(
  ctx: Context,
  config: Config,
  defaultProjectRoot: string
): () => void {
  const def: CommandDefinition = {
    name: 'graphify',
    description: 'Build or incrementally update this project’s Graphify knowledge graph.',
    input: { hint: '[build|update] [path] [--force|--no-cluster]' },
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      try {
        const projectRoot = invocation.agent.session.header.cwd || defaultProjectRoot
        const request = parseGraphifyCommand(invocation.rawInput, projectRoot)
        const { command, args } = resolveGraphifyCliCommand(config, request)
        const text = await runGraphify(command, args, request.projectRoot, invocation.signal)
        return { kind: 'success', text }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        return { kind: 'error', text: `Graphify failed: ${text}` }
      }
    },
  }

  return ctx.commands.register(def)
}

/** Runs Graphify while preserving a bounded, useful result for the command UI. */
function runGraphify(command: string, args: readonly string[], cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const onAbort = () => {
      child.kill('SIGTERM')
      settle(() => reject(new Error('Graphify command cancelled')))
    }
    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      action()
    }
    const append = (current: string, chunk: Buffer) => {
      const combined = current + chunk.toString('utf8')
      return combined.length > 65_536 ? combined.slice(-65_536) : combined
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    signal.addEventListener('abort', onAbort, { once: true })
    child.once('error', (error) => settle(() => reject(error)))
    child.once('close', (code, childSignal) => {
      if (code === 0) {
        settle(() => resolve(stdout || 'Graphify completed successfully.'))
        return
      }
      const status = childSignal ? `signal ${childSignal}` : `code ${code ?? 'unknown'}`
      settle(() => reject(new Error(stderr || stdout || `Graphify exited with ${status}`)))
    })
  })
}
