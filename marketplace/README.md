# HAPI plugin marketplace metadata

This directory is reserved for marketplace catalog metadata only.

Rules:

- Do not commit installable plugin archives (`.tgz`, `.tar.gz`, `.zip`).
- Do not commit plugin source trees with `hapi.plugin.json`, `dist/`, or `node_modules/`.
- Marketplace entries should point to package assets hosted by the plugin author's GitHub Releases.
- Validate catalog changes with `bun run marketplace:validate`.
- Release builds run `bun run marketplace:check` to validate metadata and fail if marketplace plugin artifacts would be bundled.

Contribution path:

1. Publish a `.tgz` or `.zip` HAPI plugin package to your plugin repo's GitHub Releases.
2. Compute the SHA-256 checksum and add/update a metadata entry in `catalog.v1.json`.
3. Run `bun run marketplace:check` before opening a PR.

Design: `docs/development/plugin-marketplace-design.md`.
