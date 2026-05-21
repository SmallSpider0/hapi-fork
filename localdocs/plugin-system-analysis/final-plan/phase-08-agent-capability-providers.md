# Phase 08 — Agent capability providers：模型、profile、session/history/usage/skills

更新时间: 2026-05-21
状态: 已完成。

## 目标

在 agent adapter 基础上，开放细粒度能力 provider，让插件贡献模型列表、permission mode、profile、session discovery、history importer、usage provider、slash command/skill descriptor 等可选能力。该阶段服务不同 agent 生态的差异，而不是把所有差异硬编码进 core。

## 扩展点候选

- `modelProvider`：动态模型/服务 tier/上下文长度展示。
- `permissionModeProvider`：agent 支持的权限模式与默认值。
- `profileProvider`：agent profile/workspace preset。
- `sessionDiscoveryProvider`：发现 agent-native 历史会话。
- `historyImporter`：把 agent-native 历史转换为 HAPI message DTO。
- `usageProvider`：用量/成本/限额展示。
- `skillProvider` / `slashCommandProvider`：静态 descriptor，不直接执行任意 Web JS。

## Checklist 更新规则

勾选前必须由 review/verification 子代理核对：provider 数据只影响声明/展示/受控转换、不绕过 core session/permission/message invariants、测试证据。验证通过后追加“验证记录”。

## Checklist

### 实现

- [x] 定义 capability provider registry 与 contribution ids。
- [x] Shared 增加 model/profile/permission/session/history/usage descriptor schema。
- [x] Runner adapter 可注册 provider；Hub 聚合 provider output。
- [x] Web 根据 provider descriptor 渲染模型、profile、权限模式、历史入口。
- [x] History importer 输出统一 Message DTO，并经过 schema 校验。
- [x] Usage provider output 与 auth/namespace/session scope 绑定。
- [x] Provider timeout/throw 有隔离与 diagnostics。

### 测试

- [x] Model provider 返回非法模型项时被拒绝。
- [x] Permission mode provider 不能声明 core 未允许的危险模式，或必须显式标记风险。
- [x] Session discovery 不泄漏其他 namespace 的历史。
- [x] History importer 输出不合法 message 时失败可诊断。
- [x] Usage provider timeout 不影响 session chat。
- [x] Web 对 unavailable provider 有 graceful fallback。

### 验收

- [x] 插件 agent 能展示自己的模型、profile、permission mode。
- [x] 用户可通过插件 provider 导入/查看 agent-native 历史。
- [x] Provider 失败不会破坏核心 session 运行。

## 验证记录

- [x] 2026-05-21：architecture-location 子代理确认 Phase 8 触点：shared provider schema、Runner registry/manager、RunnerState publication、Web NewSession descriptor consumption；边界为 Runner 执行插件代码，Hub/Web 仅消费 snapshot。
- [x] 2026-05-21：实现 provider snapshot schema 与 Runner registry；provider output 写入 RunnerState `agentCapabilities`，Hub 通过 Machine state 聚合到 Web；Web 新建会话展示 provider 模型/profile/permission/history/usage/skills/slash command 数据。
- [x] 2026-05-21：History importer 通过 `AgentHistoryImportResultSchema` 校验，并接入 machine RPC、Hub namespace guard route、Web native history Import 按钮。
- [x] 2026-05-21：review 子代理发现 provider permission mode 扩权、history import 未接入、scope 约束不足三个 blocker；已修复为同插件 agent ownership、permission mode 只声明不扩权、session-scoped usage 拒绝、history import 走 namespace-guarded machine route。
- [x] 2026-05-21：review 子代理复核结论：No remaining blockers found。
- [x] 2026-05-21：验证命令通过：`bun run --cwd cli test -- src/runner/buildCliArgs.test.ts src/runner/plugins/runnerPluginManager.test.ts src/plugins/pluginFoundation.test.ts`。
- [x] 2026-05-21：验证命令通过：`bun run --cwd hub test -- src/web/routes/machines.test.ts src/sync/rpcGateway.test.ts`。
- [x] 2026-05-21：验证命令通过：`bun run --cwd web test -- src/components/NewSession/preferences.test.ts src/components/NewSession/AgentSelector.test.tsx src/components/NewSession/types.test.ts`。
- [x] 2026-05-21：验证命令通过：`bun run typecheck`、`git diff --check`。
