import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from './config.ts'
import type { ResolvedProject, GraphFreshnessInfo } from './types.ts'
import { resolveGraphifyCliCommand } from './server-process.ts'

export const INDEX_METADATA_FILENAME = '.dsh-graphify-index.json'

/**
 * Durable metadata recorded by dsh-graphify after a successful graph build or update.
 * Tracks the exact git repository state (commit HEAD, tree SHA, branch) the graph reflects,
 * eliminating false-positive freshness checks on branch checkouts.
 */
export interface GraphifyIndexMetadata {
  readonly version: 1
  readonly indexedAt: string
  readonly graphPath: string
  readonly graphMtimeMs: number
  readonly git?: {
    readonly head: string
    readonly tree: string
    readonly branch?: string | null
  }
}

export interface UpdateResult {
  readonly success: boolean
  readonly stdout: string
  readonly stderr: string
  readonly error?: string
}

/**
 * Writes a durable index metadata file inside graphify-out/.
 */
export function writeGraphifyIndexMetadata(
  projectRoot: string,
  customGraphPath?: string
): GraphifyIndexMetadata | null {
  const graphPath = customGraphPath || path.join(projectRoot, 'graphify-out', 'graph.json')
  if (!fs.existsSync(graphPath)) return null

  let graphMtimeMs = Date.now()
  try {
    graphMtimeMs = fs.statSync(graphPath).mtimeMs
  } catch {
    // Fall back to current time
  }

  let gitInfo: GraphifyIndexMetadata['git']
  try {
    const headRes = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 2000,
    })
    if (headRes.status === 0 && headRes.stdout.trim()) {
      const head = headRes.stdout.trim()
      const treeRes = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 2000,
      })
      const tree = treeRes.status === 0 && treeRes.stdout.trim() ? treeRes.stdout.trim() : head
      const branchRes = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 2000,
      })
      const branch = branchRes.status === 0 ? branchRes.stdout.trim() : null

      gitInfo = { head, tree, branch }
    }
  } catch {
    // Non-git environment
  }

  const metadata: GraphifyIndexMetadata = {
    version: 1,
    indexedAt: new Date(graphMtimeMs).toISOString(),
    graphPath: path.relative(projectRoot, graphPath),
    graphMtimeMs,
    ...(gitInfo ? { git: gitInfo } : {}),
  }

  const metaDir = path.dirname(graphPath)
  if (fs.existsSync(metaDir)) {
    try {
      const metaFilePath = path.join(metaDir, INDEX_METADATA_FILENAME)
      fs.writeFileSync(metaFilePath, JSON.stringify(metadata, null, 2), 'utf8')
      return metadata
    } catch {
      // Ignored if unwritable
    }
  }
  return null
}

/**
 * Reads durable index metadata if present in graphify-out/.
 */
export function readGraphifyIndexMetadata(projectRoot: string): GraphifyIndexMetadata | null {
  const metaPath = path.join(projectRoot, 'graphify-out', INDEX_METADATA_FILENAME)
  if (!fs.existsSync(metaPath)) return null

  try {
    const raw = fs.readFileSync(metaPath, 'utf8')
    const parsed = JSON.parse(raw) as GraphifyIndexMetadata
    if (parsed && parsed.version === 1 && typeof parsed.graphMtimeMs === 'number') {
      return parsed
    }
  } catch {
    // Malformed metadata file ignored
  }
  return null
}

