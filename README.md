# dsh-graphify

[![CI Status](https://github.com/QuantumKuba/dsh-graphify-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/QuantumKuba/dsh-graphify-plugin/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-graphify.svg)](https://www.npmjs.com/package/dsh-graphify)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Cordis](https://img.shields.io/badge/Cordis-v4-orange.svg)](https://cordis.moe)

Native [Graphify](https://github.com/deepseek-ai/graphify) Knowledge Graph Plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

This plugin connects DeepSeek Harness to Graphify's code intelligence engine, exposing **10 native code intelligence tools**, **god nodes discovery**, **community clustering**, **dependency traversal**, and **PR impact triage** directly to the agent loop.

---

## Why dsh-graphify?

Standard coding agents often waste context tokens and compute running linear, unindexed grep sweeps across repositories. `dsh-graphify` gives the agent topological awareness of your codebase:

- **Architectural Hubs**: Instantly identify god nodes and core abstractions.
- **Topological Search**: Perform BFS/DFS traversals over code relationships rather than blind keyword search.
- **Blast Radius Analysis**: Assess PR impact across code communities before applying changes.
- **Zero Configuration**: Auto-detects existing `graphify-out/graph.json` in your workspace.

---

## Architecture

```
                                  +------------------------+
                                  | DeepSeek Harness (DSH) |
                                  +-----------+------------+
                                              |
                                      apply(ctx, config)
                                              |
                     +------------------------+------------------------+
                     |                                                 |
             ctx.systemPrompt                                      ctx.tools
                     |                                                 |
         [graphify:guidance prompt]                          [10 Graphify Tools]
                     |                                                 |
                     v                                         execute(args, exec)
          Agent Context Injected                                       |
                                                           +-----------v------------+
                                                           |   GraphifyMcpClient    |
                                                           +-----------+------------+
                                                                       |
                                                               JSON-RPC 2.0 (stdio)
                                                                       |
                                                           +-----------v------------+
                                                           |  Graphify MCP Server   |
                                                           |  (python -m graphify)  |
                                                           +-----------+------------+
                                                                       |
                                                           +-----------v------------+
                                                           | graphify-out/graph.json|
                                                           +------------------------+
```

---

## Setup Tutorial: Getting Started

Follow these steps to set up Graphify and integrate it into your DeepSeek Harness environment.

### Prerequisites

- **Node.js**: `^20.0.0` or `>=22.0.0`
- **pnpm**: `^9.0.0`
- **Python**: `>=3.10` with [`uv`](https://docs.astral.sh/uv/) installed (recommended)

---

### Step 1: Install the Graphify CLI

Graphify powers the background MCP server and knowledge graph generator. Install it using `uv` or `pip`:

```sh
# Recommended: Install via uv tool
uv tool install graphifyy

# Alternative: Install via pip
pip install graphifyy
```

Verify that Graphify is available:

```sh
uv run --with graphifyy graphify --help
```

---

### Step 2: Generate the Knowledge Graph for Your Workspace

Navigate to your target project directory and run the Graphify indexer:

```sh
cd /path/to/your/project
graphify .
```

This generates a `graphify-out/` folder containing:
- `graphify-out/graph.json` — The serialized knowledge graph.
- `graphify-out/GRAPH_REPORT.md` — Architectural overview and god nodes report.
- `graphify-out/graph.html` — Interactive visual graph explorer.

*(Note: You do not need to manually start the MCP server. Once `graphify-out/graph.json` exists, DeepSeek Harness automatically launches and connects to the background Graphify MCP server over stdio).*

---

### Step 3: Install `dsh-graphify` in Your DSH Project

Add `dsh-graphify` to your DeepSeek Harness repository or workspace:

```sh
pnpm add dsh-graphify
```

---

### Step 4: Enable the Plugin in Configuration

#### Option A: Bundle Patch (`cordis.patch.yml`)
If you use DSH bundle layers, add the plugin patch:

```yaml
- insert:
    - id: graphify
      name: dsh-graphify
      config:
        autoDetect: true
        enablePromptSection: true
        timeoutMs: 60000
```

#### Option B: Application Config (`cordis.yml`)
If you configure plugins in your profile `cordis.yml`:

```yaml
plugins:
  dsh-graphify:
    autoDetect: true
    enablePromptSection: true
    timeoutMs: 60000
```

#### Option C: Programmatic Mounting
In a custom Cordis runtime application:

```typescript
import { Context } from '@deepseek-ai/cordis'
import * as GraphifyPlugin from 'dsh-graphify'

const ctx = new Context()
await ctx.plugin(GraphifyPlugin, {
  autoDetect: true,
  enablePromptSection: true,
})
```

---

### Step 5: Launch DSH and Verify

Start your DeepSeek Harness session:

```sh
pnpm dsh --profile headless "Analyze the architecture and core hub nodes of this project"
```

The model will automatically receive guidance via `graphify:guidance` and query the graph using `god_nodes` or `query_graph`.

---

## Functionality Overview

### 1. Implemented MCP Tools (10 Native Tools)

All 10 tools are registered to `ctx.tools` with JSON schemas and support cooperative `AbortSignal` cancellation:

| Tool | Purpose | Key Parameters |
| :--- | :--- | :--- |
| `query_graph` | BFS or DFS traversal over code nodes and relational edges | `question` *(required)*, `mode` (`'bfs'`/`'dfs'`), `depth` (1-6), `token_budget`, `project_path` |
| `get_node` | Retrieve full node details, signatures, docstrings, and attributes | `label` *(required)*, `project_path` |
| `get_neighbors` | Retrieve immediate neighbors with edge types and relational metadata | `label` *(required)*, `relation_filter`, `token_budget`, `project_path` |
| `get_community` | Inspect all symbols and files within a modular community cluster | `community_id` *(required)*, `token_budget`, `project_path` |
| `god_nodes` | Identify the highest-degree architectural hub nodes in the graph | `top_n` (default: 10), `project_path` |
| `graph_stats` | Summary statistics (node count, edge count, density, confidence) | `project_path` |
| `shortest_path` | Find the shortest dependency or call path between two concepts | `source` *(required)*, `target` *(required)*, `max_hops`, `undirected`, `project_path` |
| `list_prs` | List open GitHub PRs with CI status and community blast radius | `base`, `repo`, `project_path` |
| `get_pr_impact` | Detailed blast radius of a pull request against graph communities | `pr_number` *(required)*, `repo`, `project_path` |
| `triage_prs` | Prioritize open pull requests based on conflict risk and impact | `base`, `repo`, `project_path` |

---

### 2. Workspace Auto-Detection

The `detectGraph()` engine traverses ancestor directories starting at `process.cwd()` to find:
- `<dir>/graphify-out/graph.json`
- `<dir>/.graphify_root`

When detected, the plugin automatically configures the working directory and injects links to `GRAPH_REPORT.md` and wiki documentation.

---

### 3. Subprocess Lifecycle & Standalone MCP Server

#### Automatic Lifecycle (Default)
When DeepSeek Harness boots with `dsh-graphify`, **you do not need to manually start or maintain a separate MCP server process**. The plugin automatically spawns and supervises the server child process over `stdio`:
- **Executable Resolution**: Auto-detects `uv`, virtual environments, or system `python3`.
- **Environment Scrubbing**: Redacts sensitive API keys and tokens from the child environment.
- **Cooperative Cancellation**: Connects DSH `AbortSignal` tokens to MCP `notifications/cancelled`.
- **Graceful Quiescence**: Shuts down cleanly via `SIGTERM` with an automated `SIGKILL` timeout fallback on plugin disposal.

#### Running the MCP Server Standalone (Manual / Debugging)
If you wish to test the Graphify MCP server independently, inspect JSON-RPC communication directly, or connect it to another MCP client (such as Claude Desktop, Cursor, or Antigravity IDE), you can start it manually with:

```sh
# Recommended: Run via uv (automatically resolves dependencies)
uv run --with graphifyy --with mcp -m graphify.serve graphify-out/graph.json

# Alternative: Run with python3
python3 -m graphify.serve graphify-out/graph.json

# Alternative: Run via the graphify CLI
graphify serve --graph graphify-out/graph.json
```

---

### 4. Dynamic System Prompt Section

Registers `graphify:guidance` on `ctx.systemPrompt`, instructing the model on:
- Prioritizing graph queries before expensive multi-file grep sweeps.
- When to choose BFS (`query_graph`) vs. hub discovery (`god_nodes`) vs. path tracing (`shortest_path`).
- Paths to generated architectural reports and wiki indexes.

---

### 5. Slash Command (`/graphify`)

Registers a `/graphify [path]` slash command on `ctx.commands` (when available in DSH), allowing users to trigger knowledge graph generation or re-indexing directly from the chat interface.

---

### 6. Cordis Microkernel & Effect Lifecycle

All tool registrations, prompt sections, slash commands, and child processes are bound via `ctx.effect()`. Disposing the plugin or triggering Hot Module Reloading (HMR) cleanly terminates the subprocess and unregisters all tools with zero memory or process leaks.

---

## Configuration Reference

Options can be defined in `cordis.yml`, `cordis.patch.yml`, or passed to `ctx.plugin()`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `command` | `string` | `'graphify'` | CLI executable command (auto-resolves `uv` or `python3 -m graphify.serve`). |
| `args` | `string[]` | `['serve', '--transport', 'stdio']` | Subprocess arguments for the Graphify MCP server. |
| `graphPath` | `string` | `undefined` | Explicit path to `graph.json` (bypasses auto-detection when set). |
| `autoDetect` | `boolean` | `true` | Probes parent directories for `graphify-out/graph.json`. |
| `enablePromptSection` | `boolean` | `true` | Injects knowledge graph guidance into the agent system prompt. |
| `timeoutMs` | `number` | `60000` | Cooperative timeout per tool execution in milliseconds. |
| `serverName` | `string` | `'graphify'` | Stable identifier used for server registration and logs. |
| `toolPrefix` | `string` | `''` | Optional prefix for registered tools (e.g. `'kg_'` -> `'kg_query_graph'`). |
| `cwd` | `string` | `undefined` | Working directory for the Graphify subprocess. |

---

## Roadmap & Remaining TODOs

The following features and enhancements are planned for upcoming releases:

- [ ] **Live Incremental Graph Updates**:
  - Integrate a filesystem watcher (`chokidar` / FS events) to trigger incremental graph re-indexing upon source file edits.
- [ ] **DSH Web UI Visual Graph Cards**:
  - Implement Web card presentation renderers to display interactive D3 / ForceGraph visual graphs directly inside the DSH Web client.
- [ ] **Hybrid Semantic + Topological Search**:
  - Combine vector embeddings with graph topology for dual lexical and structural retrieval.
- [ ] **Remote / SSE MCP Server Transport**:
  - Support connecting to remote Graphify MCP servers over Server-Sent Events (SSE) and WebSockets in addition to local `stdio`.
- [ ] **Streaming Output for Large Traversals**:
  - Add streaming token generation for large sub-graph dumps and community cluster exports.
- [ ] **Dedicated PR Review Autonomous Agent Preset**:
  - Create a `@deepseek-ai/dsh-bundle-pr-review` preset layer that autonomously triages PRs and checks community blast radius before merging.

---

## Programmatic Usage

You can also use the underlying `GraphifyMcpClient` or `detectGraph` utilities independently:

```typescript
import { GraphifyMcpClient, detectGraph } from 'dsh-graphify'

// 1. Detect existing graph
const detected = detectGraph(process.cwd())
console.log('Detected graph:', detected?.graphJsonPath)

// 2. Initialize MCP client
const client = new GraphifyMcpClient({
  command: 'uv',
  args: ['run', '--with', 'graphifyy', '--with', 'mcp', '-m', 'graphify.serve', detected?.graphJsonPath || ''],
  cwd: process.cwd(),
})

// 3. Execute queries
const stats = await client.callTool('graph_stats', {})
console.log(stats)

// 4. Dispose client when done
await client.dispose()
```

---

## Troubleshooting

### `uv: command not found` or Python errors
- Ensure `uv` or `python3` (>=3.10) is installed and available on your system `$PATH`.
- You can specify an explicit executable path in configuration via `command: '/path/to/python'`.

### `No graph detected in workspace`
- Run `graphify .` in your workspace root to generate `graphify-out/graph.json`.
- Alternatively, set `graphPath: '/absolute/path/to/graph.json'` in your plugin configuration.

### Tool Execution Timeouts
- For massive monorepos, graph queries might take longer. Increase `timeoutMs` in your config (e.g. `timeoutMs: 120000`).

---

## Development & Testing

```sh
# Install dependencies
pnpm install

# Compile TypeScript to lib/ and lib/types/
pnpm run build

# Validate static types
pnpm run typecheck

# Run test suite
pnpm test

# Clean build artifacts
pnpm run clean
```

---

## License

[MIT](LICENSE) © DeepSeek
