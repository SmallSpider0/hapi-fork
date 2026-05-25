# HAPI source plugins

This directory contains first-party marketplace plugin source.
The architecture rules here mirror the rules for every HAPI plugin, including external marketplace plugins, uploaded packages, and local user plugins.

Layout:

```text
plugins/<plugin-id>/
  hapi.plugin.json        # runtime manifest
  hapi.marketplace.json   # marketplace display/search metadata
  src/*.js                # ESM runtime entries imported by Hub/Runner
```

Rules:

- Plugins must be real extension implementations, not switches for feature logic that still lives in core.
- Core app code must stay plugin-agnostic: no plugin ID/name/contribution ID branches, plugin-specific routes, or plugin-specific config/env handling.
- Declare capabilities and contributions in `hapi.plugin.json`; implement runtime behavior in `src/*.js` via the SDK registration APIs.
- Web UI must use descriptor primitives from the manifest. New primitives must be reusable by any plugin, not tied to one plugin ID.
- Keep runtime entries as plain ESM JavaScript for now; no plugin-local install/build step.
- Do not commit `node_modules/`, `dist/`, package archives, or symlinks.
- Run `bun run marketplace:generate` after editing source plugins.
- Run `bun run marketplace:check` before opening a PR.

Generated outputs:

- `marketplace/catalog.v1.json`
- `shared/src/plugins/marketplaceSources.generated.ts`

Hub installs these source plugins by packaging the embedded source tree into the existing install-plan flow, so remote Runner installation still receives bytes through RPC instead of reading this repository path directly.
