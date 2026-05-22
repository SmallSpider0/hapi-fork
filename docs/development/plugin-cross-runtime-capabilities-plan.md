# Cross-runtime plugin capabilities plan

Status: MVP implemented on `feat/plugin-runtime-management-roadmap`; follow-ups noted inline.
Date: 2026-05-22
Branch context: `feat/plugin-runtime-management-roadmap`

## Implementation snapshot

已落地的最小闭环：

- manifest 新增 `capabilities[]`，可描述 Web / Hub / Runner 任意 1-3 个 part。
- Web composer action 统一为 `pluginMessageAction`，通过 `handler.position + actionId` 绑定 Hub/Runner handler。
- Hub runtime 新增 `ctx.messages.registerAction()`；Runner runtime 新增 `ctx.actions.register()`。
- Hub/Runner inventory 上报 `contributionStates` 与 `capabilities`。
- Hub 新增 `GET /api/plugins/capabilities`，支持 `target` 与 `sessionId`；聊天页用 `sessionId` 解析 `session-runner` readiness。
- `POST /api/sessions/:id/messages` 只接受 `pluginAction`；旧 `scheduledAt` / `delivery.notBefore` public API 被 strict schema 拒绝。
- 定时发送已迁移为 `com.hapi.core.schedule-send` Web+Hub 插件；core 只保留内部可靠队列与 `scheduled_at` 索引。
- Settings 插件详情页展示 capability parts/status/diagnostics。
- 生成的 Plugin API reference 已更新。

已明确暂缓：

- `enable-capability` 编排命令：仍作为后续 UX 优化；不影响底层 target enable/disable 与 readiness。
- composer `schemaForm` 运行时表单 UI：schema 已预留，当前聊天输入只渲染 `delayPicker`、`button`、`confirm`。

## 0. 背景与目标

当前插件系统已经有三个“运行位置/消费位置”的雏形：

- **Hub**：可信本地 in-process runtime；已有 notification channel 等 Hub runtime 扩展点。
- **Runner**：可信本地 in-process runtime；已有 environment provider、command resolver、spawn hook、agent adapter/capability provider 等 Runner 扩展点。
- **Web**：只消费声明式 descriptors；不得执行第三方浏览器 JS。

当前问题不是“能否在多个 target 上安装同一个插件”，而是：一个用户感知的功能往往由多个位置共同完成。例如定时发送：

- Web 提供 composer 按钮与时间选择器；
- Hub 做鉴权、请求校验、可靠入库、成熟释放；
- Runner/CLI 通过既有消息通道消费最终消息。

如果只是把 Web 按钮做成 descriptor，而 Hub 语义仍写死在 core，那么插件只是一个设置开关，不是功能提供者。

本方案目标：

> 一个插件包可以在 **1-3 个位置**同时添加能力；HAPI core 负责安装、生命周期、鉴权、跨位置路由与核心一致性，插件负责声明并实现自己的功能语义。

非目标：

- 不引入浏览器内第三方插件 JS。
- 不让插件直接访问 SQLite、Socket.IO、SSE、RPC gateway、SyncEngine、Store。
- 不让插件拥有核心一致性路径：auth、namespace、message ordering、DB migrations、permission correctness、final spawn lifecycle 仍归 core。
- 不一次性引入复杂依赖图、插件间依赖、动态 npm install、OSGi/VS Code 级别 extension host。

## 1. 核心概念

### 1.1 Position

`position` 表示插件能力的运行/消费位置：

| Position | 是否执行插件代码 | 说明 |
|---|---:|---|
| `web` | 否 | Web 只渲染 core 支持的声明式 UI descriptors。 |
| `hub` | 是 | Hub 机器上的可信本地 runtime。 |
| `runner` | 是 | Runner 机器上的可信本地 runtime；每台 Runner 是独立 target。 |

注意：Web 是位置，但不是 trusted runtime。Web part 只能引用 core 内置 UI primitive 或 action descriptor。

### 1.2 Capability

