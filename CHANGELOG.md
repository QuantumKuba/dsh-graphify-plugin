# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
