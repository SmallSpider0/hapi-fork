# Plugin architecture guardrails

HAPI plugins must be real extension implementations, not core features hidden behind a plugin toggle.

## Rules

- Core packages provide generic extension points only.
- Core `hub/src`, `web/src`, and `cli/src` must not hard-code first-party plugin IDs.
- Runtime-supported extension points are declared once in `shared/src/plugins/extensionPoints.ts`.
- API routes must be named by extension point, not by plugin name.
  - Good: `/api/machines/:id/spawn-options/preview`
  - Bad: `/api/machines/:id/launch-presets/resolve`
- Web settings UI must be descriptor-driven.
  - Good: `kind: "runnerSpawnDefaultsEditor"`
  - Bad: `if (plugin.id === "...") <SpecialPluginEditor />`
- Runtime behavior must be registered by plugin runtime code:
  - Hub: `ctx.notifications.registerChannel`, `ctx.messages.registerAction`
  - Runner: `ctx.runtime.registerSpawnOptionsProvider`, `ctx.runtime.registerEnvironmentProvider`, `ctx.runtime.registerCommandResolver`, `ctx.runtime.registerSpawnHook`, `ctx.actions.register`
- Shared runtime-only helpers live under `shared/src/plugins/runtime/*`; Hub/Runner should reuse them instead of duplicating activation, diagnostics, filesystem, registry, state CRUD, reload, compatibility, or capability-view logic.
- Hub plugin admin routes should stay thin. Inventory, fanout, install-plan, marketplace, target, and notification-option logic live under `hub/src/plugins/admin/*`.

## Implemented extension points

Source of truth: `shared/src/plugins/extensionPoints.ts`.

- Hub host info uses `HUB_IMPLEMENTED_EXTENSION_POINTS`.
- Runner host info uses `RUNNER_IMPLEMENTED_EXTENSION_POINTS`.
- Schema-only/future points use `SCHEMA_ONLY_EXTENSION_POINTS` and must not be advertised by Hub/Runner host info.
- `hub.action` is not implemented.

## Runner extension semantics

- User-set `manualFields` win over plugin spawn-option defaults.
- Env keys starting with `HAPI_`, plus protected auth/home keys, are not plugin-overridable. Windows env keys are compared case-insensitively.
- `toolPaths` in `RunnerEnvironmentProposal` is reserved for future structured tool resolution. Current Runner records a warning and does not apply it.

## Compatibility checks

- Version ranges support `*`, exact versions, `=`, `<`, `<=`, `>`, `>=`, caret ranges, whitespace-separated AND, and `||` OR.
- Whitespace after comparators is accepted, e.g. `>= 0.18.0 < 0.19.0`.
- Global `compatibility.os/arch` and runtime-specific `compatibility.hub|runner.os/arch` are both enforced.

## Current first-party plugins

- Schedule Send: Hub message action + Web composer action.
- ServerChan Notifier: Hub notification channel; legacy core ServerChan channel removed.
- Runner Launch Presets: Runner spawn-options provider + generic `runnerSpawnDefaultsEditor` descriptor.

## Verification

Run:

```bash
bun typecheck
bun run test
bun run docs:plugin-api:check
bun run marketplace:check
rg "HAPI_(SERVERCHAN_NOTIFIER|RUNNER_LAUNCH_PRESETS)_PLUGIN_ID|com\\.hapi\\.(serverchan-notifier|runner-launch-presets)" hub/src web/src cli/src --glob '!**/*.test.ts'
rg "launch-presets/resolve|resolveRunnerLaunchPresets|RunnerLaunchPresetsEditor" hub/src web/src cli/src --glob '!**/*.test.ts'
rg "'hub\\.action'|\\\"hub\\.action\\\"" hub/src cli/src shared/src --glob '!**/*.test.ts'
```

The `rg` commands should return no matches.
