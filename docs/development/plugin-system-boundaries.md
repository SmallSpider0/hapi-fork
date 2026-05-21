# Plugin system boundaries

Status: active boundary for current and future plugin-system work. The first runtime is Hub; the intended system is multi-runtime and must also cover Runner/Agent extension points.

This document fixes the Phase 00 contract for plugin work. Later plugin PRs must keep these boundaries unless they explicitly update this document and explain the security, runtime, and deployment impact.

## Goal

Keep the plugin system small, scoped, and explicit:

- define terms shared by Hub, CLI, Runner, Web, and Shared;
- keep core invariants in core;
- make future acceptance gates explicit;
- support a multi-runtime roadmap without turning auth, realtime sync, storage, runner, or Web rendering into unbounded plugin surfaces.

## Checklist governance

Checklist items in this document and in `localdocs/plugin-system-analysis/final-plan/` are status records, not aspirations. Before changing an item from unchecked to checked:

- provide implementation evidence, validation commands, and the current diff to a review or verification sub-agent;
- fix any blocker reported by that sub-agent before checking the item;
- update the relevant phase file verification log with date, sub-agent type, conclusion, and evidence;
- do not use a Hub-only validation to check a Runner/Agent/Web-descriptor item.

## Terms

| Term | Definition |
|---|---|
| Plugin | An extension package placed in a user-controlled plugin directory. Current plugins are trusted local code, not sandboxed code. |
| Manifest | `hapi.plugin.json`; the cold-path contract that can be read without executing plugin code. |
| Contribution | Static capability declared by a manifest, such as notification channels, Runner providers, agent descriptors, or Web descriptors. |
| Runtime | The process/location where plugin code runs. Hub is the first runtime; Runner runtime is planned. Web consumes descriptors only and must not execute plugin JavaScript. |
| Target scope | The machine/runtime selected for a plugin operation, for example `hub`, `runner:<machineId>`, or `all-runners`. |
| Registry | Core-owned table of plugin records, status, diagnostics, and registered contributions. |
| Diagnostic | User-facing and doctor-facing plugin status/error information. |
| Disposable | Cleanup handle returned by plugin registrations; called during shutdown/deactivation/reload. |

## Existing agent-native plugin terminology

Some current HAPI code already uses the word "plugin" for agent-native concepts, such as Claude slash-command plugin sources and OpenCode hook plugin materialization. Those are not the HAPI plugin system defined here unless a later phase explicitly bridges them through agent descriptors or capability providers.

## Fixed HAPI boundaries

| Area | Decision |
|---|---|
| Hub | First runtime target. Hub notification plugins and Hub-side management/reload may run in-process as trusted local code. |
| CLI | May reuse discovery/state helpers and manage local `$HAPI_HOME`; remote or Runner management must use explicit target scope and typed Hub/Runner APIs. |
| Runner | Planned runtime target. Hub must not read/write Runner plugin files directly; Runner plugin management goes through Runner-owned RPC handlers. Runner command construction remains core-owned. |
| Agent | Planned extension surface via Runner adapter and capability descriptors. Agent descriptors must be validated before spawn; session/auth/permission/message-ordering remain core-owned. |
| Web | Management UI and descriptor renderer only. Web must not execute unsandboxed plugin JavaScript or arbitrary remote bundles. |
| Shared | Holds schemas, DTOs, and narrow shared types. It must not become a large plugin SDK. |
| Auth/namespace | Core-owned. Plugins cannot bypass token, JWT, owner, or namespace checks. |
| DB/storage | Core-owned for current phases. Plugins cannot migrate or write core tables directly; plugin-private storage is deferred until it has a scoped API. |
| RPC/SSE/Socket.IO | Core-owned transport. Plugins cannot receive raw gateways, servers, or sockets. Cross-runtime plugin behavior uses typed core RPC/DTOs. |

## Core invariants that stay in core

The plugin system must not be used to implement or fix these invariants:

- auth / JWT / token / namespace isolation;
- permission-flow correctness;
- SQLite schema and migrations;
- Socket.IO / RPC / SSE base transport;
- session-cache consistency;
- runner trust boundary;
- message ordering and loss recovery;
- terminal/file access base permissions;
- final agent spawn/session lifecycle decisions.

Plugins may extend edge capabilities, providers, presentation, notifications, local environment discovery, and agent adapters. They must not own core consistency or security paths.

## External design choices

### Adopt for HAPI

