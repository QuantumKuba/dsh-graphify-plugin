# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.0] - 2026-09-11

### Added
- **Marketplace Resilience & Graceful Degraded Startup**:
  - Decoupled plugin lifecycle mount from Graphify runtime availability via lazy `RuntimeResolution` discriminated union.
  - DeepSeek Harness boots cleanly even if Graphify is absent and `uv` is absent—preventing broken DSH profiles on initial install.
  - `graphify_status` reports `UNAVAILABLE` with actionable remediation and pinned installation commands.
  - Tool and slash command invocations return structured, actionable error messages instead of unhandled rejections or crashes.
  - Dynamic runtime rediscovery: once a user installs Graphify, the plugin discovers it on the next invocation without requiring a DSH host restart.
- **Model-Controlled Project Path Security**:
  - Added `allowExternalProjects` configuration (default: `false`) bounding model tool calls to the active session workspace.
  - Implemented `fs.realpathSync` containment checks preventing symlink escapes and directory prefix collisions (`/repo` vs `/repo-evil`).
  - Preserved human slash command path flexibility for intentional manual `/graphify` invocations.
- **Reproducible Version Pinning**:
  - Centralized `DEFAULT_GRAPHIFY_VERSION = '0.9.57'` as the tested default for automatic `uv` provisioning and diagnostic messages.
- **Web Client Inject Audit & Dependency Hardening**:
  - Added `@deepseek-ai/dsh-client-ui-primitives` to `dsh.client.inject` matching runtime browser imports.
  - Bounded `@deepseek-ai/cordis` peer dependency to `>=4.0.0 <5` and removed unnecessary type-only runtime peer dependencies.
- **Packed Clean-Machine Install Test**:
  - Added `test/packed-install.test.ts` validating clean package installation from `pnpm pack` tarball in an isolated consumer project across all missing-runtime and multi-workspace scenarios.
- **Official MCP SDK Integration**:
  - Replaced ad-hoc JSON-RPC transport with `@modelcontextprotocol/sdk` (`Client` and `StdioClientTransport`).
  - Added generation tracking to prevent race conditions and zombie subprocess leaks on reconnect.
  - Implemented bounded exponential backoff reconnection with state machine handling handshake failures and attempt tracking (`reconnect.maxAttempts`, `reconnect.initialDelayMs`, `reconnect.maxDelayMs`).
  - Added stderr ring buffer retaining up to 50 chunks / 64 KiB for post-mortem diagnostics on crash.
  - Implemented cooperative cancellation with `AbortSignal` across all transport calls.
- **Diagnostic Doctor Tool (`graphify_status`)**:
  - Added `graphify_status` tool reporting runtime command and discovery source, MCP transport health, reconnect attempts, project resolution details, graph timestamps, staleness metrics, baseline availability, and metadata versions.
  - Generates structured status objects and formatted summaries with actionable remediation advice.
- **Compact Tool Mode for 20B–30B Local LLMs**:
  - Added `toolMode` configuration (`compact` vs `full`).
  - Compact mode registers 6 high-signal tools (`graphify_status`, `query_graph`, `get_node`, `get_neighbors`, `shortest_path`, `graphify_project_resource`) with concise parameter schemas to reduce context token waste and prevent tool hallucination on smaller models.
- **Session-Scoped Multi-Workspace Resolution**:
  - Added `ProjectResolver` honoring context precedence: explicit `project_path` > session cwd (`toolContext.agent.session.header.cwd` / `session.header.cwd`) > ancestor directory traversal > configured `config.cwd` > process fallback.
  - Added mtime-validated caching with filesystem invalidation.
- **Graph Freshness & Concurrency-Safe Auto-Update**:
  - Added git- and mtime-based freshness detection with durable v3 index metadata (`.dsh-graphify-index.json`) tracking per-path dirty states with exact content hashes and deletion markers.
  - Injects non-intrusive staleness warnings into tool results when code modifications postdate graph generation.
  - Built `ProjectUpdateCoalescer` providing mutex-locked deduplication for concurrent incremental graph update requests across sessions, holding the lock until child process termination, with isolated caller `AbortSignal`s preventing cancellation interference.
- **Decision Policy Agent Prompting**:
  - Rewrote system prompt guidance into an authoritative decision tree optimized for local coding models.
  - Guides models through the standard navigation loop: Graphify for macro architecture -> direct source inspection -> editor -> test -> `/graphify update`.
- **Schema Drift Detection**:
  - Added `test/schema-drift.test.ts` and `src/schema-drift.ts` comparing live or mocked Graphify tool schemas against declared definitions to detect breaking changes and additions.
  - Added `pnpm run test:drift` command wired into CI.
- **Benchmark Specification**:
  - Added `BENCHMARK.md` detailing an 8-category, 12-metric evaluation protocol comparing DeepSeek Harness agents with and without Graphify on 20B–30B local LLMs.
- **Upstream DeepSeek Harness Compatibility CI**:
  - Added `.github/workflows/dsh-compatibility.yml` verifying plugin builds and contracts across supported DeepSeek Harness dependency versions.

