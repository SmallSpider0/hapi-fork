# Phase 00 — 全局边界、术语、验收门槛

更新时间: 2026-05-21
完成证据: `docs/development/plugin-system-boundaries.md` 已将本阶段的边界、术语、非目标与后续验收门槛固化为 tracked developer doc；本文件的 checklist 作为后续阶段 gate 保留，不代表 Phase 00 需要实现 runtime 行为。

## 目标

固定 HAPI 插件系统的安全边界、运行位置、术语、全局 checklist，避免后续把插件系统扩散成无边界大改造；同时明确 Runner/Agent/Web descriptor 是计划内扩展面，而不是被排除在插件系统之外。

## 术语

| 术语 | 定义 |
|---|---|
| Plugin | 用户放入本机插件目录的扩展包；MVP 视为完全信任本地代码。 |
| Manifest | `hapi.plugin.json`；冷路径契约；不执行插件代码即可读取。 |
| Contribution | Manifest 静态声明的能力，例如 notification channel descriptor。 |
| Runtime | 插件代码执行位置；首个 runtime 是 Hub in-process，后续计划增加 Runner runtime；Web 只消费 descriptor，不运行插件代码。 |
| Registry | Core 管理插件记录、状态、diagnostics、已注册 contribution 的中心表。 |
| Diagnostic | 面向用户/doctor 的状态与错误说明。 |
| Disposable | 插件注册资源的清理句柄；Hub shutdown 时调用。 |

## HAPI 固定边界

| 区域 | 决策 |
|---|---|
| Hub | 首个 runtime；Phase 02 支持 notification plugin，Phase 03 支持管理与受控热重载。 |
| CLI | Phase 01 可复用 discovery/state helper；Phase 03 提供本地管理命令，并可触发 Hub reload；后续按 target scope 管理 Runner。 |
| Runner | 计划内 runtime；Phase 04 建立 scope/RPC/state，Phase 05 引入 RunnerPluginManager，Phase 06 开放 Runner 扩展点。 |
| Agent | 计划内扩展面；Phase 07/08 通过 Runner adapter 与 capability provider 接入，不把 session/auth/permission/message ordering 交给插件。 |
| Web | Phase 03 提供插件管理页面；Phase 09 才接入插件贡献的 declarative UI；永不执行未隔离插件 JS。 |
| Shared | 放 manifest/DTO/schema；不放大型 SDK。 |
| Auth/namespace | Core-owned；插件不可绕过。 |
| DB | Core-owned；MVP 无 plugin storage。 |
| RPC/SSE/Socket.IO | Core-owned；插件不能直接拿 gateway/server。 |

## 永不插件化的 core invariant

- auth / JWT / token / namespace 隔离。
- permission flow correctness。
- SQLite schema/migrations。
- Socket.IO/RPC/SSE 基础传输。
- session cache consistency。
- runner trust boundary。
- message ordering/loss recovery。
- terminal/file access 基础权限。

插件只能扩展边缘能力；不能承担核心一致性修复。

## 外部经验取舍

### 应映射到 HAPI

- OpenClaw：manifest-first、明确扫描顺序、central registry、path/symlink hardening、workspace 默认禁用、in-process trust warning。
- VS Code：activation later、contribution descriptor 先于 runtime、Disposable lifecycle、failed/disabled/incompatible/blocked 状态区分。
- IntelliJ：compatibility fields、signed plugin / verifier 思路、动态卸载约束必须显式声明。
- Eclipse：extension registry 概念、dropins 作为目录安装正式路径、热更新后 registry object 不应长期假设有效。
- Happy：不作为通用插件系统样板；只借鉴 Codium 静态 `pluginHost` 的 registry/capability 形状，以及 generic ACP runner 的 command+args adapter 思路。

### 不应映射到 HAPI

- Eclipse OSGi bundle / p2。
- IntelliJ class loader / 复杂 dependency graph。
- VS Code 全量 extension host 立即实现。
- OpenClaw 宽泛 hook/filter/action/provider/service 大集合。
- arbitrary HTTP route / service registry 早期开放。
- Web arbitrary plugin JS。
- project-local runtime 自动启用。
- marketplace/signature/install/update 放进 MVP。
- 插件访问 raw `Session` / `Store` / `SyncEngine` / RPC gateway。
- 把 Happy Codium 的静态 JS 插件模式直接搬到 HAPI Web。
- 把 Happy ACP runner 误当作完整插件系统；它只解决 agent process adapter。

## Checklist 更新规则

勾选前必须按 `README.md` 的“Checklist 勾选与子代理验证规则”执行：提交当前 diff、验证命令、准备勾选条目给 review/verification 子代理；无 blocker 后才更新 `[x]`，并追加验证记录。

## Global checklist

审计说明: 已打钩项为当前已完成阶段的 gate；未打钩项仍属于后续 callback / Web contribution / runner / hardening 阶段，不能仅因尚未存在对应 surface 而视作完成。

### Security / trust

- [x] Disabled plugin never imported。
- [x] Invalid manifest never imported。
- [x] `plugins.json` parse error fail closed。
- [x] Entry path must stay under plugin root after realpath。
- [x] Symlink escape rejected。
- [x] Secrets never stored in `plugins.json`。
- [x] Secrets redacted from logs/diagnostics/API/SSE。
- [x] Enable shows “in-process trusted code” warning。
- [x] Project-local plugins not scanned in MVP。
- [x] Web never executes plugin JS。

### HAPI boundary

- [x] Plugin context does not expose raw `Store` / `SyncEngine` / SQLite。
- [x] Plugin context does not expose Socket.IO / SSE / RPC gateway。
- [x] Plugin notification DTO does not leak internal `Session` shape。
- [x] Namespace included in DTO only for routing/display; authorization remains core-owned。
- [ ] Callback/permission phases enforce namespace in core, not plugin。

### Runtime stability

- [x] Activate throw does not crash Hub。
- [x] One channel send failure does not block other channels。
- [x] Disposable cleanup called on Hub shutdown。
- [x] Dispose failure logged but shutdown continues。
- [x] Diagnostics distinguish invalid/disabled/failed/incompatible/blocked。
- [x] Phase 02 startup-only MVP does not promise hot reload。
- [x] Phase 03 Hub controlled hot reload is explicit and serialized。

### Config / CLI

- [x] Enable/disable writes atomically。
- [x] Concurrent write behavior defined: lock or safe failure。
- [x] Doctor catches missing entry/config/secret。
- [x] CLI local mode only mutates local `$HAPI_HOME`。
- [x] Enable/disable applies through Hub reload or clearly reports reload failure / restart fallback。
- [x] Web plugin management routes require auth and never expose secret values。

### Protocol / future phases

- [ ] Interactive callbacks require auth/signature/replay protection。
- [ ] Permission approve/deny APIs are scoped by namespace/session/request id。
- [ ] Agent descriptors validated before runner spawn。
- [ ] Runner command construction remains core-owned。
- [ ] Web contributions are descriptor-only and mapped to built-in components。

## 验证记录

- 2026-05-21 — review sub-agent — 当前已勾选项来自既有实现/测试证据与本轮计划文档复审；后续任何勾选变更必须追加新的子代理验证记录。