`capability` 是用户可理解的功能单元，可能由 1-3 个 position parts 组成。

示例：

| Capability | Web part | Hub part | Runner part |
|---|---|---|---|
| Hub notification logger | 设置面板 | notification channel | — |
| Runner env injector | 设置面板/徽章 | — | environment provider |
| Schedule send | composer action + delay picker | message action handler | — |
| Attach current git diff then send | composer action | request router/validation | workspace diff provider |
| Custom agent | New Session fields | descriptor aggregation | agent adapter + capability provider |

### 1.3 Capability part

`capability.part` 是能力在某个 position 的组成部分。每个 part 指向已有或新增 contribution id，而不是复制一份实现。

原则：

- `manifest.contributions.*` 仍是冷路径静态声明。
- runtime `ctx.*.register*()` 仍是热路径实际注册。
- `capabilities[]` 只负责把静态/动态 parts 组合成一个用户功能。

### 1.4 Capability availability

一个 capability 的状态不能只看插件 enabled，还要看所有 required parts：

- manifest 是否声明；
- target 是否安装并启用；
- runtime 是否成功激活；
- runtime 是否注册了对应 handler；
- runner target 是否在线/匹配当前 session；
- 插件版本是否一致或兼容。

建议状态：

```ts
type PluginCapabilityStatus =
    | 'ready'
    | 'partial'
    | 'disabled'
    | 'missing-target'
    | 'offline'
    | 'failed'
    | 'incompatible'
```

Web 默认只渲染 `ready` capability。设置页可以显示 `partial` 及原因。

## 2. Manifest 设计

### 2.1 保留现有 contributions

现有结构继续保留：

```json
{
  "runtimes": {
    "hub": { "entry": "dist/hub.js" },
    "runner": { "entry": "dist/runner.js" }
  },
  "contributions": {
    "hub": {},
    "runner": {},
    "agent": {},
    "web": {}
  }
}
```

### 2.2 新增 capabilities 顶层字段

建议新增：

```json
{
  "capabilities": [
    {
      "id": "schedule-send",
      "kind": "chat.composer.messageAction",
      "displayName": "Schedule Send",
      "description": "Delay a user message until a selected time.",
      "parts": {
        "web": {
          "required": true,
          "contributions": [
            { "type": "composerAction", "id": "schedule-send" }
          ]
        },
        "hub": {
          "required": true,
          "contributions": [
            { "type": "messageAction", "id": "schedule-send" }
          ]
        }
      }
    }
  ]
}
```

字段建议：

```ts
type PluginCapabilityKind =
    | 'chat.composer.messageAction'
    | 'chat.contextProvider'
    | 'notification.channel'
    | 'runner.spawnExtension'
    | 'agent.adapter'
    | 'agent.capabilityProvider'
    | 'settings.panel'
    | 'integration.bridge'

type PluginCapabilityPart = {
    required?: boolean // default true
    target?: 'hub' | 'session-runner' | 'selected-runner' | 'all-runners'
    contributions: Array<{
        type: string
        id: string
    }>
}

type PluginCapability = {
    id: string
    kind: PluginCapabilityKind
    displayName?: string
    description?: string
    parts: {
        web?: PluginCapabilityPart
        hub?: PluginCapabilityPart
        runner?: PluginCapabilityPart
    }
    compatibility?: {
        minPluginVersion?: string
        sameVersionAcrossTargets?: boolean
    }
}
```

### 2.3 Why separate capability from contributions

不建议把所有跨位置关系塞进每个 contribution 内，原因：

- 一个 capability 可能复用多个 contribution。
- 一个 contribution 也可能服务多个 capability。
- 冷路径 manifest 可直接呈现“这个插件提供什么能力”。
- 管理 UI 可以按 capability 聚合，而不是按 Hub/Runner/Web 分散显示。

## 3. Web descriptor 改造

### 3.1 Web 只声明入口，不拥有执行语义

当前 `deliveryNotBefore` 这类 kind 容易把业务语义写死在 Web/core。建议改为更通用的 descriptor：

