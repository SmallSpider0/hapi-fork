# Phase 04 — Multi-runtime foundation：作用域、状态、Hub↔Runner 管理协议

更新时间: 2026-05-21
状态: 计划阶段。

## 目标

把插件系统从单一 Hub runtime 扩展为可表达多运行时的基础模型，但本阶段不加载 Runner 插件代码。重点是 scope、inventory、状态同步、RPC 管理协议和 DTO，先解决“Hub 与 Runner 不在同一台设备”时的语义。

## 核心设计

### Runtime scope

插件管理操作必须显式携带 target scope：

- `hub`：Hub 本机插件目录与 Hub runtime。
- `runner:<machineId>`：指定 Runner 所在机器。
- `all-runners`：批量目标；必须返回 per-runner result，不允许只给一个全局成功。

### Manifest 多运行时字段

`hapi.plugin.json` 继续 manifest-first，新增但不立即激活 Runner runtime：

```ts
type PluginManifest = {
    id: string
    name: string
    version: string
    pluginApiVersion: '0.1'
    runtimes?: {
        hub?: { entry: string }
        runner?: { entry: string }
    }
    contributions?: {
        hub?: { notificationChannels?: unknown[] }
        runner?: {
            environmentProviders?: unknown[]
            commandResolvers?: unknown[]
            spawnHooks?: unknown[]
        }
        agent?: {
            adapters?: unknown[]
            capabilityProviders?: unknown[]
        }
        web?: {
            settingsPanels?: unknown[]
            newSessionFields?: unknown[]
            actions?: unknown[]
            badges?: unknown[]
        }
    }
}
```

### 状态权威

- Hub 是聚合视图与 Web API 入口。
- Runner 是 Runner 本机插件文件、enable/config、active runtime 的权威。
- Hub 不直接读写 Runner 文件系统；必须通过 Runner RPC。
- 离线 Runner 的插件状态显示为 stale/offline，不把旧状态误报成 active。

### 管理协议

Hub 通过既有 RPC gateway 增加窄接口；接口只传 schema-validated DTO：

- `runner.plugins.list`
- `runner.plugins.inspect`
- `runner.plugins.enable`
- `runner.plugins.disable`
- `runner.plugins.config.update`
- `runner.plugins.reload`
- `runner.plugins.install.prepare`
- `runner.plugins.install.commit`
- `runner.plugins.delete`

RPC 必须沿用 machine identity、namespace/auth 边界，不向插件暴露 gateway。

## Checklist 更新规则

勾选前必须由 review/verification 子代理核对：DTO schema、Hub↔Runner RPC 边界、离线状态、跨机器语义、测试证据。验证通过后追加“验证记录”。

## Checklist

### 实现

- [ ] Shared 增加 runtime scope DTO：`hub` / `runner:<machineId>` / `all-runners`。
- [ ] Shared 增加 per-target plugin inventory/status schema。
- [ ] Manifest schema 支持 `runtimes.runner` 与 `contributions.runner/agent/web` 静态声明。
- [ ] Hub plugin API 接收 target scope，不再默认把全局列表等同 Hub 本机。
- [ ] Web plugin list/detail 能显示 Hub 与每个 Runner 的插件状态。
- [ ] Hub 保存 Runner plugin inventory cache，并标记 offline/stale 时间。
- [ ] Runner 注册插件管理 RPC handlers；本阶段只返回 discovery/state，不 import runtime。
- [ ] API error model 能表达 partial success、runner offline、unsupported runtime。

### 测试

- [ ] Shared scope schema 拒绝非法 machine id 与未知 scope。
- [ ] Hub list 聚合 Hub + 多 Runner 状态。
- [ ] Runner offline 时 Hub 返回 stale/offline，不假装 active。
- [ ] Hub 不直接访问 Runner 插件路径；测试用 mock RPC 验证边界。
- [ ] `all-runners` partial failure 返回 per-runner result。
- [ ] Runner RPC handler 校验请求 schema 与 auth/machine context。

### 验收

- [ ] 用户能在 Web/CLI 区分“Hub 插件”和“某台 Runner 的插件”。
- [ ] Hub 与 Runner 不在同一台机器时，Hub 不再给出误导性本地路径语义。
- [ ] 后续 Phase 05 可以在 Runner 内部接入 runtime，而不改 Phase 04 DTO 基础。

## 验证记录

- [ ] 待实现后追加：日期、子代理类型、结论、验证命令/证据。
