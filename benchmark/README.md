# dsh-graphify Benchmark Suite

Empirical, reproducible evaluation framework measuring the performance and token efficiency of `dsh-graphify` in DeepSeek Harness compared to standard baseline filesystem exploration on **Express.js**.

## Overview

Smaller local models (7B–32B, e.g. Qwen2.5-Coder, DeepSeek-Coder-V2) struggle with code exploration because raw keyword search (`grep`, `find`) yields excessive noise across tests and docs, polluting the model's context window and causing hallucinations or dead-ends.

This benchmark rigorously evaluates how an AST knowledge graph resolves this by providing structured, high-signal subgraphs in a single tool call.

## Target Codebase: Express.js (`v4.21.2`)
- **Scale**: 425 AST nodes, 639 links, 45 architectural communities.
- **Why Express**: Universally known web framework with realistic multi-layer routing, prototype delegation, and god nodes.
- **Fast Setup**: Clones and indexes locally with Graphify AST in under 3 seconds.

## Standardized Task Suite (10 Tasks)
1. **`task-01-route-match`**: Route Path Matching & Layer Evaluation (`lib/router/layer.js`)
2. **`task-02-dispatch-pipeline`**: HTTP Request Dispatch Pipeline Tracing (`application.js` -> `router/index.js` -> `layer.js`)
3. **`task-03-blast-radius-send`**: Blast Radius of Modifying `res.send()` (`lib/response.js`)
4. **`task-04-god-nodes`**: Central Architectural Hubs & God Nodes (`express.js`, `application.js`, `router/index.js`, `response.js`)
5. **`task-05-prototype-wiring`**: Request & Response Prototype Lifecycle Wiring (`application.js` & `middleware/init.js`)
6. **`task-06-param-compilation`**: Route Parameter Callback Compilation (`lib/router/index.js`)
7. **`task-07-view-engine`**: Template Engine Resolution & View Rendering (`lib/view.js`)
8. **`task-08-subrouter-mounting`**: Nested Sub-Router Mounting & Prefix Isolation (`lib/application.js` & `lib/router/layer.js`)
9. **`task-09-error-middleware-arity`**: Error Middleware Arity Differentiation (`lib/router/layer.js`)
10. **`task-10-content-negotiation`**: Content Negotiation & Request Header Delegation (`lib/request.js`)

## Running the Benchmark

```sh
# Step 1: Prepare target codebase and build Graphify knowledge graph
pnpm run benchmark:setup

# Step 2a: Execute fast deterministic benchmark (2 seconds, calibrated offline baseline)
pnpm run benchmark

# Step 2b: Execute live LLM agent trials against LM Studio (qwen/qwen3.8-27b)
pnpm run benchmark -- --live

# Step 2c: Run specific tasks live (e.g. task 1 and 2)
pnpm run benchmark -- --live --tasks=task-01-route-match,task-02-dispatch-pipeline
```

### Execution Modes
- **Offline Calibrated Mode (`pnpm run benchmark`)**: Executes real `grep`, `read_file`, and live `graphify-mcp` tools using calibrated local model navigation sequences. Finishes in ~2 seconds with 100% deterministic metrics, ideal for CI and regression checks.
- **Live Model Mode (`pnpm run benchmark -- --live`)**: Connects to your local **LM Studio** server (at `http://127.0.0.1:1235/v1` or `1234`) running **`qwen/qwen3.8-27b`**. The model autonomously issues tool calls turn-by-turn.

## Generated Deliverables
- **`BENCHMARK_REPORT.md`**: Executive summary, side-by-side performance tables, and case studies.
- **`benchmark/data/benchmark-results.json`**: Complete raw trial telemetry.
