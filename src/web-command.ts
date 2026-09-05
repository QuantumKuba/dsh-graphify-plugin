import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'

/** Human-entered `/graphify` command projected into the DSH Web conversation. */
export interface GraphifyCommandInputData {
  readonly commandId: CommandId
  readonly text: string
  readonly time: number
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Human-entered `/graphify` command input. */
    'graphify-command-input': GraphifyCommandInputData
  }
}

/** One independently registered business Event-to-Node state machine in DSH Web Conversation. */
export interface ConversationNodeDefinition<State = unknown> {
  readonly kind: string
  readonly target?: string
  match(event: SessionEvent<any>): { id: string; role: string } | null
  start(context: any, match: { event: SessionEvent<any> }, reader?: unknown): State
  update(context: { state: State }, match?: unknown): State
  publication?(match: unknown): unknown
  buildLocationData?(context: unknown, scope: unknown, previous: unknown): unknown
  buildViewNode?(context: { key: string; id: string; state?: State; start?: { location?: unknown } }): unknown
}

interface GraphifyCommandInputState extends GraphifyCommandInputData {
  readonly seq: number
}

/**
 * Derives the visible command line from its durable structured run.
 * @param event - `/graphify` command run.
 * @returns Command text with trailing parser whitespace removed.
 */
export function graphifyCommandText(event: SessionEvent<'command/run'>): string {
  return `/${event.data.name}${(event.data.args ?? '').trimEnd()}`
}

/** Graphify-owned command input projection; DSH retains the generic result row. */
export const graphifyCommandInputDefinition: ConversationNodeDefinition<GraphifyCommandInputState> = {
  kind: 'graphify-command-input',
  target: 'chat',
  match: (event) => event.type === 'command/run' && event.data.name === 'graphify'
    ? { id: String(event.data.commandId), role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'command/run') {
      throw new Error('graphify-command-input start requires command/run')
    }
    return {
      commandId: match.event.data.commandId,
      seq: match.event.seq,
      time: match.event.time,
      text: graphifyCommandText(match.event),
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'graphify-command-input',
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq - 0.1,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: {
        commandId: context.state.commandId,
        text: context.state.text,
        time: context.state.time,
      },
    }
  },
}
