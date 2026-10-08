import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { BENCHMARK_TASKS } from './tasks/index.ts'
import type { TaskCard } from './tasks/types.ts'
import type {
  BenchmarkArm,
  TrialResult,
  ArmMetrics,
  TaskComparison,
  BenchmarkSummary,
  StatisticalMetricReport,
} from './engine/types.ts'
import {
  findLatestDshSession,
  readDshSessionFile,
  parseDshSessionEvents,
  evaluateDshSession,
} from './engine/dsh-telemetry.ts'
import { scoreTrialAgainstCriteria } from './engine/scoring.ts'
import { analyzePairedMetric, type PairedMetricSample } from './engine/statistics.ts'
import { renderConsoleSummary } from './reporters/console-reporter.ts'
import { generateMarkdownReport } from './reporters/markdown-reporter.ts'

const EXPRESS_ROOT = path.resolve(process.cwd(), 'benchmark/data/express')

function getDshBinary(): string {
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) {
    return process.env.DSH_BIN
  }
  const defaultNpx = '/Users/kuba/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh'
  if (fs.existsSync(defaultNpx)) {
    return defaultNpx
  }
  return 'dsh'
}

interface RunTaskArmOptions {
  task: TaskCard
  arm: BenchmarkArm
  profile: string
  repetitionIndex: number
  presentationOrder: 'control-first' | 'treatment-first'
  timeoutMs?: number
  verbose?: boolean
}

/**
 * Runs a single benchmark task through DeepSeek Harness CLI and collects native telemetry.
 */
async function runDshTaskArm(opts: RunTaskArmOptions): Promise<TrialResult> {
  const { task, arm, profile, repetitionIndex, presentationOrder, timeoutMs = 480000, verbose = false } = opts
  const dshBin = getDshBinary()

  console.log(
    `\n▶ [${arm.toUpperCase()}] Running Task ${task.id} (Rep ${repetitionIndex + 1}, Order: ${presentationOrder})`
  )
  console.log(`  Profile: ${profile} | Codebase: ${EXPRESS_ROOT}`)

  const startTimeMs = Date.now()

  const child = spawn(dshBin, ['--profile', profile, task.prompt], {
    cwd: EXPRESS_ROOT,
    env: {
      ...process.env,
      DSH_PERMISSION_MODE: 'danger-full-access',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdoutText = ''
  let stderrText = ''

  child.stdout?.on('data', (chunk) => {
    const str = chunk.toString()
    stdoutText += str
    if (verbose) {
      process.stdout.write(str)
    }
  })

  child.stderr?.on('data', (chunk) => {
    const str = chunk.toString()
    stderrText += str
    if (verbose) {
      process.stderr.write(str)
    }
  })

  let timedOut = false
  const exitCode: number = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      console.warn(`\n⚠️ Warning: Task ${task.id} timed out after ${timeoutMs}ms. Harvesting session telemetry...`)
      resolve(-1)
    }, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code ?? 0)
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      console.error(`Process error:`, err)
      resolve(-1)
    })
  })

  const endTimeMs = Date.now()
  const wallClockMs = endTimeMs - startTimeMs

  // Locate the session created by DSH
  const sessionDir = findLatestDshSession(EXPRESS_ROOT, startTimeMs)
  if (!sessionDir) {
    console.warn(`⚠️ Warning: Could not locate DSH session folder in ${EXPRESS_ROOT}`)
    return {
      taskId: task.id,
      taskTitle: task.title,
      arm,
      repetitionIndex,
      presentationOrder,
      success: false,
      turns: 1,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      durationMs: wallClockMs,
      inspectedFiles: [],
      irrelevantFiles: [],
      inspectionPrecision: 0,
      noiseRatio: 0,
      turnsToFirstCorrectFile: null,
      finalAnswer: stdoutText.trim(),
      toolHistory: [],
    }
  }

  const events = readDshSessionFile(sessionDir)
  const parsed = parseDshSessionEvents(events)
  const baseResult = evaluateDshSession(parsed, task, arm)

  // Apply pre-registered scoring rules
  const scoreReport = scoreTrialAgainstCriteria(
    task.id,
    arm,
    baseResult.inspectedFiles,
    baseResult.finalAnswer,
    baseResult.toolHistory.map((t) => ({ turn: t.turn, target: JSON.stringify(t.args) })),
    parsed.cwd || EXPRESS_ROOT
  )

  const finalResult: TrialResult = {
    ...baseResult,
    repetitionIndex,
    presentationOrder,
    success: scoreReport.isStrictSuccess,
    inspectionPrecision: scoreReport.inspectionPrecision,
    noiseRatio: scoreReport.noiseRatio,
    irrelevantFiles: baseResult.inspectedFiles.filter(
      (f) => !task.groundTruth.primaryFiles.includes(f) && !(task.groundTruth.directDeps || []).includes(f)
    ),
    turnsToFirstCorrectFile: scoreReport.turnsToFirstCorrectFile ?? baseResult.turnsToFirstCorrectFile,
  }

  console.log(
    `  ↳ Session: ${path.basename(sessionDir)} | Tokens: ${finalResult.totalTokens.toLocaleString()} | Precision: ${((finalResult.inspectionPrecision ?? 0) * 100).toFixed(0)}% | Noise: ${finalResult.irrelevantFiles.length} files | Success: ${finalResult.success ? '✅' : '❌'}`
  )

  return finalResult
}