- Manifest-first metadata, deterministic scan order, central registry, path/symlink hardening, workspace plugins disabled by default, and explicit in-process trust warnings.
- Static contributions before runtime activation, lazy activation where appropriate, disposable registration lifecycle, and clear failed/disabled/incompatible/blocked states.
- Compatibility fields, signing/verifier direction for later distribution, and explicit limits around dynamic unload.
- Directory-installed plugins and registry failure states without adopting heavyweight module systems.
- Lightweight capability registries and generic command+args agent-adapter ideas, without treating agent adapters as the whole plugin system.

### Do not adopt for current phases

- OSGi-style bundles, p2, class loaders, or complex dependency graphs.
- A full extension host before HAPI has stable extension points.
- A broad hook/filter/action/provider/service surface before concrete needs exist.
- Arbitrary HTTP route or service registration.
- Arbitrary Web plugin JavaScript.
- Project-local runtime auto-enable.
- Runtime `npm install`.
- Plugin access to raw `Session`, `Store`, `SyncEngine`, RPC gateway, Socket.IO, or SSE objects.
- Browser-side plugin auth/secret persistence.
- Treating a generic ACP runner as a complete plugin system; it is only an agent process adapter pattern.

## Acceptance checklist for later phases

These gates are stronger than Phase 00 implementation. A later phase can only mark an item done when code or tests prove it and sub-agent verification is recorded.

### Security / trust

- [x] Disabled plugins are never imported for Hub runtime.
- [x] Invalid manifests are never imported for Hub runtime.
- [x] `plugins.json` parse errors fail closed.
- [x] Runtime entry paths stay under the plugin root after `realpath`.
- [x] Symlink escapes are rejected.
- [x] Secrets are never stored in `plugins.json`.
- [x] Secrets are redacted from logs, diagnostics, API responses, and SSE payloads.
- [x] Enable flows show an in-process trusted-code warning.
- [x] Project-local plugins are not scanned in current phases.
- [x] Web never executes plugin JavaScript.
- [ ] Runner runtime repeats disabled/invalid/path-safety checks on the Runner machine.

### HAPI boundary

- [x] Plugin context does not expose raw `Store`, `SyncEngine`, or SQLite.
- [x] Plugin context does not expose Socket.IO, SSE, or RPC gateways.
- [x] Plugin notification DTOs do not leak the internal `Session` shape.
- [x] Namespace may appear in DTOs only for routing/display; authorization stays core-owned.
- [ ] Callback/permission phases enforce namespace in core, not in plugin code.
- [ ] Runner management uses target-scoped RPC and never direct Hub filesystem access.
- [ ] Agent descriptors are validated before runner spawn.

### Runtime stability

- [x] Hub activation failures do not crash Hub.
- [x] One Hub notification channel send failure does not block other channels.
- [x] Disposable cleanup runs during Hub shutdown.
- [x] Dispose failures are logged while shutdown continues.
- [x] Diagnostics distinguish invalid, disabled, failed, incompatible, and blocked plugins.
- [x] Phase 02 startup-only runtime does not promise hot reload.
- [x] Phase 03 Hub controlled reload is serialized and cleans HAPI-mediated resources through Disposable.
- [ ] Runner reload is serialized and failure keeps previous active Runner plugin.

### Config / CLI / Web

- [x] Enable/disable writes are atomic.
- [x] Concurrent write behavior is defined by a lock or a safe failure.
- [x] Doctor catches missing entry, config, and secret issues.
- [x] CLI plugin management is local to `$HAPI_HOME` unless a target-scoped API is used.
- [x] Enable/disable applies through Hub reload or clearly reports reload failure / restart fallback.
- [x] Web plugin management routes require auth and never expose secret values.
- [ ] Config and secret state are scoped by runtime/machine.
- [ ] Cross-device install distinguishes Hub local path, Runner local path, and uploaded package.

### Protocol / future phases

- [ ] Interactive callbacks require auth, signature checks, and replay protection.
- [ ] Permission approve/deny APIs are scoped by namespace, session id, and request id.
- [ ] Runner command construction remains core-owned.
- [ ] Web contributions are descriptor-only and mapped to built-in components.
- [ ] Plugin communication uses typed DTOs and never raw gateways/sockets.

## Verification log

- 2026-05-21 — review sub-agent — Boundary document updated to align with multi-runtime plan, checklist governance, Hub-controlled reload, and Runner/Agent future gates. Future checkbox updates must add a new verification entry.
