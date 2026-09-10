# dsh-graphify Benchmark Specification

> **Status**: Specification & Experimental Protocol (Design only — not yet implemented).
>
> **Objective**: Quantify the impact of `dsh-graphify` on coding agent performance, efficiency, and localization accuracy in DeepSeek Harness (DSH), focusing specifically on local coding LLMs in the 20B–30B class.

---

## 1. Executive Summary & Research Question

When coding agents use raw directory traversals (e.g. broad `grep`, `find`, or multi-file reads), smaller local models frequently suffer from:
1. **Context saturation**: Excessive irrelevant source code polluting the context window.
2. **Tool-selection confusion**: Inability to construct multi-hop dependency chains.
3. **High latency and compute cost**: Hundreds of thousands of tokens consumed scanning unindexed repositories.

This benchmark establishes a rigorous, reproducible experimental protocol to evaluate:
> *How much does native knowledge graph integration (`dsh-graphify`) improve task success, token efficiency, localization accuracy, and wall-clock speed for local coding models compared to baseline DeepSeek Harness?*

---

## 2. Target Models & Runtime Environment

### Target Models (20B–30B Class)
The benchmark specifically targets edge and local coding models where context efficiency and tool precision matter most:
- **Qwen2.5-Coder-32B-Instruct** (Q4_K_M / Q8_0 via Ollama / llama.cpp / vLLM)
- **DeepSeek-Coder-V2-Lite-Instruct** (16B / 21B MoE active)
- **Codestral-22B-v0.1**
- Baseline reference frontier models: **DeepSeek-V3** / **DeepSeek-R1** (for ceiling comparison)

### Local Inference Controls
- **Inference Server**: Ollama / vLLM on dedicated GPU hardware (e.g. 1x NVIDIA RTX 4090 / A100 or Apple Silicon M-series unified memory 64GB+).
- **Sampling Parameters**:
  - `temperature`: 0.0 (greedy decoding for deterministic tool calls)
  - `top_p`: 1.0
  - `context_window`: 32,768 tokens
  - `seed`: Fixed integer across comparative runs

---

## 3. Comparative Conditions

The benchmark executes an A/B matrix across identical task suites:

| Arm | Harness Configuration | Available Tools | Freshness Policy |
| :--- | :--- | :--- | :--- |
| **Control (Baseline)** | DSH standard profile (`fs`, `shell`, `editor`) | `read_file`, `write_file`, `edit_file`, `grep`, `list_dir`, `bash` | N/A |
| **Treatment A (Full)** | DSH + `dsh-graphify` (`toolMode: full`) | Baseline tools + 10 Graphify tools + `graphify_status` + escape hatches | `freshness: { mode: 'warn' }` |
| **Treatment B (Compact - Recommended)** | DSH + `dsh-graphify` (`toolMode: compact`, `toolPrefix: graphify_`) | Baseline tools + 6 compact Graphify tools (`query_graph`, `get_node`, `get_neighbors`, `shortest_path`, `graphify_status`, `graphify_resource`) | `freshness: { mode: 'warn' }` |

---

## 4. Benchmark Task Categories

The benchmark evaluates 8 distinct coding task archetypes on realistic, non-trivial open-source codebases (e.g. `express`, `fastapi`, `cordis`, `deepseek-harness`):

### 1. Symbol & Location Discovery
- **Task**: Identify the declaration, defining interface, and canonical export of a concept specified in natural language (e.g. *"Where is session event deduplication implemented?"*).
- **Evaluation**: Agent must return the exact file and line range.

### 2. Direct Caller & Dependency Identification
- **Task**: Determine all immediate callers and dependencies of a key internal function before refactoring.
- **Evaluation**: Compare identified callers against static analysis ground truth.

### 3. Architecture & Structural Understanding
- **Task**: Explain the architectural relationship and data flow between two distant modules (e.g. Web UI chat rendering and backend durable session log).
- **Evaluation**: Rubric-scored architectural assessment; accuracy of intermediate abstraction steps.

### 4. Bug Localization
- **Task**: Given a failing test case or bug description, locate the defect in an unfamiliar repository without executing code.
- **Evaluation**: Metric measures time-to-first-correct-file and number of irrelevant files opened.

