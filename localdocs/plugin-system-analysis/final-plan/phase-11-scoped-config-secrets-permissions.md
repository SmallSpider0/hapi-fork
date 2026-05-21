# Phase 11 — Scoped config/secrets/permissions：按 runtime/machine 分域

更新时间: 2026-05-21
状态: 已完成。

## 目标

把插件配置、secret、permissions 从单一 Hub 视角扩展为按 runtime/machine 分域。Hub、不同 Runner、不同 agent adapter 可以拥有不同配置和 secret 状态；UI 必须显示 present/missing，而不泄漏 secret value。

## 配置域

- `hub:<pluginId>`：Hub runtime config。
- `runner:<machineId>:<pluginId>`：Runner runtime config。
- `agent:<machineId>:<agentId>:<pluginId>`：Agent adapter/capability config。
- Shared default config 只能作为初始值，不得覆盖 target-specific config。

## Secret 域

- Secret value 存在于目标 runtime 机器的环境或后续 secret backend。
- Hub 只能知道 Runner secret present/missing，不获得明文。
- Web 只展示名称、说明、required/optional、present/missing、lastChecked。
- 写 secret 后端前，先保持“外部注入 + doctor 检查”模型。

## Permission 模型

- 早期 permissions 仍是声明/审计，不是 sandbox enforcement。
- 对危险能力加显式 enable warning 与 target scope 展示。
- 若后续引入 external-process runtime/sandbox，再把 permissions 变成可执行 grant。

## Checklist 更新规则

勾选前必须由 review/verification 子代理核对：config/secret scope、跨机器 secret 不回传、permissions 文案不误导为 sandbox、测试证据。验证通过后追加“验证记录”。

## Checklist

### 实现

- [x] Shared 增加 scoped plugin config schema。
- [x] Hub/Runner 分别持有本机 config state，不互相覆盖。
- [x] API 返回 per-scope config metadata 与 redacted values。
- [x] Secret present/missing 检查在目标 runtime 执行。
- [x] Web 支持按 target 编辑 config，禁止显示 secret value。
- [x] CLI 支持 `--target hub|runner:<machineId>` 读写 config。
- [x] Permissions 展示 runtime/target 维度与 trusted-code warning。
- [x] Diagnostics 标记 missing required secret 的具体 target。

### 测试

- [x] Hub config 更新不改变 Runner config。
- [x] Runner config 更新不改变 Hub config。
- [x] Runner secret value 不出现在 Hub API/logs/diagnostics。
- [x] Web config form 不渲染 secret value。
- [x] Missing secret diagnostic 带 target scope。
- [x] Permission warning 文案明确 advisory/non-sandbox。

### 验收

- [x] 多台 Runner 可以为同一插件使用不同 config/secret 状态。
- [x] 用户能定位“哪台机器缺哪个 secret”。
- [x] 权限展示不会让用户误以为已有强 sandbox。

## 验证记录

- [x] 2026-05-21：architecture/review 子代理核对 scoped config、secret 不回传、permissions non-sandbox 文案、diagnostics target scope；最终 review 结论为无阻塞，同意勾选并提交。
- [x] 2026-05-21：验证命令通过：
  - `bun run --cwd cli test -- src/commands/plugins.test.ts src/runner/plugins/runnerPluginManager.test.ts src/plugins/pluginFoundation.test.ts`
  - `bun run --cwd hub test -- src/plugins/pluginManager.test.ts src/web/routes/plugins.test.ts src/web/routes/machines.test.ts`
  - `bun run --cwd web test -- src/components/plugins/DescriptorRenderer.test.tsx src/hooks/mutations/usePluginActions.test.tsx src/components/NewSession/preferences.test.ts src/components/NewSession/pluginFields.test.ts`
  - `bun run typecheck`
  - `git diff --check`
