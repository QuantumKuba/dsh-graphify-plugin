# Navigation efficiency validation

## What is measured

The existing compact-model trial in `benchmark-results.json` reports 62,415 control tokens and 101,418 treatment tokens (+62.5%). The pasted trace analysis reports no Graphify calls in that treatment run. This is a failed adoption case, not evidence that graph retrieval itself saved tokens. The earlier three-task experiment and this one-task experiment are separate samples.

The changed compact schemas serialize to 1,904 characters versus 3,006 at the start of this change: a 36.7% reduction. This counts tool names, descriptions and input schemas with `JSON.stringify`; it excludes the harness, tokenizer and system prompt. Including plugin guidance, the combined serialization falls from 3,654 to 2,622 characters (28.2%). These figures do not establish a reduction in total model tokens.

All tool results have a configured hard text limit, including tools without upstream token-budget support. Live Graphify 0.9.57 returned an `app.handle` search described by upstream as approximately 1,723 tokens despite an 800-token request. The local limit bounds that result to 3,949 characters and labels the omission. Raw MCP metadata remains persisted for inspection.

## Live retrieval smoke

The results in [navigation-check.json](benchmark/navigation-check.json) come from the installed MCP server on the existing Express graph, with freshness warnings disabled to isolate retrieval. These are deterministic retrieval checks, not model trials or answer-accuracy scores.

| Input | Expected file appears | Result characters | Interpretation |
| --- | --- | --- | --- |
| `Layer.match` | Yes | 1,933 | Exact lookup misses; automatic search identifies `lib/router/layer.js:L110`. |
| `app.handle` | Yes | 3,949 | Candidate search includes `lib/application.js`, but also unrelated nodes; source verification remains necessary. |
| `res.send` | No | 255 | The graph lacks a `res.send` method node and upstream returns ambiguous test filenames. The plugin preserves uncertainty rather than inventing a match. |

## Fresh model trial and remaining evaluation

The local model endpoint at `127.0.0.1:1235` requires host network access in this environment. The fresh paired trial ran with `node --import tsx benchmark/run-dsh.ts --fresh --task task-01-route-match --repetitions 1 --output-dir benchmark/results/bounded-navigation`; the original results remain unchanged. Both arms passed the runner’s strict score: control used 57,330 total tokens and seven tool calls; treatment used 54,933 tokens and five calls (4.2% fewer tokens, 28.6% fewer calls). After correcting absolute-path normalization and excluding directory search scopes, both read the same two relevant source files and have zero irrelevant explicit file reads. The uncorrected capture is retained as `before-path-rescore.json`. Wall time increased from 92.1 to 171.3 seconds; this run does not demonstrate a latency improvement. Treatment called `get_node` and `query_graph` before reading the target source. See [paired results](benchmark/results/bounded-navigation/benchmark-results.json). A single control-first pair cannot establish improved accuracy or general token savings; the runner’s promotional summary is not a supported population-level conclusion.

Run repeated paired trials on each supported model class, including known-symbol/unknown-file discovery, verified-path tasks, relationship tracing, missing graph symbols and stale graphs. Keep model settings, source revision, graph revision and profile versions fixed; alternate arm order. Report model requests, actual graph-tool usage, source reads, input/output/cache tokens, latency and answer correctness separately. A session's single user turn is not the number of model requests. Reject a token-saving claim if required-file or answer accuracy regresses. Use held-out repositories as well as Express.

The largest remaining retrieval issue is qualified-symbol ambiguity and missing indexed methods. Address that in upstream extraction/ranking with symbol-location fixtures before adding more graph tools or expanding traversal budgets.

The telemetry parser counts explicit file targets, not every file whose content might appear in a search result. Shell targets remain heuristic; directory-scoped grep calls are not counted as single-file inspections. Path normalization uses the recorded session workspace, and unrelated files with the same basename no longer count as expected files.
