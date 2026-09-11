import type { Context } from '@deepseek-ai/cordis';
import type { PromptSection, DetectedGraph, ResolvedProject } from './types.ts';
import type { Config } from './config.ts';
import { ProjectResolver } from './project-resolver.ts';
/**
 * Creates the Graphify decision policy prompt section for coding agents.
 *
 * Formulates a clear decision workflow (when to query, when to read source, when to stop),
 * dynamically honoring configured tool prefixes, compact/full tool modes, and project status.
 */
export declare function createGraphifyPromptSection(_detectedGraph?: DetectedGraph | ResolvedProject | null, config?: Config, _resolver?: ProjectResolver): PromptSection;
/**
 * Registers the Graphify prompt section on ctx.systemPrompt if available.
 */
export declare function registerGraphifyPrompt(ctx: Context, detectedGraph?: DetectedGraph | ResolvedProject | null, config?: Config, resolver?: ProjectResolver): () => void;
