# Phase 03 — 插件管理体验：CLI / Web / Hub 热重载

更新时间: 2026-05-21
状态: 当前 Hub 管理体验阶段；覆盖 CLI、Web、Hub 热重载、本地路径安装、删除与诊断。仍只管理 Hub runtime，不代表最终插件系统只支持 Hub。

## 目标

把 Phase 01/02 的“本地插件目录 + `plugins.json` + Hub notification runtime”产品化：用户可以通过 CLI 和 Web 发现、查看、安装、启用、禁用、配置、删除、诊断插件，并让 Hub 在不重启进程的情况下对 Hub notification 插件执行受控热重载。

本阶段解决 Hub 侧用户体验；Runner/Agent 扩展能力从 Phase 04 开始继续推进。

## 交付范围

### CLI 管理

- `hapi plugins list [--json]`
- `hapi plugins inspect <id> [--json]`
- `hapi plugins enable <id> [--config <json-or-file>] [--reload]`
- `hapi plugins disable <id> [--reload]`
- `hapi plugins config get <id> [--json]`
- `hapi plugins config set <id> <key> <value> [--reload]`
- `hapi plugins reload [id] [--json]`
- `hapi plugins doctor [id] [--json]`
- `hapi plugins install <path> [--enable] [--reload]`
- `hapi plugins delete <id> [--yes] [--reload]`

CLI 默认只操作本机 `$HAPI_HOME`。当 `--reload` 或 `reload` 被调用时，可以连接当前配置的 Hub API 触发 Hub 侧 reload；如果 Hub 不可达，命令必须清楚提示“状态已写入，下次 Hub reload/restart 生效”。

### Hub 管理 API

Authenticated REST endpoints，仅操作 Hub 当前 `$HAPI_HOME` 与 Hub 本机插件目录：

- `GET /api/plugins`
- `GET /api/plugins/:id`
- `POST /api/plugins/:id/enable`
- `POST /api/plugins/:id/disable`
- `PATCH /api/plugins/:id/config`
- `POST /api/plugins/reload`
- `POST /api/plugins/:id/reload`
- `GET /api/plugins/diagnostics`
- `POST /api/plugins/local-directory`
- `POST /api/plugins/install-local`
- `DELETE /api/plugins/:id`

要求：

- API 返回 shared schema 校验后的 DTO；不暴露 raw registry object、raw `Session`、`Store`、`SyncEngine`、SQLite handle、SSE/RPC/socket 对象。
- 所有管理操作复用现有 Web auth/JWT/token 边界；无 unauthenticated callback。
- API 响应中只显示 secret 名称与 present/missing 状态；绝不返回 secret value。
- 安装/删除只针对 Hub 本机插件目录；不得让 Hub 直接读写远端 Runner 文件系统。

### Web 管理 UI

- 顶层插件入口靠近设置入口，避免把插件能力隐藏在 Settings 内部。
- 插件列表展示：name、id、version、source、status、enabled、active、runtime、diagnostics 摘要。
- 插件详情展示：manifest metadata、root/entry 信息、declared contributions、network/secrets permissions、config schema、diagnostics。
- 状态信息使用清晰 badge/icon 表达 enabled、active、source、runtime、warnings，而不是只显示“是/否”文本。
- Enable 前风险提示：
  - 插件会作为 trusted local code 在 Hub 进程内执行。
  - permissions 只是声明与审计，不是 sandbox enforcement。
  - declared network/secrets。
  - secret value 不会在 Web 中显示或保存。
- 支持 Web 启用、禁用、保存 config、手动 reload、从 Hub 本地路径安装、删除本地插件。
- Config UI 首版可以是 JSON editor + schema validation errors；后续再做 schema form。
- Web 只做管理 UI，不执行插件 JS，不加载远程 component bundle。

### Hub 热重载

- Hub 引入长期存活的 PluginManager，替代“启动时一次性 load 后丢弃”的 runtime 形态。
- Reload 触发源：
  - CLI `hapi plugins reload`。
  - Web enable/disable/config/install/delete/reload 操作。
  - Hub 启动后对 `$HAPI_HOME/plugins.json` 与已发现插件目录做 debounce 文件监听；监听不可用时降级为手动 reload。
- Reload 行为：
  - 重新 discovery + validate + read/apply `plugins.json`。
  - 对 enabled/disabled/config/entry/manifest 变化做 diff。
  - 新启用插件：import + activate，成功后 active。
  - 禁用插件：立即 dispose 该插件注册的 notification channels。
  - 已启用且文件/config 变化：在 per-plugin staging registry 中激活新实例；成功后 swap 并 dispose 旧实例；失败则保留旧实例并报告 reload diagnostic。
  - unchanged active plugin 不重复 activate。
  - disabled/invalid/incompatible/blocked plugin 不 import。
- Reload 必须串行化；并发请求合并或排队，不能交错修改 active registry。
- Reload result 必须返回每个插件的状态变化：`activated`、`deactivated`、`reloaded`、`unchanged`、`failed`、`kept-previous`。
- 热重载只保证 HAPI-mediated resources 的清理：notification channels、Disposable、registry entries。插件自行创建的外部资源必须通过 `dispose()` 清理；Core 不承诺强制杀死任意 in-process side effect。

## 明确排除