function calculateArmMetrics(trials: TrialResult[]): ArmMetrics {
  if (trials.length === 0) {
    return {
      successRate: 0,
      meanInputTokens: 0,
      medianInputTokens: 0,
      meanTotalTokens: 0,
      medianTotalTokens: 0,
      meanTurns: 0,
      medianTurns: 0,
      meanToolCalls: 0,
      meanIrrelevantFiles: 0,
      meanTtff: 0,
      meanDurationMs: 0,
    }
  }

  const n = trials.length
  const successCount = trials.filter((t) => t.success).length
  const successRate = Math.round((successCount / n) * 100)

  const sum = (fn: (t: TrialResult) => number) => trials.reduce((acc, t) => acc + fn(t), 0)
  const mean = (fn: (t: TrialResult) => number) => Math.round(sum(fn) / n)

  const median = (fn: (t: TrialResult) => number) => {
    const vals = trials.map(fn).sort((a, b) => a - b)
    const mid = Math.floor(vals.length / 2)
    return vals.length % 2 !== 0 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2)
  }

  const ttffList = trials.map((t) => t.turnsToFirstCorrectFile).filter((x): x is number => x !== null)
  const meanTtff =
    ttffList.length > 0 ? Math.round((ttffList.reduce((a, b) => a + b, 0) / ttffList.length) * 10) / 10 : 0

  return {
    successRate,
    meanInputTokens: mean((t) => t.inputTokens),
    medianInputTokens: median((t) => t.inputTokens),
    meanTotalTokens: mean((t) => t.totalTokens),
    medianTotalTokens: median((t) => t.totalTokens),
    meanTurns: Math.round((sum((t) => t.turns) / n) * 10) / 10,
    medianTurns: median((t) => t.turns),
    meanToolCalls: Math.round((sum((t) => t.toolCalls) / n) * 10) / 10,
    meanIrrelevantFiles: Math.round((sum((t) => t.irrelevantFiles.length) / n) * 10) / 10,
    meanTtff,
    meanDurationMs: mean((t) => t.durationMs),
  }
}

