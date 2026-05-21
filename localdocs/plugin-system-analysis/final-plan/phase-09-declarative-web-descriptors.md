# Phase 09 — Declarative Web descriptors：插件贡献的 Web UI，不执行 JS

更新时间: 2026-05-21
状态: 计划阶段。

## 目标

让插件通过 JSON descriptor 贡献 Web 设置、状态展示和受控动作入口，同时保持 Web 不执行插件 JavaScript。Web 只渲染内置组件库支持的 descriptor。

## 可贡献 UI

- Settings panels：schema form、说明文本、危险提示、链接。
- New session fields：agent/plugin 提供的 profile/model/env 选项。
- Plugin detail sections：diagnostics、capabilities、runtime status。
- Session actions：调用 Hub/Runner 受控 API 的按钮，不执行自定义代码。
- Badges/status：enabled/active/source/runtime/warnings/permissions。
- Notification callback views：仅渲染 core 定义动作；复杂交互移至 Phase 12。

## 设计约束

- Web descriptor 必须可被 Zod/JSON Schema 校验。
- 只允许内置 component kind，如 `text`、`badge`、`schemaForm`、`actionButton`、`table`。
- Action 只能指向 core 注册的 typed action id，不能写 arbitrary URL 或 JS。
- Web 不保存 secret value。
- Descriptor failure 只影响对应插件 UI，不影响整个 app。

## Checklist 更新规则

勾选前必须由 review/verification 子代理核对：Web 无插件 JS、descriptor schema、action allowlist、secret redaction、UI fallback、测试证据。验证通过后追加“验证记录”。

## Checklist

### 实现

- [ ] Shared 增加 Web contribution descriptor schema。
- [ ] Hub/Web API 返回 plugin web contributions。
- [ ] Web descriptor renderer 支持内置组件 allowlist。
- [ ] Settings plugin panel 可由 descriptor 生成 schema form。
- [ ] New session page 可消费 agent/plugin descriptor fields。
- [ ] Action button 只调用 core-registered typed action。
- [ ] Descriptor parse/render failure 有局部 error boundary。
- [ ] i18n 支持 descriptor label/description fallback。

### 测试

- [ ] Web 拒绝未知 component kind。
- [ ] Web 拒绝 action 指向 arbitrary URL/JS。
- [ ] Secret value 不出现在 DOM/API snapshot。
- [ ] Malformed descriptor 只显示该插件错误，不 crash plugins page。
- [ ] Settings schema form 写入 config 后触发正确 target scope reload。
- [ ] New session descriptor fields 能参与 form validation。

### 验收

- [ ] 插件可以贡献设置面板和状态展示，而不提供浏览器 JS bundle。
- [ ] 用户能清楚看到插件 runtime、target、权限和危险动作。
- [ ] 禁用/删除插件后，对应 Web contribution 消失。

## 验证记录

- [ ] 待实现后追加：日期、子代理类型、结论、验证命令/证据。
