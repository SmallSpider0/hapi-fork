> **状态更新（2026-05-21）**
>
> 本裁剪稿只保留历史上下文；后续执行计划以 `final-plan/README.md` 与 Phase 00-12 文件为准。当前路线不是 Hub-only：Hub notification runtime 与管理体验只是第一块能力，后续计划必须覆盖 Runner runtime、Runner extension points、Agent adapter/capability providers、Web descriptor、跨设备安装与按 runtime/machine 分域的配置/secret。本文中关于“不热加载”“只改 `plugins.json` 后重启”“不含安装/删除”“Agent/Runner 后置但未展开”等内容不再作为当前实施约束。

# HAPI 插件系统裁剪实施方案

更新时间: 2026-05-19
状态: 裁剪版落地方案；用于约束下一步实现范围，不替代 `requirements-analysis.md` 的长期愿景。

## 1. 结论

插件系统 **裁剪采用**。

第一阶段只做：

1. `PluginRegistry-lite`
2. `Manifest-lite`
3. Hub 侧 `notificationChannel` extension point
4. 本地用户显式启用
5. CLI 本地管理命令
6. 一个 Bark/ServerChan-like 示例插件

暂不做 agent adapter、Web runtime 插件、marketplace、project-local runtime、通用 hook/filter/action 系统、插件 DB storage、权限运行时 grant。

## 2. 裁剪原则

| 原则 | 说明 |
|---|---|
| 先验证一个真实 extension point | 选择 notification channel；当前代码已有接口，历史需求最强。 |
| Manifest-first，但字段最少 | 只保留发现、展示、启用、加载、诊断所需字段。 |
| user-local only | 只加载 `$HAPI_HOME/plugins` / `HAPI_PLUGIN_DIRS`；不加载项目 `.hapi/plugins` runtime。 |
| Web 不执行插件 JS | MVP 不做 Web 插件，只预留 descriptor 概念。 |
| 权限只展示，不承诺 sandbox | in-process JS 是完全信任的本地代码；network/secrets 仅用于审计与 doctor，不是强制拦截。 |
| 核心 invariant 留在 core | auth、namespace、permission flow、SQLite、Socket.IO/RPC/SSE、消息一致性不插件化。 |
| 可撤销注册 | 所有 `registerX()` 返回 disposable；Hub shutdown/deactivate 时清理；MVP 不承诺热卸载。 |

## 3. MVP 范围

### 3.1 保留

| 模块 | MVP 内容 |
|---|---|
| Shared | `PluginManifestLiteSchema`、插件状态/diagnostic 类型。 |
| Hub | 发现、校验、启用状态读取、动态 import hub entry、activate/deactivate、diagnostics、notification channel 注册。 |
| CLI | `hapi plugins list/inspect/enable/disable/doctor`；只管理本机 `$HAPI_HOME`。 |
| Config | `$HAPI_HOME/plugins.json` 保存启用状态与非 secret config。 |
| Secrets | 只从环境变量读取 manifest 声明的 secret 名；不写 secret 文件，不做 Web secret UI。 |
| Example | 一个单向通知插件：Bark 或 ServerChan clone。 |
| Tests | manifest 校验、enabled plugin load、disabled plugin 不 import、channel failure isolation、secret redaction、disposable cleanup。 |

### 3.2 删除 / 后置

| 原方案内容 | 裁剪决定 | 后置阶段 |
|---|---|---|
| Manifest v2 全字段 | 后置；MVP 只做 lite schema。 | v2 hardening |
| `permissions.required/optional` runtime grant | 后置；MVP 只展示 permissions/network/secrets。 | interactive notification 后 |
| `plugin.lock.json` / signature / marketplace | 删除出 MVP。 | marketplace 阶段 |
| project-local `.hapi/plugins` runtime | 删除出 MVP。 | workspace trust 后 |
| Web settingsPanel/sessionAction/renderer | 删除出 MVP。 | declarative Web 阶段 |
| arbitrary Web JS | 明确不做。 | 若未来需要：iframe sandbox + signature |
| Agent adapter / dynamic agent descriptor | 后置。 | agent 阶段 |
| Voice provider | 后置。 | voice 阶段 |
| runnerSpawnStrategy / commandResolver | 后置。 | environment 阶段 |
| generic action/filter/provider taxonomy | 后置；先不要抽象。 | 多 extension point 后再统一 |
| plugin SQLite storage | 后置；MVP 无插件私有持久化。 | stateful plugin 阶段 |
| callback route + permission approve/deny | 不进第一个 MVP；作为 MVP-2。 | interactive notification |

## 4. Manifest-lite

文件名：`hapi.plugin.json`

### 4.1 字段