```json
{
  "id": "schedule-send",
  "kind": "pluginMessageAction",
  "label": { "en": "Schedule send", "zh-CN": "定时发送" },
  "icon": "clock",
  "capabilityId": "schedule-send",
  "handler": {
    "position": "hub",
    "actionId": "schedule-send"
  },
  "ui": {
    "kind": "delayPicker",
    "maxDelayMs": 604800000,
    "presets": [
      { "id": "plus-5m", "label": "+5m", "delayMs": 300000 }
    ]
  }
}
```

Web 支持有限 UI primitives：

```ts
type ComposerActionUi =
    | { kind: 'button' }
    | { kind: 'confirm'; title: WebLocalizedText; body?: WebLocalizedText }
    | { kind: 'delayPicker'; maxDelayMs: number; presets: DelayPreset[] }
    | { kind: 'schemaForm'; fields: WebSchemaFormField[] }
```

Web 输出统一 action payload：

```ts
type PluginActionRequest = {
    pluginId: string
    capabilityId?: string
    actionId: string
    position: 'hub' | 'runner'
    payload: unknown
}
```

Web 不直接发送 `delivery.notBefore`、`scheduledAt` 这类业务字段。

### 3.2 Web capability gating

Web 不应直接渲染所有 `web.contributions`。应使用 Hub 聚合后的 capability view：

```ts
GET /api/plugins/capabilities?sessionId=<id>
```

返回：

```json
{
  "capabilities": [
    {
      "pluginId": "com.hapi.core.schedule-send",
      "pluginName": "Schedule Send",
      "capabilityId": "schedule-send",
      "kind": "chat.composer.messageAction",
      "status": "ready",
      "parts": {
        "web": { "status": "ready" },
        "hub": { "status": "ready" }
      },
      "web": {
        "composerActions": [/* safe descriptors */]
      }
    }
  ]
}
```

Web 只展示：

- `status === 'ready'`；
- kind 与当前 UI surface 匹配；
- target 与当前 session/machine 匹配。

## 4. Hub runtime 扩展点

### 4.1 新增 message action registry

Hub plugin SDK 增加：

```ts
ctx.messages.registerAction({
    id: 'schedule-send',
    kind: 'chat.composer.messageAction',
    async plan(input) {
        return {
            ok: true,
            plan: {
                type: 'messageDelivery',
                delivery: { notBefore: input.payload.notBefore }
            }
        }
    }
})
```

建议类型：

```ts
type HubMessageActionInput = {
    namespace: string
    session: PluginSessionRef
    text: string
    localId?: string
    attachments: PluginAttachmentRef[]
    payload: unknown
    capabilityId?: string
    actionId: string
}

type HubMessageActionResult =
    | { ok: true; plan: MessageSendPlan }
    | { ok: false; code: string; message: string }

type MessageSendPlan =
    | { type: 'immediate' }
    | {
        type: 'messageDelivery'
        delivery: {
            notBefore?: number
        }
        source: {
            pluginId: string
            capabilityId?: string
            actionId: string
        }
    }
```

Hub core 负责把 `MessageSendPlan` 转成 MessageService 调用。插件不直接写 DB。

### 4.2 Hub action dispatch API

`POST /api/sessions/:id/messages` 支持：

```json
{
  "text": "hello",
  "localId": "local-123",
  "pluginAction": {
    "pluginId": "com.hapi.core.schedule-send",
    "capabilityId": "schedule-send",
    "actionId": "schedule-send",
    "position": "hub",
    "payload": { "notBefore": 1770000000000 }
  }
}
```

处理流程：

```txt
route auth + namespace
  -> validate basic message shape
  -> resolve pluginAction target
  -> assert plugin enabled + runtime active
  -> assert manifest capability has web+hub parts ready
  -> dispatch Hub registered action
  -> validate returned MessageSendPlan against core invariants
  -> MessageService.sendMessage(plan)
```

错误建议：

