/**
 * Execution types, telemetry schemas, and evaluation structures for the benchmark engine.
 */

export type BenchmarkArm = 'control' | 'treatment'

export interface ToolCallRecord {
  turn: number
  toolName: string
  args: Record<string, unknown>
  outputSummary: string
  outputLength: number
  tokenEstimate: number
}

export interface TrialResult {
  taskId: string
  taskTitle: string
  arm: BenchmarkArm
  repetitionIndex?: number
  presentationOrder?: 'control-first' | 'treatment-first'
  success: boolean
  turns: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  durationMs: number
  inspectedFiles: string[]
  irrelevantFiles: string[]
  inspectionPrecision?: number
  noiseRatio?: number
  turnsToFirstCorrectFile: number | null
  finalAnswer: string
  toolHistory: ToolCallRecord[]
}

export interface ArmMetrics {
  successRate: number // 0 - 100%
  meanInputTokens: number
  medianInputTokens: number
  meanTotalTokens: number
  medianTotalTokens: number
  meanTurns: number
  medianTurns: number
  meanToolCalls: number
  meanIrrelevantFiles: number
  meanTtff: number
  meanDurationMs: number
}

export interface TaskComparison {
  taskId: string
  title: string
  category: string
  controlTokens: number
  treatmentTokens: number
  tokenSavingsPercent: number
  controlTurns: number
  treatmentTurns: number
  controlIrrelevantFiles: number
  treatmentIrrelevantFiles: number
  controlSuccess: boolean
  treatmentSuccess: boolean
  controlTtff: number | null
  treatmentTtff: number | null
}

export interface StatisticalMetricReport {
  metricName: string
  sampleSize: number
  controlMean: number
  controlStd: number
  treatmentMean: number
  treatmentStd: number
  meanDifference: number
  percentageChange: number
  ci95Parametric: [number, number]
  ci95Bootstrap: [number, number]
  tStatistic: number
  tPValue: number
  wilcoxonW: number
  wilcoxonPValue: number
  cohensD: number
  isStatisticallySignificant: boolean
}

export interface BenchmarkSummary {
  timestamp: string
  targetCodebase: {
    name: string
    version: string
    path: string
    nodes: number
    edges: number
  }
  taskCount: number
  control: ArmMetrics
  treatment: ArmMetrics
  deltas: {
    tokenReductionRatio: number // Control / Treatment (e.g. 3.4x)
    tokenSavingsPercent: number // (Control - Treatment) / Control %
    turnReductionPercent: number
    toolCallReductionPercent: number
    noiseReductionPercent: number // Irrelevant file reduction %
    successRateDelta: number // Treatment % - Control %
    speedupRatio: number
  }
  statistics?: Record<string, StatisticalMetricReport>
  tasks: TaskComparison[]
  rawTrials: TrialResult[]
}

export interface BenchmarkRunOptions {
  taskFilter?: string[]
  live?: boolean
  model?: string
  endpoint?: string
  verbose?: boolean
  outputPath?: string
}
