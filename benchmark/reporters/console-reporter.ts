import type { BenchmarkSummary } from '../engine/types.ts'

/**
 * Renders live benchmark progress and final comparison summary in the terminal.
 */
export function renderConsoleSummary(summary: BenchmarkSummary): void {
  const { control, treatment, deltas, tasks, targetCodebase } = summary

  console.log('\n' + '='.repeat(84))
  console.log('       DEEPSEEK HARNESS (DSH) + DSH-GRAPHIFY BENCHMARK REPORT')
  console.log('='.repeat(84))
  console.log(` Target Codebase : ${targetCodebase.name} (${targetCodebase.version})`)
  console.log(` Target Scale    : ${targetCodebase.nodes} AST nodes, ${targetCodebase.edges} graph edges`)
  console.log(` Standard Tasks  : ${summary.taskCount} tasks evaluated across 8 developer archetypes`)
  console.log('-'.repeat(84))

  console.log('\n📊 AGGREGATE PERFORMANCE COMPARISON (Control Baseline vs Treatment Graphify):\n')

  const pad = (s: string | number, n: number) => String(s).padEnd(n)
  const padNum = (s: string | number, n: number) => String(s).padStart(n)

  console.log(
    `  ${pad('Metric', 32)} ${padNum('Control (Raw)', 16)} ${padNum('Treatment (Graph)', 18)} ${padNum('Improvement', 14)}`
  )
  console.log('  ' + '-'.repeat(82))

  console.log(
    `  ${pad('Task Success Rate (%)', 32)} ${padNum(control.successRate + '%', 16)} ${padNum(treatment.successRate + '%', 18)} ${padNum('+' + deltas.successRateDelta + '%', 14)}`
  )
  console.log(
    `  ${pad('Mean Input Context Tokens', 32)} ${padNum(control.meanInputTokens.toLocaleString(), 16)} ${padNum(treatment.meanInputTokens.toLocaleString(), 18)} ${padNum('-' + deltas.tokenSavingsPercent + '%', 14)}`
  )
  console.log(
    `  ${pad('Mean Total Tokens', 32)} ${padNum(control.meanTotalTokens.toLocaleString(), 16)} ${padNum(treatment.meanTotalTokens.toLocaleString(), 18)} ${padNum(deltas.tokenReductionRatio + 'x less', 14)}`
  )
  console.log(
    `  ${pad('Median Total Tokens', 32)} ${padNum(control.medianTotalTokens.toLocaleString(), 16)} ${padNum(treatment.medianTotalTokens.toLocaleString(), 18)} ${padNum(Math.round(((control.medianTotalTokens - treatment.medianTotalTokens) / control.medianTotalTokens) * 100) + '% savings', 14)}`
  )
  console.log(
    `  ${pad('Mean Navigation Turns', 32)} ${padNum(control.meanTurns, 16)} ${padNum(treatment.meanTurns, 18)} ${padNum('-' + deltas.turnReductionPercent + '%', 14)}`
  )
  console.log(
    `  ${pad('Mean Tool Calls Count', 32)} ${padNum(control.meanToolCalls, 16)} ${padNum(treatment.meanToolCalls, 18)} ${padNum('-' + deltas.toolCallReductionPercent + '%', 14)}`
  )
  console.log(
    `  ${pad('Mean Irrelevant Files Read', 32)} ${padNum(control.meanIrrelevantFiles, 16)} ${padNum(treatment.meanIrrelevantFiles, 18)} ${padNum('-' + deltas.noiseReductionPercent + '%', 14)}`
  )
  console.log(
    `  ${pad('Mean Turns to First File (TTFF)', 32)} ${padNum(control.meanTtff, 16)} ${padNum(treatment.meanTtff, 18)} ${padNum(Math.round((control.meanTtff / Math.max(1, treatment.meanTtff)) * 10) / 10 + 'x faster', 14)}`
  )

  console.log('\n📋 PER-TASK BREAKDOWN:\n')
  console.log(
    `  ${pad('Task ID', 26)} ${pad('Category', 18)} ${padNum('Ctrl Tok', 10)} ${padNum('Graph Tok', 10)} ${padNum('Savings', 9)} ${padNum('Noise Decr', 10)}`
  )
  console.log('  ' + '-'.repeat(85))

  for (const t of tasks) {
    const noiseChange = `${t.controlIrrelevantFiles} -> ${t.treatmentIrrelevantFiles}`
    console.log(
      `  ${pad(t.taskId, 26)} ${pad(t.category, 18)} ${padNum(t.controlTokens.toLocaleString(), 10)} ${padNum(t.treatmentTokens.toLocaleString(), 10)} ${padNum(t.tokenSavingsPercent + '%', 9)} ${padNum(noiseChange, 10)}`
    )
  }

  console.log('\n' + '='.repeat(84))
  console.log(`🚀 MARKETING HIGHLIGHT: dsh-graphify reduces context tokens by ${deltas.tokenSavingsPercent}%`)
  console.log(`   and eliminates ${deltas.noiseReductionPercent}% of irrelevant file inspections for small local models.`)
  console.log('='.repeat(84) + '\n')
}
