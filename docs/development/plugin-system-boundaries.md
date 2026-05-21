# Plugin system boundaries

Status: design boundary for future plugin-system work. HAPI does not have a user-facing plugin runtime yet.

This document fixes the Phase 00 contract before implementation work starts. Later plugin PRs must keep these boundaries unless they explicitly update this document and explain the security/runtime impact.

## Goal

Keep the plugin system small and scoped:

- establish safety boundaries before runtime code exists;
- define terms shared by Hub, CLI, Runner, Web, and Shared;
- make future acceptance gates explicit;
- avoid turning plugin support into an unbounded cross-cutting rewrite of auth, realtime sync, storage, runner, or Web runtime.

## Terms

| Term | Definition |
|---|---|
| Plugin | An extension package placed in a user-controlled plugin directory. MVP plugins are trusted local code, not sandboxed code. |
| Manifest | `hapi.plugin.json`; the cold-path contract that can be read without executing plugin code. |
| Contribution | Static capability declared by a manifest, such as a notification-channel descriptor. |
| Runtime | The process/location where plugin code runs. MVP runtime is limited to Hub in-process code. |
| Registry | Core-owned table of plugin records, status, diagnostics, and registered contributions. |
| Diagnostic | User-facing and doctor-facing plugin status/error information. |
| Disposable | Cleanup handle returned by plugin registrations; called during shutdown/deactivation. |

## Existing agent-native plugin terminology

Some current HAPI code already uses the word "plugin" for agent-native concepts, such as Claude slash-command plugin sources and OpenCode hook plugin materialization. Those are not the HAPI plugin system defined here, and Phase 00 does not change their behavior.

## Fixed HAPI boundaries

| Area | Decision |
|---|---|
| Hub | First runtime target. Notification-channel plugins may be introduced after the cold-path foundation. |
| CLI | May reuse discovery/state helpers after the foundation exists. Local management commands come later. |
| Runner | No plugin runtime before agent/runner descriptors are designed. Runner command construction remains core-owned. |
| Web | No plugin runtime before declarative descriptors are designed. Web must not execute unsandboxed plugin JavaScript. |
| Shared | Holds schemas, DTOs, and narrow shared types. It must not become a large plugin SDK. |
| Auth/namespace | Core-owned. Plugins cannot bypass token, JWT, owner, or namespace checks. |
| DB/storage | Core-owned for MVP. Plugins cannot migrate or write core tables directly. MVP has no plugin-private persistent storage; plugin SQLite/storage APIs are deferred. |
| RPC/SSE/Socket.IO | Core-owned transport. Plugins cannot receive raw gateways, servers, or sockets. |

## Core invariants that stay in core

The plugin system must not be used to implement or fix these invariants:

- auth / JWT / token / namespace isolation;
- permission-flow correctness;
- SQLite schema and migrations;
- Socket.IO / RPC / SSE base transport;
- session-cache consistency;
- runner trust boundary;
- message ordering and loss recovery;
- terminal/file access base permissions.

Plugins may extend edge capabilities, providers, presentation, and local policies. They must not own core consistency or security paths.

## External design choices

### Adopt for HAPI

- Manifest-first metadata, deterministic scan order, central registry, path/symlink hardening, workspace plugins disabled by default, and explicit in-process trust warnings.
- Static contributions before runtime activation, lazy activation, disposable registration lifecycle, and clear failed/disabled/incompatible/blocked states.
- Compatibility fields, signing/verifier direction for later distribution, and explicit limits around dynamic unload.
- Directory-installed plugins and registry failure states without adopting heavyweight module systems.
- Lightweight capability registries and generic command+args agent-adapter ideas, without adopting a Web plugin runtime.

### Do not adopt for MVP

- OSGi-style bundles, p2, class loaders, or complex dependency graphs.
- A full extension host before HAPI has stable extension points.
- A broad hook/filter/action/provider/service surface before concrete needs exist.
- Arbitrary HTTP route or service registration.
- Arbitrary Web plugin JavaScript.
- Project-local runtime auto-enable.
- Marketplace, signature, install, or update flows.
- Plugin access to raw `Session`, `Store`, `SyncEngine`, RPC gateway, Socket.IO, or SSE objects.
- Browser-side plugin auth/secret persistence.
- Treating a generic ACP runner as a complete plugin system; it is only an agent process adapter pattern.

## Acceptance gates for later phases

These gates are intentionally stronger than Phase 00 implementation. A later phase can only mark an item done when code or tests prove it.

### Security / trust

- Disabled plugins are never imported.
- Invalid manifests are never imported.
- `plugins.json` parse errors fail closed.
- Runtime entry paths stay under the plugin root after `realpath`.
- Symlink escapes are rejected.
- Secrets are never stored in `plugins.json`.
- Secrets are redacted from logs, diagnostics, API responses, and SSE payloads.
- Enable flows show an in-process trusted-code warning.
- Project-local plugins are not scanned in MVP.
- Web never executes plugin JavaScript.

### HAPI boundary

- Plugin context does not expose raw `Store`, `SyncEngine`, or SQLite.
- Plugin context does not expose Socket.IO, SSE, or RPC gateways.
- Plugin notification DTOs do not leak the internal `Session` shape.
- Namespace may appear in DTOs only for routing/display; authorization stays core-owned.
- Callback/permission phases enforce namespace in core, not in plugin code.

### Runtime stability

- Activation failures do not crash Hub.
- One channel send failure does not block other channels.
- Disposable cleanup runs during Hub shutdown.
- Dispose failures are logged while shutdown continues.
- Diagnostics distinguish invalid, disabled, failed, incompatible, and blocked plugins.
- MVP docs and CLI output do not promise hot reload.

### Config / CLI

- Enable/disable writes are atomic.
- Concurrent write behavior is defined by a lock or a safe failure.
- Doctor catches missing entry, config, and secret issues.
- CLI plugin management is local to `$HAPI_HOME`.
- Enable/disable output says Hub restart is required when hot reload is unavailable.

### Protocol / future phases

- Interactive callbacks require auth, signature checks, and replay protection.
- Permission approve/deny APIs are scoped by namespace, session id, and request id.
- Agent descriptors are validated before runner spawn.
- Runner command construction remains core-owned.
- Web contributions are descriptor-only and mapped to built-in components.
