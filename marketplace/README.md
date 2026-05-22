# HAPI plugin marketplace metadata

This directory is reserved for marketplace catalog metadata only.

Rules:

- Do not commit installable plugin archives (`.tgz`, `.tar.gz`, `.zip`).
- Do not commit plugin source trees with `hapi.plugin.json`, `dist/`, or `node_modules/`.
- Marketplace entries should point to package assets hosted by the plugin author's GitHub Releases.
- Release builds run `bun run marketplace:check-packaging` to fail if marketplace plugin artifacts would be bundled.

Design: `docs/development/plugin-marketplace-design.md`.
