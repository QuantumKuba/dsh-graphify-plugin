import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.ts'
import { detectGraph } from './detector.ts'
import { resolveGraphifyCommand } from './server-process.ts'
import { GraphifyMcpClient } from './client.ts'
import { registerGraphifyTools } from './tools.ts'
import { registerGraphifyPrompt } from './prompt.ts'
import { registerGraphifyCommand } from './commands.ts'

export const name = 'graphify'
export const inject = ['tools', 'systemPrompt']
export { Config } from './config.ts'
export * from './types.ts'
export { detectGraph } from './detector.ts'
export { GraphifyMcpClient } from './client.ts'
export { createGraphifyToolDefinitions, registerGraphifyTools } from './tools.ts'
export { createGraphifyPromptSection, registerGraphifyPrompt } from './prompt.ts'
export { registerGraphifyCommand } from './commands.ts'

/**
 * DeepSeek Harness Graphify Plugin.
 *
 * Integrates Graphify's knowledge graph analysis tools, prompt guidance,
 * and /graphify slash commands into the DeepSeek Harness runtime.
 */
export function apply(ctx: Context, config?: Config): void {
  const cfg = Config(config ?? ({} as Config))

  // 1. Detect existing graph in workspace or configured path
  const detectedGraph = cfg.autoDetect
    ? detectGraph(cfg.cwd || process.cwd(), cfg.graphPath)
    : cfg.graphPath
      ? detectGraph(process.cwd(), cfg.graphPath)
      : null

  // 2. Resolve Graphify execution command
  const workingDir = cfg.cwd || detectedGraph?.projectRoot || process.cwd()
  const { command, args } = resolveGraphifyCommand(cfg, detectedGraph?.graphJsonPath, workingDir)

  // 3. Create MCP Client
  const client = new GraphifyMcpClient({
    command,
    args,
    cwd: workingDir,
    timeoutMs: cfg.timeoutMs,
  })

  // 4. Attach reversible Cordis effect managing tool/prompt registrations and process lifecycle
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

  // 5. Optionally register /graphify slash command when ctx.commands is composed
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.effect(() => {
      const unregisterCommand = registerGraphifyCommand(cmdCtx, cfg, detectedGraph)
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
