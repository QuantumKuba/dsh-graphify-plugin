# DSH Web client package moves

## Decision

The Graphify command Web client follows the package layout of DSH `0.1.5-rc.2` and later, including the `next` (`0.2.0-rc.2`) and `alpha` (`0.2.1-alpha.1`) channels:

- The `graphify-command-input` node data is declared on `ChatNodeDataMap` in `@deepseek-ai/dsh-client-ui-chat/client`.
- `ConversationNodeDefinition` is imported from `@deepseek-ai/dsh-client-ui-conversation/client` instead of being redeclared locally.
- The `slots`, `locale`, and `uiConversation` Context members come from the `/client` type augmentations of the chat, conversation, locale, and renderer packages. `src/web-client.ts` no longer redeclares `uiConversation`.
- The input bubble renders `node.data.text` directly. `MessageText` is no longer exported by `@deepseek-ai/dsh-client-ui-primitives`, and the bubble already sets `white-space: pre-wrap`.
- `dsh.client.inject` and the development dependencies add `dsh-client-ui-chat`, `dsh-client-ui-renderer`, and `dsh-util-values`. `snapshotJsonValue` now comes from `@deepseek-ai/dsh-util-values`.

The DSH compatibility workflow upgrades the same package set for each channel. `@deepseek-ai/schemastery` is a runtime dependency, so the workflow upgrades it with `pnpm add`, not `pnpm add -D`.

## Context

The weekly `DeepSeek Harness & Upstream Compatibility` run failed its Typecheck step on both channels with ten errors in `src/web-client.ts` and `src/web-command.ts`. Each error followed from one of the moved declarations above: the missing `MessageText` export, the conflicting `uiConversation` declaration, the unknown `conversation.chat.node` slot, the missing `slots` member, and a `command/run` event key that was no longer visible without the session type augmentation.

GitHub Actions also warned that `actions/checkout@v4`, `actions/setup-node@v4`, `actions/setup-python@v5`, `pnpm/action-setup@v4`, and `astral-sh/setup-uv@v5` run on the deprecated Node.js 20 runtime, and that `setup-uv` found no `uv.lock` to key its cache on.

## Consequences

Typecheck, build, unit tests, and schema drift detection pass against both `next` and `alpha`. The workflows use the first Node.js 24 majors of each action (`checkout@v5`, `setup-node@v5`, `setup-python@v6`, `pnpm/action-setup@v5`, `setup-uv@v7`) and disable the `setup-uv` cache, since the repository has nothing for it to key on.

The compatibility workflow still resolves transitive DSH packages (`dsh-scope`, `dsh-agent`, and others) at the versions the upgraded packages pull in, so pnpm prints unmet-peer warnings on `alpha`. Typecheck and tests do not depend on those packages directly. The runtime behavior of the Web client inside a live DSH host is covered by the type-level checks and `test/web-client.test.ts`, not by an end-to-end browser test.
