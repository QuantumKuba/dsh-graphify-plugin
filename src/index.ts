import type { Context } from '@deepseek-ai/cordis'
import { Config, validateConfig } from './config.ts'
import { detectGraph } from './detector.ts'
import {
  resolveGraphifyCommand,
  resolveGraphifyCliCommand,
  resolveGraphifyRuntime,
  resolveGraphifyCliRuntime,
  getRuntimeInfo,
  DEFAULT_GRAPHIFY_VERSION,
} from './server-process.ts'
import { GraphifyMcpClient } from './client.ts'
import { registerGraphifyTools, createGraphifyToolDefinitions, getPrefixedToolName } from './tools.ts'
import { registerGraphifyPrompt, createGraphifyPromptSection } from './prompt.ts'
import { registerGraphifyCommand } from './commands.ts'
import { ProjectResolver } from './project-resolver.ts'
import { checkGraphFreshness, ProjectUpdateCoalescer } from './freshness.ts'
import { collectGraphifyStatus, formatGraphifyStatus } from './status.ts'
import { getPackageVersion } from './version.ts'

export const name = 'dsh-graphify'
export const inject = ['tools', 'systemPrompt']
export { Config, validateConfig } from './config.ts'
export * from './types.ts'
export { detectGraph } from './detector.ts'
export { GraphifyMcpClient } from './client.ts'
export {
  createGraphifyToolDefinitions,
  registerGraphifyTools,
  getPrefixedToolName,
  isPathContained,
  validateProjectPathAccess,
} from './tools.ts'
export { createGraphifyPromptSection, registerGraphifyPrompt } from './prompt.ts'
export { registerGraphifyCommand } from './commands.ts'
export {
  resolveGraphifyCommand,
  resolveGraphifyCliCommand,
  resolveGraphifyRuntime,
  resolveGraphifyCliRuntime,
  getRuntimeInfo,
  DEFAULT_GRAPHIFY_VERSION,
} from './server-process.ts'
export { ProjectResolver } from './project-resolver.ts'
export {
  checkGraphFreshness,
  ProjectUpdateCoalescer,
  writeGraphifyIndexMetadata,
  readGraphifyIndexMetadata,
  INDEX_METADATA_FILENAME,
} from './freshness.ts'
export { collectGraphifyStatus, formatGraphifyStatus } from './status.ts'
export { toLosslessJson } from './lossless-json.ts'
export { getPackageVersion } from './version.ts'

/**
 * DeepSeek Harness Graphify Plugin.
 *
 * Integrates Graphify's knowledge graph intelligence, prompt decision policy,
 * session-scoped project resolution, graph freshness monitoring, doctor status,
 * and /graphify slash commands into the DeepSeek Harness runtime.
 */
export function apply(ctx: Context, config?: Config): void {
  const cfg = Config(config ?? ({} as Config))
  validateConfig(cfg)
  const logger = typeof ctx.logger === 'function' ? ctx.logger('graphify') : undefined

  const resolver = new ProjectResolver(cfg)
  const initialProject = resolver.resolve()
  const workingDir = initialProject.projectRoot

  const client = new GraphifyMcpClient({
    resolveRuntime: () => resolveGraphifyRuntime(cfg, initialProject.graphJsonPath || undefined),
    cwd: workingDir,
    timeoutMs: cfg.timeoutMs,
    reconnect: cfg.reconnect,
    logger,
  })

  ctx.effect(() => {
    logger?.debug?.(`[dsh-graphify] Mounting plugin with toolMode: ${cfg.toolMode}, freshness: ${cfg.freshness.mode}`)

    const unregisterPrompt = cfg.enablePromptSection
      ? registerGraphifyPrompt(ctx, initialProject.hasGraph ? initialProject : null, cfg, resolver)
      : () => {}

    const unregisterTools = registerGraphifyTools(
      ctx,
      client,
      cfg,
      initialProject.hasGraph ? initialProject : null,
      resolver
    )

    return async () => {
      try {
        unregisterPrompt()
      } catch {
        // Ignore unregister errors
      }
      try {
        unregisterTools()
      } catch {
        // Ignore unregister errors
      }
      try {
        resolver.invalidate()
        await client.dispose()
      } catch {
        // Ignore disposal errors
      }
    }
  })

  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.effect(() => {
      const unregisterCommand = registerGraphifyCommand(cmdCtx, cfg, workingDir)
      return () => {
        try {
          unregisterCommand()
        } catch {
          // Ignore
        }
      }
    })
  })
}
