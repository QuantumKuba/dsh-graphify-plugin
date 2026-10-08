import path from 'node:path'
import type { TaskCard } from '../tasks/types.ts'
import type { BenchmarkArm, ToolCallRecord, TrialResult } from './types.ts'

export interface EvaluationInput {
  task: TaskCard
  arm: BenchmarkArm
  turns: number
  durationMs: number
  inspectedFiles: string[]
  finalAnswer: string
  toolHistory: ToolCallRecord[]
}

/**
 * Normalizes file paths relative to the target repository root.
 */
export function normalizePath(p: string): string {
  return p.replace(/^\.?\//, '').trim()
}

/**
 * Fast, accurate token estimator for code and English prose (~3.8 chars/token).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 3.8)
}

/**
 * Evaluates a completed trial against the task card ground truth.
 */
export function evaluateTrial(input: EvaluationInput): TrialResult {
  const { task, arm, turns, durationMs, inspectedFiles, finalAnswer, toolHistory } = input
  const { groundTruth } = task

  const normalizedPrimary = groundTruth.primaryFiles.map(normalizePath)
  const normalizedDeps = (groundTruth.directDeps || []).map(normalizePath)
  const normalizedInspected = Array.from(new Set(inspectedFiles.map(normalizePath)))

  // Identify irrelevant files: not in primary and not in direct deps
  const irrelevantFiles = normalizedInspected.filter(
    (file) => !normalizedPrimary.includes(file) && !normalizedDeps.includes(file)
  )

  // Compute turns to first correct file (TTFF)
  let turnsToFirstCorrectFile: number | null = null
  for (const record of toolHistory) {
    const fileArg =
      (typeof record.args.filePath === 'string' && record.args.filePath) ||
      (typeof record.args.path === 'string' && record.args.path) ||
      (typeof record.args.node_id === 'string' && record.args.node_id) ||
      ''

    const normalizedArg = normalizePath(fileArg)
    const matchesPrimary = normalizedPrimary.some(
      (pf) => normalizedArg.includes(pf) || record.outputSummary.includes(pf)
    )

    if (matchesPrimary && turnsToFirstCorrectFile === null) {
      turnsToFirstCorrectFile = record.turn
      break
    }
  }

  // If final answer contains the primary file and TTFF not yet assigned
  if (turnsToFirstCorrectFile === null) {
    const mentionsPrimary = normalizedPrimary.some((pf) => finalAnswer.includes(pf))
    if (mentionsPrimary) {
      turnsToFirstCorrectFile = turns
    }
  }

  // Determine task success:
  // 1. All primary files were either inspected or explicitly identified in final answer
  const foundAllPrimary = normalizedPrimary.every(
    (pf) => normalizedInspected.includes(pf) || finalAnswer.includes(pf)
  )

  // 2. Mentions at least one core symbol or path
  const mentionsSymbol = groundTruth.relevantSymbols.some((sym) =>
    finalAnswer.toLowerCase().includes(sym.toLowerCase())
  )

  const success = foundAllPrimary && (mentionsSymbol || normalizedPrimary.length > 0)

  // Calculate token usage
  let inputTokens = 0
  let outputTokens = 0

  for (const record of toolHistory) {
    // Prompt overhead per turn + tool invocation args
    inputTokens += estimateTokens(JSON.stringify(record.args)) + 250
    // Tool output returned into model context
    inputTokens += record.tokenEstimate
    // Model output generating the call
    outputTokens += 60
  }

  // Final answer tokens
  outputTokens += estimateTokens(finalAnswer)
  inputTokens += estimateTokens(task.prompt) + 400

  return {
    taskId: task.id,
    taskTitle: task.title,
    arm,
    success,
    turns,
    toolCalls: toolHistory.length,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    durationMs,
    inspectedFiles: normalizedInspected,
    irrelevantFiles,
    turnsToFirstCorrectFile,
    finalAnswer,
    toolHistory,
  }
}
