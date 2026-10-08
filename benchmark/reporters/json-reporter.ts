import fs from 'node:fs'
import path from 'node:path'
import type { BenchmarkSummary } from '../engine/types.ts'

/**
 * Dumps machine-readable JSON telemetry and summary data.
 */
export function writeJsonReport(summary: BenchmarkSummary, outputPath: string): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), 'utf8')
}
