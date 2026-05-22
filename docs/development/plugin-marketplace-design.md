# Plugin marketplace design

Status: design + packaging guard on `feat/plugin-runtime-management-roadmap`
Date: 2026-05-22

## Goals

- Add a simple HAPI plugin marketplace so users can discover and install plugins from Web and CLI.
- Use GitHub as the default distribution path: developers publish plugin packages in their own GitHub Releases, then contribute metadata to this repo.
- Reuse existing package install, manifest-derived target planning, Hub/Runner RPC fan-out, diagnostics, and scoped config.
- Keep Web descriptor-only; Web never executes third-party plugin JavaScript.
- Ensure release builds do not bundle marketplace plugin packages or source trees from this repo.

## Non-goals

- No paid store, ratings, comments, accounts, or publisher backend for MVP.
- No runtime `npm install`.
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

Missing:

- No marketplace catalog schema/API/UI.
- No fetch/download path from GitHub release asset URL to the existing install-plan flow.
- No installed metadata that can remember marketplace source/release for update checks.
- No contribution workflow / CI validator for marketplace entries.

Release packaging baseline:

- `bun run build:single-exe(:all)` compiles `cli/src/bootstrap.ts`, embeds Web `web/dist`, and embeds tool assets via explicit imports.
- A marketplace directory is safe only if it stays metadata-only and runtime code fetches catalog data over HTTP/file URL. Static imports or committed plugin archives would risk bundling.
- This design adds `bun run marketplace:check-packaging`, wired into `build`, `build:single-exe`, and `build:single-exe:all`.

## External references

Adopted ideas:

- Obsidian Community Plugins: central list maps plugin metadata to GitHub repo; detail/install use `manifest.json`, `README.md`, GitHub Releases assets, and `versions.json` for compatibility fallback. <https://github.com/obsidianmd/obsidian-releases>
- HACS: static generated data index plus GitHub API freshness checks; custom repositories supported; latest GitHub Release tag is the remote version. <https://www.hacs.dev/docs/faq/data_sources/> and <https://hacs.xyz/docs/publish/start/>
- VS Code Marketplace: manifest-driven uniqueness, SemVer, categories/keywords, runtime placement (`extensionKind`), install/manage/update UX, publisher trust/signature warnings. <https://code.visualstudio.com/api/references/extension-manifest> and <https://code.visualstudio.com/docs/configure/extensions/extension-marketplace>
- Open VSX: optional future model for a dedicated registry + publish CLI. MVP should not need this backend. <https://open-vsx.org/>

## Proposed model

### Marketplace source

MVP source is a static catalog:

```text
marketplace/catalog.v1.json       # tracked metadata only
```

Runtime default URL after merge:

```text
https://raw.githubusercontent.com/tiann/hapi/main/marketplace/catalog.v1.json
```

Config overrides:

- `HAPI_PLUGIN_MARKETPLACE_URL` for a single custom catalog URL.
- `$HAPI_HOME/plugin-marketplaces.json` later for multiple sources.
- Local file URLs allowed for development.

The binary must not import this catalog. Hub fetches it at runtime, caches it in memory/disk, and exposes normalized results to Web/CLI.

### Plugin package ownership

Marketplace does not host plugin code in this repo.

Developer flow:

1. Developer maintains a public GitHub repo.
2. Repo root contains `README.md`, `LICENSE`, `hapi.plugin.json`, and optional `versions.json`.
3. Developer builds a plugin package:
   - `plugin-id-vX.Y.Z.hapi-plugin.tgz` or `.zip`
   - includes `hapi.plugin.json`
   - includes `hapi.plugin.package.json`
   - package manifest lists file checksums and package checksum
4. Developer publishes a GitHub Release whose tag matches `hapi.plugin.json.version`.
5. Developer opens PR adding one metadata entry to HAPI marketplace catalog.

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
    package: {
        filename: string
        url: string
        format: 'tgz' | 'zip'
        checksum: `sha256:${string}`
        size?: number
        packageManifestUrl?: string
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
- `release.tag` should match plugin version by convention (`v${version}` or exact version), but catalog stores explicit asset URL to avoid guessing.
- `package.url` should be a GitHub Release asset URL or raw URL; redirect allowed, final host shown before install.
- Catalog may embed `manifest` to render and plan without downloading every package. Install still downloads package and re-validates embedded `hapi.plugin.package.json`.

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
2. Download package to temp file.
3. Verify checksum before extraction.
4. Inspect `hapi.plugin.package.json`.
5. Confirm catalog manifest and package manifest agree.
6. Convert to current `PluginInstallPlanRequest` using `contentBase64`, `checksum`, `format`, and `manifest`.
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
  - package host/checksum
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

> The HAPI release artifact may include marketplace metadata and UI code, but must not include third-party marketplace plugin packages or plugin source trees.

Rules:

- `marketplace/` stores JSON/Markdown metadata only.
- Plugin packages live in contributors' GitHub Releases.
- Runtime code fetches catalog/package URLs; it must not statically import `marketplace/**`.
- Web build must not copy `marketplace/**` into `web/dist`.
- Bun single-exe build embeds only explicit source imports and generated Web assets.
- Release/build scripts run `bun run marketplace:check-packaging`.

Guard behavior:

- fails on `marketplace/**/*.tgz`, `.tar.gz`, `.zip`;
- fails on `marketplace/**/hapi.plugin.json`;
- fails on `marketplace/**/dist/**` or `marketplace/**/node_modules/**`;
- fails on relative static imports from runtime source into top-level `marketplace/**`.

## Security posture

Marketplace should show this before install:

- Hub/Runner plugins are trusted local code.
- Manifest permissions are disclosure/UX metadata, not a hard sandbox.
- Install only from maintainers/repos you trust.
- Check package checksum and source repo.
- Secrets are still provided through environment/context, not Web config storage.

Future hardening:

- Signed catalog releases.
- Maintainer signing keys.
- Sigstore/provenance.
- Enterprise allow/deny list.
- Mirror/private marketplace sources.

## Implementation phases

### Phase 1: schema + fetch service

- Add `shared/src/plugins/marketplace.ts` schemas.
- Add `hub/src/plugins/marketplaceService.ts`:
  - source URL config;
  - fetch/cache/refresh;
  - release selection;
  - package download + checksum verify.
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
- Generate `marketplace/catalog.v1.json` from per-plugin entries if PR conflicts become common.

## Acceptance gates

- `bun run marketplace:check-packaging`
- `bun typecheck`
- `bun run test`
- `bun run build:single-exe` or CI `bun run build:single-exe:all`
- Manual install test from a sample GitHub Release asset:
  1. marketplace list shows entry;
  2. install plan matches manifest positions;
  3. install executes to Hub and selected Runner;
  4. release artifact size does not grow by plugin package size;
  5. `grep -R "marketplace/.*hapi.plugin.json\|\.hapi-plugin\|\.tgz\|\.zip" cli/dist-exe` finds no plugin payload paths.
