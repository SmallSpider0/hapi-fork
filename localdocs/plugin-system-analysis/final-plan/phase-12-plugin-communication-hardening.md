# Phase 12 — Plugin communication、interactive callbacks、生态硬化

更新时间: 2026-05-21
状态: 长期计划阶段。

## 目标

在 Hub/Runner/Agent/Web descriptor 基础稳定后，再开放插件间通信、interactive notification callbacks、权限动作、签名/marketplace/external-process runtime 等生态能力。该阶段不再扩大核心传输边界；所有动作仍必须经 core auth/namespace/session 校验。

## 能力方向

### Interactive callbacks

- 插件可声明 notification action descriptor。
- Hub 生成 signed callback token 或 core-owned action id。
- Web/Telegram/push callback 进入 core endpoint，再由 core 校验 namespace/session/request/replay 后转发给插件。
- 插件不能注册 arbitrary unauthenticated HTTP route。

### Plugin communication

- 提供 typed event bus 或 command registry；先限制同 runtime、同 target。
- 跨 Hub/Runner 通信必须经 core RPC 与 schema，不暴露 raw gateway。
- 所有事件可诊断、可限流、可禁用。

### Hardening / distribution

- Plugin verifier：manifest、entry、checksum、permission review。
- Optional signature 与 marketplace metadata。
- External-process runtime / sandbox 评估。
- API versioning、compat matrix、migration guide。
- Rollback、quarantine、safe mode。

## Checklist 更新规则

勾选前必须由 review/verification 子代理核对：auth/namespace/replay、无 arbitrary route、event bus schema、signature/verifier、回滚/隔离、测试证据。验证通过后追加“验证记录”。

## Checklist

### 实现

- [ ] Interactive callback descriptor schema。
- [ ] Core-owned callback endpoint，支持 auth/signature/replay protection。
- [ ] Callback action scope 绑定 namespace/session/request id。
- [ ] Plugin callback handler 在对应 runtime/target 执行。
- [ ] Typed plugin event bus，禁止 raw gateway/socket 暴露。
- [ ] Event bus 支持 rate limit 与 diagnostics。
- [ ] Plugin verifier CLI/Hub API。
- [ ] Package signature metadata 与校验策略。
- [ ] Quarantine/safe mode 禁用问题插件。
- [ ] Rollback 支持按 target 恢复上一版本。
- [ ] External-process runtime feasibility spike，不替换默认 in-process trust model。

### 测试

- [ ] Callback replay token 被拒绝。
- [ ] Callback namespace/session mismatch 被拒绝。
- [ ] 未授权 callback 无法调用插件 handler。
- [ ] Event bus malformed payload 被拒绝。
- [ ] Rate limit 防止插件事件风暴。
- [ ] Signature mismatch 或 verifier fail 阻止安装/启用。
- [ ] Safe mode 启动时不 import 第三方插件。
- [ ] Rollback 后旧版本 active，新版本 quarantined。

### 验收

- [ ] 插件 notification 可以提供受控交互动作，而不开放任意 HTTP route。
- [ ] 插件间通信可审计、可限流、可禁用。
- [ ] 用户可以验证、隔离、回滚插件。

## 验证记录

- [ ] 待实现后追加：日期、子代理类型、结论、验证命令/证据。
