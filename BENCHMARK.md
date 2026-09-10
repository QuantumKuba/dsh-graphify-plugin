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
- **Inference Server**: Dedicated local execution using:
  - **Linux x86_64**: 1x NVIDIA RTX 4090 (24GB) or A100 (80GB) via vLLM / llama.cpp
  - **macOS ARM64**: Apple Silicon M3/M4 Max with 64GB–128GB unified memory via MLX / llama.cpp Metal backend
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

For each task trial, telemetry captures 12 quantitative metrics split into primary and secondary categories:

### Primary Metrics (Decision Gates)
1. **Task Success Rate (%)**: Percentage of tasks solved completely without human intervention or execution failure.
2. **Input / Context Tokens**: Total prompt tokens billed and consumed across all turns.
3. **Time to First Correct File (TTFF)**: Number of turns and elapsed seconds before the agent first opens a file from the ground truth set.

### Secondary Metrics (Diagnostic & Efficiency)
4. **Test Pass Rate (%)**: Percentage of pre-existing and task-specific regression tests passing after edits.
5. **Files Inspected**: Total unique files opened or read during the task.
6. **Irrelevant Files Inspected**: Count of opened files that are not members of the ground truth set $G$ or its direct 1-hop static dependencies $\text{DirectDeps}(G)$.
7. **Tool Calls Count**: Total tool invocations made by the agent.
8. **Graphify Query Ratio**: Proportion of navigation tool calls made using Graphify versus raw filesystem tools (`list_dir`, `grep`).
9. **Output Tokens**: Total tokens generated by the model.
10. **Wall-Clock Time (s)**: Total elapsed seconds from prompt submission to task completion.
11. **Incorrect Edits**: Code modifications attempted on files outside the required change set.
12. **Regressions Introduced**: Previously passing unit tests broken by agent modifications.

### Metric Definitions & Ground Truth
- **Ground Truth Files ($G$)**: The minimal, authoritatively determined set of files that must be modified or referenced to solve the task card correctly.
- **Irrelevant File ($f$)**: Any inspected file $f \notin G \cup \text{DirectDeps}(G)$. Minimizing irrelevant file reads directly reduces context token waste and model confusion.

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

## 7. Statistical Power Analysis & Execution Protocol

When implementing this experimental protocol:
1. **Sample Size & Statistical Power**:
   - The benchmark specifies **50 standardized task cards** across the 8 categories.
   - Running **3 repeated trials** per task per arm yields **150 trials per model condition**.
   - Power analysis ($\alpha = 0.05, 1 - \beta = 0.80$) confirms $N = 150$ provides sufficient power to detect a $\ge 15\%$ absolute delta in binary success rate using McNemar's test for paired binary outcomes, and medium effect sizes (Cohen's $d \ge 0.45$) for continuous token and latency metrics using the Wilcoxon signed-rank test.
2. **Confidence Intervals**: All reported metrics must include 95% bootstrap confidence intervals (1,000 resamples).
3. **Execution Harness**: Implement a standalone benchmark runner under `benchmarks/` utilizing DeepSeek Harness's JSON-RPC client.
4. **Reporting**: Publish automated comparison charts reporting:
   - *Token Reduction Ratio* ($Tokens_{\text{Control}} / Tokens_{\text{Graphify}}$)
   - *Localization Precision Delta* ($IrrelevantFiles_{\text{Control}} - IrrelevantFiles_{\text{Graphify}}$)
   - *Net Success Rate Delta* ($\Delta Success = Success_{\text{Graphify}} - Success_{\text{Control}}$)
