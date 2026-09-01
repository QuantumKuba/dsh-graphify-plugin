# Graphify command Web presentation

## Decision

`dsh-graphify` ships a DSH Web client companion that projects each durable `command/run` for `/graphify` into a visible Chat node. DSH's generic command node continues to own the correlated `command/done` result or error.

The bundle row id, package name, and host plugin name are all `dsh-graphify`. DSH discovers a package's browser companion through the active Loader entry, so these identities must not diverge.

The package export map exposes `./package.json`. DSH resolves that subpath from the profile's config-tree anchor before it reads `dsh.client`; without the export, discovery treats the package as having no browser companion.

## Context

DSH Web keeps its blank composer posture when a new session contains only generic command rows. The host command still executes and persists both `command/run` and `command/done`, but neither row is visible until some non-command Chat content activates the conversation. A `/graphify` invocation in a fresh session therefore appears to do nothing even though the result is present in the session log.

## Consequences

The client projection makes the human command visible, activates the conversation, and exposes the existing generic result card without duplicating command execution or inventing another logging channel. Reload reconstructs the same presentation from session events. Other extension commands with the same requirement still need an owned presentation contribution or a future shared DSH facility.