| 条件 | HTTP |
|---|---:|
| action body invalid | 400 |
| plugin/action/capability not found | 404 |
| plugin disabled/partial/offline | 409 |
| handler validation failed | 400 |
| handler threw | 500 + diagnostic |

### 4.3 Core must revalidate plans

即使插件 handler 已校验，core 仍要做 defense-in-depth：

- `notBefore` 必须在允许窗口内；
- delayed message 必须有 `localId`；
- delayed message + attachments 是否支持由 core 最终决定；
- namespace/session ownership 由 core 校验；
- message ordering/invoked semantics 由 core 校验。

## 5. Runner runtime 扩展点

### 5.1 Runner action registry

Runner plugin SDK 增加：

```ts
ctx.actions.register({
    id: 'attach-current-diff',
    kind: 'chat.contextProvider',
    async run(input) {
        return {
            ok: true,
            result: {
                textPrefix: await readGitDiff(input.cwd)
            }
        }
    }
})
```

Runner action 输入必须是 DTO，不暴露 runner internals：

```ts
type RunnerPluginActionInput = {
    namespace: string
    machineId: string
    sessionId?: string
    cwd?: string
    payload: unknown
}
```

输出必须是 typed result：

```ts
type RunnerPluginActionResult =
    | { ok: true; result: unknown }
    | { ok: false; code: string; message: string }
```

### 5.2 Hub-mediated Runner dispatch

Web 不直接调用 Runner。Hub 通过 core RPC 调 Runner：

```txt
Web -> Hub /api/plugin-actions
Hub auth/namespace/session target resolution
Hub -> Runner RPC machine:<id>:runner.plugins.actions.invoke
Runner plugin manager dispatches active handler
Runner -> Hub typed result
Hub optionally continues Hub handler / message send flow
```

### 5.3 Runner target selection

Capability part 可声明 target policy：

| Policy | 说明 |
|---|---|
| `session-runner` | 当前 session 所属 machine。 |
| `selected-runner` | Web/New Session 中用户选择的 machine。 |
| `all-runners` | 管理/安装类操作，不用于普通 composer action。 |

Hub 负责按 namespace 找 machine；Runner offline 时 capability status 为 `offline`。

## 6. Capability aggregation

### 6.1 Inventory 层

现有：

- Hub manager: `listPlugins()`, `collectWebContributions()`
- Runner manager: `getInventory()` with plugins/extensions/webContributions

建议新增：

```ts
type PluginRuntimeContributionState = {
    pluginId: string
    target: PluginTargetSummary
    runtime: 'hub' | 'runner'
    contributionType: string
    contributionId: string
    declared: boolean
    registered: boolean
    active: boolean
    diagnostics: PluginDiagnosticView[]
}
```

Hub inventory 返回 Hub contribution states；Runner inventory 返回 Runner contribution states。

### 6.2 Aggregator 层

Hub Web route 新增聚合器：

```ts
buildPluginCapabilities({
    hubInventory,
    runnerInventories,
    session?: Session
}): PluginCapabilityView[]
```

聚合逻辑：

1. 从所有 enabled plugin manifests 读 `capabilities[]`。
2. 对每个 capability part：
   - web part：检查 web descriptor 是否存在；
   - hub part：检查 Hub target plugin enabled/active/registered；
   - runner part：按 target policy 找 Runner inventory，并检查 enabled/active/registered。
3. 合并 diagnostics。
4. 计算 status。
5. 返回 Web-safe descriptor subset。

### 6.3 Capability view DTO

建议：

```ts
type PluginCapabilityView = {
    pluginId: string
    pluginName?: string
    pluginVersion?: string
    capabilityId: string
    kind: PluginCapabilityKind
    displayName?: string
    description?: string
    status: PluginCapabilityStatus
    target?: PluginTargetSummary
    parts: {
        web?: PluginCapabilityPartStatus
        hub?: PluginCapabilityPartStatus
        runner?: PluginCapabilityPartStatus
    }
    web?: PluginWebContributions
    diagnostics: PluginDiagnosticView[]
}
```

