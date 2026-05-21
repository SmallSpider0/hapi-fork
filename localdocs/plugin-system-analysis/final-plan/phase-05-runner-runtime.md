# Phase 05 — Runner plugin runtime：Runner 本机发现、加载、热重载

更新时间: 2026-05-21
状态: 计划阶段。

## 目标

在 Runner 进程中引入受控 RunnerPluginManager，让插件可以在 Runner 所在机器运行本机扩展逻辑。该阶段建立生命周期、热重载、disposable、诊断与 Hub 聚合状态，但只开放最小安全扩展点；具体 command/spawn/agent 能力在 Phase 06/07/08 细化。

## 设计要点

- Runner 读取 Runner 本机 `$HAPI_HOME/plugins`、`HAPI_PLUGIN_DIRS`、`plugins.json`。
- Runner runtime 与 Hub runtime 独立；同一插件可以只声明 Hub、只声明 Runner，或两者都有。
- Runner import 只发生在 Runner 机器，Hub 不 import Runner entry。
- Runner reload 串行化，失败保留旧实例。
- Runner shutdown/disconnect 时清理 Runner plugin disposables。
- Hub 只展示 Runner runtime 状态，不持有 Runner plugin context。

## RunnerPluginContext 初稿

```ts
type RunnerPluginContext = {
    pluginId: string
    machineId: string
    logger: PluginLogger
    config: PluginConfigReader
    secrets: PluginSecretReader
    runtime: {
        registerEnvironmentProvider(provider: unknown): Disposable
        registerCommandResolver(resolver: unknown): Disposable
        registerSpawnHook(hook: unknown): Disposable
    }
}
```

具体 provider/resolver/hook 的稳定 shape 留 Phase 06。

## Checklist 更新规则

勾选前必须由 review/verification 子代理核对：Runner 本机权威、Hub 不 import Runner entry、reload 串行化、disposable cleanup、target scope 行为、测试证据。验证通过后追加“验证记录”。

## Checklist

### 实现

- [ ] `cli/src/runner` 或 runner daemon 内新增 RunnerPluginManager。
- [ ] Runner discovery/state 复用 Phase 01 helper，但数据目录按 Runner 本机解析。
- [ ] Runner 只 import enabled + valid + compatible `runtimes.runner.entry`。
- [ ] Runner activate 支持 async 与 Disposable lifecycle。
- [ ] Runner reload 串行化，失败保留旧实例。
- [ ] Runner plugin diagnostics 上报 Hub inventory cache。
- [ ] Runner disable/delete 时 dispose active resources。
- [ ] Runner shutdown 调用 disposables，dispose throw 不阻塞 shutdown。
- [ ] Runner plugin logs 进入 Runner 日志并带 plugin id/machine id。

### 测试

- [ ] Disabled/invalid Runner plugin never imported。
- [ ] Hub runtime-only plugin 不在 Runner import。
- [ ] Runner runtime-only plugin 不在 Hub import。
- [ ] Activate throw 不 crash Runner。
- [ ] Reload failure keeps previous active Runner plugin。
- [ ] Disable disposes Runner plugin resources。
- [ ] Hub 聚合能看到 Runner plugin failed/active/disabled 状态。
- [ ] Runner offline 后 Hub 状态标记 stale/offline。

### 验收

- [ ] 用户能在某台 Runner 上启用 Runner plugin，并在 Hub/Web 看到该 Runner 的 active 状态。
- [ ] Hub 与 Runner 分机部署时，Runner plugin 文件只需要存在于 Runner 机器。
- [ ] Runner reload 不需要重启 Hub。

## 验证记录

- [ ] 待实现后追加：日期、子代理类型、结论、验证命令/证据。
