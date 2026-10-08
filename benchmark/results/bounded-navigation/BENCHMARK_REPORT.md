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
| **Total Tokens** | 52,329 (0) | 71,675 (0) | **+19,346 (+37.0%)** | `[+19,346, +19,346]` | t=0.00, p=1.000 (n.s.) | W=0, p=1.000 (n.s.) | d=0.00 |
| **Irrelevant Files (Noise)** | 0.0 (0.0) | 0.0 (0.0) | **0.0 (0.0%)** | `[0, 0]` | t=0.00, p=1.000 (n.s.) | W=0, p=1.000 (n.s.) | d=0.00 |
| **Inspection Precision** | 50.0% | 50.0% | **0.0%** | `[0.0%, 0.0%]` | t=0.00, p=1.000 (n.s.) | W=0, p=1.000 (n.s.) | d=0.00 |
| **Turns to Solution** | 1.0 | 1.0 | **0.0** | `[0, 0]` | t=0.00, p=1.000 (n.s.) | W=0, p=1.000 (n.s.) | d=0.00 |
| **Duration (seconds)** | 119s | 133s | **+14s** | `[14s, 14s]` | t=0.00, p=1.000 (n.s.) | W=0, p=1.000 (n.s.) | d=0.00 |

---

## 📋 Counterbalanced Live Trial Logs

| Task ID | Rep | Order | Control Tokens | Treatment Tokens | Control Noise | Treatment Noise | Control Prec. | Treatment Prec. | Outcome |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **task-01-route-match** | 1 | `control-first` | 52,329 | 71,675 | 0 files | **0 files** | 50% | **50%** | ✅ / ✅ |

---

## ⚖️ Empirical Observations & Measured Trade-Offs

1. **Token Consumption & Schema Overhead**:
   - Treatment consumed **37% more total tokens** on average (52,329 control vs 71,675 treatment).
   - Mounting Graphify schemas introduces serialization overhead (~1,904 chars in compact mode). Total token savings depend on whether graph retrieval eliminates expensive search loops and file inspections.

2. **Tool Invocations & Latency**:
   - Tool calls: **7** calls (control) vs **8** calls (treatment) (+14%).
   - Duration: **119s** (control) vs **133s** (treatment) (+14s).
   - Graph tool invocations can reduce trial-and-error tool count, but may increase per-turn generation and bridge latency on local quantized models.

3. **Graph Tool Adoption & Noise**:
   - Treatment model actively invoked Graphify tools **3 times** across trials (3.0 calls / trial).
   - Irrelevant file reads: **0** files (control) vs **0** files (treatment).
   - Inspection precision: **50%** (control) vs **50%** (treatment).

> [!NOTE]
> Evaluated on **N = 1** paired trial(s). Single-pair or small-sample results demonstrate execution feasibility and individual trial mechanics, but cannot establish population-level statistical significance.

---

## 🔍 Evaluated Task Traces & Case Studies

### Task: Route Path Matching & Layer Evaluation (`task-01-route-match`)

> **Prompt**: "Where is the core route matching regex and path-to-regexp evaluation logic implemented in Express? Identify the specific class and method responsible for testing if a layer path matches an incoming request URL."

#### Control Arm (Baseline DSH)
- **Outcome**: ✅ Solved
- **Tokens**: 52,329 total (Input: 50,375, Output: 1,954)
- **Duration**: 119s | **Tool Calls**: 7
- **Inspected Files**: `lib/router/layer.js`, `lib/router/index.js`
- **Tool Sequence**:
  1. `glob`(pattern="lib/router/*.js") → *59 chars*
  2. `grep`(pattern="path-to-regexp|pathToRegexp", path="/Users/kuba/Documents/Github/graphify-plugin-ds...") → *87 chars*
  3. `read`(file_path="/Users/kuba/Documents/Github/graphify-plugin-ds...") → *4269 chars*
  4. `grep`(pattern="layer\\.match|\\.match\\(path\\)|function match", path="/Users/kuba/Documents/Github/graphify-plugin-ds...") → *121 chars*
  5. `read`(file_path="/Users/kuba/Documents/Github/graphify-plugin-ds...", offset=200, limit=120) → *3816 chars*
  6. `read`(file_path="/Users/kuba/Documents/Github/graphify-plugin-ds...", offset=560, limit=60) → *1509 chars*
  7. `grep`(pattern="\"version\"|\"path-to-regexp\"", path="/Users/kuba/Documents/Github/graphify-plugin-ds...") → *101 chars*

#### Treatment Arm (DSH + Graphify)
- **Outcome**: ✅ Solved
- **Tokens**: 71,675 total (Input: 69,747, Output: 1,928)
- **Duration**: 133s | **Tool Calls**: 8
- **Inspected Files**: `lib/router/layer.js`, `lib/router/index.js`
- **Tool Sequence**:
  1. `bash`(command="ls -la /Users/kuba/Documents/Github/graphify-pl...", description="List Express workspace and lib directory") → *2249 chars*
  2. `get_node`(label="Layer") → *130 chars*
  3. `get_node`(label="match") → *138 chars*
  4. `read`(file_path="/Users/kuba/Documents/Github/graphify-plugin-ds...") → *4269 chars*
  5. `grep`(pattern="\\.match\\(|layer\\.match|match\\(path", path="/Users/kuba/Documents/Github/graphify-plugin-ds...", include="*.js") → *154 chars*
  6. `get_neighbors`(label=".match()") → *154 chars*
  7. `read`(file_path="/Users/kuba/Documents/Github/graphify-plugin-ds...", offset=545, limit=70) → *1875 chars*
  8. `grep`(include="*.js", path="/Users/kuba/Documents/Github/graphify-plugin-ds...", pattern="matchLayer|process_params") → *301 chars*

---

## 🛠️ Reproduction & Live Execution

```sh
# 1. Run randomized, counterbalanced live DSH trials on your local model:
node --import tsx benchmark/run-dsh.ts --task task-01-route-match --repetitions 1

# 2. Run full suite with custom output directory:
node --import tsx benchmark/run-dsh.ts --repetitions 3 --output-dir benchmark/results/run-1
```

---
*Report generated on Tue, 15 Sep 2026 00:06:12 GMT by dsh-graphify benchmark suite.*
