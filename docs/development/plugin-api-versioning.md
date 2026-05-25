# 插件 API 版本治理

面向有 HAPI 源码的内部开发者。这里的目标不是发布独立 SDK，而是在 monorepo 内安全演进 `shared/src/plugins/sdk.ts`、Manifest schema、extension points、Hub/Runner runtime 行为。
相关 SDK 修改入口见 [插件 SDK 修改 checklist](./plugin-sdk-change-checklist.md)。

## 插件版本 vs 插件 API 版本

- `manifest.version`：插件自身版本，必须是完整 SemVer。改插件行为、Manifest contribution、runtime entry 时通常 bump 这个版本，并同步 marketplace 生成文件。
- `manifest.pluginApiVersion`：插件编写时依赖的 HAPI 插件 API contract。它描述 runtime/manifest/SDK 语义，不等于插件自身版本。
- `manifest.compatibility.pluginApi`：插件要求 host 支持的 API contract 版本范围。推荐一方插件写成当前 contract 的半开区间，例如：

```json
{
  "pluginApiVersion": "0.1",
  "compatibility": {
    "pluginApi": ">=0.1 <0.2"
  }
}
```

## Host 支持版本规则

`HAPI_PLUGIN_API_VERSION` 表示当前默认/最高 contract；`HAPI_SUPPORTED_PLUGIN_API_VERSIONS` 表示这个 checkout 仍实际支持的 contract 列表。

Hub/Runner `hostInfo` 会报告：

- `pluginApiVersion`：当前默认 contract。
- `supportedPluginApiVersions`：实际支持的 contract 列表。
- `supportedExtensionPoints`：当前 runtime 实现的 extension points。

兼容性判断必须避免只看“当前最高版本”。如果 host 当前 API 已经是 `0.2`，但仍支持 `0.1` 所需 SDK/extension points，那么 `pluginApiVersion: "0.1"` 且 `compatibility.pluginApi: ">=0.1 <0.2"` 的插件仍应兼容。实现上，`compatibility.pluginApi` 需要对 host 支持列表中任意一个版本满足即可通过。

## 何时 bump plugin API

| 变更类型 | 是否 bump plugin API | 示例 |
|---|---:|---|
| 新增可选 ctx API | 通常否 | 新增可选 `ctx.runtime.registerX` |
| 新增 extension point 且旧点保留 | 通常否 | 新增 `runner.spawnOptionsProvider` |
| 删除 ctx API | 是 | 删除 `registerSpawnHook` |
| 改 callback 参数语义 | 是 | `RunnerSpawnContext` 字段含义变化 |
| Manifest 新增可选字段 | 通常否 | `display.featureIntro` |
| Manifest required 字段变化 | 是 | 新 required top-level field |
| extension point 改名/删除 | 是 | `runner.spawnHook` rename |
| bug fix / diagnostics 文案 | 否 | 错误文案调整 |

Bump 时同时更新：

1. `shared/src/plugins/manifest.ts` 的 `HAPI_PLUGIN_API_VERSION`。
2. `HAPI_SUPPORTED_PLUGIN_API_VERSIONS`：仍兼容旧 contract 就保留旧版本；确实删除旧 API 才移除。
3. `shared/src/plugins/runtime/compatibility.ts` tests，确保 supported-version 列表不是过严 gate。
4. `docs/development/plugin-api-versioning.md` 和 generated plugin API docs。
5. 一方插件 manifests 的 `compatibility.pluginApi`，只在确实需要新 contract 时更新 `pluginApiVersion`。

## 何时只 bump 插件版本

只影响某个插件实现或 descriptor，不改变公共 SDK/schema 语义时，只 bump `manifest.version`：

- runtime bug fix 或行为增强；
- 新增/调整插件自己的 settings panel 字段；
- 新增插件自己的 contribution；
- 改 marketplace metadata。

## Cross-runtime 版本规则

跨 Hub/Runner 的插件可在 Manifest 中声明：

```json
{
  "compatibility": {
    "crossRuntime": {
      "samePluginVersionAcrossTargets": true,
      "allowVersionSkew": "none"
    }
  }
}
```

安装计划会对 ready targets 的 expected version 做全局检查：

- `samePluginVersionAcrossTargets: true` 或 `allowVersionSkew: "none"`：不允许 ready targets 使用多个插件版本。
- `allowVersionSkew: "patch"`：允许同 major/minor 的 patch skew。
- `allowVersionSkew: "minor"`：允许同 major 的 minor/patch skew。
- compatible Runner 模式下跳过旧版本 Runner 时会给 warning；需要强制替换时启用 overwrite 或选择更少 targets。

## 一方插件更新 checklist

```bash
bun run plugin:validate -- plugins/<plugin-id>
bun run marketplace:generate
bun run marketplace:check
bun run docs:plugin-api:check
bun run test:shared
bun run test:hub -- src/plugins/installPlanner.test.ts src/plugins/marketplaceService.test.ts
bun run typecheck
```

需要临时上传包测试时：

```bash
bun run plugin:pack -- plugins/<plugin-id> --out /tmp/<plugin-id>.tgz
hapi plugins install-package /tmp/<plugin-id>.tgz --dry-run --json
```
