import { Config, validateConfig } from "./config.js";
import { resolveGraphifyRuntime, } from "./server-process.js";
import { GraphifyMcpClient } from "./client.js";
import { registerGraphifyTools } from "./tools.js";
import { registerGraphifyPrompt } from "./prompt.js";
import { registerGraphifyCommand } from "./commands.js";
import { ProjectResolver } from "./project-resolver.js";
export const name = 'dsh-graphify';
export const inject = ['tools', 'systemPrompt'];
export { Config, validateConfig } from "./config.js";
export * from "./types.js";
export { detectGraph } from "./detector.js";
export { GraphifyMcpClient } from "./client.js";
export { createGraphifyToolDefinitions, registerGraphifyTools, getPrefixedToolName, isPathContained, validateProjectPathAccess, } from "./tools.js";
export { createGraphifyPromptSection, registerGraphifyPrompt } from "./prompt.js";
export { registerGraphifyCommand } from "./commands.js";
export { resolveGraphifyCommand, resolveGraphifyCliCommand, resolveGraphifyRuntime, resolveGraphifyCliRuntime, getRuntimeInfo, DEFAULT_GRAPHIFY_VERSION, } from "./server-process.js";
export { ProjectResolver } from "./project-resolver.js";
export { checkGraphFreshness, ProjectUpdateCoalescer, writeGraphifyIndexMetadata, readGraphifyIndexMetadata, INDEX_METADATA_FILENAME, } from "./freshness.js";
export { collectGraphifyStatus, formatGraphifyStatus } from "./status.js";
export { getPackageVersion } from "./version.js";
/**
 * DeepSeek Harness Graphify Plugin.
 *
 * Integrates Graphify's knowledge graph intelligence, prompt decision policy,
 * session-scoped project resolution, graph freshness monitoring, doctor status,
 * and /graphify slash commands into the DeepSeek Harness runtime.
 */
export function apply(ctx, config) {
    const cfg = Config(config ?? {});
    validateConfig(cfg);
    const logger = typeof ctx.logger === 'function' ? ctx.logger('graphify') : undefined;
    const resolver = new ProjectResolver(cfg);
    const initialProject = resolver.resolve();
    const workingDir = initialProject.projectRoot;
    const client = new GraphifyMcpClient({
        resolveRuntime: () => resolveGraphifyRuntime(cfg, initialProject.graphJsonPath || undefined),
        cwd: workingDir,
        timeoutMs: cfg.timeoutMs,
        reconnect: cfg.reconnect,
        logger,
    });
    ctx.effect(() => {
        logger?.debug?.(`[dsh-graphify] Mounting plugin with toolMode: ${cfg.toolMode}, freshness: ${cfg.freshness.mode}`);
        const unregisterPrompt = cfg.enablePromptSection
            ? registerGraphifyPrompt(ctx, initialProject.hasGraph ? initialProject : null, cfg, resolver)
            : () => { };
        const unregisterTools = registerGraphifyTools(ctx, client, cfg, initialProject.hasGraph ? initialProject : null, resolver);
        return async () => {
            try {
                unregisterPrompt();
            }
            catch {
                // Ignore unregister errors
            }
            try {
                unregisterTools();
            }
            catch {
                // Ignore unregister errors
            }
            try {
                resolver.invalidate();
                await client.dispose();
            }
            catch {
                // Ignore disposal errors
            }
        };
    });
    ctx.inject(['commands'], (cmdCtx) => {
        cmdCtx.effect(() => {
            const unregisterCommand = registerGraphifyCommand(cmdCtx, cfg, workingDir);
            return () => {
                try {
                    unregisterCommand();
                }
                catch {
                    // Ignore
                }
            };
        });
    });
}
