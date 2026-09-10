# dsh-graphify

`dsh-graphify` is the native [Graphify](https://github.com/Graphify-Labs/graphify) knowledge graph plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It equips coding agents—especially local 20B–30B models—with structural code intelligence: architecture queries, dependency paths, community clustering, god node detection, and pull-request blast radius analysis.

Built on the official `@modelcontextprotocol/sdk` stdio transport, `dsh-graphify` integrates natively into Cordis lifecycle management, handles multi-workspace session project resolution, offers automatic graph freshness tracking, and provides a built-in diagnostic doctor tool (`graphify_status`).

---

## Key Features

- **MCP Transport via `@modelcontextprotocol/sdk`**: Replaces ad-hoc JSON-RPC with the official SDK client and stdio transport. Features generation tracking against zombie processes, bounded exponential backoff reconnection, stderr ring-buffer captures (50 lines / 64 KB), and cooperative `AbortSignal` cancellation.
- **DeepSeek Harness & Cordis Native**: Compatible with newest DeepSeek Harness releases (`dsh-session >=0.1.1-rc.2` through `0.1.5-alpha.2` / `0.1.2-rc.1`, Cordis `^4.0.1` / `4.0.2`). Native lifecycle hooks (`ctx.effect()`), session-scoped context resolution, and durable Web UI companion cards.
- **Optimized for 20B–30B Local LLMs**: Offers `toolMode: 'compact'` exposing 6 high-signal tools with curated descriptions and schema-constrained parameters to eliminate hallucinated tool choices and preserve context window budget.
- **Session-Scoped Multi-Workspace Resolution**: Resolves project paths dynamically from DSH session context (`toolContext.agent.session.header.cwd`), ancestor graph detection, or configured overrides—enabling a single DSH instance to serve multiple workspaces safely.
- **Graph Freshness & Concurrency-Safe Updates**: Git- and mtime-based graph staleness detection with configurable warning (`freshness: 'warn'`) or automatic deduplicated background updating (`freshness: 'auto'`) via `ProjectUpdateCoalescer`.
- **Diagnostic Doctor Tool (`graphify_status`)**: Self-healing environment inspection for models and developers, reporting Python/uv runtime paths, connection states, project mtimes, staleness metrics, and actionable remediation steps.
- **Decision Policy Prompting**: Injects high-agency navigation rules into the agent loop, teaching models when to use Graphify vs. grep/filesystem tools, and enforcing the authoritative verification loop (Graphify -> source files -> editor -> tests -> update).

---

## Installation

### 1. Install Graphify

Install Graphify with its MCP extra (required for `python -m graphify.serve`):

```sh
uv tool install 'graphifyy[mcp]'
```

Build the initial knowledge graph in your repository:

```sh
graphify .
```

### 2. Add Plugin to DeepSeek Harness

Install the plugin into your DSH environment:

```sh
pnpm add dsh-graphify
```

Add the plugin to your DSH configuration or profile patch (e.g. `cordis.patch.yml` or `cordis.yml`):

```yaml
- insert:
    - id: dsh-graphify
      name: dsh-graphify
      config:
        toolMode: compact       # Recommended for 20B-30B models (compact | full)
        freshness: warn         # Freshness monitoring (warn | auto | off)
        autoDetect: true        # Walk parent directories to locate graphify-out/
```

---

## Tool Modes & Agent Guidance

Small and medium coding models (e.g. 20B–30B class) often suffer when 14+ specialized tools dilute attention and waste context tokens. `dsh-graphify` provides two tool modes:

### Compact Mode (`toolMode: 'compact'`) — *Recommended for local LLMs*

Registers the 6 essential tools that handle 95% of agent code navigation:

| Tool | Purpose |
| --- | --- |
| `graphify_status` | Doctor tool checking graph freshness, runtime status, and project path. |
| `query_graph` | BFS/DFS traversal over the knowledge graph around an entry node or query. |
| `get_node` | Deep inspection of a specific symbol (AST type, file location, docstring, community). |
| `get_neighbors` | Inspection of direct dependencies and dependents connected to a node. |
| `god_nodes` | Identification of central architectural hubs and high-degree modules. |
| `shortest_path` | Exploration of dependency connection chains between two symbols. |

### Full Mode (`toolMode: 'full'`) — *Default for backwards compatibility*

Includes all 6 compact tools plus 8 specialized tools:
- Community clustering: `get_community`, `graph_stats`
- PR blast radius & triage: `list_prs`, `get_pr_impact`, `triage_prs`
- Extensibility: `graphify_capabilities`, `graphify_call`, `graphify_resource`

---

## Doctor Tool: `graphify_status`

The `graphify_status` tool is exposed to both human operators and the model to verify environment health and troubleshoot graph issues:

```text
=== Graphify Status ===
Runtime:
  Command: /usr/local/bin/graphify-mcp (standalone-mcp)
  Version: 0.9.57
  Transport: Connected (pid: 48120, generation: 1)
Project:
  Project Path: /workspace/my-repo
  Graph Path: /workspace/my-repo/graphify-out/graph.json (exists: true)
  Last Built: 2026-09-10T00:15:30.000Z
  Active Tool Mode: compact (6 tools registered)
Freshness:
  Status: fresh
=======================
```

When issues are detected (e.g., missing runtime, missing graph, or stale files), `graphify_status` provides explicit remediation warnings guiding the agent to run `/graphify` or update the graph.

---

## Graph Freshness & Auto-Updates

Out-of-date graphs cause agents to hallucinate non-existent symbols or miss refactored dependencies. `dsh-graphify` tracks graph freshness via git commit timestamps and file modification times:

- **`freshness: 'warn'` (Default)**: Injects an actionable warning into tool responses when git commits or file modifications occurred after the graph was last built.
- **`freshness: 'auto'`**: Automatically triggers a background incremental graph update via `ProjectUpdateCoalescer` when staleness is detected. Simultaneous requests across multiple agents are deduplicated to prevent lock contention.
- **`freshness: 'off'`**: Disables freshness evaluation for airgapped or static environments.

---

## Slash Command (`/graphify`)

In interactive DSH adapters supporting `ctx.commands`, `/graphify` provides direct human control to build or update graphs. In DSH Web, durable result cards are displayed and persist across reloads from session events.

```text
/graphify                         # build the receiving session’s project
/graphify build ../another-repo   # build a specific path
/graphify update                  # incrementally rebuild modified files
/graphify update . --force        # force full graph re-indexing
/graphify update . --code-only    # AST-only indexing without LLM credits
/graphify update . --no-viz       # suppress HTML visualization generation
```

---

## Runtime Configuration Reference

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `toolMode` | `'compact' \| 'full'` | `'full'` | Expose 6 core tools (`compact`) or all 14 tools (`full`). |
| `freshness` | `'warn' \| 'auto' \| 'off'` | `'warn'` | Staleness policy: warn model, auto-update in background, or disable. |
| `command` | `string` | `'auto'` | MCP server executable or `'auto'` for automatic discovery. |
| `args` | `string[]` | `[]` | Extra arguments for custom server executables. |
| `graphifyVersion` | `string` | unset | Target version for `uv` fallback (e.g. `'0.9.57'`). |
| `cliCommand` | `string` | unset | Executable for `/graphify` command; defaults to auto-discovered `graphify`. |
| `cliArgs` | `string[]` | `[]` | Extra arguments preceding build/update operations. |
| `graphPath` | `string` | unset | Explicit path to `graphify-out/graph.json`. |
| `cwd` | `string` | unset | Fixed fallback project directory when session cwd is absent. |
| `autoDetect` | `boolean` | `true` | Walk parent directories searching for `graphify-out/graph.json`. |
| `enablePromptSection` | `boolean` | `true` | Inject decision policy and navigation rules into agent system prompt. |
| `timeoutMs` | `number` | `60000` | Per-MCP-operation timeout in milliseconds. |
| `toolPrefix` | `string` | `''` | Prefix applied to all registered tool names (e.g. `graphify_`). |
| `reconnect.maxRetries` | `number` | `3` | Maximum automatic reconnect attempts on unexpected process exits. |
| `reconnect.initialDelayMs`| `number` | `500` | Initial exponential backoff delay for reconnection. |
| `reconnect.maxDelayMs` | `number` | `5000` | Maximum exponential backoff delay for reconnection. |

---

## DeepSeek Harness Compatibility

`dsh-graphify` maintains strict compatibility with DeepSeek Harness releases:

- **Cordis Microkernel**: Compatible with `@deepseek-ai/cordis` `^4.0.1` and `4.0.2` (`>=4.0.0`).
- **DSH Session & Core**: Fully compatible with `@deepseek-ai/dsh-session` `0.1.1-rc.2` through `0.1.5-alpha.2` and `0.1.2-rc.1`.
- **Continuous Integration**: Tested via scheduled GitHub Actions workflows against upstream DSH master and latest Graphify releases.
- **Contract Drift Detection**: Automated schema drift tests (`pnpm run test:drift`) prevent breaking changes between Graphify MCP schemas and plugin definitions.

---

## Development & Testing

```sh
# Typecheck TypeScript source
pnpm run typecheck

# Build bundle and type definitions (tsc + tsdown)
pnpm run build

# Run unit and integration test suite
pnpm test

# Run schema drift detection against Graphify contracts
pnpm run test:drift

# Run end-to-end test against a live Graphify installation
GRAPHIFY_E2E=1 pnpm run test:e2e
```

---

## Benchmarking

A comprehensive benchmarking specification comparing DeepSeek Harness agents with and without Graphify across 8 task categories and 12 quantitative metrics is documented in [BENCHMARK.md](BENCHMARK.md).
