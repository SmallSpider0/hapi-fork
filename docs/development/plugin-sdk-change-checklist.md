# 插件 SDK 修改 checklist

面向 HAPI core 开发者。目标是让首次插件 SDK 相关 PR 保持小而可审查：先确认改动类别，再只修改对应层，不把插件系统扩成通用扩展宿主。

## 先判断是否需要 bump plugin API

| 变更 | 通常是否 bump | 说明 |
|---|---:|---|
| 新增可选 `ctx` API | 否 | 旧插件不调用新 API，仍可运行。 |
| 新增可选 Manifest 字段 | 否 | schema 接受旧 Manifest 即可。 |
| 新增 extension point 且旧点保留 | 否 | 同时更新 host advertised extension points。 |
| 删除/重命名 `ctx` API | 是 | 旧 runtime code 可能直接失败。 |
| callback 参数语义或返回值语义变化 | 是 | 即使类型兼容，也可能破坏行为。 |
| Manifest 新增 required 字段 | 是 | 旧 Manifest 无法通过校验。 |
| 删除/重命名 extension point | 是 | 旧 compatibility/manifest 声明失效。 |

版本规则详见 [插件 API 版本治理](./plugin-api-versioning.md)。

## 修改 Hub runtime SDK

常见文件：

1. `shared/src/plugins/sdk.ts`：公开类型入口。
2. `hub/src/plugins/registry.ts`：`HubPluginContext` 创建和注册校验。
3. `hub/src/plugins/pluginManager.ts`：如需在 active registry 中读取新 contribution。
4. `shared/src/plugins/manifest.ts`：如新增 Manifest contribution descriptor。
5. `shared/src/plugins/extensionPoints.ts`：如新增 host advertised extension point。
6. `scripts/plugin-api-docs/*`：如 docs generator 需要描述新概念。
7. tests：至少覆盖 registry validation、manager behavior、generated docs/check。

## 修改 Runner runtime SDK

常见文件：

1. `shared/src/plugins/sdk.ts`：公开类型入口。
2. `cli/src/runner/plugins/runnerPluginRegistry.ts`：`RunnerPluginContext` 创建和注册校验。
3. `cli/src/runner/plugins/runnerExtensionPipeline.ts`：如新 contribution 影响 spawn/agent 执行流程。
4. `shared/src/plugins/runnerExtensions.ts`：如新增 context/proposal/result DTO。
5. `cli/src/runner/plugins/runnerPluginManager.ts`：inventory、capability、diagnostics、host info。
6. `shared/src/plugins/manifest.ts`：如新增 Manifest contribution descriptor。
7. `shared/src/plugins/extensionPoints.ts`：如新增 advertised extension point。
8. tests：registry、pipeline、manager/inventory、install compatibility。

## 修改 Web descriptor surface

常见文件：

1. `shared/src/plugins/webDescriptors.ts`：descriptor schema 和类型。
2. `web/src/components/plugins/DescriptorRenderer.tsx`：通用渲染 primitive。
3. `web/src/components/AssistantChat/composerActions.ts`：如果改 composer action UI。
4. `scripts/plugin-api-docs/renderMarkdown.ts` 或 tutorial fixtures：文档生成。
5. tests：descriptor renderer、composer action collector、docs generation。

规则：Web 只能渲染已验证 descriptor；不要引入浏览器侧插件 JavaScript，不要按 plugin id 写特殊分支。

## 修改 Manifest / install / marketplace contract

常见文件：

1. `shared/src/plugins/manifest.ts`：schema、placement 推导。
2. `shared/src/plugins/runtime/compatibility.ts`：host compatibility gate。
3. `shared/src/plugins/runtime/versioning.ts`：marketplace latest compatible/version choice。
4. `hub/src/plugins/installPlanner.ts`：target selection、blocking errors、warnings。
5. `hub/src/plugins/marketplaceService.ts` 和 `hub/src/plugins/admin/*`：marketplace/install plan API。
6. `web/src/routes/settings/plugins.tsx` 和 `cli/src/commands/plugins.ts`：展示 server 返回的 plan/view。
7. generated marketplace/docs：`bun run marketplace:generate`、`bun run docs:plugin-api`。

## 必跑命令

按实际触碰范围收敛；SDK/Manifest 相关 PR 至少跑：

```bash
bun run plugin:validate -- plugins/<plugin-id>
bun run docs:plugin-api:check
bun run marketplace:check
bun run test:shared
bun run typecheck
```

如改 Hub/Runner runtime，再跑相关 package 测试：

```bash
cd hub && bun run test -- src/plugins/<changed-test>.test.ts
cd cli && bun run test -- src/runner/plugins/<changed-test>.test.ts
```

## 首 PR 非目标

首次改善开发体验时避免同时做这些事：

- 不引入插件沙箱或权限隔离重构。
- 不引入 plugin-local dependency install/build system。
- 不新增通用 dev server/hot reload 协议。
- 不扩大插件访问 core DB/RPC/SSE/Socket.IO 的能力。
- 不为一方插件写 plugin-id 特例。