- 通用 marketplace、在线 update、签名分发。
- 运行时 `npm install`。
- 自动启用 project-local `.hapi/plugins`。
- Web 执行任意插件 JS、远程 bundle、iframe plugin runtime。
- 浏览器保存 secret value 或提供通用 secret vault。
- Arbitrary plugin HTTP route / service registry。
- Interactive callback、permission approve/deny；移至 Phase 12。
- Runner plugin runtime、Runner command/spawn extension point；移至 Phase 05/06。
- Agent adapter / dynamic agent descriptor；移至 Phase 07/08。
- Declarative Web contributions；移至 Phase 09。Phase 03 的 Web 范围仅是“管理插件”。

## Checklist 更新规则

勾选前必须按 `README.md` 的“Checklist 勾选与子代理验证规则”执行：提交当前 diff、验证命令、准备勾选条目给 review/verification 子代理；无 blocker 后才更新 `[x]`，并追加验证记录。

## Checklist

### 实现

- [x] Shared 增加 plugin admin DTO/schema。
- [x] Hub PluginManager 持有 active plugin runtime records。
- [x] Hub reload 串行化与 per-plugin staging activation。
- [x] Hub 支持 enable/disable/config/reload REST endpoints。
- [x] Hub watcher debounce `$HAPI_HOME/plugins.json` 与已发现插件目录；不可用时降级手动 reload。
- [x] Reload result 可解释 activated/deactivated/reloaded/unchanged/failed/kept-previous。
- [x] Disable 可立即 dispose active notification channels。
- [x] Changed plugin reload 成功后 swap；失败保留旧实例。
- [x] CLI `plugins` command 注册到 command registry。
- [x] CLI list/inspect 不 import plugin runtime。
- [x] CLI enable/disable/config 使用 Phase 01 state helper 原子写。
- [x] CLI reload 可调用 Hub API；Hub 不在线时输出明确 fallback。
- [x] CLI 支持从本地路径安装插件。
- [x] CLI 支持删除本地插件目录并清理 enable/config 状态。
- [x] Web 顶层插件入口独立于 Settings 菜单。
- [x] Web plugin list/detail/diagnostics/permissions/config/action controls。
- [x] Web 支持从 Hub 本地路径浏览并安装插件。
- [x] Web 支持删除本地插件。
- [x] Web 状态展示使用 badge/icon 区分 enabled、active、source、runtime、warnings。
- [x] Enable 风险提示覆盖 trusted code、permissions non-enforcement、secret value 不展示。
- [x] API/Web/CLI 均不返回或保存 secret value。
- [x] 删除“安装内置示例插件”入口；示例只作为 fixture/文档，不作为产品安装项。

### 测试

- [x] CLI list shows discovered/enabled/active/invalid。
- [x] CLI inspect redacts secrets and does not import runtime。
- [x] CLI enable/disable writes `plugins.json` atomically。
- [x] CLI install copies/links local plugin with path safety checks。
- [x] CLI delete rejects unsafe roots and updates state atomically。
- [x] Hub API requires auth for plugin management routes。
- [x] Hub enable activates plugin without full restart。
- [x] Hub disable disposes plugin channels without full restart。
- [x] Config change reloads plugin and exposes new behavior。
- [x] Entry file change reloads plugin via explicit reload。
- [x] Watcher debounce triggers reload or reports unsupported fallback deterministically。
- [x] Activation failure during reload keeps previous active instance。
- [x] Concurrent reload requests serialize。
- [x] Invalid/disabled plugin never imported during reload。
- [x] API diagnostics redact declared secret values。
- [x] Web enable/disable/reload/install/delete invalidates plugin query and shows success/error result。

### 验收

- [x] 用户可把插件放入 `$HAPI_HOME/plugins/<id>`，从 CLI 或 Web 启用，无需重启 Hub 即可收到 plugin notification。
- [x] 用户可从 CLI 或 Web 禁用 active 插件，后续通知不再发送到该插件，无需重启 Hub。
- [x] 用户可从 CLI 或 Web 安装 Hub 本地插件路径。
- [x] 用户可从 CLI 或 Web 删除 Hub 本地插件并清理状态。
- [x] 用户修改插件 entry 或 config 后，手动 reload 或 watcher reload 能应用新行为。
- [x] Reload 失败不会拖垮 Hub，也不会让旧的可用插件实例丢失。
- [x] Web 管理 UI 不执行插件 JS、不显示 secret value。
- [x] CLI 离线时仍可管理本地 `plugins.json`，并明确提示如何应用变更。
- [x] Web 文档明确说明 Hub 本地路径安装不等于 Runner 本地路径安装。

## 验证记录

- 2026-05-21 — review sub-agent — Phase 03 勾选状态来自当前本地实现与已运行验证；如后续修改勾选项，必须追加新的子代理验证记录。
- 2026-05-21 — review sub-agent — 补充 Web 安装说明，明确 Hub 本地路径不是浏览器本机路径，也不是远端 Runner 路径；新增递归 secret/redacted config 持久化防护与 Web plugin action invalidation 测试；验证命令：`bun run --cwd cli test -- src/commands/plugins.test.ts src/plugins/pluginFoundation.test.ts`、`bun run --cwd hub test src/plugins/pluginManager.test.ts src/web/routes/plugins.test.ts src/plugins/hubPluginRuntime.test.ts`、`bun run --cwd web test -- src/hooks/mutations/usePluginActions.test.tsx src/routes/settings/index.test.tsx`、`bun run typecheck`、`git diff --check`；Phase 03 checklist 全部完成。