- **Fail-Closed Freshness Baseline Capture**:
  - Hardened `captureIndexedPathStates` and `computeWorkingTreeFingerprint` so any failure during `git diff`, `git ls-files`, or file content hashing immediately marks the baseline incomplete (`baselineComplete: false`).
  - Updated metadata v3 evaluation (`checkMetadataGitFreshness`, `checkGraphFreshness`, `getChangedSourceInventory`, `evaluateAutoUpdateEligibility`) to require `baselineComplete === true`. Incomplete baselines immediately report `stale` and reject auto-update eligibility, guaranteeing an unverified tree can never report false-fresh.
- **Symlink Identity Hashing & Boundary Containment**:
  - Implemented link identity hashing for symbolic links (`SHA-256("symlink\0" + readlink(path))`), ensuring retargeted symlinks trigger staleness detection even when file contents match.
  - Added strict project root containment validation for symlinks; symlinks pointing outside the repository root fail baseline capture closed.
- **`/graphify build --code-only` Baseline Gating**:
  - Gated metadata generation on `/graphify build`: explicit `--code-only` builds bypass v3 metadata generation, clean up any preexisting metadata, and warn the caller that a full build is required to establish an incremental freshness baseline.
- **Atomic Temp File Cleanup**:
  - Wrapped atomic metadata write (`.tmp` file write/fsync/rename) in a `try...finally` block with best-effort `.tmp` removal on write or rename failure, preventing orphan temporary files.
- **Nested Canonical Graph Root Precedence**:
  - Prioritized canonical layout detection (`path.basename(graphDir) === 'graphify-out'`) over session root fallback for custom graph paths, correctly resolving nested subproject roots.
- **Conservative Code Extension Verification**:
  - Confirmed `PROVEN_CODE_EXTENSIONS` against Graphify v0.9.57 built-in AST extractors (`graphify.detect.CODE_EXTENSIONS`), ensuring only proven language extractors participate in auto-update.
- **False-Fresh Prevention & Metadata v3 Per-Path Tracking**:
  - Fixed fundamental freshness baseline flaw where reverting a dirty file to Git HEAD could cause false-fresh graph reporting.
  - Metadata v3 captures `indexedPaths` mapping modified files, untracked files, and deletions to exact content hashes at graph-index time.
  - Reconstructing changed sources compares current effective working tree bytes against the indexed baseline rather than inferring state from Git HEAD alone.
  - Implemented all-or-nothing auto-update eligibility: only changes to proven built-in AST code extensions (`.ts`, `.py`, `.go`, `.rs`, `.java`, etc.) can trigger incremental update.
  - Changes to semantic documentation (`.md`), manifests (`package.json`, `pyproject.toml`), configs, or unproven file types preserve staleness and emit actionable notices directing full rebuild.
  - Safe rename and deletion semantics: code-to-code renames are incremental-eligible; doc renames/deletions require a full rebuild.
  - Legacy metadata (v1/v2) and missing metadata fail safe: conservative evaluation prevents unverified graphs from bootstrapping to FRESH via code-only update.
  - Transactional checkpointing: `/graphify update` and auto-update only advance the freshness checkpoint when all changed sources are proven AST code files. Full build (`/graphify build`) establishes a new trustworthy v3 baseline.
- **Post-Update Graph Validation**:
  - Hardened `performPostUpdateValidation` to inspect graph root structure, verifying `nodes` and `edges`/`links` arrays exist, rejecting uninitialized or empty JSON files before checkpointing.
- **Custom `graphPath` Canonical Integrity & Root Resolution**:
  - Prevented false-fresh metadata recording on custom graphPath targets when `graphify update` or `/graphify` updates the canonical project graph.
  - Fixed relative `graphPath` root detection edge case: relative paths escaping search directory (e.g. `../graphify-out/graph.json` from a nested directory) correctly bind to the parent canonical project root rather than incorrectly binding to the child search directory.
  - Implemented 4-tier project-root resolution for explicit graphs: `.graphify_root` marker validation, canonical layout inference, evidence-checked session root association, and directory fallback.
- **Git Staging Invariance**:
  - Removed git index/staging (`--cached`) from working-tree fingerprinting while maintaining binary correctness (`--binary`) and untracked file content hashing.
  - Staging (`git add`) or unstaging (`git reset`) identical file bytes never alters freshness state.
- **Symlink-Safe Resource Boundaries**:
  - Hardened `graphify_project_resource` (including `stats` branch) with `fs.realpathSync` path containment inside `graphDir` and `stat.isFile()` validation to prevent directory traversal and symlink escapes.
- **Process Quiescence Semantics**:
  - Fixed `terminateChildProcess` to wait for confirmed child process exit and stdio closure before resolving, removing premature resolution on `child.killed === true`.
- **Expedited Reconnect Failure Recovery**:
  - Hardened expedited reconnection during backoff to survive failed handshakes, preserve the retry chain, and reconnect on subsequent attempts.

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
