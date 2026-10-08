import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import type { TaskCard } from '../tasks/types.ts'
import type { TrialResult, ToolCallRecord, BenchmarkArm } from './types.ts'

/**
 * Interface representing raw DSH session events parsed from session.v3.jsonl.zstd
 */
export interface DshSessionEvent {
  type: string
  seq?: number
  time?: number
  id?: string
  createdAt?: number
  cwd?: string
  data?: any
}

export interface DshParsedSession {
  sessionId: string
  cwd: string
  createdAt: number
  startTime: number
  endTime: number
  durationMs: number
  turns: number
  steps: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  reasoningText: string
  finalAnswer: string
  toolHistory: ToolCallRecord[]
  inspectedFiles: string[]
  graphifyToolsCalled: number
  standardToolsCalled: number
  rawEvents: DshSessionEvent[]
}

/**
 * Normalizes a directory path into the DSH session folder slug format.
 * E.g., /Users/kuba/... -> --Users-kuba-...--
 */
export function getDshSessionFolderSlug(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir)
  const sanitized = resolved.replace(/^\//, '').replace(/\/$/, '').replace(/\//g, '-')
  return `--${sanitized}--`
}

/**
 * Gets the root sessions directory for DeepSeek Harness.
 */
export function getDshSessionsRoot(): string {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'sessions')
}

/**
 * Finds the latest session directory for the specified workspace created after startTimeMs.
 */
export function findLatestDshSession(workspaceDir: string, startTimeMs = 0): string | null {
  const sessionsRoot = getDshSessionsRoot()
  const slug = getDshSessionFolderSlug(workspaceDir)
  const workspaceSessionsDir = path.join(sessionsRoot, slug)

  if (!fs.existsSync(workspaceSessionsDir)) {
    return null
  }

  const entries = fs.readdirSync(workspaceSessionsDir, { withFileTypes: true })
  const sessionDirs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith('session-'))
    .map((e) => {
      const fullPath = path.join(workspaceSessionsDir, e.name)
      const stat = fs.statSync(fullPath)
      return { path: fullPath, name: e.name, mtimeMs: stat.mtimeMs }
    })
    .filter((s) => s.mtimeMs >= startTimeMs - 10000) // allow 10s clock skew
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  return sessionDirs.length > 0 ? sessionDirs[0].path : null
}

/**
 * Reads and decompresses a DSH session file (session.v3.jsonl.zstd or session.jsonl.zstd)
 */
export function readDshSessionFile(sessionDirPath: string): DshSessionEvent[] {
  const candidates = [
    path.join(sessionDirPath, 'session.v3.jsonl.zstd'),
    path.join(sessionDirPath, 'session.jsonl.zstd'),
    path.join(sessionDirPath, 'session.v3.jsonl'),
    path.join(sessionDirPath, 'session.jsonl'),
  ]

  let targetFile: string | null = null
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      targetFile = c
      break
    }
  }

  if (!targetFile) {
    throw new Error(`No DSH session log found in directory: ${sessionDirPath}`)
  }

  let jsonlContent: string
  if (targetFile.endsWith('.zstd')) {
    jsonlContent = execFileSync('zstd', ['-dc', targetFile], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf-8',
    })
  } else {
    jsonlContent = fs.readFileSync(targetFile, 'utf-8')
  }

  const lines = jsonlContent.split('\n').filter((l) => l.trim().length > 0)
  const events: DshSessionEvent[] = []
  for (const line of lines) {
    try {
      events.push(JSON.parse(line))
    } catch {
      // skip unparseable line
    }
  }

  return events
}

const GRAPHIFY_TOOL_NAMES = new Set([
  'query_graph',
  'get_node',
  'get_neighbors',
  'shortest_path',
  'god_nodes',
  'get_community',
  'graph_stats',
  'list_prs',
  'get_pr_impact',
  'triage_prs',
  'graphify_call',
  'graphify_status',
  'graphify_resource',
  'graphify_project_resource',
  'graphify_capabilities',
])

