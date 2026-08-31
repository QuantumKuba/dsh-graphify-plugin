import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import type { DetectedGraph } from './types.ts'

export interface CommandInvocation {
  commandId?: unknown
  agent?: unknown
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

declare module '@deepseek-ai/cordis' {
  interface Context {
    commands: {
      register: (def: CommandDefinition) => () => void
      [key: string]: unknown
    }
  }
}

/**
 * Registers the /graphify slash command on ctx.commands.
 */
export function registerGraphifyCommand(
  ctx: Context,
  config: Config,
  detectedGraph: DetectedGraph | null
): () => void {
  if (!ctx.commands || typeof ctx.commands.register !== 'function') {
    return () => {}
  }

  const def: CommandDefinition = {
    name: 'graphify',
    description: 'Build or query the Graphify knowledge graph (e.g. `/graphify .` to index workspace)',
    input: {
      hint: '[path | query]',
    },
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      const input = (invocation.rawInput || '').trim()
      const targetDir = input && input !== '.' ? path.resolve(process.cwd(), input) : process.cwd()

      try {
        const resultText = await runGraphifyIndexing(targetDir, invocation.signal)
        return {
          kind: 'success',
          text: resultText,
        }
      } catch (err) {
        return {
          kind: 'error',
          text: `Failed to run graphify: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
  }

  return ctx.commands.register(def)
}

import { spawn } from 'node:child_process'
import path from 'node:path'

function runGraphifyIndexing(targetDir: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('uv', ['run', '--with', 'graphifyy', 'graphify', targetDir], {
      cwd: targetDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (d) => {
      stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d) => {
      stderr += d.toString('utf8')
    })

    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          child.kill('SIGTERM')
          reject(new Error('Graphify indexing cancelled by signal'))
        },
        { once: true }
      )
    }

    child.on('error', (err) => {
      const fallback = spawn('graphify', [targetDir], {
        cwd: targetDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let fbOut = ''
      let fbErr = ''
      fallback.stdout?.on('data', (d) => (fbOut += d.toString('utf8')))
      fallback.stderr?.on('data', (d) => (fbErr += d.toString('utf8')))
      fallback.on('close', (code) => {
        if (code === 0) {
          resolve(fbOut || `Graphify indexed successfully in ${targetDir}`)
        } else {
          reject(new Error(fbErr || `Graphify exited with code ${code}`))
        }
      })
      fallback.on('error', () => reject(err))
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout || `Graphify indexed successfully in ${targetDir}`)
      } else {
        reject(new Error(stderr || stdout || `Graphify exited with code ${code}`))
      }
    })
  })
}
