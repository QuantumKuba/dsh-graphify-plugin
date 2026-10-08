import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BENCHMARK_TASKS } from './tasks/index.ts'
import { setupBenchmarkTarget, TARGET_DIR } from './setup.ts'
import { createBaselineTools } from './engine/tools/baseline-tools.ts'
import { createGraphifyTools } from './engine/tools/graphify-tools.ts'
import { runAgentTrial } from './engine/agent.ts'
import { buildBenchmarkSummary } from './engine/statistics.ts'
import { renderConsoleSummary } from './reporters/console-reporter.ts'
import { generateMarkdownReport } from './reporters/markdown-reporter.ts'
import { writeJsonReport } from './reporters/json-reporter.ts'
import type { TrialResult } from './engine/types.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')

export interface RunBenchmarkOptions {
  live?: boolean
  tasks?: string
  model?: string
  endpoint?: string
}

async function detectEndpoint(specified?: string): Promise<string> {
  if (specified) return specified
  const candidates = [
    'http://127.0.0.1:1235/v1',
    'http://127.0.0.1:1234/v1',
    process.env.OPENAI_BASE_URL,
  ].filter(Boolean) as string[]

  for (const url of candidates) {
    try {
      const res = await fetch(`${url}/models`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return url
    } catch {}
  }
  return 'http://127.0.0.1:1235/v1'
}

export async function runBenchmark(options: RunBenchmarkOptions = {}): Promise<void> {
  const isLive = options.live ?? process.argv.includes('--live')
  const endpoint = await detectEndpoint(options.endpoint)
  const model = options.model || process.env.OPENAI_MODEL || 'qwen/qwen3.8-27b'

  console.log('\n🔍 [1/4] Preparing target benchmark repository (Express.js)...')
  const targetDir = await setupBenchmarkTarget({ silent: true })

  const graphJsonPath = path.join(targetDir, 'graphify-out', 'graph.json')
  const graphRaw = fs.readFileSync(graphJsonPath, 'utf8')
  const graphData = JSON.parse(graphRaw)
  const nodeCount = Array.isArray(graphData.nodes) ? graphData.nodes.length : 0
  const edgeCount = Array.isArray(graphData.links)
    ? graphData.links.length
    : Array.isArray(graphData.edges)
      ? graphData.edges.length
      : 0

  const targetMetadata = {
    name: 'express',
    version: '4.21.2',
    path: targetDir,
    nodes: nodeCount,
    edges: edgeCount,
  }

  console.log(`✅ Target ready: ${targetMetadata.name}@${targetMetadata.version} (${nodeCount} nodes, ${edgeCount} edges)`)

  if (isLive) {
    console.log(`🤖 Mode: LIVE MODEL EXECUTION via LM Studio`)
    console.log(`   Endpoint : ${endpoint}`)
    console.log(`   Model    : ${model}`)
  } else {
    console.log(`⚡ Mode: DETERMINISTIC CALIBRATED SIMULATION (Pass --live to run against live LM Studio)`)
  }

  console.log('\n⚙️  [2/4] Initializing baseline tools and live Graphify MCP client...')
  const baselineTools = createBaselineTools(targetDir)
  const graphifyTools = await createGraphifyTools(targetDir)

  const controlTrials: TrialResult[] = []
  const treatmentTrials: TrialResult[] = []

  let tasksToRun = BENCHMARK_TASKS
  const taskArg = options.tasks || process.argv.find((a) => a.startsWith('--tasks='))?.split('=')[1]
  if (taskArg) {
    const num = parseInt(taskArg, 10)
    if (!isNaN(num)) {
      tasksToRun = BENCHMARK_TASKS.slice(0, num)
    } else {
      const ids = taskArg.split(',')
      tasksToRun = BENCHMARK_TASKS.filter((t) => ids.includes(t.id))
    }
  }

  console.log(`\n🚀 [3/4] Executing A/B matrix across ${tasksToRun.length} standardized tasks...\n`)

  try {
    for (let i = 0; i < tasksToRun.length; i++) {
      const task = tasksToRun[i]
      process.stdout.write(`  [${i + 1}/${tasksToRun.length}] Evaluating ${task.id} (${task.title})...\n`)

      process.stdout.write(`      Running Control (Baseline DSH)... `)
      const controlResult = await runAgentTrial({
        task,
        arm: 'control',
        targetRepoDir: targetDir,
        baselineTools,
        live: isLive,
        endpoint,
        model,
      })
      controlTrials.push(controlResult)
      console.log(`Done (${controlResult.totalTokens} tokens, ${controlResult.turns} turns)`)

      process.stdout.write(`      Running Treatment (DSH + Graphify)... `)
      const treatmentResult = await runAgentTrial({
        task,
        arm: 'treatment',
        targetRepoDir: targetDir,
        baselineTools,
        graphifyTools,
        live: isLive,
        endpoint,
        model,
      })
      treatmentTrials.push(treatmentResult)
      const savings = Math.round(
        ((controlResult.totalTokens - treatmentResult.totalTokens) / controlResult.totalTokens) * 100
      )
      console.log(`Done (${treatmentResult.totalTokens} tokens, ${treatmentResult.turns} turns, saved ${savings}%)`)
    }
  } finally {
    await graphifyTools.destroy()
  }

  console.log('\n📈 [4/4] Aggregating telemetry and generating reports...')
  const summary = buildBenchmarkSummary(controlTrials, treatmentTrials, tasksToRun, targetMetadata)

  // Render Console
  renderConsoleSummary(summary)

  // Write Markdown reports
  const rootReportPath = path.join(ROOT_DIR, 'BENCHMARK_REPORT.md')
  const benchmarkReportPath = path.join(__dirname, 'BENCHMARK_REPORT.md')
  generateMarkdownReport(summary, rootReportPath)
  generateMarkdownReport(summary, benchmarkReportPath)
  console.log(`📄 Markdown Report written to: ${rootReportPath}`)

  // Write JSON telemetry
  const jsonPath = path.join(ROOT_DIR, 'benchmark', 'data', 'benchmark-results.json')
  writeJsonReport(summary, jsonPath)
  console.log(`💾 Raw Telemetry written to: ${jsonPath}\n`)
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runBenchmark().catch((err) => {
    console.error('Benchmark execution error:', err)
    process.exit(1)
  })
}
