# Plugin marketplace design

Status: source-first MVP implementation
Date: 2026-05-25

## Goals

- Add a simple HAPI plugin marketplace so users can discover and install plugins from Web and CLI.
- Use HAPI repository source as the default initial distribution path: developers contribute first-party plugin source under `plugins/<plugin-id>/`.
- Keep GitHub Release package entries as an optional future/external distribution path.
- Reuse existing package install, manifest-derived target planning, Hub/Runner RPC fan-out, diagnostics, and scoped config.
- Keep Web descriptor-only; Web never executes third-party plugin JavaScript.
- Ensure release builds do not bundle marketplace plugin packages or source trees from this repo.

## Non-goals

- No paid store, ratings, comments, accounts, or publisher backend for MVP.
- No runtime `npm install`.
- No plugin-local build step for the source-first MVP; runtime entries are plain ESM JavaScript.
- No arbitrary browser-side plugin JS.
- No dependency graph beyond future optional warnings; install one plugin package at a time.
- No sandbox claim: Hub/Runner plugins remain trusted local in-process code.

## Current state

Implemented on this branch:

- `hapi.plugin.json` manifest schema in `shared/src/plugins/manifest.ts`, with runtime placement, contributions, capabilities, compatibility, install hints, permissions, and localized display metadata.
- Package install path in `shared/src/plugins/foundation.ts`: `.tgz` / `.zip`, sha256 checksum, archive traversal/symlink hardening, required `hapi.plugin.package.json`, manifest match checks, and install into `$HAPI_HOME/plugins/<pluginId>`.
- Manifest-derived install planning in `hub/src/plugins/installPlanner.ts`: infer Web/Hub/Runner positions, host compatibility, runner selection, overwrite/conflict/offline handling.
- Hub API in `hub/src/web/routes/plugins.ts`: list/detail/capabilities, install-local, install-package, install-plan, execute plan, enable/disable/reload/delete/config.
- Runner management via machine-scoped RPC; Hub does not touch Runner plugin files directly.
- Web Settings plugin UI can list plugins, upload a package, preview an install plan, execute the plan, and manage enable/config/reload/delete.
- CLI plugin commands can manage local/remote plugin targets.
- Bundled first-party plugins are materialized at runtime from code (`shared/src/plugins/bundledCore.ts`); example plugins are opt-in with `HAPI_ENABLE_BUNDLED_EXAMPLES=1`.

MVP marketplace additions in this branch:

- Shared marketplace catalog/install schemas.
- Hub marketplace fetch/cache service and REST routes.
- HAPI source plugin catalog generation and embedded source payloads.
- Source tree checksum validation, manifest/catalog match validation, temporary package envelope creation, and reuse of the existing install-plan flow.
- GitHub Release package download remains supported for external catalog entries.
- Marketplace source metadata stored on Hub/Runner package installs.
- CLI marketplace list/info/install commands.
- Web Settings marketplace search/preview/install panel.
- Metadata-only marketplace directory plus validation/packaging guard scripts.

Remaining gaps:

- No signed catalog or maintainer key model.
- No automatic update check/upgrade UI yet.
- No GitHub Actions workflow for marketplace PRs yet; local `bun run marketplace:check` is available.

Release packaging baseline:

- `bun run build:single-exe(:all)` compiles `cli/src/bootstrap.ts`, embeds Web `web/dist`, and embeds tool assets via explicit imports.
- A marketplace directory is safe only if it stays metadata-only. First-party source plugins live under `plugins/` and are embedded through generated TypeScript (`shared/src/plugins/marketplaceSources.generated.ts`).
- This design adds `bun run marketplace:check` (`marketplace:generate:check` + `marketplace:validate` + `marketplace:check-packaging`), wired into `build`, `build:single-exe`, and `build:single-exe:all`.

## External references

Adopted ideas:

