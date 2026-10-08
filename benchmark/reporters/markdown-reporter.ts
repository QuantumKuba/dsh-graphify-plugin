import fs from 'node:fs'
import type { BenchmarkSummary } from '../engine/types.ts'
import { BENCHMARK_TASKS } from '../tasks/index.ts'

function formatPValue(p: number): string {
  if (p < 0.001) return '< 0.001 (***)'
  if (p < 0.01) return `${p.toFixed(3)} (**)`
  if (p < 0.05) return `${p.toFixed(3)} (*)`
  return `${p.toFixed(3)} (n.s.)`
}

function formatCi(ci: [number, number]): string {
  return `[${ci[0] > 0 ? '+' : ''}${Math.round(ci[0]).toLocaleString()}, ${ci[1] > 0 ? '+' : ''}${Math.round(ci[1]).toLocaleString()}]`
}

function formatToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue
    const valStr =
      typeof v === 'string'
        ? v.length > 50
          ? JSON.stringify(v.slice(0, 47) + '...')
          : JSON.stringify(v)
        : JSON.stringify(v)
    parts.push(`${k}=${valStr}`)
  }
  return parts.join(', ')
}

const GRAPH_TOOL_NAMES = new Set([
  'query_graph',
  'get_node',
  'get_neighbors',
  'shortest_path',
  'god_nodes',
  'get_community',
  'graph_stats',
  'graphify_status',
])

/**
 * Generates a scientifically rigorous Markdown benchmark report with statistical inference
 * and dynamically rendered trial traces.
 */
