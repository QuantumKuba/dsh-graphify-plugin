# Contributing to dsh-graphify

Thank you for your interest in contributing to `@deepseek-ai/dsh-graphify`! This document outlines the process for development, testing, and submitting contributions.

---

## Development Setup

### Prerequisites

- **Node.js**: `^20.0.0` or `>=22.0.0`
- **pnpm**: `^9.0.0`
- **Python**: `>=3.10` with [`uv`](https://docs.astral.sh/uv/) installed (recommended for Graphify)

### Installation

Clone the repository and install dependencies:

```sh
git clone https://github.com/QuantumKuba/dsh-graphify-plugin.git
cd dsh-graphify-plugin
pnpm install
```

---

## Available Scripts

| Command | Purpose |
| :--- | :--- |
| `pnpm run build` | Compiles TypeScript source from `src/` to `lib/` and declaration files to `lib/types/` |
| `pnpm run typecheck` | Runs the TypeScript compiler in `--noEmit` mode to validate static types |
| `pnpm test` | Runs the full test suite using Node's built-in test runner with `tsx` |
| `pnpm run clean` | Cleans up the `lib/` output directory and build caches |

---

## Architectural Conventions

When contributing to this plugin, please follow these core principles:

1. **Cordis Reversibility (`ctx.effect()`)**:
   - Every registration (tools, system prompts, slash commands, background processes) MUST be bound inside `ctx.effect()` or return a cleanup disposer.
   - Disposers must cleanly release all resources, unregister hooks, and terminate child processes gracefully so that hot-reloading and context disposal leave zero dangling state.

2. **Subprocess Lifecycle & Quiescence**:
   - The Graphify MCP server is managed over `stdio` using JSON-RPC 2.0.
   - Any long-running or async subprocess execution must support `AbortSignal` cooperative cancellation.
   - Child process teardown must attempt `SIGTERM` first, followed by a graceful timeout and fallback to `SIGKILL`.

3. **Type Safety & Schemas**:
   - Maintain `strict: true` type safety throughout the codebase.
   - Config options must be defined with `@deepseek-ai/schemastery` schemas with default values and descriptive annotations.
   - Tool definitions must expose valid JSON schemas for parameters and output.

4. **Testing Policy**:
   - Unit tests are located in `test/`.
   - Every new tool or feature should have corresponding unit tests that verify parameter serialization, execution handling, and cancellation behavior.

---

## Submitting a Pull Request

1. Create a descriptive branch from `main`:
   ```sh
   git checkout -b feature/my-new-tool
   ```
2. Make your code changes and add tests.
3. Verify that all gates pass locally:
   ```sh
   pnpm run typecheck
   pnpm run build
   pnpm test
   ```
4. Commit your changes with clear, descriptive commit messages:
   ```sh
   git commit -m "feat(tools): add community clustering filter parameter"
   ```
5. Open a Pull Request on GitHub and follow the PR template.