function extractFilesFromArgs(toolName: string, args: Record<string, unknown>, inspectedFiles: Set<string>): void {
  if (args.file_path && typeof args.file_path === 'string') {
    inspectedFiles.add(args.file_path)
  }
  if (toolName === 'read' && typeof args.path === 'string') {
    inspectedFiles.add(args.path)
  }
  if (toolName === 'bash' && typeof args.command === 'string') {
    const fileMatches = args.command.match(/\b(?:lib\/[a-zA-Z0-9_\-/]+\.js|test\/[a-zA-Z0-9_\-/]+\.js|package\.json)\b/g)
    if (fileMatches) {
      for (const fm of fileMatches) {
        inspectedFiles.add(fm)
      }
    }
  }
}

/**
 * Parses raw DSH events into structured metrics.
 */
export function parseDshSessionEvents(events: DshSessionEvent[]): DshParsedSession {
  let sessionId = ''
  let cwd = ''
  let createdAt = 0
  let startTime = 0
  let endTime = 0
  let turns = 0
  let steps = 0
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  let reasoningText = ''
  let finalAnswer = ''
  let graphifyToolsCalled = 0
  let standardToolsCalled = 0

  const toolHistory: ToolCallRecord[] = []
  const inspectedFiles = new Set<string>()

  // Map to pair tool/call with tool/result
  const pendingCalls = new Map<string, { turn: number; toolName: string; args: Record<string, unknown> }>()

  for (const ev of events) {
    if (ev.time && (!startTime || ev.time < startTime)) {
      startTime = ev.time
    }
    if (ev.time && ev.time > endTime) {
      endTime = ev.time
    }

    if (ev.type === 'session') {
      sessionId = ev.id || ''
      cwd = ev.cwd || ''
      createdAt = ev.createdAt || ev.time || 0
      if (!startTime) startTime = createdAt
    } else if (ev.type === 'turn/start') {
      turns++
      if (ev.time && !startTime) startTime = ev.time
    } else if (ev.type === 'step/start') {
      steps++
    } else if (ev.type === 'assistant/message') {
      const data = ev.data
      if (data?.usage) {
        inputTokens += data.usage.inputTokens || 0
        outputTokens += data.usage.outputTokens || 0
        totalTokens += data.usage.totalTokens || ((data.usage.inputTokens || 0) + (data.usage.outputTokens || 0))
      }

      if (data?.message?.content && Array.isArray(data.message.content)) {
        for (const part of data.message.content) {
          if (part.type === 'reasoning' && part.text) {
            reasoningText += (reasoningText ? '\n' : '') + part.text
          } else if (part.type === 'text' && part.text) {
            finalAnswer = part.text.trim()
          } else if (part.type === 'tool-call') {
            const toolName = part.name
            let args: Record<string, unknown> = {}
            try {
              args = typeof part.arguments === 'string' ? JSON.parse(part.arguments) : part.arguments || {}
            } catch {
              args = { raw: part.arguments }
            }

            if (GRAPHIFY_TOOL_NAMES.has(toolName)) {
              graphifyToolsCalled++
            } else {
              standardToolsCalled++
            }
            extractFilesFromArgs(toolName, args, inspectedFiles)

            pendingCalls.set(part.id, {
              turn: turns || 1,
              toolName,
              args,
            })
          }
        }
      }
    } else if (ev.type === 'tool/call') {
      const data = ev.data
      if (data?.callId && !pendingCalls.has(data.callId)) {
        const toolName = data.name
        let args: Record<string, unknown> = {}
        try {
          args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments || {}
        } catch {
          args = { raw: data.arguments }
        }

        if (GRAPHIFY_TOOL_NAMES.has(toolName)) {
          graphifyToolsCalled++
        } else {
          standardToolsCalled++
        }

        extractFilesFromArgs(toolName, args, inspectedFiles)

        pendingCalls.set(data.callId, {
          turn: data.turn || turns || 1,
          toolName,
          args,
        })
      }
    } else if (ev.type === 'tool/result') {
      const data = ev.data
      const message = data?.message
      const contentItem = message?.content?.[0]
      const callId =
        message?.source?.callId ||
        contentItem?.toolCallId ||
        data?.callId

      const callInfo = callId ? pendingCalls.get(callId) : undefined

      let outputStr = ''
      if (typeof contentItem?.content === 'string') {
        outputStr = contentItem.content
      } else if (Array.isArray(contentItem?.content)) {
        outputStr = contentItem.content.map((c: any) => (typeof c === 'string' ? c : c?.text || JSON.stringify(c))).join('\n')
      } else if (typeof data?.value === 'string') {
        outputStr = data.value
      } else if (data?.value) {
        outputStr = JSON.stringify(data.value)
      } else if (contentItem?.text) {
        outputStr = contentItem.text
      }

      const outputSummary = outputStr.slice(0, 180).replace(/\n/g, ' ')

      toolHistory.push({
        turn: callInfo?.turn || data?.turn || turns || 1,
        toolName: callInfo?.toolName || data?.name || 'unknown_tool',
        args: callInfo?.args || {},
        outputSummary,
        outputLength: outputStr.length,
        tokenEstimate: Math.round(outputStr.length / 4),
      })
    }
  }

  // Ensure turns is at least 1 if steps occurred
  if (turns === 0 && steps > 0) {
    turns = 1
  }

  const durationMs = Math.max(1, endTime - startTime)

  return {
    sessionId,
    cwd,
    createdAt,
    startTime,
    endTime,
    durationMs,
    turns,
    steps,
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningText,
    finalAnswer,
    toolHistory,
    inspectedFiles: [...new Set(Array.from(inspectedFiles, file => {
      const relative = cwd && path.isAbsolute(file) ? path.relative(cwd, file) : file
      return relative.replaceAll('\\', '/').replace(/^\.\//, '')
    }))],
    graphifyToolsCalled,
    standardToolsCalled,
    rawEvents: events,
  }
}

/**
 * Evaluates a parsed DSH session against a TaskCard's GroundTruth.
 */
export function evaluateDshSession(
  session: DshParsedSession,
  task: TaskCard,
  arm: BenchmarkArm
): TrialResult {
  const primaryFiles = task.groundTruth.primaryFiles
  const directDeps = task.groundTruth.directDeps || []
  const relevantSymbols = task.groundTruth.relevantSymbols

  const validSet = new Set<string>()
  for (const pf of primaryFiles) {
    validSet.add(pf)
  }
  for (const dd of directDeps) {
    validSet.add(dd)
  }

  const inspected = session.inspectedFiles
  const irrelevant: string[] = []

  for (const f of inspected) {
    if (!validSet.has(f)) {
      irrelevant.push(f)
    }
  }

  // Determine turns to first correct file
  let turnsToFirstCorrectFile: number | null = null
  for (const th of session.toolHistory) {
    const toolStr = JSON.stringify(th.args) + ' ' + th.outputSummary
    const hit = primaryFiles.some((pf) => toolStr.includes(pf) || toolStr.includes(path.basename(pf)))
    if (hit) {
      turnsToFirstCorrectFile = th.turn
      break
    }
  }

  // Success criteria:
  // 1. Located target files in tool calls or final answer, OR
  // 2. Mentioned primary files and symbols in final answer
  const combinedText = session.finalAnswer + ' ' + session.toolHistory.map((t) => t.outputSummary).join(' ')
  const primaryHit = primaryFiles.some((pf) => {
    const base = path.basename(pf)
    return combinedText.includes(pf) || combinedText.includes(base)
  })
  const symbolHit = relevantSymbols.some((sym) => combinedText.includes(sym))

  const success = primaryHit || (symbolHit && turnsToFirstCorrectFile !== null)

  return {
    taskId: task.id,
    taskTitle: task.title,
    arm,
    success,
    turns: Math.max(1, session.turns),
    toolCalls: session.toolHistory.length,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    totalTokens: session.totalTokens,
    durationMs: session.durationMs,
    inspectedFiles: inspected,
    irrelevantFiles: irrelevant,
    turnsToFirstCorrectFile,
    finalAnswer: session.finalAnswer,
    toolHistory: session.toolHistory,
  }
}