/**
 * Evaluates the freshness of a project's Graphify knowledge graph relative to
 * repository HEAD state, uncommitted working tree changes, and file modifications.
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

  // 1. Check durable index metadata first if available
  const metadata = readGraphifyIndexMetadata(project.projectRoot)
  if (metadata && metadata.git) {
    const metaGitCheck = checkMetadataGitFreshness(project.projectRoot, metadata)
    if (metaGitCheck) {
      return {
        ...metaGitCheck,
        lastIndexedTime: metadata.indexedAt || lastIndexedTime,
      }
    }
  }

  // 2. Fall back to heuristic git inspection if project is a git repository
  try {
    const gitCheck = checkGitHeuristicFreshness(project.projectRoot, graphMtimeMs)
    if (gitCheck) {
      return {
        ...gitCheck,
        lastIndexedTime,
      }
    }
  } catch {
    // Fall through to filesystem check
  }

  // 3. Non-git recursive filesystem fallback
  const fileCheck = checkFilesystemRecursiveFreshness(project.projectRoot, graphMtimeMs)
  return {
    ...fileCheck,
    lastIndexedTime,
  }
}

/** Checks freshness against durable git metadata (detects branch switches and commit changes). */
function checkMetadataGitFreshness(
  projectRoot: string,
  metadata: GraphifyIndexMetadata
): Omit<GraphFreshnessInfo, 'lastIndexedTime'> | null {
  if (!metadata.git) return null

  try {
    const headRes = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 2000,
    })
    if (headRes.status !== 0 || !headRes.stdout.trim()) return null
    const currentHead = headRes.stdout.trim()

    // Compare HEAD commit SHA
    if (currentHead !== metadata.git.head) {
      return {
        state: 'stale',
        reason: `Git HEAD changed from ${metadata.git.head.slice(0, 7)} to ${currentHead.slice(0, 7)} (branch switch or new commits)`,
        strategy: 'metadata',
      }
    }

    // Compare tree SHA
    const treeRes = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 2000,
    })
    if (treeRes.status === 0 && treeRes.stdout.trim()) {
      const currentTree = treeRes.stdout.trim()
      if (currentTree !== metadata.git.tree) {
        return {
          state: 'stale',
          reason: `Git tree changed from ${metadata.git.tree.slice(0, 7)} to ${currentTree.slice(0, 7)}`,
          strategy: 'metadata',
        }
      }
    }

    // Check uncommitted changes in working tree scoped to projectRoot
    const statusRes = spawnSync('git', ['status', '--porcelain', '--', '.'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 3000,
    })

    const uncommittedFiles: string[] = []
    if (statusRes.status === 0 && statusRes.stdout) {
      for (const line of statusRes.stdout.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const filePart = trimmed.slice(2).trim()
        if (filePart && !filePart.startsWith('graphify-out') && !filePart.includes('/graphify-out/')) {
          uncommittedFiles.push(filePart)
        }
      }
    }

    if (uncommittedFiles.length > 0) {
      return {
        state: 'stale',
        reason: `${uncommittedFiles.length} uncommitted file(s) modified since graph was indexed`,
        changedFilesCount: uncommittedFiles.length,
        changedFilesSample: uncommittedFiles.slice(0, 5),
        strategy: 'metadata',
      }
    }

    return {
      state: 'fresh',
      reason: `Graph matches current Git HEAD (${currentHead.slice(0, 7)}) and clean working tree`,
      changedFilesCount: 0,
      changedFilesSample: [],
      strategy: 'metadata',
    }
  } catch {
    return null
  }
}

/** Fallback heuristic for git repos without durable metadata. */
function checkGitHeuristicFreshness(
  projectRoot: string,
  graphMtimeMs: number
): Omit<GraphFreshnessInfo, 'lastIndexedTime'> | null {
  const isGit = fs.existsSync(path.join(projectRoot, '.git')) ||
    spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 2000,
    }).status === 0

  if (!isGit) return null

  const changedFilesSet = new Set<string>()

  // 1. Check uncommitted changes
  const statusRes = spawnSync('git', ['status', '--porcelain', '--', '.'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 3000,
  })

  if (statusRes.status === 0 && statusRes.stdout) {
    for (const line of statusRes.stdout.split('\n')) {
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
  const logRes = spawnSync('git', ['log', `--since=${isoDate}`, '--name-only', '--format=', '--', '.'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 3000,
  })

  if (logRes.status === 0 && logRes.stdout) {
    for (const file of logRes.stdout.split('\n')) {
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
      reason: `${changedFiles.length} file(s) modified or added since graph was indexed (heuristic fallback, metadata file missing)`,
      changedFilesCount: changedFiles.length,
      changedFilesSample: changedFiles.slice(0, 5),
      strategy: 'git-heuristic',
    }
  }

  return {
    state: 'fresh',
    reason: 'Graph is up to date with repository commits and working tree (heuristic fallback)',
    changedFilesCount: 0,
    changedFilesSample: [],
    strategy: 'git-heuristic',
  }
}

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'graphify-out',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
  '.venv',
  'venv',
  'target',
  'vendor',
])