## 7. Lifecycle 与 enable/disable 语义

### 7.1 Plugin package vs capability

一个插件包可包含多个 capability。管理 UI 需要分两层：

- **Plugin package**：安装、删除、版本、权限、源码路径。
- **Target enablement**：在 Hub/Runner target 上启用 runtime。
- **Capability readiness**：某个用户功能是否 ready。

不要把 capability 直接等同于 enable 开关。

### 7.2 Enable flows

现有 target-scope enable 继续保留：

```txt
hapi plugins enable <pluginId> --target hub
hapi plugins enable <pluginId> --target runner:<machineId>
```

新增 convenience flow：

```txt
hapi plugins enable-capability <pluginId>/<capabilityId> --target session-runner|runner:<id>|hub
```

它只是 orchestrator：

- 找 capability required parts；
- 提示需要在哪些 target 启用；
- 分别调用现有 enable API；
- 显示部分失败。

### 7.3 Disable behavior

禁用某个 target 的插件：

- 该 target runtime handler 注销；
- capability 可能从 `ready` 变 `partial` 或 `disabled`；
- Web 不再展示需要该 part 的 action；
- API 直接调用该 action 应被拒绝；
- 已经持久化的 core jobs 继续由 core 安全处理。

例：定时发送插件禁用后：

- 新的 schedule action 被拒；
- 已入库 scheduled messages 仍 mature release；
- 这是 core queue 的一致性要求，不代表插件仍 active。

## 8. Security 与 trust

### 8.1 Trust boundary

- Hub/Runner runtime 插件是可信本地代码，无 sandbox；启用时必须保留风险提示。
- Web descriptor 永不执行任意 JS。
- Cross-runtime dispatch 必须由 Hub 鉴权、授权、namespace、target resolution 后发起。
- 插件不能自行开放 HTTP route 或 raw RPC endpoint。

### 8.2 Secrets/config

现有 scoped config 继续扩展：

```txt
hub:<pluginId>
runner:<machineId>:<pluginId>
agent:<machineId>:<agentId>:<pluginId>
```

Capability 可声明 `configScopes` 仅用于 UI 引导，不改变真实存储边界。

跨 runtime 插件如果需要同一个 secret：

- Hub secret 从 Hub process env 读取；
- Runner secret 从 Runner process env 读取；
- 不通过 Hub 转发 secret 到 Runner；
- Web 永远不接收 secret。

### 8.3 Replay / action integrity

普通 Web->Hub action 已依赖 JWT + HTTPS。若后续支持 external callback/deep link，则需要：

- signed callback token；
- nonce/replay window；
- namespace/session binding；
- action id/capability id binding。

不作为本方案 MVP。

## 9. 定时发送迁移示例

### 9.1 目标 manifest

```json
{
  "id": "com.hapi.core.schedule-send",
  "name": "Schedule Send",
  "version": "0.1.0",
  "pluginApiVersion": "0.1",
  "runtimes": {
    "hub": { "entry": "dist/hub.js" }
  },
  "capabilities": [
    {
      "id": "schedule-send",
      "kind": "chat.composer.messageAction",
      "displayName": "Schedule Send",
      "parts": {
        "web": {
          "required": true,
          "contributions": [{ "type": "composerAction", "id": "schedule-send" }]
        },
        "hub": {
          "required": true,
          "contributions": [{ "type": "messageAction", "id": "schedule-send" }]
        }
      }
    }
  ],
  "contributions": {
    "hub": {
      "messageActions": [
        { "id": "schedule-send", "displayName": "Schedule Send" }
      ]
    },
    "web": {
      "composerActions": [
        {
          "id": "schedule-send",
          "kind": "pluginMessageAction",
          "capabilityId": "schedule-send",
          "label": { "en": "Schedule send", "zh-CN": "定时发送" },
          "icon": "clock",
          "handler": { "position": "hub", "actionId": "schedule-send" },
          "ui": {
            "kind": "delayPicker",
            "maxDelayMs": 604800000,
            "presets": [
              { "id": "plus-5m", "label": "+5m", "delayMs": 300000 },
              { "id": "plus-30m", "label": "+30m", "delayMs": 1800000 },
              { "id": "plus-1h", "label": "+1h", "delayMs": 3600000 },
              { "id": "plus-4h", "label": "+4h", "delayMs": 14400000 }
            ]
          }
        }
      ]
    }
  }
}
```

