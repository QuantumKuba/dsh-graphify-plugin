# dsh-graphify

> **Architecture Overview**: `dsh-graphify` is the DeepSeek Harness plugin integration. [Graphify](https://github.com/Graphify-Labs/graphify) is the external local knowledge-graph runtime.
>
> Installing `dsh-graphify` equips coding agents—especially local 20B–30B models—with structural code intelligence: architecture queries, dependency paths, community clustering, god node detection, and pull-request blast radius analysis.

Built on the official `@modelcontextprotocol/sdk` stdio transport, `dsh-graphify` integrates natively into Cordis lifecycle management, handles multi-workspace session project resolution, offers automatic graph freshness tracking, and provides a built-in diagnostic doctor tool (`graphify_status`).

---

## Supported Environments

- **Operating Systems**: Tested and verified on **macOS** and **Linux** (Ubuntu 22.04 / 24.04). Windows is experimental / unverified.
- **Node.js**: `^22.19 || >=24` (tested on Node 22.x and 24.x).
- **DeepSeek Harness**: Tested with DSH session baseline (`>=0.1.1-rc.2`), `@next`, and `@alpha` channels.
- **Cordis**: `@deepseek-ai/cordis` `>=4.0.0 <5`.
- **Default Graphify Runtime**: Tested against Graphify `0.9.57` (`graphifyy[mcp]==0.9.57`).

---

## Installation & First-Run Guide

### 1. Install Plugin

Install the official published package through DeepSeek Harness's plugin marketplace or package manager:

```sh
dsh plugin --profile <profile> add dsh-graphify
```

or via pnpm:

```sh
pnpm add dsh-graphify
```

> [!NOTE]
> **Official Distribution**: The official supported installation method is the published npm / DSH marketplace package (`dsh-graphify`).

### 2. Install Graphify Runtime

Graphify is an external local Python runtime dependency. We recommend installing the tested version pinned for v0.2.0 via `uv`:

```sh
uv tool install 'graphifyy[mcp]==0.9.57'
```

### 3. Graceful Degraded Startup & Dynamic Rediscovery

If Graphify or `uv` is not installed yet, **the plugin still boots safely and never bricks your DSH profile**.
- `graphify_status` reports `UNAVAILABLE` and prints exact copy-paste installation instructions.
- Once you install Graphify, **you do not need to restart DSH**: `dsh-graphify` dynamically rediscovers the newly installed runtime on the next status check or tool invocation!

### 4. First Project Quickstart

1. Open DeepSeek Harness in your repository:
   ```sh
   cd /path/to/my-repo
   dsh
   ```
2. Build the initial knowledge graph using the slash command:
   ```text
   /graphify
   ```
3. Verify status:
   ```text
   graphify_status
   ```
4. Ask your agent questions:
   ```text
   "What are the main entry points and god nodes in this repository?"
   ```

---

## Configuration

Add the plugin to your DSH configuration or profile patch (e.g. `cordis.patch.yml` or `cordis.yml`):

```yaml
- insert:
    - id: dsh-graphify
      name: dsh-graphify
      config:
        toolMode: full          # 'full' (default, 15 tools) | 'compact' (recommended for local 20B-30B models, 6 tools)
        freshness:
          mode: warn            # Freshness monitoring: warn (default) | auto | off
          updateTimeoutMs: 120000
        autoDetect: true        # Walk parent directories to locate graphify-out/
        allowExternalProjects: false # Default false: restrict model tool calls to active session workspace
```

---

## Tool Modes & Agent Guidance

Small and medium coding models (e.g. 20B–30B class) often suffer when 15+ specialized tools dilute attention and waste context tokens. `dsh-graphify` provides two tool modes:

### Compact Mode (`toolMode: 'compact'`) — *Recommended for local LLMs*

Registers the 6 essential tools that handle 95% of agent code navigation:

| Tool | Purpose |
| --- | --- |
| `graphify_status` | Doctor tool checking graph freshness, runtime status, baseline availability, and project path. |
| `query_graph` | BFS/DFS traversal over the knowledge graph around an entry node or query. |
| `get_node` | Deep inspection of a specific symbol (AST type, file location, docstring, community). |
| `get_neighbors` | Inspection of direct dependencies and dependents connected to a node. |
| `shortest_path` | Exploration of dependency connection chains between two symbols. |
| `graphify_project_resource` | Session-scoped access to Graphify report, wiki, and graph statistics. |

### Full Mode (`toolMode: 'full'`) — *Default for backwards compatibility*

Includes all 6 compact tools plus 9 specialized tools:
- Hub detection & community clustering: `god_nodes`, `get_community`, `graph_stats`
- PR blast radius & triage: `list_prs`, `get_pr_impact`, `triage_prs`
- Extensibility & raw MCP: `graphify_capabilities`, `graphify_call`, `graphify_resource` (reads from server default project)

---

## Doctor Tool: `graphify_status`

The `graphify_status` tool is exposed to both human operators and the model to verify environment health and troubleshoot graph issues:

```text
Graphify Status: HEALTHY
• Project Root: /workspace/my-repo
• Knowledge Graph: /workspace/my-repo/graphify-out/graph.json
• Last Indexed: 2026-09-10T00:15:30.000Z
• Graph Freshness: FRESH - Graph matches current Git HEAD and working tree fingerprint
  Inspection Strategy: metadata
  Metadata Version: 3 (baseline: available, canonical target: yes)
• Git Repository: commit a1b2c3d (main), clean
• Runtime: /usr/local/bin/graphify-mcp [installed]
• MCP State: connected

Graph is verified, connected, and ready for architectural and dependency queries.
```

When issues are detected (e.g., missing runtime, missing graph, legacy metadata baseline, or stale files), `graphify_status` provides explicit remediation warnings guiding the agent to run `/graphify build` or update the graph.

---

## Graph Freshness & Concurrency-Safe Updates

Out-of-date graphs cause agents to hallucinate non-existent symbols or miss refactored dependencies. `dsh-graphify` tracks graph freshness via durable v3 index metadata (`.dsh-graphify-index.json`), git branch/HEAD comparisons, per-path dirty-state tracking, and recursive file modification walks:

- **Durable v3 Metadata Baseline**: Captures an indexed working-tree baseline storing content hashes for dirty tracked files, untracked files, and deletions at graph-index time. This ensures indexing from a dirty working tree is safe: reverting or modifying a dirty file later is tracked with path-specific precision, strictly preventing false-fresh graph states.
  - **Fail-Closed Baseline Guarantees**: Any failure during `git diff`, `git ls-files`, or file content hashing immediately marks baseline capture incomplete (`baselineComplete: false`). Metadata v3 only records a complete baseline when all working tree entries and content hashes are captured without error. Incomplete baselines immediately report `stale` and are ineligible for auto-update, ensuring an unverified or partially-captured tree can never report false-fresh.
  - **Symlink Identity Semantics**: In-repo symbolic links are hashed by their link target identity (`SHA-256("symlink\0" + readlink(path))`). Retargeting a symlink is detected as a modification even if the target file's content is identical. Symlinks pointing outside the project root are rejected and immediately fail baseline capture closed.
- **`freshness: { mode: 'warn' }` (Default)**: Injects an actionable warning into tool responses when git commits or file modifications occurred after the graph was last indexed.
- **`freshness: { mode: 'auto', updateTimeoutMs: 120000 }`**: Automatically triggers a coalesced pre-query incremental graph update via `ProjectUpdateCoalescer` before executing tools when staleness is detected. The process lock is held until child process termination, preventing duplicate jobs and race conditions across concurrent sessions. Individual caller abort signals are isolated so one cancellation does not disrupt coalesced operations.
  - **Conservative Code-Only Policy**: `graphify update` incrementally extracts core code files with built-in AST extractors verified against Graphify v0.9.57 (`.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.rs`, `.java`, `.cpp`, `.c`, `.cs`, `.rb`, `.kt`, `.swift`, `.php`, `.lua`, `.zig`, `.sh`). If any non-code file (such as `.md` docs, `package.json`, `pyproject.toml`, or configuration files) has changed, auto-update is refused, the graph remains stale, and an actionable notice is returned guiding the user to run a full rebuild (`/graphify build` or `graphify .`).
  - **Safe Checkpoint Semantics**: Incremental updates only advance the freshness checkpoint if all detected changes since the prior baseline are proven AST code changes. If semantic documents or unproven files changed, the incremental update command completes but the graph remains stale. A full build (`/graphify build`) establishes a new trustworthy v3 baseline representing the entire source corpus.
  - **Legacy & Missing Metadata Handling**: Graphs with legacy (v1/v2) or missing metadata cannot prove which source files changed since indexing. In these cases, auto-update will not bootstrap an unverified graph to FRESH; instead, it requires a full rebuild to establish a trustworthy v3 baseline.
  - **Canonical Target Requirement**: `graphify update` exclusively updates the canonical `<projectRoot>/graphify-out/graph.json`. Explicit or custom `graphPath` targets cannot be updated incrementally; they require a full build or rebuild.
- **`freshness: { mode: 'off' }`**: Disables freshness evaluation for airgapped or static environments.

In monorepos and subprojects, git status and diff checks are scoped to the resolved project root (`-- .`), ensuring only changes within the active workspace affect freshness evaluation. Staging state (`git add` / `git reset`) is irrelevant to freshness: working-tree file bytes are source truth, guaranteeing that staging or unstaging identical bytes never marks a fresh graph stale or a stale graph fresh.

---

## Slash Command (`/graphify`)

In interactive DSH adapters supporting `ctx.commands`, `/graphify` provides direct human control to build or update graphs. In DSH Web, durable result cards are displayed and persist across reloads from session events.

```text
/graphify                         # full build of the receiving session’s project (semantic + code)
/graphify build ../another-repo   # full build of a specific project directory
/graphify build . --code-only     # AST code build; does not establish full-corpus freshness baseline
/graphify update                  # incrementally rebuild modified AST/code files
/graphify update . --force        # bypass node count shrink guard during code update
/graphify update . --code-only    # AST-only indexing without LLM credits
/graphify update . --no-viz       # suppress HTML visualization generation
```

> [!NOTE]
> `/graphify` and `/graphify build [target]` perform a full project build (semantic + code) and establish/refresh a trustworthy v3 freshness metadata baseline (`.dsh-graphify-index.json`). In contrast, passing `--code-only` to `build` (e.g. `/graphify build . --code-only`) performs an AST-only code build without LLM extraction; this intentionally bypasses full-corpus metadata capture (unlinking any preexisting metadata) and warns the caller that a full build is required to establish an incremental freshness baseline.
> In upstream Graphify, `graphify update` is strictly an incremental AST/code re-extraction (`_rebuild_code()`). The `--force` flag bypasses the node count shrink safety guard; it does *not* semantically re-ingest markdown documents. Full semantic documentation indexing requires a full build (`/graphify build` or `graphify .`), which may invoke configured LLM extraction.

---

## Runtime Configuration Reference

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `toolMode` | `'compact' \| 'full'` | `'full'` | Expose 6 core tools (`compact`) or all 15 tools (`full`). |
| `freshness.mode` | `'warn' \| 'auto' \| 'off'` | `'warn'` | Staleness policy: warn model, coalesced pre-query auto-update, or off. |
| `freshness.updateTimeoutMs` | `number` | `120000` | Maximum wait duration in milliseconds for an incremental update. |
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
| `allowExternalProjects` | `boolean` | `false` | Allow model tool calls to access projects outside active session workspace. |
| `reconnect.enabled` | `boolean` | `true` | Enable automatic reconnection on unexpected process exits. |
| `reconnect.maxAttempts` | `number` | `10` | Maximum consecutive automatic reconnect attempts. |
| `reconnect.initialDelayMs`| `number` | `500` | Initial exponential backoff delay for reconnection. |
| `reconnect.maxDelayMs` | `number` | `30000` | Maximum exponential backoff delay for reconnection. |

---

## DeepSeek Harness Compatibility

`dsh-graphify` declares intentional, bounded dependency ranges supported across DeepSeek Harness releases:

- **Cordis Microkernel**: Runtime peer dependency `@deepseek-ai/cordis` bounded to `>=4.0.0 <5`.
- **DSH Client Composition**: Browser modules declare direct client-module runtime dependencies in `dsh.client.inject` (`@deepseek-ai/dsh-client-locale`, `@deepseek-ai/dsh-client-ui-conversation`, and `@deepseek-ai/dsh-client-ui-primitives`). Type-only dependencies are strictly scoped to compile time.
- **Continuous Compatibility**: CI tests the supported baseline on Node 22/24 across Ubuntu and macOS. A scheduled compatibility workflow runs weekly against upstream `@next` and `@alpha` channels to proactively verify package compatibility.
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
