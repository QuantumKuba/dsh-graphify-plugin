# dsh-graphify

`dsh-graphify` connects [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) to [Graphify](https://github.com/Graphify-Labs/graphify): a local knowledge graph with architecture queries, dependency paths, communities, and pull-request impact analysis.

The plugin uses the receiving DSH session’s project directory. It does not assume that the DSH host process started in the project, so one interactive DSH process can safely serve several workspaces.

## Install

Install Graphify with its MCP extra. The extra is required for `python -m graphify.serve`.

```sh
uv tool install 'graphifyy[mcp]'
pnpm add dsh-graphify
```

Build the first graph from the project root:

```sh
graphify .
```

Add the bundle to a DSH patch:

```yaml
- insert:
    - id: dsh-graphify
      name: dsh-graphify
      config:
        cwd: /absolute/path/to/project
```

`cwd` is optional when the DSH session already has a project cwd or Graphify can find `graphify-out/graph.json` from the DSH startup directory. Set it when configuring a process-wide plugin for a fixed project.

## Commands and tools

The direct human command is available only in interactive DSH adapters that compose `ctx.commands`. A headless `dsh` invocation treats `/graphify` as model input; use normal Graphify CLI commands when running headless.

In DSH Web, the package's browser companion renders the submitted `/graphify` line and DSH's durable result card. Both successful output and failures remain visible after reload because they are reconstructed from `command/run` and `command/done` session events.

```text
/graphify                         build the receiving session’s project
/graphify build ../another-project
/graphify update                  incrementally rebuild changed code
/graphify update . --force
```

The command accepts one path plus `--force` or `--no-cluster`. Graph questions belong in model tools, not the slash command.

The plugin exposes Graphify’s native MCP tools:

- `query_graph`, `get_node`, `get_neighbors`, `get_community`, `god_nodes`, `graph_stats`, and `shortest_path`
- `list_prs`, `get_pr_impact`, and `triage_prs`

It also exposes three compatibility tools:

- `graphify_capabilities` lists the installed server’s tools and resources.
- `graphify_call` invokes a newly added Graphify MCP tool before this package releases a dedicated DSH schema.
- `graphify_resource` reads Graphify resources such as `graphify://report`, graph statistics, confidence audit, and suggested questions.

Every native tool supplies `project_path` automatically from the calling agent’s session cwd. An explicit `project_path` always wins.

You do not need to start `python -m graphify.serve` separately. The plugin starts and owns an MCP subprocess when an agent first calls a Graphify tool. The `/graphify` command is independent of that MCP subprocess and invokes the Graphify CLI directly.

## Runtime configuration

The default `command: auto` first uses the interpreter behind an installed `graphify` command. If Graphify is not installed, it uses `uv run --with graphifyy[mcp]`. The installed runtime is preferred so a working deployment does not download a different Graphify version at every DSH startup.

| Setting | Default | Meaning |
| --- | --- | --- |
| `command` | `auto` | MCP server executable. Configure this with `args` for a custom server runtime. |
| `args` | `[]` | Arguments for a configured MCP server executable. |
| `graphifyVersion` | unset | Version used only by the `uv` fallback, for example `0.9.50`. |
| `cliCommand` | unset | Executable used for `/graphify`; defaults to the installed `graphify` command. |
| `cliArgs` | `[]` | Arguments placed before the Graphify build or update operation. |
| `graphPath` | unset | Explicit `graph.json` path. |
| `cwd` | unset | Fixed fallback project directory. |
| `autoDetect` | `true` | Search ancestors for `graphify-out/graph.json`. |
| `enablePromptSection` | `true` | Tell the model when to use Graphify. |
| `timeoutMs` | `60000` | Per-MCP-operation timeout in milliseconds. |
| `toolPrefix` | `''` | Prefix every registered tool name. |

For example, a pinned custom Python runtime is configured as follows:

```yaml
config:
  command: /opt/graphify/bin/python
  args: ['-m', 'graphify.serve']
  cliCommand: /opt/graphify/bin/graphify
```

The plugin preserves the environment passed by DSH. This is necessary for Graphify’s GitHub PR tools to use `GH_TOKEN` or `GITHUB_TOKEN`. Configure credentials through DSH’s credential mechanism; do not put secrets in the patch file.

## Keeping Graphify current

There are two independent update loops:

1. Keep graph data current with `graphify hook install` and `graphify update .` after code changes. Graphify also provides `graphify watch <path>` for a long-running local watcher.
2. Keep the Graphify runtime current with `uv tool upgrade graphifyy` followed by `graphify hook install` when hooks are used. Use `uv tool install --reinstall 'graphifyy[mcp]'` if the MCP extra was not originally installed.

This repository runs a weekly scheduled GitHub Actions contract test against the latest `graphifyy[mcp]`. It verifies MCP initialization, the core tool list, and Graphify resources before a release is made. Production deployments can pin `graphifyVersion` while qualifying a new version, then upgrade deliberately.

## Development

```sh
pnpm run typecheck
pnpm run build
pnpm test
```

Unit tests use a local fake MCP server and never require Graphify, a network connection, or a user cache. Run the upstream compatibility contract after installing `graphifyy[mcp]`:

```sh
GRAPHIFY_E2E=1 pnpm run test:e2e
```
