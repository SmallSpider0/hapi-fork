# Plugin architecture guardrails

HAPI plugins must be real extension implementations, not core features hidden behind a plugin toggle.

## Rules

- Core packages provide generic extension points only.
- Core `hub/src`, `web/src`, and `cli/src` must not hard-code first-party plugin IDs.
- API routes must be named by extension point, not by plugin name.
  - Good: `/api/machines/:id/spawn-options/preview`
  - Bad: `/api/machines/:id/launch-presets/resolve`
- Web settings UI must be descriptor-driven.
  - Good: `kind: "runnerSpawnDefaultsEditor"`
  - Bad: `if (plugin.id === "...") <SpecialPluginEditor />`
- Runtime behavior must be registered by plugin runtime code:
  - Hub: `ctx.notifications.registerChannel`, `ctx.messages.registerAction`
  - Runner: `ctx.runtime.registerSpawnOptionsProvider`, `ctx.runtime.registerEnvironmentProvider`, `ctx.runtime.registerCommandResolver`, `ctx.runtime.registerSpawnHook`, `ctx.actions.register`

## Current first-party plugins

- Schedule Send: Hub message action + Web composer action.
- ServerChan Notifier: Hub notification channel; legacy core ServerChan channel removed.
- Runner Launch Presets: Runner spawn-options provider + generic `runnerSpawnDefaultsEditor` descriptor.

## Verification

Run:

```bash
bun typecheck
bun run test
rg "HAPI_CORE_(SERVERCHAN_NOTIFIER|RUNNER_LAUNCH_PRESETS)_PLUGIN_ID|com\\.hapi\\.core\\.(serverchan-notifier|runner-launch-presets)" hub/src web/src cli/src --glob '!**/*.test.ts'
rg "launch-presets/resolve|resolveRunnerLaunchPresets|RunnerLaunchPresetsEditor" hub/src web/src cli/src --glob '!**/*.test.ts'
```

The `rg` commands should return no matches.