### 9.2 Hub runtime

```js
export function activate(ctx) {
    ctx.messages.registerAction({
        id: 'schedule-send',
        kind: 'chat.composer.messageAction',
        async plan(input) {
            const notBefore = Number(input.payload?.notBefore)
            if (!Number.isInteger(notBefore) || notBefore <= 0) {
                return { ok: false, code: 'invalid-not-before', message: 'notBefore must be a positive integer timestamp.' }
            }
            if (notBefore > Date.now() + 7 * 24 * 60 * 60 * 1000) {
                return { ok: false, code: 'too-far', message: 'Schedule time must be within 7 days.' }
            }
            if (input.attachments.length > 0) {
                return { ok: false, code: 'attachments-unsupported', message: 'Scheduled messages with attachments are not supported.' }
            }
            return {
                ok: true,
                plan: {
                    type: 'messageDelivery',
                    delivery: { notBefore },
                    source: {
                        pluginId: ctx.pluginId,
                        capabilityId: 'schedule-send',
                        actionId: 'schedule-send'
                    }
                }
            }
        }
    })
}
```

### 9.3 迁移效果

- 禁用插件：按钮消失，API action 被拒。
- 启用插件：按钮出现，handler 决定是否创建 delayed plan。
- Core 仍负责可靠队列与 mature release。
- 第三方可实现另一个 message action，而无需改 core route/schema 之外的通用 action plumbing。

## 10. 实施阶段

### Phase A — Schema only

改动：

- `shared/src/plugins/manifest.ts`
  - 新增 `PluginCapabilitySchema`
  - 新增 `contributions.hub.messageActions`
  - Web composer action 改为 `pluginMessageAction` + `ui` + `handler`
- `shared/src/plugins/admin.ts`
  - 新增 `PluginCapabilityViewSchema`
  - `PluginTargetInventory` 可附带 contribution states
- 生成 docs。

验收：manifest schema 测试覆盖 1/2/3 positions capability。

### Phase B — Runtime registration

改动：

- Hub registry 增加 `registerMessageAction()`。
- Runner registry 增加 `registerAction()`。
- Manager inventory 上报 registered contribution states。

验收：disabled/invalid plugins 不注册；reload dispose 后 handler 消失；activation fail 保持旧实例/诊断。

### Phase C — Capability aggregator

改动：

- Hub routes 新增 `/api/plugins/capabilities`。
- 聚合 Hub + Runner inventories。
- 支持 session-aware runner target resolution。

验收：Web descriptor 存在但 Hub handler 未注册 => `partial`；Runner offline => `offline`；ready capability 返回 Web-safe descriptors。

### Phase D — Generic action dispatch

改动：

- `SendMessageRequestSchema` 新增 `pluginAction`。
- Hub message route 调 Hub/Runner action registry。
- MessageService 接收 internal `MessageSendPlan`。

验收：禁用插件 action 失败；启用插件 action 成功；core revalidation 生效。

### Phase E — Migrate schedule send

改动：

- `com.hapi.core.schedule-send` 加 Hub runtime entry。
- 移除 Web 对 `deliveryNotBefore` 的业务识别，改为 `delayPicker` primitive。
- Web composer 从 capabilities 渲染。
- Public `scheduledAt` / `delivery.notBefore` 直接移除；新请求只走 `pluginAction`。

验收：禁用插件后新 schedule 请求失败；已有 scheduled rows 继续释放。

### Phase F — Runner-assisted sample

已实现 `com.hapi.examples.cross-runtime-action` 示例插件：

