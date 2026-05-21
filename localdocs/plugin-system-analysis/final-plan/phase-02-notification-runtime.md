# Phase 02 — Hub notification runtime MVP

更新时间: 2026-05-21
完成证据: `hub/src/plugins/*` 已实现 Hub notification plugin runtime、registry-lite、scoped context、notification adapter、enabled-plugin import/activate、diagnostics/redaction 与 dispose；`hub/src/startHub.ts` 已在 built-in channels 后加载 plugin channels 并在 shutdown dispose；`hub/src/plugins/hubPluginRuntime.test.ts` 覆盖 enabled/disabled/invalid/import failure/activate failure/channel failure/dispose/missing secret/redaction/raw Session non-leak。

## 目标

只验证一个真实 extension point：Hub notification channel。Enabled Hub 插件在 Hub 启动时 import 并 `activate(ctx)`，通过 scoped context 注册 notification channel。

## 必须包含

- Hub `PluginRegistry-lite`。
- Enabled hub plugin 动态 import + `activate(ctx)`。
- Scoped `HubPluginContext`。
- `notifications.registerChannel()` + Disposable。
- `PluginNotificationChannelAdapter`：internal `Session` → narrow DTO。
- Failure isolation：
  - invalid manifest 不 import。
  - disabled 不 import。
  - activate throw 不 crash Hub。
  - channel send throw 不影响内置 Push/Telegram/ServerChan。
  - Hub shutdown 反序 dispose。
- Tests：enabled/disabled/import failure/channel failure/dispose/secret redaction。

## 必须排除

- Callback route。
- Permission approve/deny。
- Raw `Store` / `SyncEngine` / Socket.IO / SSE / RPC gateway 暴露。
- Plugin SQLite storage。
- Hot reload / runtime disable；留 Phase 03。
- Project-local `.hapi/plugins`。
- CLI/Web 管理 UI、Hub reload API 与管理 DTO；留 Phase 03。

## HAPI 当前落点

| 当前代码 | 变化 |
|---|---|
| `hub/src/index.ts` | 构造 built-in channels 后合并 plugin channel adapters。 |
| `hub/src/notifications/notificationTypes.ts` | 保持 internal interface，不作为 plugin ABI。 |
| `hub/src/notifications/notificationHub.ts` | 继续负责 per-channel try/catch。 |
| `hub/src/configuration.ts` | 使用 `dataDir` 定位 `$HAPI_HOME/plugins.json`。 |
| `shared/src/plugins/*` | 增加 notification DTO schema/type。 |

## Plugin API

```ts
export async function activate(ctx: HubPluginContext): Promise<void> | void

type HubPluginContext = {
    pluginId: string
    logger: PluginLogger
    config: PluginConfigReader
    secrets: PluginSecretReader
    notifications: {
        registerChannel(channel: PluginNotificationChannel): Disposable
    }
}

type PluginNotificationChannel = {
    send(event: PluginNotificationEvent): Promise<void>
}
```

`PluginNotificationEvent` 使用窄 DTO，不暴露 Hub `Session` 对象。

```ts
type PluginNotificationSession = {
    id: string
    namespace: string
    name?: string
    path?: string
    agent?: string
    active: boolean
    url?: string
}
```

`namespace` 可用于路由/展示，但授权仍由 core 执行，插件不能把 DTO 当授权凭据。

## 激活流程

```text
Hub start
  load built-in config
  load built-in notification channels
  discover + validate plugins
  read plugins.json
  for each enabled plugin with hub runtime:
    validate entry path realpath
    import entry
    call activate(ctx)
    collect registered plugin notification channels
  new NotificationHub(syncEngine, builtIn + pluginChannelAdapters)
```

## 错误策略

- Import/activate throw：插件 failed，Hub 继续启动。
- Plugin channel `send()` throw：`NotificationHub` 隔离，其他 channels 继续。
- Missing secret：diagnostic warning；插件可 fail soft。
- Diagnostics redacts declared secrets。
- Phase 02 为 startup-only runtime；enable/disable/config/code 变化需重启或等待 Phase 03 的受控 reload。

## Checklist

审计说明: 当前 Phase 02 checklist 已由实现、hub targeted tests、hub full tests 与 typecheck 覆盖；不包含 callback/permission/runner、CLI/Web 管理页面、Hub reload API、热重载等后续阶段范围。

### 实现

- [x] `hub/src/plugins/` registry-lite。
- [x] Hub 复用 Phase 01 discovery/state reader。
- [x] Hub 仅 import enabled plugin。
- [x] `activate(ctx)` 支持 async。
- [x] `registerChannel()` 返回 Disposable。
- [x] Hub shutdown 调用 disposables。
- [x] Dispose failure logged but shutdown continues。
- [x] `PluginNotificationChannelAdapter` 映射 ready/permission/task/completion。
- [x] URL/path/name/agent summary 不泄漏不必要内部字段。
- [x] Declared secrets redaction。

### 测试

- [x] Disabled plugin 不 import。
- [x] Invalid manifest 不 import。
- [x] Enabled plugin activate。
- [x] Activate throw 不 crash Hub。
- [x] Registered channel 收到 ready event。
- [x] Channel send throw 不影响其他 channels。
- [x] Hub shutdown 调用 dispose。
- [x] Missing secret diagnostic。
- [x] Logs/diagnostics 不包含 secret value。
- [x] Adapter 不暴露 raw `Session`。

### 验收

- [x] 无需修改 built-in channel 类即可通过 registry 新增 channel。
- [x] Push/Telegram/ServerChan 行为不回退。
- [x] Hub 重启后 enabled plugin 生效；disable 后重启不加载。
- [x] 无 CLI/Web/runner/realtime 行为变化。

## Checklist 更新规则

后续若修改本阶段 checklist，必须按 `README.md` 的子代理验证规则执行，并在下方追加验证记录。

## 验证记录

- 2026-05-21 — review sub-agent — 已核对 Hub notification runtime、diagnostics/redaction/disposable 测试证据，Phase 02 checklist 维持完成；后续任何勾选变更必须追加新的子代理验证记录。
