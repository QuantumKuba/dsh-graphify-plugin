# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.0] - 2026-09-10

### Added
- **Official MCP SDK Integration**:
  - Replaced ad-hoc JSON-RPC transport with `@modelcontextprotocol/sdk` (`Client` and `StdioClientTransport`).
  - Added generation tracking to prevent race conditions and zombie subprocess leaks on reconnect.
  - Implemented bounded exponential backoff reconnection (`reconnect.maxRetries`, `reconnect.initialDelayMs`, `reconnect.maxDelayMs`).
  - Added stderr ring buffer retaining the last 50 lines / 64 KB for post-mortem diagnostics on crash.
  - Implemented cooperative cancellation with `AbortSignal` across all transport calls.
- **Diagnostic Doctor Tool (`graphify_status`)**:
  - Added `graphify_status` tool reporting executable discovery, Python environment paths, MCP transport health, project resolution details, graph timestamps, tool mode, and staleness metrics.
  - Generates structured status objects and formatted Markdown summaries with actionable remediation advice.
- **Compact Tool Mode for 20B–30B Local LLMs**:
  - Added `toolMode` configuration (`compact` vs `full`).
  - Compact mode registers 6 high-signal tools (`graphify_status`, `query_graph`, `get_node`, `get_neighbors`, `god_nodes`, `shortest_path`) with concise parameter schemas to reduce context token waste and prevent tool hallucination on smaller models.
- **Session-Scoped Multi-Workspace Resolution**:
  - Added `ProjectResolver` honoring context precedence: explicit `project_path` > session cwd (`toolContext.agent.session.header.cwd` / `session.header.cwd`) > ancestor directory traversal > configured `config.cwd` > process fallback.
  - Added mtime-validated caching with filesystem invalidation.
- **Graph Freshness & Concurrency-Safe Auto-Update**:
  - Added git- and mtime-based freshness detection (`freshness`: `warn` | `auto` | `off`).
  - Injects non-intrusive staleness warnings into tool results when code modifications postdate graph generation.
  - Built `ProjectUpdateCoalescer` providing mutex-locked deduplication for concurrent background graph indexing requests across sessions.
- **Decision Policy Agent Prompting**:
  - Rewrote system prompt guidance into an authoritative decision tree optimized for local coding models.
  - Guides models through the standard navigation loop: Graphify for macro architecture -> direct source inspection -> editor -> test -> `/graphify update`.
- **Schema Drift Detection**:
  - Added `test/schema-drift.test.ts` and `src/schema-drift.ts` comparing live or mocked Graphify tool schemas against declared definitions to detect breaking changes and additions.
  - Added `pnpm run test:drift` command wired into CI.
- **Benchmark Specification**:
  - Added `BENCHMARK.md` detailing an 8-category, 12-metric evaluation protocol comparing DeepSeek Harness agents with and without Graphify on 20B–30B local LLMs.
- **Upstream DeepSeek Harness Compatibility CI**:
  - Added `.github/workflows/dsh-compatibility.yml` testing plugin builds and contracts against upstream DeepSeek Harness releases (`dsh-session >=0.1.1-rc.2` through `0.1.5-alpha.2`, `cordis >=4.0.0` through `4.0.2`).

### Changed
- Bumped version to `0.2.0`.
- Added dynamic versioning via `src/version.ts` to prevent stale client metadata.
- Updated tool registration to use consistent namespace prefixing (`getPrefixedToolName`).

---

## [0.1.3] - 2026-09-09

### Added
- **Graphify v0.9.57 Compatibility**:
  - Direct executable auto-discovery for standalone `graphify-mcp` binary installed by Graphify.
  - Added `exclude_hubs_percentile` parameter (`number`, 0-100) to `god_nodes` tool definition for matching `cluster()` hub suppression.
  - Expanded `/graphify` slash command to support `--code-only` (local AST indexing without LLM credits) and `--no-viz` (suppressing HTML generation for large graphs/CI) flags in addition to `--force` and `--no-cluster`.
  - Updated prompt guidance with hub suppression and explicit resource URI references (`graphify://report`, `graphify://stats`, `graphify://god-nodes`, `graphify://surprises`, `graphify://audit`, `graphify://questions`).
- **Tests & Verification**:
  - Added test coverage for `exclude_hubs_percentile`, additional command flags, `graphify-mcp` auto-discovery, and verified against Graphify v0.9.57 release contract.

## [0.1.2] - 2026-09-05

### Fixed
- **DSH Web Boot Activation**:
  - Replaced legacy `conversationEvents` dependency injection with official `uiConversation` service (`ctx.uiConversation.events.register`).
  - Fixed `web boot: 1 entry did not activate dsh-graphify: pending (waiting for service: conversationEvents)` error.

### Changed
- **Client Architecture Modernization**:
  - Removed references to the discontinued `@deepseek-ai/dsh-client-runtime` package.
  - Aligned client context types with `@deepseek-ai/cordis` and conversation contracts.
  - Broadened peer dependency ranges for `@deepseek-ai/*` packages to `>=0.1.1-rc.2` for compatibility with DeepSeek Harness `0.1.3-alpha.1`+.

## [0.1.0] - 2026-08-31

### Added
- **10 Core Graphify MCP Tools**:
  - `query_graph`: BFS/DFS traversal over the knowledge graph.
  - `get_node`: Full node inspection by label or ID.
  - `get_neighbors`: Direct node neighbors with relational edge metadata.
  - `get_community`: Community membership and clustering inspection.
  - `god_nodes`: Identification of architectural hub nodes.
  - `graph_stats`: High-level graph topology and confidence metrics.
  - `shortest_path`: Shortest path exploration between symbols.
  - `list_prs`: Open GitHub pull requests with community blast radius.
  - `get_pr_impact`: Detailed PR graph impact analysis.
  - `triage_prs`: Actionable PR triage with conflict risk analysis.
- **Auto-Detection Engine (`detectGraph`)**:
  - Upward directory traversal locating `graphify-out/graph.json` and `.graphify_root`.
- **System Prompt Guidance**:
  - Injects `graphify:guidance` into DSH agent loop context with pointers to `GRAPH_REPORT.md` and wiki indexes.
- **Slash Command (`/graphify`)**:
  - Interactive workspace indexing via DSH command interface.
- **Subprocess Lifecycle Manager (`GraphifyServerProcess`)**:
  - stdio JSON-RPC 2.0 transport with auto-resolution of `uv` / Python binaries.
  - Graceful `SIGTERM` to `SIGKILL` termination with full process quiescence.
  - Cooperative `AbortSignal` cancellation support.
- **Cordis Microkernel Integration**:
  - Reversible effect registrations for clean hot-module-reloading and teardown.
- **Schemastery Configuration**:
  - Validated options schema compatible with `cordis.yml` profiles and DSH bundle patches.