### 5. Cross-File Reasoning
- **Task**: Answer a question whose solution requires linking facts distributed across 4 or more distinct files.
- **Evaluation**: Binary answer correctness and provenance completeness.

### 6. Blast-Radius & Impact Analysis
- **Task**: Analyze the potential breaking impact of modifying a shared utility or protocol interface.
- **Evaluation**: Precision and recall of affected downstream files and external modules.

### 7. Multi-File Code Refactoring
- **Task**: Perform an API rename or interface signature change across an entire repository and ensure the project builds and all unit tests pass.
- **Evaluation**: Automated test suite execution (`pnpm test` / `pytest`); zero compilation or lint errors.

### 8. PR Impact Reasoning
- **Task**: Given a realistic git diff or PR description, summarize affected architectural communities, touched public APIs, and merge conflict risks.
- **Evaluation**: Agreement with manual senior engineer review.

---

## 5. Measured Metrics

For each task trial, telemetry captures 12 quantitative metrics:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        EVALUATION METRICS                              │
├──────────────────────┬─────────────────────────┬───────────────────────┤
│ Accuracy & Quality   │ Efficiency & Cost       │ Speed & Dynamics      │
├──────────────────────┼─────────────────────────┼───────────────────────┤
│ • Task Success Rate  │ • Input / Context Tokens│ • Wall-Clock Time (s) │
│ • Tests Passing (%)  │ • Output Tokens         │ • Time to First       │
│ • Incorrect Edits    │ • Total Tool Calls      │   Correct File (TTFF) │
│ • Regressions Created│ • Irrelevant Files Read │ • Graphify Query Ratio│
└──────────────────────┴─────────────────────────┴───────────────────────┘
```

1. **Task Success Rate (%)**: Percentage of tasks solved to completion without human intervention.
2. **Test Pass Rate (%)**: Percentage of pre-existing and task-specific regression tests passing after edits.
3. **Files Inspected**: Total count of files opened or read.
4. **Irrelevant Files Inspected**: Count of opened files that did not contribute to the final correct solution (measure of distraction/noise).
5. **Tool Calls Count**: Total tool invocations made by the agent.
6. **Graphify Calls Count**: Count of Graphify tool queries used.
7. **Input / Context Tokens**: Total prompt tokens billed/consumed across all turns.
8. **Output Tokens**: Total tokens generated by the model.
9. **Wall-Clock Time**: Total seconds from prompt submission to turn conclusion.
10. **Incorrect Edits**: Code modifications attempted on files unrelated to the task.
11. **Regressions Introduced**: Previously passing unit tests broken by agent modifications.
12. **Time to First Correct Localization (TTFF)**: Number of turns / seconds elapsed before the agent first opens the true target file.

---

## 6. Experimental Controls & Rigor

To prevent experimental drift and confounding variables, trials enforce:
1. **Fresh Independent Sessions**: Every task execution runs in an isolated ephemeral workspace with a clean git clone. Session state, temporary files, and tool caches are purged between runs.
2. **Fixed Repository Commits**: All test repositories are pinned to immutable commit hashes.
3. **Identical Hardware**: Control and treatment arms execute on the same physical host and GPU instance under identical system load.
4. **Context Window Limits**: Both arms operate under identical hard token limits (`max_tokens: 32768`).
5. **Prompt Standardization**: User task prompts are byte-identical across both arms; only system tool injection varies.
6. **No Network Leakage**: All tests run offline against local repository checkouts and local MCP servers; zero internet access during trials.

---

## 7. Future Execution Plan

When implementing this specification:
1. Create a standalone benchmark runner under `benchmarks/` utilizing DeepSeek Harness's JSON-RPC client.
2. Formulate 50 standardized task cards with verified ground truth and automated test harnesses.
3. Run 3 repeated trials per task per arm (150 trials per model condition) to achieve statistical significance ($p < 0.05$).
4. Publish results as automated interactive charts comparing:
   - *Token Reduction Ratio* ($Tokens_{\text{Control}} / Tokens_{\text{Graphify}}$)
   - *Localization Precision Improvement* ($IrrelevantFiles_{\text{Control}} - IrrelevantFiles_{\text{Graphify}}$)
   - *Net Success Rate Delta* ($\Delta Success$)
