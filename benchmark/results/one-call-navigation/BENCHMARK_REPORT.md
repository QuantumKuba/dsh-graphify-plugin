# DeepSeek Harness Knowledge Graph Benchmark

> **Empirical Evaluation**: Quantifying the impact of `dsh-graphify` on agent navigation, token efficiency, and localization accuracy in DeepSeek Harness (DSH), evaluated on **Express.js** for local coding models.

---

## 🔬 Experimental Methodology & Pre-Registration

This benchmark evaluates autonomous coding agent performance on **Express.js (`v4.21.2`)** comparing **Baseline DSH** against **DSH + `dsh-graphify`**.

- **Target Model**: `qwen/qwen3.8-27b` (served locally via LM Studio on `http://127.0.0.1:1235/v1`).
- **Target Repository**: Express.js `v4.21.2` (425 AST nodes, 639 directional links, 45 architectural communities).
- **Control Arm**: DeepSeek Harness profile `benchmark-baseline` (standard DSH tools: `read`, `glob`, `grep`, `bash`, `write`, `edit`).
- **Treatment Arm**: DeepSeek Harness profile `benchmark-graphify` (DSH + `dsh-graphify` knowledge graph tools: `query_graph`, `get_node`, `get_neighbors`, `shortest_path`, `god_nodes`).
- **Telemetry Authority**: Native DeepSeek Harness session event logs (`~/.dsh/sessions/.../session.v3.jsonl.zstd`). Zero synthetic or simulated proxy estimates in live trials.
- **Order Counterbalancing**: Trials alternate presentation order (`Control -> Treatment` on even repetitions, `Treatment -> Control` on odd repetitions) to eliminate thermal throttling, GPU warming, and cache bias.
- **Pre-Registered Task Scoring**: Strict success requires localizing all pre-registered primary target files and identifying required architectural symbols without opening forbidden distractor test suites.

---

## 📊 Statistical Inference & Paired Hypothesis Tests

