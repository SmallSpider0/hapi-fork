# 插件按 Manifest 自动安装设计

## 目标

插件安装入口不再让用户选择 `Hub` / `Runner`。用户只选择插件包；Hub 解包读取 `hapi.plugin.json`，从插件声明推导安装位置，并对 Hub 与所有在线 Runner 做兼容性预检。

## 位置推导

- `contributions.web` 或 capability `parts.web`：视为 Web 能力；Web 不是独立安装目标，由 Hub 安装并发布描述符。
- `runtimes.hub`、`contributions.hub`、`voice`、`deployment`、`integration`、capability `parts.hub`：需要 Hub。
- `runtimes.runner`、`contributions.runner`、`contributions.agent`、capability `parts.runner`：需要 Runner。
- 未声明可执行位置的包默认安装到 Hub，便于管理/诊断。

## 兼容性字段

Manifest 支持：

```json
{
  "compatibility": {
    "hapi": ">=0.18.4",
    "pluginApi": ">=0.1 <0.2",
    "os": ["linux", "darwin"],
    "arch": ["x64", "arm64"],
    "hub": {
      "hapi": ">=0.18.4",
      "pluginApi": ">=0.1 <0.2",
      "extensionPoints": ["hub.messageAction", "web.composerAction"]
    },
    "runner": {
      "hapi": ">=0.18.4",
      "pluginApi": ">=0.1 <0.2",
      "extensionPoints": ["runner.spawnHook", "agent.capabilityProvider"]
    },
    "crossRuntime": {
      "samePluginVersionAcrossTargets": true,
      "allowVersionSkew": "none"
    }
  },
  "install": {
    "runnerPlacement": "compatible-runners",
    "offlineRunnerPolicy": "skip",
    "minReadyRunnerCount": 1
  }
}
```

Hub 与 Runner inventory 暴露 `hostInfo`：`runtime`、`hapiVersion`、`pluginApiVersion`、`os`、`arch`、`supportedExtensionPoints`。

## 安装 API

1. `POST /api/plugins/install-plan`
   - body：`PluginInstallPlanRequest`
   - 返回：`PluginInstallPlanResponse`
   - Hub 验证包 checksum、包元数据、Manifest，并生成计划。

2. `POST /api/plugins/install-plan/{planId}/execute`
   - Hub 重新预检，若存在 `blockingErrors` 则拒绝执行。
   - Hub 先安装自身目标，再通过 Runner RPC 分发同一包给兼容 Runner。
   - 结果按 target 聚合到 `PluginInstallResult.targetResults`。

旧的 `install-package?target=...` 保留为兼容/调试入口，但 UI 和 CLI 不再使用。

## CLI / Web 行为

- Web：移除安装位置下拉；按钮流程为“选择包 → 预检 → 安装”。
- CLI：`hapi plugins install-package <pkg>` 默认安装到 manifest 推导的目标。
- CLI Runner 范围可选：
  - `--runners compatible` 默认：跳过不兼容 Runner，满足 `minReadyRunnerCount` 即可。
  - `--runners all`：所有 Runner 都必须可安装。
  - `--runners id[,id]`：只安装所选 Runner，不兼容则阻塞。
- `--dry-run` 只输出安装计划。

## 冲突策略

- 同版本已安装：计划动作为 `unchanged`；若 `--enable` 则执行 enable。
- 不同版本已安装且未 `overwrite`：计划 `conflict`，在 `compatible` 模式下跳过，在 `all/selected` 模式下阻塞。
- Runner 离线：默认 `skip`；Manifest `offlineRunnerPolicy=fail` 时阻塞。
- Runner 缺少 `hostInfo`：视为需要升级，不能作为兼容目标。

## Bundled first-party plugins

Default bundled plugins follow the same manifest-derived placement as uploaded packages. See [Bundled plugin catalog policy](./bundled-plugin-catalog.md) for the default-installed first-party plugin list and the `HAPI_ENABLE_BUNDLED_EXAMPLES=1` opt-in rule for developer examples.
