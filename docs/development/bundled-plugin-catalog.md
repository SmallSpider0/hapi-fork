# Bundled plugin catalog policy

Status: implemented on `feat/plugin-runtime-management-roadmap`
Date: 2026-05-22

## Goals

Bundled plugins must demonstrate the plugin model by adding real user-facing capability, not by exposing toy switches in Settings.

Bundled plugin definitions are split into two classes:

- **Core first-party plugins**: installed and discovered by default. They may be enabled by default only when replacing an existing core UX with plugin-owned semantics.
- **Ordinary first-party plugins**: available through the normal plugin install path, but not installed or discovered by default.
- **Examples**: developer/test samples. They are not discovered in normal Hub/Runner startup unless `HAPI_ENABLE_BUNDLED_EXAMPLES=1` is set.

## Default-installed first-party plugin

| Plugin id | Positions | Default | Purpose |
|---|---|---:|---|
| `com.hapi.schedule-send` | Web + Hub | installed + enabled | Adds the chat composer delay picker and owns the Hub message-action plan for reliable scheduled delivery. |

Only Schedule Send is default-installed because it replaces an existing first-party chat-box feature.

## Ordinary first-party plugins

| Plugin id | Positions | Default | Purpose |
|---|---|---:|---|
| `com.hapi.serverchan-notifier` | Web + Hub | not installed | Adds a ServerChan notification channel with plugin-owned event switches and selectable recent agent/workspace filters. Ready-for-input notifications are on by default. Requires `SERVERCHAN_SENDKEY` in Hub env. |
| `com.hapi.runner-launch-presets` | Web + Runner | not installed | Adds Runner launch defaults by agent/workspace: model, permission/yolo mode, Claude effort, and Codex reasoning effort. |

These ordinary first-party plugins must be installed through the normal plugin flow, then explicitly enabled on the relevant target(s). Existing development homes that already had them auto-seeded keep those user-home copies until deleted.

## Marketplace readiness notes

- ServerChan Notifier should be verified with a real `SERVERCHAN_SENDKEY` before marketplace release. Local automated tests mock `fetch`; real delivery requires the operator to trigger a notification from a running Hub. `SERVERCHAN_NOTIFICATION` is legacy and no longer registers a core ServerChan channel; delivery is plugin-owned.
- Runner Launch Presets applies defaults through the generic Runner `spawnOptionsProvider` extension point before command args are built, while New Session user choices override preset fields. HAPI Web renders it via the generic `runnerSpawnDefaultsEditor` descriptor and New Session consumes the generic spawn-options preview API; raw JSON remains in developer details.

## Example plugin policy

Examples are opt-in:

```bash
HAPI_ENABLE_BUNDLED_EXAMPLES=1 hapi hub
HAPI_ENABLE_BUNDLED_EXAMPLES=1 hapi runner
HAPI_ENABLE_BUNDLED_EXAMPLES=1 hapi plugins list
```

`HAPI_DISABLE_BUNDLED_EXAMPLE_PLUGINS=1` remains a hard disable for tests and locked-down environments.

Descriptor-only stubs for unsupported future systems (voice provider, deployment pack, MCP bridge) are not bundled anymore. Future examples should satisfy at least one of these criteria:

1. It exercises a real runtime extension point.
2. It is required for an automated regression test.
3. It documents a supported declarative Web primitive without pretending to provide unsupported runtime behavior.

## Runtime placement

Bundled discovery follows manifest-derived placement:

- Hub discovers bundled records that require Hub installation or publish Web descriptors.
- Runner discovers bundled records that require Runner runtime installation.
- A plugin with Web + Runner parts may be present in Hub for descriptors and in each compatible Runner for runtime code.

This keeps installation consistent with normal package installation: users do not choose Hub vs Runner manually; the plugin manifest declares its required positions and compatibility.
