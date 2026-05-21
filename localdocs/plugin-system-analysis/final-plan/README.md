# HAPI 插件系统最终分阶段计划

更新时间: 2026-05-21
状态: 多运行时路线；当前 Hub runtime/管理体验是第一块能力，不代表最终范围。

## 总判断

HAPI 插件系统的目标不是“Hub 插件系统”，而是 **多运行时插件系统**：Hub、Runner、Agent 与 Web descriptor 共同组成一个受控扩展面。

当前已经落地的 Hub notification runtime、CLI/Web 管理、Hub 热重载、本地路径安装与删除，是第一阶段产品化结果。后续阶段必须继续补 Runner/Agent 扩展能力，尤其要覆盖 Hub 与 Runner 不在同一台设备的场景。

## 运行时分层

| 层级 | 插件代码运行位置 | 主要价值 | 不变边界 |
|---|---|---|---|
| Hub runtime | Hub 进程所在机器 | 通知渠道、回调、中心集成、Hub 侧配置 | 不暴露 raw `Store` / `SyncEngine` / Socket.IO / SSE / RPC gateway。 |
| Runner runtime | Runner 所在机器 | 本机环境适配、spawn hook、command resolver、agent adapter | Runner command construction 仍由 core 注册表和 typed adapter 控制。 |
| Agent extensions | Runner runtime 执行，Web/Hub 读取 descriptor | 新 agent、模型/权限/能力、session discovery/history/usage | Auth、namespace、permission correctness、message ordering 仍在 core。 |
| Web descriptor | Web 只渲染 JSON descriptor | 设置项、新建 session 字段、状态展示、安全动作入口 | Web 不执行插件 JS，不加载远程 component bundle。 |

## 容易混淆的当前语义

- 当前 Web “从 Hub 本地路径安装”只读取 Hub 机器文件系统，不读取 Runner 机器文件系统。
- 当前 Hub 插件只在 Hub 进程中运行，不影响远端 Runner 的 agent spawn、命令解析或本机环境。
- 当前 `hapi plugins` 默认管理执行该命令机器上的 `$HAPI_HOME`；如果 Hub 在另一台机器上，必须在 Hub 机器执行或经 Web/Hub API 管理。
- 后续 Runner 插件必须有显式 target scope，例如 `hub`、`runner:<machineId>`、`all-runners`，不能继续只用一个全局插件列表表达。

## Checklist 勾选与子代理验证规则

所有阶段文件中的 checklist 是项目状态记录，不是愿望清单。更新勾选状态时必须遵守：

1. **证据优先**：只有代码、测试、运行结果、PR/commit、文档更新等当前证据能证明条目完成时，才能把 `- [ ]` 改为 `- [x]`。
2. **子代理验证**：每次准备勾选阶段 checklist 前，主 agent 必须启动 review/verification 子代理，提供：用户目标、当前 diff、已运行验证、相关阶段文件、已准备勾选的条目、已知风险。
3. **处理 blocker**：子代理报告 blocker 时，先修复根因并重跑相关验证；不得带 blocker 勾选完成项。
4. **更新验证记录**：勾选后必须在对应阶段文件的“验证记录”中追加记录，包含日期、子代理类型、结论、验证命令或证据链接。
5. **部分完成不勾选**：实现、测试、Web UI、CLI、跨设备行为只完成其中一部分时，只能勾选对应细项，不能勾选整体验收项。
6. **跨运行时条目需实际覆盖目标运行时**：Hub 侧通过不能证明 Runner 侧完成；Runner 单机通过不能证明多 Runner 分发完成。

## 阶段文件

