/**
 * Pre-Registered Task Scoring & Ground Truth Verification.
 *
 * This module enforces strict, deterministic evaluation rules established
 * before trial execution to eliminate researcher degrees of freedom and post-hoc bias.
 */

import type { TaskCard } from '../tasks/types.ts'

export interface PreRegisteredTaskCriteria {
  taskId: string
  title: string
  category: string
  /** Primary target files that MUST be localized to solve the task. */
  primaryTargetFiles: string[]
  /** Legitimate direct dependency files acceptable to examine. */
  acceptableContextFiles: string[]
  /** Distractor/test files that explicitly count as noise if touched. */
  knownDistractors: string[]
  /** Key AST symbols/identifiers required in a correct solution. */
  requiredSymbols: string[]
}

export interface TrialScoreReport {
  taskId: string
  arm: 'control' | 'treatment'
  isStrictSuccess: boolean
  localizedAllPrimaryFiles: boolean
  identifiedRequiredSymbols: boolean
  totalInspectedFiles: number
  primaryFilesInspected: number
  irrelevantFilesInspected: number
  inspectionPrecision: number // primary / total
  noiseRatio: number // irrelevant / total
  turnsToFirstCorrectFile: number | null
}

/**
 * Normalizes file paths relative to the repository root.
 */
export function normalizePath(p: string, workspaceRoot?: string): string {
  let clean = p.trim().replaceAll('\\', '/')
  if (workspaceRoot) {
    const normRoot = workspaceRoot.trim().replaceAll('\\', '/').replace(/\/$/, '')
    if (clean.startsWith(normRoot + '/')) {
      clean = clean.slice(normRoot.length + 1)
    }
  }
  return clean
    .replace(/^(\.\/|\/)/, '')
    .replace(/^.*?benchmark\/data\/[a-zA-Z0-9_\-.]+\//, '')
    .trim()
}

/**
 * Pre-registered criteria table for all 10 benchmark tasks.
 */
export const PRE_REGISTERED_CRITERIA: Record<string, PreRegisteredTaskCriteria> = {
  'task-01-route-match': {
    taskId: 'task-01-route-match',
    title: 'Route Path Matching & Layer Evaluation',
    category: 'discovery',
    primaryTargetFiles: ['lib/router/layer.js'],
    acceptableContextFiles: ['lib/router/index.js', 'lib/router/route.js'],
    knownDistractors: ['test/app.router.js', 'test/Route.js', 'test/Router.js'],
    requiredSymbols: ['Layer', 'match'],
  },
  'task-02-dispatch-pipeline': {
    taskId: 'task-02-dispatch-pipeline',
    title: 'HTTP Request Dispatch Pipeline Tracing',
    category: 'pipeline_tracing',
    primaryTargetFiles: ['lib/application.js', 'lib/router/index.js', 'lib/router/layer.js'],
    acceptableContextFiles: ['lib/express.js', 'lib/middleware/init.js', 'lib/router/route.js'],
    knownDistractors: ['test/app.listen.js', 'test/res.send.js'],
    requiredSymbols: ['handle', 'layer'],
  },
  'task-03-blast-radius-send': {
    taskId: 'task-03-blast-radius-send',
    title: 'Blast Radius of Modifying res.send()',
    category: 'blast_radius',
    primaryTargetFiles: ['lib/response.js'],
    acceptableContextFiles: ['lib/application.js', 'lib/request.js'],
    knownDistractors: ['test/res.send.js', 'test/res.json.js', 'test/res.format.js'],
    requiredSymbols: ['json', 'sendFile', 'sendStatus'],
  },
  'task-04-god-nodes': {
    taskId: 'task-04-god-nodes',
    title: 'Central Architectural Hubs & God Nodes',
    category: 'architectural_hubs',
    primaryTargetFiles: ['lib/express.js', 'lib/application.js', 'lib/router/index.js', 'lib/response.js'],
    acceptableContextFiles: ['lib/request.js', 'lib/view.js'],
    knownDistractors: ['test/app.js'],
    requiredSymbols: ['createApplication', 'Router', 'application'],
  },
  'task-05-prototype-wiring': {
    taskId: 'task-05-prototype-wiring',
    title: 'Custom Request & Response Prototype Lifecycle Wiring',
    category: 'lifecycle_wiring',
    primaryTargetFiles: ['lib/application.js', 'lib/middleware/init.js'],
    acceptableContextFiles: ['lib/request.js', 'lib/response.js', 'lib/express.js'],
    knownDistractors: ['test/app.request.js', 'test/app.response.js'],
    requiredSymbols: ['init', 'prototype'],
  },
  'task-06-param-compilation': {
    taskId: 'task-06-param-compilation',
    title: 'Route Parameter Callback Compilation & Execution',
    category: 'parameter_handling',
    primaryTargetFiles: ['lib/router/index.js'],
    acceptableContextFiles: ['lib/router/layer.js', 'lib/router/route.js'],
    knownDistractors: ['test/app.param.js'],
    requiredSymbols: ['param', 'process_params'],
  },
  'task-07-view-engine': {
    taskId: 'task-07-view-engine',
    title: 'View Template Engine Resolution & Rendering',
    category: 'subsystem_resolution',
    primaryTargetFiles: ['lib/view.js'],
    acceptableContextFiles: ['lib/application.js', 'lib/response.js'],
    knownDistractors: ['test/view.test.js'],
    requiredSymbols: ['View', 'render', 'resolve'],
  },
  'task-08-subrouter-mounting': {
    taskId: 'task-08-subrouter-mounting',
    title: 'Sub-Router Mounting & Prefix Trimming',
    category: 'router_mounting',
    primaryTargetFiles: ['lib/application.js', 'lib/router/index.js'],
    acceptableContextFiles: ['lib/router/layer.js'],
    knownDistractors: ['test/Router.js'],
    requiredSymbols: ['use', 'handle'],
  },
  'task-09-error-middleware-arity': {
    taskId: 'task-09-error-middleware-arity',
    title: '4-Argument Error-Handling Middleware Arity Check',
    category: 'bug_localization',
    primaryTargetFiles: ['lib/router/layer.js'],
    acceptableContextFiles: ['lib/router/route.js', 'lib/router/index.js'],
    knownDistractors: ['test/app.router.js'],
    requiredSymbols: ['handle_error', 'length'],
  },
  'task-10-content-negotiation': {
    taskId: 'task-10-content-negotiation',
    title: 'HTTP Content Negotiation Delegation',
    category: 'interface_delegation',
    primaryTargetFiles: ['lib/request.js'],
    acceptableContextFiles: ['lib/response.js'],
    knownDistractors: ['test/req.accepts.js'],
    requiredSymbols: ['accepts', 'acceptsEncodings'],
  },
}

/**
 * Strictly scores a trial using pre-registered criteria.
 */
export function scoreTrialAgainstCriteria(
  taskId: string,
  arm: 'control' | 'treatment',
  inspectedFiles: string[],
  finalAnswer: string,
  timelineSteps: Array<{ turn: number; target: string }>,
  workspaceRoot?: string
): TrialScoreReport {
  const criteria = PRE_REGISTERED_CRITERIA[taskId]
  if (!criteria) {
    throw new Error(`Pre-registered criteria missing for task: ${taskId}`)
  }

  const normalize = (f: string) => normalizePath(f, workspaceRoot)
  const normalizedPrimary = criteria.primaryTargetFiles.map(normalize)
  const normalizedAcceptable = criteria.acceptableContextFiles.map(normalize)
  const uniqueInspected = Array.from(new Set(inspectedFiles.map(normalize).filter(Boolean)))

  // Identify irrelevant files
  const irrelevantFiles = uniqueInspected.filter(
    (f) => !normalizedPrimary.includes(f) && !normalizedAcceptable.includes(f)
  )

  // Check whether all primary files were localized
  const localizedPrimary = normalizedPrimary.filter(
    (pf) => uniqueInspected.includes(pf) || finalAnswer.includes(pf)
  )
  const localizedAll = localizedPrimary.length === normalizedPrimary.length

  // Check required symbols in final answer
  const answerLower = finalAnswer.toLowerCase()
  const matchedSymbols = criteria.requiredSymbols.filter((sym) =>
    answerLower.includes(sym.toLowerCase())
  )
  const identifiedSymbols = matchedSymbols.length > 0

  // Strict success: localized all primary files AND matched at least one required symbol
  const isStrictSuccess = localizedAll && identifiedSymbols

  // Calculate TTFF
  let ttff: number | null = null
  for (const step of timelineSteps) {
    const normTarget = normalize(step.target)
    if (normalizedPrimary.some((pf) => normTarget.includes(pf))) {
      ttff = step.turn
      break
    }
  }

  if (ttff === null && localizedAll) {
    ttff = timelineSteps.length > 0 ? timelineSteps[timelineSteps.length - 1].turn : 1
  }

  const totalFiles = Math.max(1, uniqueInspected.length)
  const precision = localizedPrimary.length / totalFiles
  const noiseRatio = irrelevantFiles.length / totalFiles

  return {
    taskId,
    arm,
    isStrictSuccess,
    localizedAllPrimaryFiles: localizedAll,
    identifiedRequiredSymbols: identifiedSymbols,
    totalInspectedFiles: uniqueInspected.length,
    primaryFilesInspected: localizedPrimary.length,
    irrelevantFilesInspected: irrelevantFiles.length,
    inspectionPrecision: precision,
    noiseRatio,
    turnsToFirstCorrectFile: ttff,
  }
}
