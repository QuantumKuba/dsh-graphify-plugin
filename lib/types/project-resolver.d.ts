import type { Config } from './config.ts';
import type { ResolvedProject, ToolRunContext } from './types.ts';
export interface ResolveOptions {
    /** Explicit project path passed in tool arguments. */
    explicitPath?: string;
    /** Calling agent's session working directory. */
    agentCwd?: string;
    /** Tool execution context containing agent session metadata. */
    toolContext?: ToolRunContext;
}
/**
 * Session-scoped project resolver for DeepSeek Harness.
 *
 * Resolves project roots and graph metadata dynamically per-session so that
 * a single long-running DSH process serving multiple concurrent sessions
 * (Session A -> Project A, Session B -> Project B) never leaks graph metadata
 * across sessions.
 */
export declare class ProjectResolver {
    private cache;
    private readonly config;
    constructor(config: Config);
    /**
     * Resolves the target project and graph metadata for a tool or command invocation.
     *
     * Resolution precedence:
     * 1. Explicit `explicitPath` (e.g. `project_path` argument)
     * 2. Calling agent session cwd (`toolContext.agent.session.header.cwd` or `agentCwd`)
     * 3. Configured `config.cwd`
     * 4. Process fallback (`process.cwd()`, only if autoDetect is enabled and no session cwd exists)
     */
    resolve(options?: ResolveOptions): ResolvedProject;
    /**
     * Detects the graph for a target directory, respecting autoDetect and explicit graphPath.
     */
    private detectForDirectory;
    private buildEmptyProject;
    /**
     * Validates if cached project metadata is still fresh on disk.
     */
    private isCacheValid;
    /**
     * Invalidates cached metadata for a specific directory or clears the entire cache.
     */
    invalidate(targetDir?: string): void;
}