- Obsidian Community Plugins: central list maps plugin metadata to GitHub repo; detail/install use `manifest.json`, `README.md`, GitHub Releases assets, and `versions.json` for compatibility fallback. <https://github.com/obsidianmd/obsidian-releases>
- HACS: static generated data index plus GitHub API freshness checks; custom repositories supported; latest GitHub Release tag is the remote version. <https://www.hacs.dev/docs/faq/data_sources/> and <https://hacs.xyz/docs/publish/start/>
- VS Code Marketplace: manifest-driven uniqueness, SemVer, categories/keywords, runtime placement (`extensionKind`), install/manage/update UX, publisher trust/signature warnings. <https://code.visualstudio.com/api/references/extension-manifest> and <https://code.visualstudio.com/docs/configure/extensions/extension-marketplace>
- Open VSX: optional future model for a dedicated registry + publish CLI. MVP should not need this backend. <https://open-vsx.org/>

## Proposed model

### Marketplace source

MVP source is a generated static catalog:

```text
plugins/<plugin-id>/              # first-party plugin source
marketplace/catalog.v1.json       # generated tracked metadata only
shared/src/plugins/marketplaceSources.generated.ts
```

Runtime default source:

```text
embedded://hapi-marketplace/catalog.v1.json
```

Config overrides:

- `HAPI_PLUGIN_MARKETPLACE_URL` for a single custom catalog URL.
- `$HAPI_HOME/plugin-marketplaces.json` later for multiple sources.
- Local file URLs allowed for development.
- `HAPI_PLUGIN_MARKETPLACE_SOURCE_ROOT` can point a local catalog at a checkout root for source-plugin development.

The binary imports the generated embedded source catalog so built-in marketplace plugins are available without a Git checkout or network access. Hub still supports HTTP/file catalogs for external package entries.

### Plugin package ownership

The initial marketplace hosts first-party plugin source in this repo.

Developer flow:

1. Developer edits `plugins/<plugin-id>/`.
2. Plugin root contains `hapi.plugin.json`, `hapi.marketplace.json`, and `src/*.js`.
3. Developer runs `bun run marketplace:generate`.
4. Developer opens a PR containing source and generated metadata updates.

External package flow remains supported for later ecosystem use:

1. Developer maintains a public GitHub repo.
2. Developer builds a `.tgz` or `.zip` HAPI plugin package.
3. Developer publishes it to GitHub Releases and adds a package release entry to a catalog.

### Catalog shape

Draft:

```ts
type PluginMarketplaceCatalog = {
    schemaVersion: 'hapi-plugin-marketplace/v1'
    updatedAt: string
    plugins: PluginMarketplaceEntry[]
}

type PluginMarketplaceEntry = {
    id: string
    name: string
    display?: PluginDisplayMetadata
    description?: string
    repo: `${string}/${string}`
    homepage?: string
    author?: {
        name: string
        url?: string
    }
    license?: string
    categories?: Array<'notification' | 'runner' | 'agent' | 'chat' | 'integration' | 'theme' | 'utility'>
    keywords?: string[]
    runtimes?: Array<'hub' | 'runner'>
    capabilities?: Array<{
        kind: PluginCapabilityKind
        label?: string
    }>
    releases: PluginMarketplaceRelease[]
}

type PluginMarketplaceRelease = {
    version: string
    tag: string
    releasedAt?: string
    manifest: PluginManifestLite
    package?: {
        filename: string
        url: string
        format: 'tgz' | 'zip'
        checksum: `sha256:${string}`
        size?: number
        packageManifestUrl?: string
    }
    source?: {
        type: 'hapi-source'
        path: `plugins/${string}`
        treeChecksum: `sha256:${string}`
        embedded?: boolean
    }
    compatibility?: PluginManifestLite['compatibility']
    yanked?: {
        reason: string
        replacedBy?: string
    }
}
```

Rules:

- `entry.id === release.manifest.id`.
- Latest non-yanked compatible release is default.
- `release.tag` should match plugin version by convention (`hapi-source-${version}` for built-ins, `v${version}` or exact version for packages).
- For package releases, `package.url` should be a GitHub Release asset URL or raw URL; redirect allowed, final host shown before install.
- For source releases, `source.path` must stay under `plugins/` and `treeChecksum` covers sorted file path/content pairs.
- Catalog may embed `manifest` to render and plan without downloading every package. Install still downloads package and re-validates embedded `hapi.plugin.package.json`.
  Source installs re-read embedded/local source files, validate tree checksum, validate manifest match, then create a temporary package envelope for the existing install-plan path.