0. [Phase 00 — 全局边界、术语、验收门槛](./phase-00-boundaries.md)
1. [Phase 01 — Foundation：manifest/discovery/state；不 import runtime](./phase-01-foundation.md)
2. [Phase 02 — Hub notification runtime MVP](./phase-02-notification-runtime.md)
3. [Phase 03 — 插件管理体验：CLI / Web / Hub 热重载](./phase-03-management-hot-reload.md)
4. [Phase 04 — Multi-runtime foundation：作用域、状态、Hub↔Runner 管理协议](./phase-04-multiruntime-foundation.md)
5. [Phase 05 — Runner plugin runtime：Runner 本机发现、加载、热重载](./phase-05-runner-runtime.md)
6. [Phase 06 — Runner extension points：环境、命令解析、spawn hooks](./phase-06-runner-extension-points.md)
7. [Phase 07 — Agent adapter plugins：新 agent 接入插件化](./phase-07-agent-adapter-plugins.md)
8. [Phase 08 — Agent capability providers：模型、profile、session/history/usage/skills](./phase-08-agent-capability-providers.md)
9. [Phase 09 — Declarative Web descriptors：插件贡献的 Web UI，不执行 JS](./phase-09-declarative-web-descriptors.md)
10. [Phase 10 — Cross-device install/distribution：Hub/Runner 目标选择与分发](./phase-10-cross-device-install-distribution.md)
11. [Phase 11 — Scoped config/secrets/permissions：按 runtime/machine 分域](./phase-11-scoped-config-secrets-permissions.md)
12. [Phase 12 — Plugin communication、interactive callbacks、生态硬化](./phase-12-plugin-communication-hardening.md)

## 推荐 PR 切分

| PR | 阶段 | 目标 |
|---|---|---|
| PR-1 | Phase 00 + Phase 01 | 冷路径与状态管理；不 import 插件。 |
| PR-2 | Phase 02 | Hub notification runtime。 |
| PR-3 | Phase 03 | CLI/Web 管理、Hub 热重载、安装/删除体验。 |
| PR-4 | Phase 04 | 多运行时 DTO/state/RPC 基础；不加载 Runner 插件代码。 |
| PR-5 | Phase 05 | Runner plugin manager 与 runner runtime 生命周期。 |
| PR-6 | Phase 06 | Runner 环境/命令/spawn 扩展点。 |
| PR-7 | Phase 07 | Agent adapter descriptor + runner adapter。 |
| PR-8 | Phase 08 | Agent capability providers。 |
| PR-9 | Phase 09 | Web descriptor-driven UI。 |
| PR-10 | Phase 10 | Hub/Runner 跨设备安装与分发。 |
| PR-11 | Phase 11 | Config/secrets/permissions 分域硬化。 |
| Later | Phase 12 | 回调、通信、签名、marketplace、external-process runtime。 |

## 全局后续 checklist

- [x] Phase 03 已形成 Hub 管理体验：CLI/Web/reload/install/delete。
- [ ] 插件列表和详情支持 runtime/target scope 维度。
- [ ] Hub 能通过 RPC 管理 Runner 插件，但不直接读写 Runner 文件。
- [ ] Runner 能独立发现、启用、重载、删除本机插件。
- [ ] 新 agent 可通过 plugin descriptor 接入，而不修改 Web agent radio list / Hub enum。
- [ ] Web 仅渲染 descriptor，不执行插件 JS。
- [ ] 插件 config/secrets 按 Hub/Runner/machine 分域。
- [ ] 跨设备安装支持 Hub local path、Runner local path、upload package。
- [ ] 每个阶段勾选状态均有子代理验证记录。


## 计划文档验证摘要

| 日期 | 验证方式 | 结论 |
|---|---|---|
| 2026-05-21 | search/review 子代理 | 已指出旧 Hub-only 语义、缺失 Phase 04-12 文件、缺失验证记录等问题；本轮已按清单更新。 |
| 2026-05-21 | 本地自查 | README phase links 存在；每个 phase 文件均包含 checklist、验证记录、子代理规则；`git diff --check` 通过。 |

## 固定非目标

- 不用插件修权限正确性、消息丢失、Socket.IO/RPC/SSE、SQLite schema、namespace/auth 等核心 invariant。
- 不在 Web 执行任意插件 JS。
- 不运行时 `npm install`。
- 不自动启用项目目录插件。
- 不承诺插件 API 向后兼容；通过 `pluginApiVersion` 明确失败。
