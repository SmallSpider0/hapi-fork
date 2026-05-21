# Phase 01 — Foundation：manifest/discovery/state；不 import runtime

更新时间: 2026-05-21
完成证据: `shared/src/plugins/*` 已提供 manifest/status/state/discovery 冷路径基础；`cli/src/plugins/pluginFoundation.test.ts` 覆盖 manifest 校验、路径安全、重复 id、状态文件 fail-closed、Windows delimiter；未接入 Hub runtime/import、Web、Runner/RPC/SSE/auth/namespace。

## 目标

建立插件系统冷路径：发现插件目录、读取 manifest、校验兼容性、读取/写入启用状态、生成 diagnostics。**本阶段不 import 插件代码**。

对应上传报告的基础经验：manifest 是冷路径契约；目录安装是一等能力；失败状态必须产品化。

## 必须包含

- `shared`：`PluginManifestLiteSchema`、status/diagnostic 类型。
- Hub/CLI 可复用的 discovery + manifest validation 逻辑。
- `$HAPI_HOME/plugins/*` 扫描。
- `HAPI_PLUGIN_DIRS` 扫描，使用 Node `path.delimiter`。
- `plugins.json` read/write helper：原子写；解析失败 fail closed。
- Path safety：relative entry、realpath、symlink escape 拒绝。
- Fixture tests。

## 必须排除

- Hub `import()` 插件。
- Notification channel 注册。
- Web。
- Runner/RPC/SSE/auth/namespace 改动。
- Marketplace/install/update/signature。
- Project-local `.hapi/plugins` runtime。

## Manifest-lite

文件名：`hapi.plugin.json`。

```ts
type PluginManifestLite = {
    id: string
    name: string
    version: string
    pluginApiVersion: '0.1'
    description?: string
    runtimes?: {
        hub?: { entry: string }
    }
    contributions?: {
        hub?: {
            notificationChannels?: Array<{ id: string; displayName: string }>
        }
    }
    config?: {
        // JSON Schema path; Phase 01 only inspect/doctor reads it.
        schema?: string
    }
    permissions?: {
        // Advisory only until hardening; not sandbox enforcement.
        network?: string[]
        secrets?: string[]
    }
    compatibility?: {
        hapi?: string
        os?: Array<'darwin' | 'linux' | 'win32'>
    }
}
```

## plugins.json

位置：`$HAPI_HOME/plugins.json`。

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
- 原子写入。
- 简单 lock file 防并发 CLI/进程写；或 safe failure，需明确错误。
- 解析失败 fail closed；不启用任何插件。
- Diagnostics 不写入该文件；runtime memory 或 doctor 现场计算。

## 文件与模块建议

| 包 | 新增/修改 |
|---|---|
| `shared` | `shared/src/plugins/manifest.ts`, `shared/src/plugins/types.ts`, export。 |
| `cli` | `cli/src/plugins/discovery.ts`, `state.ts`, `diagnostics.ts`。 |
| `hub` | 可复用 `shared` 类型；runtime 后续 Phase 02。 |
| `localdocs` | 记录 manifest 和状态文件契约。 |

## Path safety

- `runtimes.hub.entry` 必须是相对路径。
- `resolve(pluginRoot, entry)` 后必须仍在 root 下。
- `realpath` 后必须仍在 plugin root realpath 下。
- Symlink escape blocked。
- world-writable / ownership 可先 warning；block 策略留 Phase 11/12 hardening。

## Checklist

审计说明: 子代理已逐项核对当前实现与测试证据；本阶段 checklist 全部完成。

### 实现

- [x] `PluginManifestLiteSchema` 使用 Zod。
- [x] `pluginApiVersion` mismatch 标记 incompatible/blocked。
- [x] `id` 规则稳定；禁止空白/路径字符。
- [x] discovery 支持 `$HAPI_HOME/plugins/*`。
- [x] discovery 支持 `HAPI_PLUGIN_DIRS` + `path.delimiter`。
- [x] 重复 id 有确定优先级并产生 diagnostic。
- [x] Disabled plugin 不 import runtime。
- [x] Invalid plugin 不 import runtime。
- [x] `plugins.json` 原子写入。
- [x] `plugins.json` parse error fail closed。

### 测试

- [x] Valid manifest parse。
- [x] Invalid JSON rejected。
- [x] Invalid id/version/apiVersion rejected。
- [x] Entry `../` escape rejected。
- [x] Symlink escape rejected。
- [x] Duplicate id diagnostic。
- [x] `plugins.json` parse error fail closed。
- [x] Windows delimiter 行为有纯函数测试。

### 验收

- [x] 可以在不执行插件代码的前提下列出候选插件。
- [x] 可以读取 enabled/config 状态。
- [x] 所有 runtime 行为未接入 Hub。
- [x] 无 auth/namespace/RPC/SSE/runner 行为变化。

## Checklist 更新规则

后续若修改本阶段 checklist，必须按 `README.md` 的子代理验证规则执行，并在下方追加验证记录。

## 验证记录

- 2026-05-21 — review sub-agent — 已核对当前实现与测试证据，Phase 01 checklist 维持完成；后续任何勾选变更必须追加新的子代理验证记录。