### Optional `versions.json`

Borrow Obsidian's compatibility fallback idea:

```json
{
    "0.1.0": { "hapi": ">=0.18.4", "pluginApi": ">=0.1 <0.2" },
    "0.2.0": { "hapi": ">=0.20.0", "pluginApi": ">=0.2 <0.3" }
}
```

MVP can skip fetching this if catalog releases already include compatibility. Later, the validator can use it to generate release metadata.

## Hub API

Hub owns network fetch and install; Web only calls authenticated Hub APIs.

New routes:

```text
GET  /api/plugins/marketplace
GET  /api/plugins/marketplace/:id
POST /api/plugins/marketplace/:id/install-plan
POST /api/plugins/marketplace/:id/install
POST /api/plugins/marketplace/refresh
```

Query filters:

- `q`
- `category`
- `runtime=hub|runner`
- `target=hub|runner:<machineId>|all-runners`
- `installed=true|false`

Install plan request:

```ts
type PluginMarketplaceInstallPlanRequest = {
    version?: string
    target?: PluginTargetScope
    runnerSelection?: PluginInstallRunnerSelection
    enable?: boolean
    overwrite?: boolean
}
```

Hub behavior:

1. Resolve marketplace entry and compatible release.
2. If release is package-backed: download package and verify checksum.
3. If release is HAPI-source-backed: load embedded/local source tree, verify `treeChecksum`, verify `hapi.plugin.json` matches catalog manifest, and create a temporary `.tgz` package envelope.
4. Inspect `hapi.plugin.package.json`.
5. Confirm catalog manifest and package/source manifest agree.
6. Convert to current `PluginInstallPlanRequest` using `contentBase64`, `checksum`, `format`, and marketplace source metadata.
7. Reuse `createInstallPlan()` and existing execute path.

Install route can either return a plan only or internally create + execute after user confirmation. Web should prefer explicit plan preview.

## CLI UX

Commands:

```bash
hapi plugins marketplace list [--q serverchan] [--category notification]
hapi plugins marketplace info <plugin-id>
hapi plugins marketplace install <plugin-id> [--version x.y.z] [--enable] [--overwrite] [--runners compatible|all|id1,id2]
hapi plugins marketplace refresh
hapi plugins marketplace add-source <url>        # later
```

Aliases can be short:

```bash
hapi plugins search <query>
hapi plugins install <plugin-id>
```

Keep `install-package` and `install-local` for manual/dev flows.

## Web UX

Settings → Plugins:

- Split into tabs: `Installed` and `Marketplace`.
- Marketplace list cards:
  - localized name/description
  - categories/runtimes/capabilities
  - installed/current/latest version
  - source repo, license, author
  - warning chip for trusted local code
- Detail page:
  - README excerpt or `display.featureIntro`
  - permissions/secrets/network from manifest
  - release selector
  - target compatibility preview
- source path or package host/checksum
  - install/update button
- Install flow:
  1. Click install.
  2. Hub downloads metadata/package and returns plan.
  3. User reviews target actions and trust warning.
  4. Execute plan.

Do not render arbitrary remote README HTML; use existing Markdown renderer with sanitization and length limits.

## Installed metadata

Extend `PluginInstallMetadataSchema`:

```ts
sourceType:
  | 'env'
  | 'user-home'
  | 'bundled'
  | 'hub-local-path'
  | 'runner-local-path'
  | 'uploaded-package'
  | 'marketplace'

marketplace?: {
    sourceUrl: string
    pluginId: string
    repo: string
    version: string
    assetUrl: string
    checksum: string
}
```

This powers update badges:

- installed but not in current catalog → `unknown-source`
- installed version lower than latest compatible → `update-available`
- installed release yanked → `yanked`

## Contribution workflow

PR adds/updates catalog metadata only.

Required checks:

- JSON schema validation.
- Unique plugin id.
- Reverse-domain or npm-style id recommended.
- Repo URL is public GitHub.
- Release asset URL reachable.
- Package checksum matches.
- Package contains one plugin root.
- Package manifest matches `hapi.plugin.json`.
- Manifest `pluginApiVersion` is supported.
- README and LICENSE present in plugin repo.
- No secrets in sample config.
- No committed plugin archives/source trees in `marketplace/`.

