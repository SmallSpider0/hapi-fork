# Phase 10 — Cross-device install/distribution：Hub/Runner 目标选择与分发

更新时间: 2026-05-21
状态: 已完成。

## 目标

解决插件安装在多设备部署中的真实语义：用户可以选择把插件安装到 Hub、本机 Runner、某台远端 Runner 或多台 Runner；Hub 不假装能读取远端本地路径，Runner 不需要共享 Hub 文件系统。

## 安装来源

- Hub local path：Phase 03 已覆盖；只适用于 Hub 机器。
- Runner local path：通过目标 Runner RPC 浏览/选择 Runner 本机路径。
- Uploaded package：用户上传 `.tgz`/`.zip`，Hub 校验后分发到目标 Hub/Runner。
- Marketplace/package registry：后续生态阶段；本阶段仅定义可复用 package format。

## 分发模型

- 安装操作必须携带 target scope。
- 对 `all-runners` 返回每台机器的 install result。
- 包校验在安装目标执行最终 realpath/path safety 检查。
- 插件版本、source、checksum、installedAt、updatedAt 记录在 per-target inventory。
- 回滚/删除按 target 执行；不能只删除 Hub copy 就声称 Runner 已删除。

## Checklist 更新规则

勾选前必须由 review/verification 子代理核对：跨设备目标语义、Runner local path 不经 Hub 本地读取、package checksum、partial failure、测试证据。验证通过后追加“验证记录”。

## Checklist

### 实现

- [x] Web/CLI 安装流程要求选择 target scope。
- [x] Runner local path browse 通过 Runner RPC 实现。
- [x] Uploaded package 支持 Hub 校验与目标分发。
- [x] Package format 定义 manifest、files、checksum、optional signature metadata。
- [x] Per-target inventory 记录 source/checksum/version/installedAt。
- [x] Multi-runner install 返回 per-target result。
- [x] Delete/update/reload 都按 target scope 执行。
- [x] 离线 Runner install queue 策略明确：拒绝或排队，不能静默成功。

### 测试

- [x] Hub local path install 不允许用于 Runner target。
- [x] Runner local path browse 在 Runner 离线时返回明确错误。
- [x] Uploaded package checksum mismatch 被拒绝。
- [x] Partial multi-runner failure 不回滚已成功目标，或按明确策略执行。
- [x] Delete Hub plugin 不影响 Runner plugin inventory。
- [x] Delete Runner plugin 不影响 Hub plugin inventory。

### 验收

- [x] 用户能安装插件到指定 Runner，即使 Hub 与 Runner 不在同一台机器。
- [x] 用户能在 UI 中看清每个 target 的安装来源和版本。
- [x] 安装失败不会留下不可解释的半状态。

## 验证记录

- [x] 2026-05-21：architecture/review 子代理核对跨设备安装语义、Runner local path RPC、package checksum/metadata、partial failure、per-target metadata、offline Runner reject；最终 review 结论为无阻塞，同意勾选并提交。
- [x] 2026-05-21：验证命令通过：
  - `bun run --cwd cli test -- src/plugins/pluginFoundation.test.ts src/runner/plugins/runnerPluginManager.test.ts src/commands/plugins.test.ts`
  - `bun run --cwd hub test -- src/web/routes/plugins.test.ts src/web/routes/machines.test.ts`
  - `bun run --cwd web test -- src/hooks/mutations/usePluginActions.test.tsx src/components/NewSession/preferences.test.ts src/components/NewSession/pluginFields.test.ts src/components/plugins/DescriptorRenderer.test.tsx`
  - `bun run typecheck`
  - `git diff --check`
