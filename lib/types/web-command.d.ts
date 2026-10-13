import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client';
/** Human-entered `/graphify` command projected into the DSH Web conversation. */
export interface GraphifyCommandInputData {
    readonly commandId: CommandId;
    readonly text: string;
    readonly time: number;
}
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
    interface ChatNodeDataMap {
        /** Human-entered `/graphify` command input. */
        'graphify-command-input': GraphifyCommandInputData;
    }
}
interface GraphifyCommandInputState extends GraphifyCommandInputData {
    readonly seq: number;
}
/**
 * Derives the visible command line from its durable structured run.
 * @param event - `/graphify` command run.
 * @returns Command text with trailing parser whitespace removed.
 */
export declare function graphifyCommandText(event: SessionEvent<'command/run'>): string;
/** Graphify-owned command input projection; DSH retains the generic result row. */
export declare const graphifyCommandInputDefinition: ConversationNodeDefinition<GraphifyCommandInputState>;
export {};
