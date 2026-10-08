# Bounded symbol discovery

## Decision

Compact tool schemas expose navigation choices and use configured budgets and the session workspace. Full mode retains operational overrides. Every canonical result text is bounded by `resultMaxChars`, including errors, resources, and diagnostics; raw MCP metadata remains persisted. Truncation is explicit and asks for narrower discovery rather than repeating a larger traversal. The limit measures UTF-16 code units, not tokens.

An explicit `get_node` no-match response triggers one bounded depth-one `query_graph` request in the same project with the same cancellation signal. Candidate results are labeled and both upstream responses remain in metadata. This handles qualified symbols such as `Layer.match` when the indexed label is `.match()`. Other responses do not trigger recovery; the fallback is intentionally limited to the observed upstream no-match text and must be checked against new Graphify releases.

## Evidence and tradeoffs

The supplied compact-mode trial used no Graphify calls and consumed 101,418 tokens versus 62,415 for control. Familiar symbol names did not provide verified paths. Prompt guidance distinguishes those cases without requiring graph calls when a path is already supplied. Live Express Graphify lookup confirms that the qualified symbol misses exact lookup but search returns `lib/router/layer.js:L110`.

Compact schema serialization falls from 3,006 to 1,904 characters in this checkout. This measures schema size, not actual model token savings. Hard output limits can omit evidence, so the notice requires source verification. A fallback costs another MCP request but avoids asking the model to plan an exact-match recovery. No claim of improved end-to-end accuracy follows from these deterministic checks. New paired model trials remain necessary.

## Verification

Tests cover all native navigation result limits, escape calls, Unicode truncation, invalid configuration, compact schema size, and explicit no-match recovery. Real MCP schema checks validate the supported installed Graphify tool definitions. These plugin-owned output tests do not replace a recorded DSH model session benchmark.

The fresh Qwen paired trial passes both strict scores with 57,330 control tokens and 54,933 treatment tokens (4.2% less), and seven versus five tool calls. Latency is worse (92.1 versus 171.3 seconds); one pair does not establish general savings. Benchmark inspection paths are normalized against the recorded workspace, directory search scopes are excluded, and basename collisions do not count as relevant files. Both arms inspect the same two relevant files after rescoring. `--output-dir` isolates new trials from existing results.