export function generateMarkdownReport(summary: BenchmarkSummary, outputPath: string): void {
  const { control, treatment, deltas, statistics, rawTrials } = summary

  const statsTokens = statistics?.totalTokens
  const statsNoise = statistics?.irrelevantFiles
  const statsDuration = statistics?.durationMs
  const statsTurns = statistics?.turns
  const statsPrecision = statistics?.inspectionPrecision

  const treatmentTrials = (rawTrials || []).filter((t) => t.arm === 'treatment')
  const totalGraphCalls = treatmentTrials.reduce(
    (acc, t) => acc + (t.toolHistory || []).filter((h) => GRAPH_TOOL_NAMES.has(h.toolName)).length,
    0
  )

  let md = `# DeepSeek Harness Knowledge Graph Benchmark

> **Empirical Evaluation**: Quantifying the impact of \`dsh-graphify\` on agent navigation, token efficiency, and localization accuracy in DeepSeek Harness (DSH), evaluated on **Express.js** for local coding models.

---

## 🔬 Experimental Methodology & Pre-Registration

This benchmark evaluates autonomous coding agent performance on **Express.js (\`v4.21.2\`)** comparing **Baseline DSH** against **DSH + \`dsh-graphify\`**.

- **Target Model**: \`qwen/qwen3.8-27b\` (served locally via LM Studio on \`http://127.0.0.1:1235/v1\`).
- **Target Repository**: Express.js \`v4.21.2\` (425 AST nodes, 639 directional links, 45 architectural communities).
- **Control Arm**: DeepSeek Harness profile \`benchmark-baseline\` (standard DSH tools: \`read\`, \`glob\`, \`grep\`, \`bash\`, \`write\`, \`edit\`).
- **Treatment Arm**: DeepSeek Harness profile \`benchmark-graphify\` (DSH + \`dsh-graphify\` knowledge graph tools: \`query_graph\`, \`get_node\`, \`get_neighbors\`, \`shortest_path\`, \`god_nodes\`).
- **Telemetry Authority**: Native DeepSeek Harness session event logs (\`~/.dsh/sessions/.../session.v3.jsonl.zstd\`). Zero synthetic or simulated proxy estimates in live trials.
- **Order Counterbalancing**: Trials alternate presentation order (\`Control -> Treatment\` on even repetitions, \`Treatment -> Control\` on odd repetitions) to eliminate thermal throttling, GPU warming, and cache bias.
- **Pre-Registered Task Scoring**: Strict success requires localizing all pre-registered primary target files and identifying required architectural symbols without opening forbidden distractor test suites.

---

## 📊 Statistical Inference & Paired Hypothesis Tests

`

  if (statistics && statsTokens) {
    md += `Evaluated on **N = ${statsTokens.sampleSize} paired trials** with order counterbalancing. Statistical significance is computed using both parametric (Paired Student's t-test) and non-parametric (Wilcoxon Signed-Rank test) methods, with 2,000-resample Bootstrap 95% Confidence Intervals:

| Metric | Control Mean (SD) | Treatment Mean (SD) | Mean Paired Difference (Δ) | 95% Bootstrap CI | Paired t-test (p) | Wilcoxon W (p) | Effect Size (Cohen's d_z) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Total Tokens** | ${Math.round(statsTokens.controlMean).toLocaleString()} (${Math.round(statsTokens.controlStd).toLocaleString()}) | ${Math.round(statsTokens.treatmentMean).toLocaleString()} (${Math.round(statsTokens.treatmentStd).toLocaleString()}) | **${statsTokens.meanDifference > 0 ? '+' : ''}${Math.round(statsTokens.meanDifference).toLocaleString()} (${statsTokens.percentageChange > 0 ? '+' : ''}${statsTokens.percentageChange.toFixed(1)}%)** | \`${formatCi(statsTokens.ci95Bootstrap)}\` | t=${statsTokens.tStatistic.toFixed(2)}, p=${formatPValue(statsTokens.tPValue)} | W=${statsTokens.wilcoxonW}, p=${formatPValue(statsTokens.wilcoxonPValue)} | d=${statsTokens.cohensD.toFixed(2)} |
| **Irrelevant Files (Noise)** | ${statsNoise?.controlMean.toFixed(1)} (${statsNoise?.controlStd.toFixed(1)}) | ${statsNoise?.treatmentMean.toFixed(1)} (${statsNoise?.treatmentStd.toFixed(1)}) | **${statsNoise && statsNoise.meanDifference > 0 ? '+' : ''}${statsNoise?.meanDifference.toFixed(1)} (${statsNoise?.percentageChange.toFixed(1)}%)** | \`${statsNoise ? formatCi(statsNoise.ci95Bootstrap) : 'N/A'}\` | t=${statsNoise?.tStatistic.toFixed(2)}, p=${formatPValue(statsNoise?.tPValue ?? 1)} | W=${statsNoise?.wilcoxonW}, p=${formatPValue(statsNoise?.wilcoxonPValue ?? 1)} | d=${statsNoise?.cohensD.toFixed(2)} |
| **Inspection Precision** | ${((statsPrecision?.controlMean ?? 0) * 100).toFixed(1)}% | ${((statsPrecision?.treatmentMean ?? 0) * 100).toFixed(1)}% | **${statsPrecision && statsPrecision.meanDifference > 0 ? '+' : ''}${(statsPrecision.meanDifference * 100).toFixed(1)}%** | \`${statsPrecision ? `[${(statsPrecision.ci95Bootstrap[0] * 100).toFixed(1)}%, ${(statsPrecision.ci95Bootstrap[1] * 100).toFixed(1)}%]` : 'N/A'}\` | t=${statsPrecision?.tStatistic.toFixed(2)}, p=${formatPValue(statsPrecision?.tPValue ?? 1)} | W=${statsPrecision?.wilcoxonW}, p=${formatPValue(statsPrecision?.wilcoxonPValue ?? 1)} | d=${statsPrecision?.cohensD.toFixed(2)} |
| **Turns to Solution** | ${statsTurns?.controlMean.toFixed(1)} | ${statsTurns?.treatmentMean.toFixed(1)} | **${statsTurns && statsTurns.meanDifference > 0 ? '+' : ''}${statsTurns?.meanDifference.toFixed(1)}** | \`${statsTurns ? formatCi(statsTurns.ci95Bootstrap) : 'N/A'}\` | t=${statsTurns?.tStatistic.toFixed(2)}, p=${formatPValue(statsTurns?.tPValue ?? 1)} | W=${statsTurns?.wilcoxonW}, p=${formatPValue(statsTurns?.wilcoxonPValue ?? 1)} | d=${statsTurns?.cohensD.toFixed(2)} |
| **Duration (seconds)** | ${Math.round((statsDuration?.controlMean ?? 0) / 1000)}s | ${Math.round((statsDuration?.treatmentMean ?? 0) / 1000)}s | **${statsDuration && statsDuration.meanDifference > 0 ? '+' : ''}${Math.round(statsDuration.meanDifference / 1000)}s** | \`${statsDuration ? `[${Math.round(statsDuration.ci95Bootstrap[0] / 1000)}s, ${Math.round(statsDuration.ci95Bootstrap[1] / 1000)}s]` : 'N/A'}\` | t=${statsDuration?.tStatistic.toFixed(2)}, p=${formatPValue(statsDuration?.tPValue ?? 1)} | W=${statsDuration?.wilcoxonW}, p=${formatPValue(statsDuration?.wilcoxonPValue ?? 1)} | d=${statsDuration?.cohensD.toFixed(2)} |
`
  } else {
    md += `| Metric | Control (Baseline DSH) | Treatment (DSH + Graphify) | Impact |
| :--- | :--- | :--- | :--- |
| **Mean Total Tokens Consumed** | **${control.meanTotalTokens.toLocaleString()}** tokens | **${treatment.meanTotalTokens.toLocaleString()}** tokens | **${deltas.tokenSavingsPercent}%** |
| **Irrelevant Files Inspected** | **${control.meanIrrelevantFiles}** files / task | **${treatment.meanIrrelevantFiles}** files / task | **${deltas.noiseReductionPercent}% noise reduction** |
| **Navigation Turns to Solution** | **${control.meanTurns}** turns | **${treatment.meanTurns}** turns | **${deltas.turnReductionPercent}% fewer turns** |
| **Task Success Rate** | **${control.successRate}%** | **${treatment.successRate}%** | **${deltas.successRateDelta >= 0 ? '+' : ''}${deltas.successRateDelta}%** |
`
  }

  md += `
---

## 📋 Counterbalanced Live Trial Logs

| Task ID | Rep | Order | Control Tokens | Treatment Tokens | Control Noise | Treatment Noise | Control Prec. | Treatment Prec. | Outcome |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
`

  if (rawTrials && rawTrials.length > 0) {
    const taskRepMap = new Map<string, { control?: any; treatment?: any }>()
    for (const t of rawTrials) {
      const key = `${t.taskId}-rep${t.repetitionIndex ?? 0}`
      if (!taskRepMap.has(key)) taskRepMap.set(key, {})
      const obj = taskRepMap.get(key)!
      if (t.arm === 'control') obj.control = t
      else obj.treatment = t
    }

    for (const [key, pair] of taskRepMap.entries()) {
      const c = pair.control
      const tr = pair.treatment
      const taskId = c?.taskId || tr?.taskId || key
      const rep = c?.repetitionIndex ?? tr?.repetitionIndex ?? 0
      const order = c?.presentationOrder || (rep % 2 === 0 ? 'control-first' : 'treatment-first')
      const cTokens = c ? c.totalTokens.toLocaleString() : 'N/A'
      const trTokens = tr ? tr.totalTokens.toLocaleString() : 'N/A'
      const cNoise = c ? c.irrelevantFiles.length : 'N/A'
      const trNoise = tr ? tr.irrelevantFiles.length : 'N/A'
      const cPrec = c ? `${((c.inspectionPrecision ?? 0) * 100).toFixed(0)}%` : 'N/A'
      const trPrec = tr ? `${((tr.inspectionPrecision ?? 0) * 100).toFixed(0)}%` : 'N/A'
      const solved = (c?.success ? '✅' : '❌') + ' / ' + (tr?.success ? '✅' : '❌')
      md += `| **${taskId}** | ${rep + 1} | \`${order}\` | ${cTokens} | ${trTokens} | ${cNoise} files | **${trNoise} files** | ${cPrec} | **${trPrec}** | ${solved} |\n`
    }
  } else {
    md += `| None | - | - | - | - | - | - | - | - | - |\n`
  }

  md += `
---

## ⚖️ Empirical Observations & Measured Trade-Offs

1. **Token Consumption & Schema Overhead**:
   - ${control.meanTotalTokens > 0 ? (deltas.tokenSavingsPercent >= 0 ? `Treatment consumed **${deltas.tokenSavingsPercent}% fewer total tokens** on average (${control.meanTotalTokens.toLocaleString()} control vs ${treatment.meanTotalTokens.toLocaleString()} treatment).` : `Treatment consumed **${Math.abs(deltas.tokenSavingsPercent)}% more total tokens** on average (${control.meanTotalTokens.toLocaleString()} control vs ${treatment.meanTotalTokens.toLocaleString()} treatment).`) : 'Token delta not evaluated.'}
   - Mounting Graphify schemas introduces serialization overhead (~1,904 chars in compact mode). Total token savings depend on whether graph retrieval eliminates expensive search loops and file inspections.

2. **Tool Invocations & Latency**:
   - Tool calls: **${control.meanToolCalls}** calls (control) vs **${treatment.meanToolCalls}** calls (treatment) (${deltas.toolCallReductionPercent >= 0 ? `-${deltas.toolCallReductionPercent}%` : `+${Math.abs(deltas.toolCallReductionPercent)}%`}).
   - Duration: **${Math.round(control.meanDurationMs / 1000)}s** (control) vs **${Math.round(treatment.meanDurationMs / 1000)}s** (treatment) (${treatment.meanDurationMs >= control.meanDurationMs ? `+${Math.round((treatment.meanDurationMs - control.meanDurationMs) / 1000)}s` : `-${Math.round((control.meanDurationMs - treatment.meanDurationMs) / 1000)}s`}).
   - Graph tool invocations can reduce trial-and-error tool count, but may increase per-turn generation and bridge latency on local quantized models.

3. **Graph Tool Adoption & Noise**:
`

  if (treatmentTrials.length > 0 && totalGraphCalls === 0) {
    md += `   - ⚠️ **Failed Adoption Notice**: Treatment model made **0 Graphify tool calls** across evaluated trials. Token consumption differences reflect baseline exploration variance, not graph retrieval.\n`
  } else if (treatmentTrials.length > 0) {
    md += `   - Treatment model actively invoked Graphify tools **${totalGraphCalls} times** across trials (${(totalGraphCalls / treatmentTrials.length).toFixed(1)} calls / trial).\n`
  }
  md += `   - Irrelevant file reads: **${control.meanIrrelevantFiles}** files (control) vs **${treatment.meanIrrelevantFiles}** files (treatment).
   - Inspection precision: **${((statsPrecision?.controlMean ?? 0) * 100).toFixed(0)}%** (control) vs **${((statsPrecision?.treatmentMean ?? 0) * 100).toFixed(0)}%** (treatment).

> [!NOTE]
> Evaluated on **N = ${statsTokens?.sampleSize ?? rawTrials?.length ?? 1}** paired trial(s). Single-pair or small-sample results demonstrate execution feasibility and individual trial mechanics, but cannot establish population-level statistical significance.

---

## 🔍 Evaluated Task Traces & Case Studies
`

  if (rawTrials && rawTrials.length > 0) {
    const taskIds = Array.from(new Set(rawTrials.map((t) => t.taskId)))
    for (const taskId of taskIds) {
      const taskCard = BENCHMARK_TASKS.find((t) => t.id === taskId)
      const c = rawTrials.find((t) => t.taskId === taskId && t.arm === 'control')
      const tr = rawTrials.find((t) => t.taskId === taskId && t.arm === 'treatment')

      md += `
### Task: ${taskCard?.title || taskId} (\`${taskId}\`)

> **Prompt**: "${taskCard?.prompt || 'N/A'}"
`

      if (c) {
        md += `
#### Control Arm (Baseline DSH)
- **Outcome**: ${c.success ? '✅ Solved' : '❌ Failed'}
- **Tokens**: ${c.totalTokens.toLocaleString()} total (Input: ${c.inputTokens.toLocaleString()}, Output: ${c.outputTokens.toLocaleString()})
- **Duration**: ${Math.round(c.durationMs / 1000)}s | **Tool Calls**: ${c.toolCalls}
- **Inspected Files**: ${c.inspectedFiles.length > 0 ? c.inspectedFiles.map((f: string) => `\`${f}\``).join(', ') : 'None'}
- **Tool Sequence**:
${c.toolHistory.map((h: any, i: number) => `  ${i + 1}. \`${h.toolName}\`(${formatToolArgs(h.args)}) → *${h.outputLength} chars*`).join('\n')}
`
      }

      if (tr) {
        md += `
#### Treatment Arm (DSH + Graphify)
- **Outcome**: ${tr.success ? '✅ Solved' : '❌ Failed'}
- **Tokens**: ${tr.totalTokens.toLocaleString()} total (Input: ${tr.inputTokens.toLocaleString()}, Output: ${tr.outputTokens.toLocaleString()})
- **Duration**: ${Math.round(tr.durationMs / 1000)}s | **Tool Calls**: ${tr.toolCalls}
- **Inspected Files**: ${tr.inspectedFiles.length > 0 ? tr.inspectedFiles.map((f: string) => `\`${f}\``).join(', ') : 'None'}
- **Tool Sequence**:
${tr.toolHistory.map((h: any, i: number) => `  ${i + 1}. \`${h.toolName}\`(${formatToolArgs(h.args)}) → *${h.outputLength} chars*`).join('\n')}
`
      }
    }
  } else {
    md += `\n*No live trial traces recorded.*\n`
  }

  md += `
---

## 🛠️ Reproduction & Live Execution

\`\`\`sh
# 1. Run randomized, counterbalanced live DSH trials on your local model:
node --import tsx benchmark/run-dsh.ts --task task-01-route-match --repetitions 1

# 2. Run full suite with custom output directory:
node --import tsx benchmark/run-dsh.ts --repetitions 3 --output-dir benchmark/results/run-1
\`\`\`

---
*Report generated on ${new Date().toUTCString()} by dsh-graphify benchmark suite.*
`

  fs.writeFileSync(outputPath, md, 'utf-8')
}
