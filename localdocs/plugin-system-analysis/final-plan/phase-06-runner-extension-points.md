# Phase 06 — Runner extension points：环境、命令解析、spawn hooks

更新时间: 2026-05-21
状态: 计划阶段。

## 目标

开放 Runner 本机最小扩展点，让插件影响 agent 启动前后的本机适配逻辑，但不把 agent command construction 的最终控制权交给插件。核心仍负责 schema、权限模式、namespace、session、RPC 与进程生命周期。

## 扩展点

### Environment provider

插件可提供额外环境变量、PATH 片段、工作目录提示、工具路径探测结果。Core 合并时必须可审计、可诊断、可冲突检测。

### Command resolver

插件可为已知 agent descriptor 提供 command candidates 或 override proposal；Core 根据安全策略选择最终命令。插件返回 proposal，不直接 spawn。

### Spawn hook

插件可注册：

- `beforeSpawn(context) -> proposal | void`
- `afterSpawn(context) -> void`
- `onExit(context) -> void`

Hook 不得接收 raw socket/RPC gateway；不得直接修改 core session state。

## Checklist 更新规则

勾选前必须由 review/verification 子代理核对：插件只能返回 proposal、Core 保留最终 spawn 决策、错误隔离、审计日志、跨平台测试证据。验证通过后追加“验证记录”。

## Checklist

### 实现

- [ ] 定义 `RunnerEnvironmentProvider` schema/type。
- [ ] 定义 `RunnerCommandResolver` proposal schema/type。
- [ ] 定义 `RunnerSpawnHook` schema/type。
- [ ] Core command builder 聚合插件 proposal，但最终 spawn 参数由 Core 生成。
- [ ] 冲突策略：多插件修改同一 env/command 时有 deterministic priority 与 diagnostics。
- [ ] Hook 超时、throw、reject 不 crash Runner。
- [ ] 审计日志显示哪个插件影响了 env/command/spawn。
- [ ] Web/CLI detail 展示 Runner extension contributions 与 diagnostics。

### 测试

- [ ] Environment provider 可以添加 env，secret values 不进入 diagnostics。
- [ ] Command resolver proposal 被 Core 校验后应用。
- [ ] 非法 command proposal 被拒绝并记录 diagnostic。
- [ ] beforeSpawn throw 不阻止 core fallback 行为，除非策略显式 block。
- [ ] 多插件优先级稳定。
- [ ] Windows/Linux/macOS path 合并逻辑有纯函数测试。

### 验收

- [ ] 插件可以帮助 Runner 找到本机 agent binary 或注入必要 env。
- [ ] Core 仍能解释最终 command 来源与安全决策。
- [ ] Runner 插件失败不会导致所有 session spawn 全局不可用。

## 验证记录

- [ ] 待实现后追加：日期、子代理类型、结论、验证命令/证据。
