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
| `com.hapi.core.serverchan-notifier` | Web + Hub | disabled | Adds a ServerChan notification channel with plugin-owned filtering/config. Requires `SERVERCHAN_SENDKEY` in Hub env. |
| `com.hapi.core.runner-env-profiles` | Web + Runner | disabled | Adds Runner-scoped environment/profile injection for non-secret proxy, registry, and PATH values. |
| `com.hapi.core.runner-spawn-guard` | Web + Runner | disabled | Adds Runner spawn blocking rules for agents, workspace prefixes, and bypass/yolo permission modes. |

Only Schedule Send is default-enabled because it replaces an existing first-party chat-box feature. Other core plugins are installed/discoverable, but require explicit enablement on the relevant target(s).

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
