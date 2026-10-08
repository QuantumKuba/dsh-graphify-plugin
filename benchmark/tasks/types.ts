/**
 * Task Card definitions and scoring criteria for the dsh-graphify benchmark suite.
 */

export type TaskCategory =
  | 'discovery'
  | 'pipeline_tracing'
  | 'blast_radius'
  | 'architectural_hubs'
  | 'lifecycle_wiring'
  | 'parameter_handling'
  | 'subsystem_resolution'
  | 'router_mounting'
  | 'bug_localization'
  | 'interface_delegation'

export interface GroundTruth {
  /** The primary files that contain the authoritative implementation or change set. */
  primaryFiles: string[]
  /** Core symbols, functions, or methods that define the solution. */
  relevantSymbols: string[]
  /** 1-hop valid dependency files. */
  directDeps?: string[]
  /** Common distractor files that naive keyword searches falsely open. */
  forbiddenDistractors?: string[]
  /** Exact shortest dependency path hops if applicable. */
  expectedPath?: string[]
}

export interface TaskCard {
  id: string
  title: string
  category: TaskCategory
  difficulty: 'easy' | 'medium' | 'hard'
  /** User-facing prompt sent to the agent. */
  prompt: string
  /** Ground truth definition for validation and irrelevant file scoring. */
  groundTruth: GroundTruth
  /** Evaluation description for human reporting. */
  evaluationCriteria: string
}
