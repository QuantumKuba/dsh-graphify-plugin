import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.ts'
import { detectGraph } from './detector.ts'
import { resolveGraphifyCommand, resolveGraphifyCliCommand } from './server-process.ts'
import { GraphifyMcpClient } from './client.ts'
import { registerGraphifyTools } from './tools.ts'
import { registerGraphifyPrompt } from './prompt.ts'
import { registerGraphifyCommand } from './commands.ts'

export const name = 'dsh-graphify'
export const inject = ['tools', 'systemPrompt']
export { Config } from './config.ts'
export * from './types.ts'
export { detectGraph } from './detector.ts'
export { GraphifyMcpClient } from './client.ts'
export { createGraphifyToolDefinitions, registerGraphifyTools } from './tools.ts'
export { createGraphifyPromptSection, registerGraphifyPrompt } from './prompt.ts'
export { registerGraphifyCommand } from './commands.ts'
export { resolveGraphifyCommand, resolveGraphifyCliCommand } from './server-process.ts'

/**
 * DeepSeek Harness Graphify Plugin.
 *
 * Integrates Graphify's knowledge graph analysis tools, prompt guidance,
 * and /graphify slash commands into the DeepSeek Harness runtime.
 */
export function apply(ctx: Context, config?: Config): void {
  const cfg = Config(config ?? ({} as Config))
  const configuredRoot = cfg.cwd || process.cwd()

  const detectedGraph = cfg.autoDetect
    ? detectGraph(configuredRoot, cfg.graphPath)
    : cfg.graphPath
      ? detectGraph(configuredRoot, cfg.graphPath)
      : null

  const workingDir = detectedGraph?.projectRoot || configuredRoot
  const { command, args } = resolveGraphifyCommand(cfg, detectedGraph?.graphJsonPath)

  const client = new GraphifyMcpClient({
    command,
    args,
    cwd: workingDir,
    timeoutMs: cfg.timeoutMs,
  })

  ctx.effect(() => {
    const unregisterPrompt = cfg.enablePromptSection
      ? registerGraphifyPrompt(ctx, detectedGraph)
      : () => {}

    const unregisterTools = registerGraphifyTools(ctx, client, cfg, detectedGraph)

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
        await client.dispose()
      } catch {
        // Ignore client disposal error
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