/** Recursive filesystem fallback: walks source directories excluding build and lock artifacts. */
function checkFilesystemRecursiveFreshness(
  projectRoot: string,
  graphMtimeMs: number
): Omit<GraphFreshnessInfo, 'lastIndexedTime'> {
  const changedFiles: string[] = []
  let filesScanned = 0
  const maxFiles = 10000
  const maxDepth = 15

  function walk(currentDir: string, depth: number): void {
    if (depth > maxDepth || filesScanned >= maxFiles) return

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (filesScanned >= maxFiles) break

      const name = entry.name
      if (IGNORED_DIRECTORIES.has(name) || (name.startsWith('.') && name !== '.')) continue

      const fullPath = path.join(currentDir, name)

      if (entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        walk(fullPath, depth + 1)
      } else if (entry.isFile()) {
        filesScanned++
        try {
          const stat = fs.statSync(fullPath)
          if (stat.mtimeMs > graphMtimeMs + 2000) {
            changedFiles.push(path.relative(projectRoot, fullPath))
          }
        } catch {
          // Ignore unreadable file
        }
      }
    }
  }

  try {
    walk(projectRoot, 0)
  } catch {
    return {
      state: 'unknown',
      reason: 'Could not inspect filesystem entries for freshness',
      strategy: 'filesystem-heuristic',
    }
  }

  if (changedFiles.length > 0) {
    return {
      state: 'stale',
      reason: `${changedFiles.length} nested file(s) modified after graph index`,
      changedFilesCount: changedFiles.length,
      changedFilesSample: changedFiles.slice(0, 5),
      strategy: 'filesystem-heuristic',
    }
  }

  return {
    state: 'fresh',
    reason: 'No modified files detected after graph index',
    changedFilesCount: 0,
    changedFilesSample: [],
    strategy: 'filesystem-heuristic',
  }
}

/**
 * Coalesces concurrent update requests for the same project root so multiple
 * agent turns never trigger duplicate simultaneous rebuilds.
 *
 * Guarantees that the project lock remains held until the underlying child
 * process has fully terminated, preventing race conditions on timeout or abort.
 */
export class ProjectUpdateCoalescer {
  private inProgress = new Map<string, Promise<UpdateResult>>()
  private spawnFn: typeof spawn

  constructor(options?: { spawn?: typeof spawn }) {
    this.spawnFn = options?.spawn ?? spawn
  }

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

      const child = this.spawnFn(command, args, {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let isExited = false
      let killTimer: NodeJS.Timeout | undefined

      const cleanupAndResolve = (result: UpdateResult) => {
        if (killTimer) clearTimeout(killTimer)
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(result)
      }

      const timeoutMs = config.freshness?.updateTimeoutMs || 120000
      let timer: NodeJS.Timeout | undefined
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          terminateChild(`Graphify update timed out after ${timeoutMs}ms`)
        }, timeoutMs)
      }

      const onAbort = () => {
        terminateChild('Graphify update cancelled by signal')
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      const terminateChild = (_reason: string) => {
        if (isExited) return
        try {
          child.kill('SIGTERM')
        } catch {
          // Process may already be dead
        }

        // Grace period before escalating to SIGKILL
        killTimer = setTimeout(() => {
          if (!isExited) {
            try {
              child.kill('SIGKILL')
            } catch {
              // Ignore
            }
          }
        }, 1500)
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        if (stdout.length > 65536) stdout = stdout.slice(-65536)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
        if (stderr.length > 65536) stderr = stderr.slice(-65536)
      })

      child.once('error', (err) => {
        isExited = true
        cleanupAndResolve({
          success: false,
          stdout,
          stderr,
          error: err.message,
        })
      })

      child.once('close', (code, childSignal) => {
        isExited = true
        if (signal?.aborted) {
          cleanupAndResolve({
            success: false,
            stdout,
            stderr,
            error: 'Graphify update cancelled by signal',
          })
          return
        }

        if (code === 0) {
          try {
            writeGraphifyIndexMetadata(projectRoot)
          } catch {
            // Ignore metadata write error
          }
          cleanupAndResolve({
            success: true,
            stdout,
            stderr,
          })
        } else {
          const status = childSignal ? `signal ${childSignal}` : `code ${code ?? 'unknown'}`
          cleanupAndResolve({
            success: false,
            stdout,
            stderr,
            error: stderr || stdout || `Graphify update exited with ${status}`,
          })
        }
      })
    })
  }
}