```ts
type HapiPluginManifestLite = {
    id: string
    name: string
    version: string
    pluginApiVersion: '0.1'
    description?: string
    runtimes?: {
        hub?: {
            entry: string
        }
    }
    contributions?: {
        hub?: {
            notificationChannels?: Array<{
                id: string
                displayName: string
            }>
        }
    }
    config?: {
        // JSON Schema file path; MVP only used by CLI doctor/inspect.
        schema?: string
    }
    permissions?: {
        network?: string[]
        secrets?: string[]
    }
    compatibility?: {
        hapi?: string
        os?: Array<'darwin' | 'linux' | 'win32'>
    }
}
```

说明：`permissions.network/secrets` 在 MVP 是 declared/advisory 信息，只用于 `inspect/doctor/enable` 风险展示，不代表 Hub 会强制拦截网络或 env 访问。

### 4.2 示例

```json
{
    "id": "com.example.bark",
    "name": "Bark Notifications",
    "version": "0.1.0",
    "pluginApiVersion": "0.1",
    "description": "Send HAPI notifications to Bark.",
    "runtimes": {
        "hub": {
            "entry": "dist/hub.js"
        }
    },
    "contributions": {
        "hub": {
            "notificationChannels": [
                {
                    "id": "bark",
                    "displayName": "Bark"
                }
            ]
        }
    },
    "permissions": {
        "network": ["https://api.day.app/*"],
        "secrets": ["BARK_DEVICE_KEY"]
    }
}
```

## 5. 文件布局

```text
$HAPI_HOME/
  plugins.json                  # enabled/config only; no secrets
  plugins/
    com.example.bark/
      hapi.plugin.json
      dist/hub.js
```

`HAPI_PLUGIN_DIRS`：额外扫描路径，使用 Node `path.delimiter` 分隔（POSIX `:`，Windows `;`）。优先级：

1. `HAPI_PLUGIN_DIRS`
2. `$HAPI_HOME/plugins/*`

MVP 不扫描项目目录。

## 6. plugins.json

```json
{
    "enabled": {
        "com.example.bark": {
            "enabled": true,
            "config": {
                "serverUrl": "https://api.day.app"
            }
        }
    }
}
```

要求：

- 不保存 secret 明文。
- 配置写入原子化；并发写 MVP 可用简单 lock file，避免引入 DB。
- diagnostics 不写入 `plugins.json`，只保存在 Hub runtime memory 或 doctor 现场计算。
- 解析失败时 fail closed：插件全部不加载，doctor 输出错误。
- MVP 不做热加载；`enable/disable` 修改文件后，下次 Hub 启动生效。

## 7. Hub API 形态

### 7.1 插件入口

`dist/hub.js` 导出：

```ts
export async function activate(ctx: HubPluginContext): Promise<void> | void
```

### 7.2 Context-lite

```ts
type HubPluginContext = {
    pluginId: string
    logger: PluginLogger
    config: {
        get<T = unknown>(key: string): T | undefined
        all(): Record<string, unknown>
    }
    secrets: {
        get(name: string): string | undefined
    }
    notifications: {
        registerChannel(channel: PluginNotificationChannel): Disposable
    }
}

type Disposable = {
    dispose(): void | Promise<void>
}
```

说明：

- `ctx.secrets.get(name)` 只允许通过 context 读取 manifest 声明的 secret；但 in-process 插件仍是完全信任代码，技术上可直接读 env/filesystem。
- 不暴露 raw `Store` / `SyncEngine` / Socket.IO / SQLite。
- `registerChannel()` 返回 disposable；MVP 在 Hub shutdown 时反序 dispose，未来若支持 runtime deactivate 再复用。

### 7.3 Plugin notification API

不要把现有 `hub/src/notifications/notificationTypes.ts` 的 `NotificationChannel` 直接作为外部插件 ABI；它携带 hub `Session` 内部结构，后续演进风险大。

MVP 定义更窄的插件 DTO：

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

type PluginNotificationEvent =
    | { type: 'ready'; session: PluginNotificationSession }
    | {
        type: 'permission-request'
        session: PluginNotificationSession
        request?: { id: string; tool?: string; arguments?: unknown }
    }
    | {
        type: 'task'
        session: PluginNotificationSession
        notification: { summary: string; status?: string }
    }
    | { type: 'session-completion'; session: PluginNotificationSession; reason: string }

