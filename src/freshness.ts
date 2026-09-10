import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from './config.ts'
import type { ResolvedProject, GraphFreshnessInfo } from './types.ts'
import { resolveGraphifyCliCommand } from './server-process.ts'

export interface UpdateResult {
  readonly success: boolean
  readonly stdout: string
  readonly stderr: string
  readonly error?: string
}

/**
 * Evaluates the freshness of a project's Graphify knowledge graph relative to
 * recent file and git repository changes.
 */
export function checkGraphFreshness(project: ResolvedProject): GraphFreshnessInfo {
  if (!project.hasGraph || !project.graphJsonPath) {
    return {
      state: 'unknown',
      reason: 'No graph.json found in project directory or ancestors.',
    }
  }

  let graphMtimeMs: number
  try {
    const stat = fs.statSync(project.graphJsonPath)
    graphMtimeMs = stat.mtimeMs
  } catch {
    return {
      state: 'unknown',
      reason: 'Cannot read graph.json modification time.',
    }
  }

  const lastIndexedTime = new Date(graphMtimeMs).toISOString()

  // Attempt git status / diff check if project is in a git repository
  try {
    const gitCheck = checkGitFreshness(project.projectRoot, graphMtimeMs)
    if (gitCheck) {
      return {
        ...gitCheck,
        lastIndexedTime,
      }
    }
  } catch {
    // Fall back to mtime inspection if git check fails
  }

  // Non-git filesystem fallback
  const fileCheck = checkFilesystemFreshness(project.projectRoot, graphMtimeMs)
  return {
    ...fileCheck,
    lastIndexedTime,
  }
}

/** Checks working-tree and commit changes via git. */
function checkGitFreshness(projectRoot: string, graphMtimeMs: number): Omit<GraphFreshnessInfo, 'lastIndexedTime'> | null {
  const isGit = fs.existsSync(path.join(projectRoot, '.git')) ||
    spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 2000,
    }).status === 0

  if (!isGit) return null

  const changedFilesSet = new Set<string>()

  // 1. Check uncommitted changes in working tree (excluding graphify-out)
  const statusRes = spawnSync('git', ['status', '--porcelain'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 3000,
  })

  if (statusRes.status === 0 && statusRes.stdout) {
    const lines = statusRes.stdout.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const filePart = trimmed.slice(2).trim()
      if (filePart && !filePart.startsWith('graphify-out') && !filePart.includes('/graphify-out/')) {
        changedFilesSet.add(filePart)
      }
    }
  }

  // 2. Check commits made after graph modification time
  const isoDate = new Date(graphMtimeMs).toISOString()
  const logRes = spawnSync('git', ['log', `--since=${isoDate}`, '--name-only', '--format='], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 3000,
  })

  if (logRes.status === 0 && logRes.stdout) {
    const committedFiles = logRes.stdout.split('\n')
    for (const file of committedFiles) {
      const trimmed = file.trim()
      if (trimmed && !trimmed.startsWith('graphify-out') && !trimmed.includes('/graphify-out/')) {
        changedFilesSet.add(trimmed)
      }
    }
  }

  const changedFiles = Array.from(changedFilesSet)
  if (changedFiles.length > 0) {
    return {
      state: 'stale',
      reason: `${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'} modified or added since graph was indexed`,
      changedFilesCount: changedFiles.length,
      changedFilesSample: changedFiles.slice(0, 5),
    }
  }

  return {
    state: 'fresh',
    reason: 'Graph is up to date with repository commits and working tree',
    changedFilesCount: 0,
    changedFilesSample: [],
  }
}

/** Non-git fallback: inspects top-level directory entries for files modified after graph. */
function checkFilesystemFreshness(projectRoot: string, graphMtimeMs: number): Omit<GraphFreshnessInfo, 'lastIndexedTime'> {
  const changedFiles: string[] = []

  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'graphify-out' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const fullPath = path.join(projectRoot, entry.name)
      try {
        const stat = fs.statSync(fullPath)
        if (stat.mtimeMs > graphMtimeMs + 2000) {
          changedFiles.push(entry.name)
        }
      } catch {
        // Ignore
      }
    }
  } catch {
    return {
      state: 'unknown',
      reason: 'Could not inspect filesystem entries for freshness',
    }
  }

  if (changedFiles.length > 0) {
    return {
      state: 'stale',
      reason: `${changedFiles.length} file(s) modified after graph index`,
      changedFilesCount: changedFiles.length,
      changedFilesSample: changedFiles.slice(0, 5),
    }
  }

  return {
    state: 'fresh',
    reason: 'No modified files detected after graph index',
    changedFilesCount: 0,
    changedFilesSample: [],
  }
}

/**
 * Coalesces concurrent update requests for the same project root so multiple
 * agent turns never trigger duplicate simultaneous rebuilds.
 */
export class ProjectUpdateCoalescer {
  private inProgress = new Map<string, Promise<UpdateResult>>()

  /**
   * Runs or awaits an in-progress incremental update for the given project.
   */
  async update(
    config: Config,
    projectRoot: string,
    signal?: AbortSignal
  ): Promise<UpdateResult> {
    const canonical = path.resolve(projectRoot)
    const existing = this.inProgress.get(canonical)
    if (existing) {
      return existing
    }

    const promise = this.executeIncrementalUpdate(config, canonical, signal)
    this.inProgress.set(canonical, promise)

    try {
      return await promise
    } finally {
      this.inProgress.delete(canonical)
    }
  }

  private executeIncrementalUpdate(
    config: Config,
    projectRoot: string,
    signal?: AbortSignal
  ): Promise<UpdateResult> {
    return new Promise((resolve) => {
      const { command, args } = resolveGraphifyCliCommand(config, {
        operation: 'update',
        projectRoot,
        flags: [],
      })

      const child = spawn(command, args, {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let settled = false

      const timeoutMs = config.freshness.updateTimeoutMs || 120000
      let timer: NodeJS.Timeout | undefined
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          child.kill('SIGTERM')
          settle(false, `Graphify update timed out after ${timeoutMs}ms`)
        }, timeoutMs)
      }

      const onAbort = () => {
        child.kill('SIGTERM')
        settle(false, 'Graphify update cancelled by signal')
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      const settle = (success: boolean, error?: string) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve({
          success,
          stdout,
          stderr,
          error,
        })
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        if (stdout.length > 65536) stdout = stdout.slice(-65536)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
        if (stderr.length > 65536) stderr = stderr.slice(-65536)
      })

      child.once('error', (err) => settle(false, err.message))
      child.once('close', (code, childSignal) => {
        if (code === 0) {
          settle(true)
        } else {
          const status = childSignal ? `signal ${childSignal}` : `code ${code ?? 'unknown'}`
          settle(false, stderr || stdout || `Graphify update exited with ${status}`)
        }
      })
    })
  }
}
