import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

describe('Packed Package Clean-Machine Installation (Part I & J)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clean-pack-'))
  const tarballPath = path.join(tempDir, 'dsh-graphify-0.2.0.tgz')

  it('packs cleanly, installs in isolated environment, and validates all scenarios', async () => {
    // 1. Build and pack the repository
    execSync('pnpm run build', { cwd: repoRoot, stdio: 'pipe' })
    execSync(`pnpm pack --pack-destination "${tempDir}"`, { cwd: repoRoot, stdio: 'pipe' })
    assert.ok(fs.existsSync(tarballPath), `Tarball must exist at ${tarballPath}`)

    // 2. Set up a clean consumer project in a separate isolated directory
    const consumerDir = path.join(tempDir, 'consumer-app')
    fs.mkdirSync(consumerDir, { recursive: true })
    fs.writeFileSync(
      path.join(consumerDir, 'package.json'),
      JSON.stringify(
        {
          name: 'clean-consumer-test',
          type: 'module',
          dependencies: {
            '@deepseek-ai/cordis': '^4.0.1',
          },
        },
        null,
        2
      )
    )

    // Install packed tarball
    execSync(`pnpm add "${tarballPath}"`, { cwd: consumerDir, stdio: 'pipe' })

    // 3. Verify installed package structure
    const installedPkgDir = path.join(consumerDir, 'node_modules', 'dsh-graphify')
    assert.ok(fs.existsSync(path.join(installedPkgDir, 'package.json')), 'package.json exists')
    assert.ok(fs.existsSync(path.join(installedPkgDir, 'cordis.patch.yml')), 'cordis.patch.yml exists')
    assert.ok(fs.existsSync(path.join(installedPkgDir, 'lib', 'index.js')), 'lib/index.js exists')
    assert.ok(fs.existsSync(path.join(installedPkgDir, 'lib', 'graphify-client.js')), 'lib/graphify-client.js exists')
    assert.ok(fs.existsSync(path.join(installedPkgDir, 'lib', 'types', 'index.d.ts')), 'lib/types/index.d.ts exists')
    assert.ok(fs.existsSync(path.join(installedPkgDir, 'lib', 'types', 'web-client.d.ts')), 'lib/types/web-client.d.ts exists')

    // 4. Import the installed module from the packed tarball (NOT repository source)
    const hostModule = (await import(path.join(installedPkgDir, 'lib', 'index.js'))) as typeof import('../src/index.ts')
    assert.equal(typeof hostModule.apply, 'function')
    assert.equal(typeof hostModule.Config, 'function')
    assert.equal(typeof hostModule.validateConfig, 'function')
    assert.equal(hostModule.DEFAULT_GRAPHIFY_VERSION, '0.9.57')

    // Verify browser client bundle can be read
    const clientBundle = fs.readFileSync(path.join(installedPkgDir, 'lib', 'graphify-client.js'), 'utf8')
    assert.match(clientBundle, /window\.__ModuleLoader__\.load\(\{\s*id:\s*"dsh-graphify"/)

    // 5. Scenario 1: Graphify unavailable (no graphify, no uv on PATH)
    {
      const origPath = process.env.PATH
      const emptyBin = path.join(tempDir, 'empty-bin')
      fs.mkdirSync(emptyBin, { recursive: true })
      let fiber: any
      try {
        process.env.PATH = emptyBin
        const ctx = new Context()
        const registeredTools = new Map<string, any>()
        const registeredCmds = new Map<string, any>()
        ctx.provide('tools')
        ctx.tools = { register: (t: any) => { registeredTools.set(t.name, t); return () => {} } }
        ctx.provide('systemPrompt')
        ctx.systemPrompt = { section: () => () => {} }
        ctx.provide('commands')
        ctx.commands = { register: (c: any) => { registeredCmds.set(c.name, c); return () => {} } }

        fiber = await ctx.plugin(hostModule, { command: 'auto', cwd: consumerDir } as any)

        const statusTool = registeredTools.get('graphify_status')!
        const statusRes = await statusTool.execute({}, {
          signal: new AbortController().signal,
          agent: { session: { header: { cwd: consumerDir } } },
        })
        assert.equal(statusRes.overall, 'unavailable')
        assert.match(statusRes.text, /Graphify Status: UNAVAILABLE/)

        const queryTool = registeredTools.get('query_graph')!
        const queryRes = await queryTool.execute({ question: 'hello' }, {
          signal: new AbortController().signal,
          agent: { session: { header: { cwd: consumerDir } } },
        })
        assert.equal(queryRes.isError, true)
        assert.match(queryRes.text, /Graphify is unavailable/i)

        const graphifyCmd = registeredCmds.get('graphify')!
        const cmdRes = await graphifyCmd.handler({
          rawInput: 'build .',
          signal: new AbortController().signal,
          agent: { session: { header: { cwd: consumerDir } } },
        })
        assert.equal(cmdRes.kind, 'error')
        assert.match(cmdRes.text, /Graphify is not installed/i)
      } finally {
        if (fiber) await fiber.dispose()
        process.env.PATH = origPath
      }
    }

    // 6. Scenario 3: Graph missing initially, then built or provided
    {
      const ctx = new Context()
      const registeredTools = new Map<string, any>()
      ctx.provide('tools')
      ctx.tools = { register: (t: any) => { registeredTools.set(t.name, t); return () => {} } }
      ctx.provide('systemPrompt')
      ctx.systemPrompt = { section: () => () => {} }
      ctx.provide('commands')
      ctx.commands = { register: () => () => {} }

      const fakeServer = path.join(repoRoot, 'test', 'fixtures', 'fake-mcp-server.mjs')
      let fiber: any
      try {
        fiber = await ctx.plugin(hostModule, {
          command: process.execPath,
          args: [fakeServer],
          cwd: consumerDir,
        } as any)

        const statusTool = registeredTools.get('graphify_status')!
        const missingStatus = await statusTool.execute({}, {
          signal: new AbortController().signal,
          agent: { session: { header: { cwd: consumerDir } } },
        })
        assert.equal(missingStatus.overall, 'missing')
        assert.match(missingStatus.text, /Knowledge Graph: MISSING/)
      } finally {
        if (fiber) await fiber.dispose()
      }
    }

    // 7. Scenario 4: Multiple workspaces isolation
    {
      const projA = path.join(tempDir, 'projA')
      const projB = path.join(tempDir, 'projB')
      fs.mkdirSync(path.join(projA, 'graphify-out'), { recursive: true })
      fs.mkdirSync(path.join(projB, 'graphify-out'), { recursive: true })

      fs.writeFileSync(path.join(projA, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [{ id: 'A' }] }))
      fs.writeFileSync(path.join(projB, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [{ id: 'B1' }, { id: 'B2' }] }))
      fs.writeFileSync(path.join(projA, 'graphify-out', 'GRAPH_REPORT.md'), '# Report A')
      fs.writeFileSync(path.join(projB, 'graphify-out', 'GRAPH_REPORT.md'), '# Report B')

      const fakeServer = path.join(repoRoot, 'test', 'fixtures', 'fake-mcp-server.mjs')
      const client = new hostModule.GraphifyMcpClient({
        command: process.execPath,
        args: [fakeServer],
        cwd: projA,
      })

      const config = hostModule.Config({ allowExternalProjects: false })
      const tools = hostModule.createGraphifyToolDefinitions(client, config)
      const resourceTool = tools.find((t) => t.name === 'graphify_project_resource')!

      // Session A reading from projA
      const resA = await resourceTool.execute({ resource: 'report' }, {
        signal: new AbortController().signal,
        agent: { session: { header: { cwd: projA } } },
      })
      assert.match((resA as { text: string }).text, /Report A/)

      // Session B reading from projB
      const resB = await resourceTool.execute({ resource: 'report' }, {
        signal: new AbortController().signal,
        agent: { session: { header: { cwd: projB } } },
      })
      assert.match((resB as { text: string }).text, /Report B/)

      // Session A trying to read projB with allowExternalProjects=false is rejected
      const resCross = await resourceTool.execute({ resource: 'report', project_path: projB }, {
        signal: new AbortController().signal,
        agent: { session: { header: { cwd: projA } } },
      })
      assert.equal((resCross as { isError: boolean }).isError, true)
      assert.match((resCross as { text: string }).text, /Access to external project path .* is blocked/)

      await client.dispose()
    }
  })
})
