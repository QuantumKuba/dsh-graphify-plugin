import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const BENCHMARK_ROOT = __dirname
export const DATA_DIR = path.join(BENCHMARK_ROOT, 'data')
export const TARGET_DIR = path.join(DATA_DIR, 'express')
export const REPO_URL = 'https://github.com/expressjs/express.git'
export const REPO_TAG = '4.21.2'

export interface SetupOptions {
  force?: boolean
  silent?: boolean
}

/**
 * Ensures the target Express repository is cloned and indexed with Graphify.
 * Returns the absolute path to the target directory.
 */
export async function setupBenchmarkTarget(options: SetupOptions = {}): Promise<string> {
  const { force = false, silent = false } = options
  const log = (msg: string) => {
    if (!silent) console.log(`[benchmark:setup] ${msg}`)
  }

  fs.mkdirSync(DATA_DIR, { recursive: true })

  const isCloned = fs.existsSync(TARGET_DIR) && fs.existsSync(path.join(TARGET_DIR, '.git'))
  if (force && fs.existsSync(TARGET_DIR)) {
    log(`Removing existing directory at ${TARGET_DIR} (force=true)...`)
    fs.rmSync(TARGET_DIR, { recursive: true, force: true })
  }

  if (!isCloned || force) {
    log(`Cloning Express repository (${REPO_TAG}) from ${REPO_URL}...`)
    const cloneRes = spawnSync(
      'git',
      ['clone', '--depth', '1', '--branch', REPO_TAG, REPO_URL, TARGET_DIR],
      { stdio: silent ? 'ignore' : 'inherit' }
    )
    if (cloneRes.status !== 0) {
      throw new Error(`Failed to clone ${REPO_URL} (exit code ${cloneRes.status})`)
    }
  } else {
    log(`Target repository already exists at ${TARGET_DIR}.`)
  }

  const graphJsonPath = path.join(TARGET_DIR, 'graphify-out', 'graph.json')
  const hasGraph = fs.existsSync(graphJsonPath)

  if (!hasGraph || force) {
    log('Building Graphify knowledge graph (local AST extract)...')
    const extractRes = spawnSync('graphify', ['extract', '.', '--code-only'], {
      cwd: TARGET_DIR,
      stdio: silent ? 'ignore' : 'inherit',
    })
    if (extractRes.status !== 0) {
      throw new Error(`Graphify extract failed with exit code ${extractRes.status}`)
    }

    log('Clustering communities and generating report...')
    const clusterRes = spawnSync('graphify', ['cluster-only', '.'], {
      cwd: TARGET_DIR,
      stdio: silent ? 'ignore' : 'inherit',
    })
    // cluster-only may exit 0 even if LLM labeler warns; check graph.json existence
    if (!fs.existsSync(graphJsonPath)) {
      throw new Error(`Graphify clustering failed to generate ${graphJsonPath}`)
    }
  } else {
    log(`Existing Graphify knowledge graph found at ${graphJsonPath}.`)
  }

  const graphRaw = fs.readFileSync(graphJsonPath, 'utf8')
  const graphData = JSON.parse(graphRaw)
  const nodeCount = Array.isArray(graphData.nodes) ? graphData.nodes.length : 0
  const edgeCount = Array.isArray(graphData.links)
    ? graphData.links.length
    : Array.isArray(graphData.edges)
      ? graphData.edges.length
      : 0

  log(`Target readiness confirmed: ${nodeCount} nodes, ${edgeCount} edges indexed.`)
  return TARGET_DIR
}

// Standalone execution
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const force = process.argv.includes('--force')
  setupBenchmarkTarget({ force })
    .then((dir) => {
      console.log(`\nSuccessfully prepared target codebase at: ${dir}`)
      process.exit(0)
    })
    .catch((err) => {
      console.error(`Setup failed:`, err)
      process.exit(1)
    })
}
