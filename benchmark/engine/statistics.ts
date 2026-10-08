/**
 * Rigorous Statistical Analysis Engine for A/B Agent Benchmarks.
 *
 * Implements:
 * - Paired difference analysis
 * - Parametric 95% Confidence Intervals (Student's t-distribution)
 * - Non-parametric 2,000-resample Bootstrap 95% Confidence Intervals
 * - Paired Student's t-test (two-tailed p-value)
 * - Wilcoxon Signed-Rank Test (with tie-handling & continuity correction)
 * - Standardized effect sizes (Cohen's d_z for paired samples)
 */

export interface PairedMetricSample {
  control: number
  treatment: number
}

export interface MetricStatisticalSummary {
  metricName: string
  sampleSize: number
  controlMean: number
  controlStd: number
  treatmentMean: number
  treatmentStd: number
  meanDifference: number // treatment - control
  percentageChange: number // (treatmentMean - controlMean) / controlMean * 100
  stdDifference: number
  standardError: number
  ci95Parametric: [number, number]
  ci95Bootstrap: [number, number]
  tStatistic: number
  tPValue: number
  wilcoxonW: number
  wilcoxonPValue: number
  cohensD: number
  isStatisticallySignificant: boolean // p < 0.05
}

/**
 * Standard normal cumulative distribution function (Abramowitz and Stegun approximation).
 */
function normalCdf(x: number): number {
  const b1 = 0.31938153
  const b2 = -0.356563782
  const b3 = 1.781477937
  const b4 = -1.821255978
  const b5 = 1.330274429
  const p = 0.2316419
  const c2 = 0.39894228

  if (x >= 0) {
    const t = 1.0 / (1.0 + p * x)
    return (
      1.0 -
      c2 * Math.exp((-x * x) / 2.0) * t * (t * (t * (t * (t * b5 + b4) + b3) + b2) + b1)
    )
  } else {
    const t = 1.0 / (1.0 - p * x)
    return (
      c2 * Math.exp((-x * x) / 2.0) * t * (t * (t * (t * (t * b5 + b4) + b3) + b2) + b1)
    )
  }
}

/**
 * Student's t distribution two-tailed p-value approximation via Hill's algorithm / normal approximation for df.
 */
function studentTPValue(t: number, df: number): number {
  if (df <= 0 || isNaN(t)) return 1.0
  const absT = Math.abs(t)

  if (df === 1) {
    return 1 - (2 / Math.PI) * Math.atan(absT)
  }

  // Cornish-Fisher or transformed normal approximation for small/moderate df
  const x = absT
  const a = df - 0.5
  const b = 48 * a * a
  const z = Math.sqrt(
    a * Math.log(1 + (x * x) / df) * (1 - (1 - (1 - 4 / b) / b) / b)
  )

  const pNorm = normalCdf(z)
  const twoTailed = 2 * (1 - pNorm)
  return Math.min(1.0, Math.max(0.0, twoTailed))
}

/**
 * Critical t-value for 95% two-sided confidence interval.
 */
function tCritical95(df: number): number {
  const tTable: Record<number, number> = {
    1: 12.706,
    2: 4.303,
    3: 3.182,
    4: 2.776,
    5: 2.571,
    6: 2.447,
    7: 2.365,
    8: 2.306,
    9: 2.262,
    10: 2.228,
    15: 2.131,
    20: 2.086,
    30: 2.042,
  }
  if (tTable[df]) return tTable[df]
  if (df > 30) return 1.96
  return 2.571
}

/**
 * Computes mean of a number array.
 */
function mean(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((acc, v) => acc + v, 0) / arr.length
}

/**
 * Computes sample standard deviation (Bessel's correction, N-1).
 */
function stdDev(arr: number[], m?: number): number {
  if (arr.length <= 1) return 0
  const avg = m ?? mean(arr)
  const sumSq = arr.reduce((acc, v) => acc + Math.pow(v - avg, 2), 0)
  return Math.sqrt(sumSq / (arr.length - 1))
}

/**
 * Computes non-parametric Bootstrap 95% Confidence Interval with B resamples.
 */
