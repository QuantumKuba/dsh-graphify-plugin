import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.ts';
export interface CommandInvocation {
    commandId?: unknown;
    agent: {
        readonly session: {
            readonly header: {
                readonly cwd?: string;
            };
        };
    };
    rawInput: string;
    attachments?: readonly unknown[];
    signal: AbortSignal;
}
export type CommandResult = {
    kind: 'success';
    text?: string;
    sourceEventSeq?: number;
} | {
    kind: 'error';
    text: string;
};
export interface CommandDefinition {
    name: string;
    description: string;
    input?: {
        hint: string;
        images?: boolean;
    };
    recordInput?: boolean;
    handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
}
/** Parsed Graphify command supported by the direct DSH command surface. */
export interface GraphifyCommandRequest {
    readonly operation: 'build' | 'update';
    readonly projectRoot: string;
    readonly flags: readonly string[];
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        commands: {
            register: (def: CommandDefinition) => () => void;
            [key: string]: unknown;
        };
    }
}
export declare const ALLOWED_GRAPHIFY_FLAGS: readonly ["--force", "--no-cluster", "--code-only", "--no-viz"];
/**
 * Parses `/graphify [build|update] [path] [--force|--no-cluster|--code-only|--no-viz]` against the
 * receiving Session's project root.
 */
export declare function parseGraphifyCommand(rawInput: string, projectRoot: string): GraphifyCommandRequest;
/** Registers the `/graphify` build and incremental-update command. */
export declare function registerGraphifyCommand(ctx: Context, config: Config, defaultProjectRoot: string): () => void;