Manual review:

- Check purpose and category.
- Check permissions/network/secrets are plausible.
- Check README has usage and uninstall/config notes.
- Check no obvious malicious install/postinstall pattern in packaged JS. This is review, not a sandbox guarantee.

## Packaging isolation

Invariant:

> The HAPI release artifact may include first-party source plugins through generated embedded source, marketplace metadata, and UI code, but must not include third-party marketplace plugin packages.

Rules:

- `marketplace/` stores generated JSON/Markdown metadata only.
- First-party source plugins live in `plugins/` and are embedded through a generated TypeScript module.
- External plugin packages live in contributors' GitHub Releases.
- Runtime code must not statically import `marketplace/**`.
- Web build must not copy `marketplace/**` into `web/dist`.
- Bun single-exe build embeds only explicit source imports and generated Web assets.
- Release/build scripts run `bun run marketplace:check`.

Guard behavior:

- fails on `marketplace/**/*.tgz`, `.tar.gz`, `.zip`;
- fails on `marketplace/**/hapi.plugin.json`;
- fails on `marketplace/**/dist/**` or `marketplace/**/node_modules/**`;
- fails on `plugins/**/node_modules/**`, `plugins/**/dist/**`, and plugin package archives;
- fails on relative static imports from runtime source into top-level `marketplace/**`.

Catalog validator behavior:

- verifies generated marketplace files are up to date;
- validates `marketplace/catalog.v1.json` with the shared marketplace schema;
- enforces unique plugin ids and release versions;
- enforces GitHub Release asset URLs under the declared `owner/repo` for package releases;
- enforces package filename extension matches `format`;
- enforces source releases stay under `plugins/` and declare a tree checksum;
- enforces SHA-256 checksums through the shared schema.

## Security posture

Marketplace should show this before install:

- Hub/Runner plugins are trusted local code.
- Manifest permissions are disclosure/UX metadata, not a hard sandbox.
- Install only from maintainers/repos you trust.
- Check source tree/package checksum and source repo.
- Secrets are still provided through environment/context, not Web config storage.

Future hardening:

- Signed catalog releases.
- Maintainer signing keys.
- Sigstore/provenance.
- Enterprise allow/deny list.
- Mirror/private marketplace sources.

## Implementation phases

### Phase 1: schema + source catalog generation

- Add `shared/src/plugins/marketplace.ts` schemas.
- Add `plugins/<plugin-id>/` source layout.
- Add generator for `marketplace/catalog.v1.json` and embedded source module.
- Add `hub/src/plugins/marketplaceService.ts`:
  - source URL config;
  - fetch/cache/refresh;
  - release selection;
  - package download + checksum verify;
  - embedded/local HAPI source package envelope creation.
- Add hub routes above.
- Tests: schema parse, release selection, checksum mismatch, yanked release ignored.

### Phase 2: install integration

- Convert marketplace release to existing package install-plan request.
- Extend install metadata with marketplace source.
- Update Hub/Runner install result metadata.
- Tests: plan from catalog release; install stores marketplace metadata; update detection.

### Phase 3: CLI

- Add marketplace subcommands.
- Reuse remote plugin admin client.
- Tests: list/info/install dry-run output.

### Phase 4: Web

- Add Marketplace tab.
- Add detail/plan/install flow.
- Add localized strings.
- Tests: metadata helper, install plan UI smoke if current test stack supports it.

### Phase 5: contribution automation

- Add catalog validator script.
- Add GitHub workflow on PR touching `marketplace/**`.
- Generate `marketplace/catalog.v1.json` and `shared/src/plugins/marketplaceSources.generated.ts` from `plugins/**`.

## Acceptance gates

- `bun run marketplace:check`
- `bun typecheck`
- `bun run test`
- `bun run build:single-exe` or CI `bun run build:single-exe:all`
- Manual install test from an embedded source marketplace plugin:
  1. marketplace list shows entry;
  2. install plan matches manifest positions;
  3. install executes to Hub and selected Runner;
  4. installed metadata records `distribution: hapi-source`;
  5. release artifact contains generated first-party source but no committed marketplace package archives.