- Web composer action：`example-cross-runtime` confirm 按钮。
- Hub message action：`example-cross-runtime`，返回 immediate `MessageSendPlan`。
- Runner action：`example-cross-runtime-context`，作为 `session-runner` required part 参与 readiness。

验收：`GET /api/plugins/capabilities?sessionId=<id>` 只按当前 session runner 计算 ready/offline/missing-target；Runner 缺失时聊天页不渲染 action。

### Phase G — Management UX

已完成：

- Plugin detail 页新增 “Capabilities” section。
- 显示 capability parts、target status、diagnostics、enable guidance。

后续可选：

- 可选：`enable capability` orchestrator。

验收：用户能看懂为什么一个跨位置能力不可用。

## 11. 测试矩阵

必须补齐：

1. Manifest accepts capability with only Web, only Hub, only Runner, Web+Hub, Web+Runner, Hub+Runner, Web+Hub+Runner。
2. Disabled Hub plugin：static descriptor 可见于 plugin detail，但 capability 不 ready，action dispatch 409。
3. Disabled Runner plugin：session-runner capability offline/disabled，不渲染 Web action。
4. Web descriptor exists but runtime handler missing：`partial`。
5. Runtime handler exists but Web descriptor missing：API-only capability ready，但 composer 不渲染。
6. Version mismatch across Hub/Runner：status `incompatible` 或 `partial`。
7. Namespace mismatch machine：Hub 不把 Runner action 发到其他 namespace。
8. Runner offline：capability status `offline`，cached inventory 标记 stale。
9. Reload：handler registry 替换；旧 handler dispose；failed reload keeps previous active handler。
10. Schedule-send migration：禁用后新请求失败，旧 scheduled messages 继续 mature release。
11. Web never executes plugin JS；所有 UI 来自 descriptor primitive。
12. Secrets redaction across Hub/Runner diagnostics。

## 12. 无兼容层迁移策略

本次实现不保留旧 public API 兼容层；旧客户端必须同步升级：

- `POST /api/sessions/:id/messages`：`scheduledAt` / `delivery.notBefore` 作为未知字段被 strict schema 拒绝。
- `web.composerActions.kind = deliveryNotBefore`：直接删除，所有 composer action 统一为 `kind = pluginMessageAction`。
- DB `scheduled_at`：继续作为 Hub 内部索引字段保留；它不是 public request contract。
- 后续如需审计，可新增 `delivery_plugin_id`, `delivery_action_id`, `delivery_payload_json` 或独立 `message_delivery_jobs` 表。

推荐最终内部模型：

```ts
type InternalMessageDelivery = {
    notBefore?: number
    source?: {
        pluginId: string
        capabilityId?: string
        actionId: string
    }
    payload?: unknown
}
```

Core 可继续用 `scheduled_at` 做索引；source metadata 用于审计和 UI 展示。

## 13. 设计约束总结

- Capability 是用户功能；contribution 是实现零件；runtime registration 是实际可执行状态。
- 一个插件包可包含 Web/Hub/Runner 任意 1-3 个 position parts。
- Web part 永远是 descriptor-only。
- Hub 是跨位置 action 的唯一入口和策略执行点。
- Runner action 必须通过 Hub-mediated typed RPC 调用。
- Core 保留安全、一致性、可靠队列、DB、transport、namespace 权限。
- 禁用插件必须阻止新增能力调用，但不能破坏已持久化 core jobs。

## 14. 推荐落地顺序

如果只做一条最小闭环，优先顺序：

1. `capabilities[]` schema + capability view DTO。
2. Hub `registerMessageAction()`。
3. `/api/plugins/capabilities` ready/partial 聚合。
4. Web composer 改消费 capability view。
5. `pluginAction` dispatch 到 Hub handler。
6. schedule-send 迁移为 Web+Hub first-party plugin。
7. 再扩展 Runner action 与三位置示例。

这样能最快纠正“插件只是开关”的问题，同时不提前扩大 Web/Runner 安全面。