type PluginNotificationChannel = {
    send(event: PluginNotificationEvent): Promise<void>
}
```

Hub 内部增加 adapter：`PluginNotificationChannelAdapter` 实现现有 internal `NotificationChannel`，负责把 `Session` 转成窄 DTO 后调用插件 `send(event)`。

好处：

- 插件不依赖 hub `Session` 内部字段。
- 可以隐藏 permission/core state 细节。
- 后续 shared schema 变化时，只维护 adapter。

## 8. Hub 加载流程

```text
start hub
  load built-in config
  discover plugin manifests
  validate manifests
  read plugins.json enabled state
  for each enabled hub plugin:
    import hub entry
    create scoped context
    activate
    collect disposables + diagnostics
  create NotificationHub([...built-in channels, ...plugin channels])
```

错误策略：

- manifest 无效：插件状态 `failed`，不 import。
- plugin import/activate throw：状态 `failed`，Hub 继续启动。
- channel send throw：沿用 `NotificationHub` per-channel try/catch。
- shutdown/deactivate：dispose 已注册资源；失败写 diagnostics，不影响 Hub shutdown。
- MVP 不要求 CLI `disable` 让正在运行的 Hub 热卸载。

## 9. CLI 命令

MVP 命令：

```bash
hapi plugins list [--json]
hapi plugins inspect <id> [--json]
hapi plugins enable <id>
hapi plugins disable <id>
hapi plugins doctor [id]
```

边界：

- 只操作当前进程可访问的本机 `$HAPI_HOME`。
- 不通过远程 Hub API 管理插件。
- 不做热加载；命令修改 `plugins.json` 后提示重启 Hub 生效。
- 不做 install/update/uninstall；用户手动放置插件目录。
- `enable` 前展示：id、name、version、entry、network、secrets、config 缺失项，以及“插件将在 Hub 进程内执行，等同本地可信代码”的风险提示。

## 10. 示例插件选择

首选：**Bark notification plugin**。

原因：

- 单向 HTTP 发送，边界最小。
- 不需要 callback route。
- 能验证 secret、network 声明、failure isolation。
- 与 Feishu/WeCom/QQ 需求同类。

验收：

1. 插件未 enabled 时不 import。
2. enabled 后 `NotificationHub` 包含该 channel。
3. Bark 发送失败不影响 Push/Telegram/ServerChan。
4. doctor 显示缺 `BARK_DEVICE_KEY`。
5. logs/API 不输出 secret 明文。

## 11. 测试范围

### Shared

- valid manifest parse。
- invalid id/version/apiVersion rejected。
- relative hub entry path normalized/rejected when escaping plugin dir。
- entry path realpath + symlink escape rejected。

### Hub

- discover `$HAPI_HOME/plugins/*`。
- disabled plugin 不 import。
- enabled plugin activate。
- activate throw 不 crash hub。
- channel throw 被隔离。
- dispose called on stop。
- secret redaction in diagnostics/log payload。

### CLI

- list shows discovered/enabled/failed。
- inspect prints manifest + risk fields。
- enable/disable updates `plugins.json` atomically。
- doctor reports missing entry/config/secret。

## 12. 下一阶段路线

### Phase 2: interactive notification

目标：WeCom/Feishu。

新增：

- plugin callback route registry
- signature verification helper
- namespace scoping
- permission approve/deny scoped API
- audit diagnostics

仍不暴露 raw `SyncEngine`。

### Phase 3: dynamic agent descriptor

目标：PI/dummy ACP agent。

新增：

- `AgentDescriptor[]` from machine metadata/RPC
- Hub spawn accepts plugin agent id after descriptor validation
- Web NewSession agent list descriptor-driven
- runner arg builder / external-process adapter prototype

### Phase 4: declarative Web contributions

目标：pinned sessions 或 image renderer。

新增：

- Hub exposes validated descriptors
- Web maps descriptor to built-in components only
- action bridge through authenticated Hub route

### Phase 5: hardening

按真实需求补：

- plugin storage namespace
- project-local recommendation + workspace trust
- lockfile/integrity/signature
- marketplace/install/update
- external-process plugin kind

## 13. 明确不做的事

- 不用插件修权限正确性 bug。
- 不用插件修消息丢失、SSE/Socket.IO/RPC 基础传输 bug。
- 不让插件直接改 SQLite schema。
- 不在 Web 执行未签名插件 JS。
- 不运行时 npm install。
- 不自动启用项目目录里的插件。

## 14. 第一 PR 建议范围

建议第一 PR 只包含：

1. `shared/src/plugins/manifest.ts`
2. `hub/src/plugins/*` registry-lite
3. Hub 启动时加载 enabled notification plugins
4. `hapi plugins list/inspect/enable/disable/doctor`
5. Bark/fixture 示例插件或测试 fixture
6. targeted tests + typecheck

不要同时改：

- Web NewSession
- agent flavor union
- runner spawn schema
- voice routes
- callback routes
- marketplace / install
