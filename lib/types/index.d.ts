import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.ts';
export declare const name = "dsh-graphify";
export declare const inject: string[];
export { Config, validateConfig } from './config.ts';
export * from './types.ts';
export { detectGraph } from './detector.ts';
export { GraphifyMcpClient } from './client.ts';
export { createGraphifyToolDefinitions, registerGraphifyTools, getPrefixedToolName, isPathContained, validateProjectPathAccess, } from './tools.ts';
export { createGraphifyPromptSection, registerGraphifyPrompt } from './prompt.ts';
export { registerGraphifyCommand } from './commands.ts';
export { resolveGraphifyCommand, resolveGraphifyCliCommand, resolveGraphifyRuntime, resolveGraphifyCliRuntime, getRuntimeInfo, DEFAULT_GRAPHIFY_VERSION, } from './server-process.ts';
export { ProjectResolver } from './project-resolver.ts';
export { checkGraphFreshness, ProjectUpdateCoalescer, writeGraphifyIndexMetadata, readGraphifyIndexMetadata, INDEX_METADATA_FILENAME, } from './freshness.ts';
export { collectGraphifyStatus, formatGraphifyStatus } from './status.ts';
export { getPackageVersion } from './version.ts';
/**
 * DeepSeek Harness Graphify Plugin.
 *
 * Integrates Graphify's knowledge graph intelligence, prompt decision policy,
 * session-scoped project resolution, graph freshness monitoring, doctor status,
 * and /graphify slash commands into the DeepSeek Harness runtime.
 */
export declare function apply(ctx: Context, config?: Config): void;
