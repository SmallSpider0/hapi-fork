# Phase 07 — Agent adapter plugins：新 agent 接入插件化

更新时间: 2026-05-21
状态: 已完成。

## 目标

让新 agent 可以通过插件 descriptor + Runner adapter 接入，而不是每次新增 agent 都改 Web agent radio list、Hub enum、Runner command 分支。该阶段覆盖 agent descriptor、adapter 激活、capability negotiation 与最小 spawn/run 接口。

## 设计边界

- Agent adapter 在 Runner runtime 执行。
- Web/Hub 读取 agent descriptor，不执行 adapter 代码。
- Core 仍负责 session id、namespace、permission mode、message ordering、transport。
- Adapter 只负责把 Core 请求转换为 agent 进程或协议调用。
- ACP 可作为一种 adapter 类型，但不把“ACP runner”误认为完整插件系统。

## Agent descriptor 初稿

```ts
type AgentDescriptor = {
    id: string
    displayName: string
    description?: string
    adapter: {
        runtime: 'runner'
        kind: 'stdio' | 'acp' | 'custom-runner-plugin'
        contributionId: string
    }
    capabilities: {
        supportsResume?: boolean
        supportsPlanMode?: boolean
        supportsImages?: boolean
        supportsFileContext?: boolean
        permissionModes?: string[]
        models?: string[]
    }
}
```

## Checklist 更新规则

勾选前必须由 review/verification 子代理核对：descriptor 不执行代码、Runner adapter 边界、Web/Hub 动态 agent 列表、权限/namespace/core invariants、测试证据。验证通过后追加“验证记录”。

## Checklist

### 实现

- [x] Manifest 支持 `contributions.agent.adapters`。
- [x] Shared 增加 `AgentDescriptor` 与 validation schema。
- [x] Runner 插件可注册 agent adapter，并返回 descriptor。
- [x] Hub 聚合 Runner agent descriptors，按 machine/availability 展示。
- [x] Web 新建 session 的 agent 选项从 descriptor registry 读取。
- [x] Runner spawn 使用 descriptor + adapter proposal，Core 负责最终 session lifecycle。
- [x] Adapter 错误映射为稳定 diagnostics 与 user-facing error。
- [x] Descriptor capability 影响 UI 可用项，但不绕过 Core 权限策略。

### 测试

- [x] Invalid agent descriptor rejected before spawn。
- [x] Adapter plugin 未 active 时对应 agent 不可选或标记 unavailable。
- [x] Web agent list 能显示 built-in + plugin agents。
- [x] Plugin agent session spawn 成功走 Runner adapter。
- [x] Adapter throw 不 crash Runner/Hub。
- [x] Namespace/session id 仍由 Core 创建与校验。

### 验收

- [x] 新增一个 agent adapter 插件后，用户无需改 core 枚举即可在 Web 选择该 agent。
- [x] Hub 与 Runner 分机部署时，只有拥有该 adapter 的 Runner 标记该 agent available。
- [x] 删除/禁用 adapter 插件后，Web 立即反映不可用状态。

## 验证记录

- [x] 2026-05-21：architecture-location 子代理确认 Phase 8/Agent adapter 相关边界：Runner 执行插件代码，Hub/Web 仅消费 descriptor/snapshot，Core 保持 session、namespace、permission、message invariants。
- [x] 2026-05-21：review 子代理发现 stale YOLO 与模型状态风险；已修复为 Web 按 descriptor 抑制 YOLO、Runner spawn fail-closed、模型仅在 `setModel` 成功后通过 keepalive 记录，并增加 descriptor payload bounds。
- [x] 2026-05-21：review 子代理复核后结论：No blockers found。
- [x] 2026-05-21：验证命令通过：`bun run --cwd cli test -- src/runner/buildCliArgs.test.ts src/runner/plugins/runnerPluginManager.test.ts src/plugins/pluginFoundation.test.ts`。
- [x] 2026-05-21：验证命令通过：`bun run --cwd hub test -- src/web/routes/machines.test.ts src/sync/rpcGateway.test.ts`。
- [x] 2026-05-21：验证命令通过：`bun run --cwd web test -- src/components/NewSession/preferences.test.ts src/components/NewSession/AgentSelector.test.tsx src/components/NewSession/types.test.ts`。
- [x] 2026-05-21：验证命令通过：`bun run typecheck`、`git diff --check`。