async function main() {
  const args = process.argv.slice(2)
  const taskFilterIdx = args.indexOf('--task')
  const taskFilter = taskFilterIdx !== -1 ? args[taskFilterIdx + 1] : null

  const profileIdx = args.indexOf('--profile')
  const explicitProfile = profileIdx !== -1 ? args[profileIdx + 1] : null

  const repIdx = args.indexOf('--repetitions')
  const repetitions = repIdx !== -1 ? parseInt(args[repIdx + 1], 10) : 1

  const verbose = args.includes('--verbose') || args.includes('-v')
  const timeoutIdx = args.indexOf('--timeout')
  const timeoutMs = timeoutIdx !== -1 ? parseInt(args[timeoutIdx + 1], 10) : 480000
  const outputIdx = args.indexOf('--output-dir')
  if (outputIdx !== -1 && (!args[outputIdx + 1] || args[outputIdx + 1].startsWith('--'))) {
    throw new Error('--output-dir requires a directory path')
  }
  const outputDir = path.resolve(process.cwd(), outputIdx === -1 ? '.' : args[outputIdx + 1])
  fs.mkdirSync(outputDir, { recursive: true })
  const reportPath = path.join(outputDir, 'BENCHMARK_REPORT.md')
  const jsonPath = path.join(outputDir, 'benchmark-results.json')

  let tasksToRun = BENCHMARK_TASKS
  if (taskFilter) {
    tasksToRun = BENCHMARK_TASKS.filter(
      (t) => t.id.toLowerCase() === taskFilter.toLowerCase() || t.id.includes(taskFilter)
    )
    if (tasksToRun.length === 0) {
      console.error(`Error: No task matches filter "${taskFilter}"`)
      process.exit(1)
    }
  }

  console.log(`=============================================================`)
  console.log(`🚀 DEEPSEEK HARNESS BENCHMARK ORCHESTRATOR`)
  console.log(`=============================================================`)
  console.log(`Target Codebase: Express.js (${EXPRESS_ROOT})`)
  console.log(`DSH Binary: ${getDshBinary()}`)
  console.log(`Tasks Queued: ${tasksToRun.length}`)
  console.log(`Repetitions per Task: ${repetitions}`)
  console.log(`Order Counterbalancing: Active (Control->Treatment / Treatment->Control)`)
  console.log(`Profiles: Control="benchmark-baseline" | Treatment="benchmark-graphify"`)
  console.log(`Timeout per Arm: ${Math.round(timeoutMs / 1000)}s`)
  console.log(`Telemetry Source: DeepSeek Harness Native Session Logs (session.v3.jsonl.zstd)`)
  console.log(`=============================================================\n`)

  const fresh = args.includes('--fresh')
  let accumulatedTrials: TrialResult[] = []
  if (!fresh && fs.existsSync(jsonPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
      if (Array.isArray(prev.rawTrials)) {
        accumulatedTrials = prev.rawTrials
      }
    } catch {
      accumulatedTrials = []
    }
  }

  for (const task of tasksToRun) {
    for (let rep = 0; rep < repetitions; rep++) {
      const isControlFirst = rep % 2 === 0
      const firstArm: BenchmarkArm = isControlFirst ? 'control' : 'treatment'
      const secondArm: BenchmarkArm = isControlFirst ? 'treatment' : 'control'
      const presentationOrder = isControlFirst ? 'control-first' : 'treatment-first'

      const armsToRun = explicitProfile
        ? [explicitProfile === 'benchmark-baseline' ? 'control' : 'treatment']
        : [firstArm, secondArm]

      for (const arm of armsToRun) {
        const profile = arm === 'control' ? 'benchmark-baseline' : 'benchmark-graphify'
        try {
          const res = await runDshTaskArm({
            task,
            arm: arm as BenchmarkArm,
            profile,
            repetitionIndex: rep,
            presentationOrder,
            timeoutMs,
            verbose,
          })

          // Save / update in accumulated trials
          const existingIdx = accumulatedTrials.findIndex(
            (t) => t.taskId === res.taskId && t.arm === res.arm && (t.repetitionIndex ?? 0) === rep
          )
          if (existingIdx !== -1) {
            accumulatedTrials[existingIdx] = res
          } else {
            accumulatedTrials.push(res)
          }

          // Persist intermediate progress
          fs.writeFileSync(jsonPath, JSON.stringify({ rawTrials: accumulatedTrials }, null, 2), 'utf-8')
        } catch (err: any) {
          console.error(`❌ ${arm.toUpperCase()} trial failed for task ${task.id} (rep ${rep}):`, err.message)
        }
      }
    }
  }

  const allControlTrials = accumulatedTrials.filter((t) => t.arm === 'control')
  const allTreatmentTrials = accumulatedTrials.filter((t) => t.arm === 'treatment')

  // Compile comparison across all evaluated tasks
  const allTaskIds = Array.from(new Set(accumulatedTrials.map((t) => t.taskId)))
  const taskComparisons: TaskComparison[] = allTaskIds.map((taskId) => {
    const card = BENCHMARK_TASKS.find((b) => b.id === taskId)
    const cTrials = allControlTrials.filter((t) => t.taskId === taskId)
    const tTrials = allTreatmentTrials.filter((t) => t.taskId === taskId)

    const cAvgTokens =
      cTrials.length > 0 ? Math.round(cTrials.reduce((a, b) => a + b.totalTokens, 0) / cTrials.length) : 0
    const tAvgTokens =
      tTrials.length > 0 ? Math.round(tTrials.reduce((a, b) => a + b.totalTokens, 0) / tTrials.length) : 0
    const savings = cAvgTokens > 0 ? Math.round(((cAvgTokens - tAvgTokens) / cAvgTokens) * 100) : 0

    return {
      taskId,
      title: card?.title || taskId,
      category: card?.category || 'general',
      controlTokens: cAvgTokens,
      treatmentTokens: tAvgTokens,
      tokenSavingsPercent: savings,
      controlTurns: cTrials.length > 0 ? Math.round(cTrials.reduce((a, b) => a + b.turns, 0) / cTrials.length) : 0,
      treatmentTurns: tTrials.length > 0 ? Math.round(tTrials.reduce((a, b) => a + b.turns, 0) / tTrials.length) : 0,
      controlIrrelevantFiles:
        cTrials.length > 0
          ? Math.round(cTrials.reduce((a, b) => a + b.irrelevantFiles.length, 0) / cTrials.length)
          : 0,
      treatmentIrrelevantFiles:
        tTrials.length > 0
          ? Math.round(tTrials.reduce((a, b) => a + b.irrelevantFiles.length, 0) / tTrials.length)
          : 0,
      controlSuccess: cTrials.some((t) => t.success),
      treatmentSuccess: tTrials.some((t) => t.success),
      controlTtff: cTrials[0]?.turnsToFirstCorrectFile ?? null,
      treatmentTtff: tTrials[0]?.turnsToFirstCorrectFile ?? null,
    }
  })

  // Build paired samples for statistical testing
  const pairedTokenSamples: PairedMetricSample[] = []
  const pairedNoiseSamples: PairedMetricSample[] = []
  const pairedDurationSamples: PairedMetricSample[] = []
  const pairedTurnsSamples: PairedMetricSample[] = []
  const pairedPrecisionSamples: PairedMetricSample[] = []

  for (const taskId of allTaskIds) {
    const cList = allControlTrials.filter((t) => t.taskId === taskId)
    const tList = allTreatmentTrials.filter((t) => t.taskId === taskId)
    const count = Math.min(cList.length, tList.length)
    for (let i = 0; i < count; i++) {
      pairedTokenSamples.push({ control: cList[i].totalTokens, treatment: tList[i].totalTokens })
      pairedNoiseSamples.push({ control: cList[i].irrelevantFiles.length, treatment: tList[i].irrelevantFiles.length })
      pairedDurationSamples.push({ control: cList[i].durationMs, treatment: tList[i].durationMs })
      pairedTurnsSamples.push({ control: cList[i].turns, treatment: tList[i].turns })
      pairedPrecisionSamples.push({
        control: cList[i].inspectionPrecision ?? 0,
        treatment: tList[i].inspectionPrecision ?? 0,
      })
    }
  }

  const statistics: Record<string, StatisticalMetricReport> = {}
  if (pairedTokenSamples.length > 0) {
    try {
      statistics['totalTokens'] = analyzePairedMetric('totalTokens', pairedTokenSamples)
      statistics['irrelevantFiles'] = analyzePairedMetric('irrelevantFiles', pairedNoiseSamples)
      statistics['durationMs'] = analyzePairedMetric('durationMs', pairedDurationSamples)
      statistics['turns'] = analyzePairedMetric('turns', pairedTurnsSamples)
      statistics['inspectionPrecision'] = analyzePairedMetric('inspectionPrecision', pairedPrecisionSamples)
    } catch (err: any) {
      console.warn('Could not compute full statistics:', err.message)
    }
  }

  const controlMetrics = calculateArmMetrics(allControlTrials)
  const treatmentMetrics = calculateArmMetrics(allTreatmentTrials)

  const summary: BenchmarkSummary = {
    timestamp: new Date().toISOString(),
    targetCodebase: {
      name: 'express',
      version: 'v4.21.2',
      path: EXPRESS_ROOT,
      nodes: 425,
      edges: 639,
    },
    taskCount: allTaskIds.length,
    control: controlMetrics,
    treatment: treatmentMetrics,
    deltas: {
      tokenReductionRatio:
        treatmentMetrics.meanTotalTokens > 0
          ? Math.round((controlMetrics.meanTotalTokens / treatmentMetrics.meanTotalTokens) * 10) / 10
          : 1,
      tokenSavingsPercent:
        controlMetrics.meanTotalTokens > 0
          ? Math.round(
              ((controlMetrics.meanTotalTokens - treatmentMetrics.meanTotalTokens) /
                controlMetrics.meanTotalTokens) *
                100
            )
          : 0,
      turnReductionPercent:
        controlMetrics.meanTurns > 0
          ? Math.round(
              ((controlMetrics.meanTurns - treatmentMetrics.meanTurns) / controlMetrics.meanTurns) * 100
            )
          : 0,
      toolCallReductionPercent:
        controlMetrics.meanToolCalls > 0
          ? Math.round(
              ((controlMetrics.meanToolCalls - treatmentMetrics.meanToolCalls) /
                controlMetrics.meanToolCalls) *
                100
            )
          : 0,
      noiseReductionPercent:
        controlMetrics.meanIrrelevantFiles > 0
          ? Math.round(
              ((controlMetrics.meanIrrelevantFiles - treatmentMetrics.meanIrrelevantFiles) /
                controlMetrics.meanIrrelevantFiles) *
                100
            )
          : 0,
      successRateDelta: treatmentMetrics.successRate - controlMetrics.successRate,
      speedupRatio:
        treatmentMetrics.meanDurationMs > 0
          ? Math.round((controlMetrics.meanDurationMs / treatmentMetrics.meanDurationMs) * 10) / 10
          : 1,
    },
    statistics,
    tasks: taskComparisons,
    rawTrials: accumulatedTrials,
  }

  // Print results
  renderConsoleSummary(summary)

  // Write markdown and json reports
  generateMarkdownReport(summary, reportPath)
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), 'utf-8')

  console.log(`\n✅ Benchmark Complete!`)
  console.log(`📄 Markdown Report: ${reportPath}`)
  console.log(`📊 JSON Artifact:   ${jsonPath}\n`)
}

main().catch((err) => {
  console.error('Benchmark runner fatal error:', err)
  process.exit(1)
})
