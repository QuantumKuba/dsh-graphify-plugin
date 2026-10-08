import assert from 'node:assert/strict'
import { it } from 'node:test'
import { parseDshSessionEvents, evaluateDshSession } from '../benchmark/engine/dsh-telemetry.ts'
import { BENCHMARK_TASKS } from '../benchmark/tasks/index.ts'

it('normalizes explicit reads and excludes search directories without basename collisions', () => {
  const parsed = parseDshSessionEvents([
    { type: 'session', id: 'fixture', cwd: '/repo' },
    { type: 'tool/call', data: { callId: '1', name: 'read', arguments: { file_path: '/repo/lib/router/layer.js' } } },
    { type: 'tool/call', data: { callId: '2', name: 'grep', arguments: { path: '/repo/lib', pattern: 'match' } } },
    { type: 'tool/call', data: { callId: '3', name: 'read', arguments: { path: 'lib/router/layer.js' } } },
    { type: 'tool/call', data: { callId: '4', name: 'read', arguments: { path: '/repo/unrelated/layer.js' } } },
  ])
  assert.deepEqual(parsed.inspectedFiles, ['lib/router/layer.js', 'unrelated/layer.js'])
  const task = BENCHMARK_TASKS.find(t => t.id === 'task-01-route-match')!
  assert.deepEqual(evaluateDshSession(parsed, task, 'control').irrelevantFiles, ['unrelated/layer.js'])
})

it('scores trials accurately with custom workspaceRoot', async () => {
  const { scoreTrialAgainstCriteria } = await import('../benchmark/engine/scoring.ts')
  const report = scoreTrialAgainstCriteria(
    'task-01-route-match',
    'control',
    ['/custom/workspace/lib/router/layer.js', '/custom/workspace/lib/router/index.js'],
    'Found Layer.prototype.match in lib/router/layer.js',
    [{ turn: 1, target: '/custom/workspace/lib/router/layer.js' }],
    '/custom/workspace'
  )
  assert.equal(report.isStrictSuccess, true)
  assert.equal(report.irrelevantFilesInspected, 0)
  assert.equal(report.primaryFilesInspected, 1)
})

it('generates dynamic markdown report with real trial traces and without hardcoded case studies', async () => {
  const { generateMarkdownReport } = await import('../benchmark/reporters/markdown-reporter.ts')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')

  const tempReport = path.join(os.tmpdir(), `bench-test-${Date.now()}.md`)
  try {
    generateMarkdownReport(
      {
        timestamp: new Date().toISOString(),
        targetCodebase: { name: 'express', version: '4.21.2', path: '/test', nodes: 10, edges: 10 },
        taskCount: 1,
        control: {
          successRate: 100,
          meanInputTokens: 1000,
          medianInputTokens: 1000,
          meanTotalTokens: 1200,
          medianTotalTokens: 1200,
          meanTurns: 1,
          medianTurns: 1,
          meanToolCalls: 2,
          meanIrrelevantFiles: 0,
          meanTtff: 1,
          meanDurationMs: 5000,
        },
        treatment: {
          successRate: 100,
          meanInputTokens: 900,
          medianInputTokens: 900,
          meanTotalTokens: 1100,
          medianTotalTokens: 1100,
          meanTurns: 1,
          medianTurns: 1,
          meanToolCalls: 1,
          meanIrrelevantFiles: 0,
          meanTtff: 1,
          meanDurationMs: 4000,
        },
        deltas: {
          tokenReductionRatio: 1.1,
          tokenSavingsPercent: 8,
          turnReductionPercent: 0,
          toolCallReductionPercent: 50,
          noiseReductionPercent: 0,
          successRateDelta: 0,
          speedupRatio: 1.25,
        },
        tasks: [],
        rawTrials: [
          {
            taskId: 'task-01-route-match',
            taskTitle: 'Route Match Test',
            arm: 'control',
            success: true,
            turns: 1,
            toolCalls: 1,
            inputTokens: 1000,
            outputTokens: 200,
            totalTokens: 1200,
            durationMs: 5000,
            inspectedFiles: ['lib/router/layer.js'],
            irrelevantFiles: [],
            finalAnswer: 'Matched Layer.match',
            toolHistory: [
              { turn: 1, toolName: 'read', args: { file_path: 'lib/router/layer.js' }, outputSummary: 'data', outputLength: 100, tokenEstimate: 25 },
            ],
          },
          {
            taskId: 'task-01-route-match',
            taskTitle: 'Route Match Test',
            arm: 'treatment',
            success: true,
            turns: 1,
            toolCalls: 1,
            inputTokens: 900,
            outputTokens: 200,
            totalTokens: 1100,
            durationMs: 4000,
            inspectedFiles: ['lib/router/layer.js'],
            irrelevantFiles: [],
            finalAnswer: 'Matched Layer.match',
            toolHistory: [
              { turn: 1, toolName: 'get_node', args: { label: 'Layer' }, outputSummary: 'node data', outputLength: 80, tokenEstimate: 20 },
            ],
          },
        ],
      },
      tempReport
    )

    const content = fs.readFileSync(tempReport, 'utf-8')
    assert.ok(content.includes('Task: Route Path Matching & Layer Evaluation'))
    assert.ok(content.includes('`get_node`(label="Layer")'))
    assert.ok(!content.includes('Blast Radius Analysis of `res.send()`'))
    assert.ok(!content.includes('89% noise reduction'))
  } finally {
    try { fs.unlinkSync(tempReport) } catch {}
  }
})