Evaluated on **N = 1 paired trials** with order counterbalancing. Statistical significance is computed using both parametric (Paired Student's t-test) and non-parametric (Wilcoxon Signed-Rank test) methods, with 2,000-resample Bootstrap 95% Confidence Intervals:

| Metric | Control Mean (SD) | Treatment Mean (SD) | Mean Paired Difference (Δ) | 95% Bootstrap CI | Paired t-test (p) | Wilcoxon W (p) | Effect Size (Cohen's d_z) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Total Tokens** | 59,705 (0) | 49,215 (0) | **-10,490 (-17.6%)** | `[-10,490, -10,490]` | t=0.00, p=1.000 (n.s.) | W=0, p=1.000 (n.s.) | d=0.00 |
| **Irrelevant Files (Noise)** | 1.0 (0.0) | 1.0 (0.0) | **0.0 (0.0%)** | `[0, 0]` | t=0.00, p=1.000 (n.s.) | W=0, p=1.000 (n.s.) | d=0.00 |
| **Inspection Precision** | 33.3% | 33.3% | **0.0%** | `[0.0%, 0.0%]` | t=0.00, p=1.000 (n.s.) | W=0, p=1.000 (n.s.) | d=0.00 |
| **Turns to Solution** | 1.0 | 1.0 | **0.0** | `[0, 0]` | t=0.00, p=1.000 (n.s.) | W=0, p=1.000 (n.s.) | d=0.00 |
| **Duration (seconds)** | 123s | 144s | **+21s** | `[21s, 21s]` | t=0.00, p=1.000 (n.s.) | W=0, p=1.000 (n.s.) | d=0.00 |

---

## 📋 Counterbalanced Live Trial Logs

| Task ID | Rep | Order | Control Tokens | Treatment Tokens | Control Noise | Treatment Noise | Control Prec. | Treatment Prec. | Outcome |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **task-01-route-match** | 1 | `control-first` | 59,705 | 49,215 | 1 files | **1 files** | 33% | **33%** | ✅ / ✅ |

---

## ⚖️ Empirical Observations & Measured Trade-Offs

1. **Token Consumption & Schema Overhead**:
   - Treatment consumed **18% fewer total tokens** on average (59,705 control vs 49,215 treatment).
   - Mounting Graphify schemas introduces serialization overhead (~1,904 chars in compact mode). Total token savings depend on whether graph retrieval eliminates expensive search loops and file inspections.

2. **Tool Invocations & Latency**:
   - Tool calls: **6** calls (control) vs **4** calls (treatment) (-33%).
   - Duration: **123s** (control) vs **144s** (treatment) (+21s).
   - Graph tool invocations can reduce trial-and-error tool count, but may increase per-turn generation and bridge latency on local quantized models.

3. **Graph Tool Adoption & Noise**:
   - ⚠️ **Failed Adoption Notice**: Treatment model made **0 Graphify tool calls** across evaluated trials. Token consumption differences reflect baseline exploration variance, not graph retrieval.
   - Irrelevant file reads: **1** files (control) vs **1** files (treatment).
   - Inspection precision: **33%** (control) vs **33%** (treatment).

> [!NOTE]
> Evaluated on **N = 1** paired trial(s). Single-pair or small-sample results demonstrate execution feasibility and individual trial mechanics, but cannot establish population-level statistical significance.

---

## 🔍 Evaluated Task Traces & Case Studies

### Task: Route Path Matching & Layer Evaluation (`task-01-route-match`)

> **Prompt**: "Where is the core route matching regex and path-to-regexp evaluation logic implemented in Express? Identify the specific class and method responsible for testing if a layer path matches an incoming request URL."

#### Control Arm (Baseline DSH)
- **Outcome**: ✅ Solved
- **Tokens**: 59,705 total (Input: 57,611, Output: 2,094)
- **Duration**: 123s | **Tool Calls**: 6
- **Inspected Files**: `lib/router/layer.js`, `lib/router/index.js`, `package.json`
- **Tool Sequence**:
  1. `glob`(pattern="lib/router/*.js") → *59 chars*
  2. `bash`(command="grep -rn \"path-to-regexp\" lib/ | head -20", description="Find path-to-regexp usage in lib") → *67 chars*
  3. `read`(file_path="/Users/kuba/Documents/Github/graphify-plugin-ds...") → *4269 chars*
  4. `bash`(command="grep -n \"match_path\\|\\.match(\\|process_params\\|...", description="Find router call site and versions") → *253 chars*
  5. `read`(file_path="/Users/kuba/Documents/Github/graphify-plugin-ds...", offset=560, limit=45) → *1194 chars*
  6. `bash`(command="grep -n \"matchLayer\" lib/router/index.js; sed -...", description="Show matchLayer call site context") → *1529 chars*

#### Treatment Arm (DSH + Graphify)
- **Outcome**: ✅ Solved
- **Tokens**: 49,215 total (Input: 47,530, Output: 1,685)
- **Duration**: 144s | **Tool Calls**: 4
- **Inspected Files**: `package.json`, `lib/router/layer.js`, `lib/router/index.js`
- **Tool Sequence**:
  1. `bash`(command="ls lib/router && node -e \"console.log(require('...", description="List router lib files and Express version") → *34 chars*
  2. `read`(file_path="lib/router/layer.js") → *4269 chars*
  3. `grep`(pattern="match_layer|\\.match\\(", path="lib/router/index.js") → *74 chars*
  4. `read`(file_path="lib/router/index.js", offset=555, limit=45) → *1241 chars*

---

## 🛠️ Reproduction & Live Execution

```sh
# 1. Run randomized, counterbalanced live DSH trials on your local model:
node --import tsx benchmark/run-dsh.ts --task task-01-route-match --repetitions 1

# 2. Run full suite with custom output directory:
node --import tsx benchmark/run-dsh.ts --repetitions 3 --output-dir benchmark/results/run-1
```

---
*Report generated on Tue, 15 Sep 2026 00:58:30 GMT by dsh-graphify benchmark suite.*