function bootstrapCI(diffs: number[], B = 2000): [number, number] {
  const n = diffs.length
  if (n === 0) return [0, 0]
  if (n === 1) return [diffs[0], diffs[0]]

  const bootstrapMeans: number[] = new Array(B)

  for (let b = 0; b < B; b++) {
    let sum = 0
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.random() * n)
      sum += diffs[idx]
    }
    bootstrapMeans[b] = sum / n
  }

  bootstrapMeans.sort((a, b) => a - b)
  const lowIdx = Math.floor(B * 0.025)
  const highIdx = Math.floor(B * 0.975)

  return [bootstrapMeans[lowIdx], bootstrapMeans[highIdx]]
}

/**
 * Computes Wilcoxon Signed-Rank Test for paired differences.
 */
function wilcoxonSignedRank(diffs: number[]): { w: number; pValue: number } {
  const nonZero = diffs.filter((d) => Math.abs(d) > 1e-9)
  const n = nonZero.length

  if (n === 0) {
    return { w: 0, pValue: 1.0 }
  }

  const items = nonZero.map((d) => ({ diff: d, absDiff: Math.abs(d), sign: Math.sign(d), rank: 0 }))
  items.sort((a, b) => a.absDiff - b.absDiff)

  let i = 0
  while (i < n) {
    let j = i
    while (j < n && items[j].absDiff === items[i].absDiff) {
      j++
    }
    const avgRank = (i + 1 + j) / 2
    for (let k = i; k < j; k++) {
      items[k].rank = avgRank
    }
    i = j
  }

  let wPlus = 0
  let wMinus = 0
  for (const item of items) {
    if (item.sign > 0) wPlus += item.rank
    else if (item.sign < 0) wMinus += item.rank
  }

  const w = Math.min(wPlus, wMinus)

  const meanW = (n * (n + 1)) / 4
  const varW = (n * (n + 1) * (2 * n + 1)) / 24
  if (varW <= 0) return { w, pValue: 1.0 }

  const z = (Math.abs(w - meanW) - 0.5) / Math.sqrt(varW)
  const pValue = 2 * (1 - normalCdf(z))
  return { w, pValue: Math.min(1.0, Math.max(0.0, pValue)) }
}

/**
 * Computes full paired statistical analysis for a single metric.
 */
export function analyzePairedMetric(
  metricName: string,
  samples: PairedMetricSample[]
): MetricStatisticalSummary {
  const n = samples.length
  if (n === 0) {
    throw new Error(`Cannot analyze empty sample set for metric ${metricName}`)
  }

  const controlVals = samples.map((s) => s.control)
  const treatmentVals = samples.map((s) => s.treatment)
  const diffs = samples.map((s) => s.treatment - s.control)

  const cMean = mean(controlVals)
  const cStd = stdDev(controlVals, cMean)
  const tMean = mean(treatmentVals)
  const tStd = stdDev(treatmentVals, tMean)

  const meanDiff = mean(diffs)
  const sDiff = stdDev(diffs, meanDiff)
  const se = n > 1 ? sDiff / Math.sqrt(n) : 0

  const pctChange = cMean !== 0 ? ((tMean - cMean) / Math.abs(cMean)) * 100 : 0

  const df = n - 1
  const tCrit = df >= 1 ? tCritical95(df) : 0
  const ciParametric: [number, number] = [meanDiff - tCrit * se, meanDiff + tCrit * se]
  const ciBootstrap = bootstrapCI(diffs, 2000)

  const tStat = se > 0 ? meanDiff / se : 0
  const tPVal = df >= 1 ? studentTPValue(tStat, df) : 1.0

  const { w: wilcoxonW, pValue: wilcoxonPVal } = wilcoxonSignedRank(diffs)
  const cohensD = sDiff > 0 ? meanDiff / sDiff : 0

  return {
    metricName,
    sampleSize: n,
    controlMean: cMean,
    controlStd: cStd,
    treatmentMean: tMean,
    treatmentStd: tStd,
    meanDifference: meanDiff,
    percentageChange: pctChange,
    stdDifference: sDiff,
    standardError: se,
    ci95Parametric: ciParametric,
    ci95Bootstrap: ciBootstrap,
    tStatistic: tStat,
    tPValue: tPVal,
    wilcoxonW,
    wilcoxonPValue: wilcoxonPVal,
    cohensD,
    isStatisticallySignificant: tPVal < 0.05 || wilcoxonPVal < 0.05,
  }
}
