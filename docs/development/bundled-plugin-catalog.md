# Bundled plugin catalog policy

Status: implemented on `feat/plugin-runtime-management-roadmap`
Date: 2026-05-22

## Goals

Bundled plugins must demonstrate the plugin model by adding real user-facing capability, not by exposing toy switches in Settings.

Default bundled plugins are split into two classes:

- **Core first-party plugins**: shipped and discovered by default. They may be enabled by default only when replacing an existing core UX with plugin-owned semantics.
- **Examples**: developer/test samples. They are not discovered in normal Hub/Runner startup unless `HAPI_ENABLE_BUNDLED_EXAMPLES=1` is set.

## Default core plugins

| Plugin id | Positions | Default | Purpose |
|---|---|---:|---|
| `com.hapi.core.schedule-send` | Web + Hub | enabled | Adds the chat composer delay picker and owns the Hub message-action plan for reliable scheduled delivery. |
| `com.hapi.core.serverchan-notifier` | Web + Hub | disabled | Adds a ServerChan notification channel with plugin-owned event switches and selectable recent agent/workspace filters. Ready-for-input notifications are on by default. Requires `SERVERCHAN_SENDKEY` in Hub env. |
| `com.hapi.core.runner-env-profiles` | Web + Runner | disabled | Adds Runner-scoped environment/profile injection for non-secret proxy, registry, and PATH values. Supports flat config plus multi-profile JSON. |
| `com.hapi.core.runner-launch-presets` | Web + Runner | disabled | Adds Runner launch defaults by agent/workspace: model, permission/yolo mode, Claude effort, and Codex reasoning effort. |

Only Schedule Send is default-enabled because it replaces an existing first-party chat-box feature. Other core plugins are installed/discoverable, but require explicit enablement on the relevant target(s).

## Marketplace readiness notes

- ServerChan Notifier should be verified with a real `SERVERCHAN_SENDKEY` before marketplace release. Local automated tests mock `fetch`; real delivery requires the operator to trigger a notification from a running Hub. If legacy `SERVERCHAN_NOTIFICATION=true` is also enabled, the Hub skips the old env-driven ServerChan channel when this plugin is enabled to avoid duplicate sends.
- Runner Environment Profiles rejects protected / secret-shaped env keys and uses path-boundary prefix matching (`/repo` does not match `/repo2`). It is intended for non-secret proxy, registry, and PATH changes only.
- Runner Launch Presets applies defaults before command args are built, while New Session user choices override preset fields. HAPI Web renders it with a visual preset list, dynamic Agent/model/permission filtering, draft match testing, and a clearer New Session applied-preset notice; raw JSON remains in developer details.

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
