# Token-efficient Graphify navigation

## Decision

`dsh-graphify` defaults to the compact five-tool navigation set. Full mode remains available for communities, architecture hubs, pull-request analysis, resources, and forward-compatible capability access.

Graph tools that accept `token_budget` use `resultTokenBudget` as both their default and maximum. The default is 800 tokens; a caller may request less, while deployments that need broader results can raise the configured limit.

The model guidance directs localization through one narrow graph query, exact-node caller analysis through relation-filtered neighbours, and status checks only after a graph failure. Source reads remain authoritative and targeted.

## Context

The paired pilot benchmark showed fewer irrelevant file inspections on structural navigation tasks, but Graphify increased total tokens and tool calls. The full tool schema was included in every model request, agents requested multi-thousand-token graph traversals, routine status checks added calls, and broad blast-radius queries did not reliably identify direct callers.

## Consequences

Default sessions carry fewer Graphify schemas and bounded graph output. Full capabilities require an explicit `toolMode: full` configuration. Large graph responses require an explicit `resultTokenBudget` increase. Blast-radius quality still depends on the graph's extracted relationships, so the guidance does not present broad reachability as a verified impact list.
