# Phase 08 — Agent capability providers：模型、profile、session/history/usage/skills

更新时间: 2026-05-21
状态: 计划阶段。

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

- [ ] 定义 capability provider registry 与 contribution ids。
- [ ] Shared 增加 model/profile/permission/session/history/usage descriptor schema。
- [ ] Runner adapter 可注册 provider；Hub 聚合 provider output。
- [ ] Web 根据 provider descriptor 渲染模型、profile、权限模式、历史入口。
- [ ] History importer 输出统一 Message DTO，并经过 schema 校验。
- [ ] Usage provider output 与 auth/namespace/session scope 绑定。
- [ ] Provider timeout/throw 有隔离与 diagnostics。

### 测试

- [ ] Model provider 返回非法模型项时被拒绝。
- [ ] Permission mode provider 不能声明 core 未允许的危险模式，或必须显式标记风险。
- [ ] Session discovery 不泄漏其他 namespace 的历史。
- [ ] History importer 输出不合法 message 时失败可诊断。
- [ ] Usage provider timeout 不影响 session chat。
- [ ] Web 对 unavailable provider 有 graceful fallback。

### 验收

- [ ] 插件 agent 能展示自己的模型、profile、permission mode。
- [ ] 用户可通过插件 provider 导入/查看 agent-native 历史。
- [ ] Provider 失败不会破坏核心 session 运行。

## 验证记录

- [ ] 待实现后追加：日期、子代理类型、结论、验证命令/证据。
