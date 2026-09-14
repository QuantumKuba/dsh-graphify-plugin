# dsh-graphify user onboarding

## Decision

The package README leads with the user outcome, a visual overview, and a four-step first run. It distinguishes Graphify's local graph engine from the DSH-native integration, then describes the plugin's session-aware project resolution, freshness policy, focused compact mode, command UI, and runtime diagnosis as user-facing advantages.

The README keeps detailed implementation material out of the installation path. It presents the common configuration choices and links the complete schema to its source. The repository distributes the overview image in the npm package so that the rendered README works in package registries as well as on GitHub.

## Consequences

Users can see the purpose of the plugin before choosing configuration. The initial setup has one plugin command, one runtime-install command, and one graph-build command. The documentation names the limits of incremental updates and benchmark claims, so the quickstart does not imply stale graphs are current or experimental results are established evidence.
