import { HAPI_PLUGIN_API_VERSION, type PluginDisplayMetadata, type PluginLocalizedTextMetadata, type PluginManifestLite } from './manifest'
import type { PluginWebContributions } from './webDescriptors'
import { getBundledPluginsRoot, materializeBundledPlugins, prepareBundledPlugins, type BundledPlugin } from './bundledMaterialize'
import { getPluginStateFile, getUserPluginsDir, PluginStateLockError, readPluginState, writePluginState } from './foundation'

export const HAPI_BUNDLED_CORE_PLUGINS_DIR = 'bundled-core-plugins'
export const HAPI_CORE_SCHEDULE_SEND_PLUGIN_ID = 'com.hapi.core.schedule-send'
export const HAPI_CORE_SERVERCHAN_NOTIFIER_PLUGIN_ID = 'com.hapi.core.serverchan-notifier'
export const HAPI_CORE_RUNNER_LAUNCH_PRESETS_PLUGIN_ID = 'com.hapi.core.runner-launch-presets'
const HAPI_CORE_PLUGIN_VERSION = '0.1.1'

export type BundledCorePlugin = BundledPlugin

function manifestBase(manifest: Omit<PluginManifestLite, 'pluginApiVersion' | 'version'> & { version?: string }): PluginManifestLite {
    return {
        ...manifest,
        version: manifest.version ?? '0.1.0',
        pluginApiVersion: HAPI_PLUGIN_API_VERSION
    }
}

function labelMetadata(
    enName: string,
    zhName: string,
    enDescription?: string,
    zhDescription?: string
): PluginLocalizedTextMetadata {
    return {
        name: { en: enName, 'zh-CN': zhName },
        ...(enDescription || zhDescription ? {
            description: {
                ...(enDescription ? { en: enDescription } : {}),
                ...(zhDescription ? { 'zh-CN': zhDescription } : {})
            }
        } : {})
    }
}

function displayMetadata(
    enName: string,
    zhName: string,
    enDescription: string,
    zhDescription: string,
    enFeatureIntro: string,
    zhFeatureIntro: string
): PluginDisplayMetadata {
    return {
        ...labelMetadata(enName, zhName, enDescription, zhDescription),
        featureIntro: {
            en: enFeatureIntro,
            'zh-CN': zhFeatureIntro
        }
    }
}

export const scheduleSendWebContributions: PluginWebContributions = {
    composerActions: [{
        id: 'schedule-send',
        kind: 'pluginMessageAction',
        capabilityId: 'schedule-send',
        label: {
            en: 'Schedule send',
            'zh-CN': '定时发送',
        },
        icon: 'clock',
        handler: {
            position: 'hub',
            actionId: 'schedule-send'
        },
        ui: {
            kind: 'delayPicker',
            maxDelayMs: 7 * 24 * 60 * 60 * 1000,
            presets: [
                { id: 'plus-5m', label: '+5m', delayMs: 5 * 60 * 1000 },
                { id: 'plus-30m', label: '+30m', delayMs: 30 * 60 * 1000 },
                { id: 'plus-1h', label: '+1h', delayMs: 60 * 60 * 1000 },
                { id: 'plus-4h', label: '+4h', delayMs: 4 * 60 * 60 * 1000 },
            ],
        }
    }],
}

const scheduleSendHubRuntime = `
const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000

function readNotBefore(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null
    }
    const value = payload.notBefore
    return Number.isInteger(value) && value > 0 ? value : null
}

export function activate(ctx) {
    ctx.messages.registerAction({
        id: 'schedule-send',
        kind: 'chat.composer.messageAction',
        async plan(input) {
            const notBefore = readNotBefore(input.payload)
            if (notBefore === null) {
                return { ok: false, code: 'invalid-not-before', message: 'Schedule send requires payload.notBefore as a positive integer timestamp.' }
            }
            if (!input.localId) {
                return { ok: false, code: 'missing-local-id', message: 'Scheduled messages require localId.' }
            }
            if (input.attachments.length > 0) {
                return { ok: false, code: 'attachments-unsupported', message: 'Scheduled messages with attachments are not supported.' }
            }
            if (notBefore > Date.now() + MAX_DELAY_MS) {
                return { ok: false, code: 'schedule-too-far', message: 'Schedule time must be within 7 days.' }
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
                    },
                    payload: input.payload
                }
            }
        }
    })
}
`.trim()

const serverChanNotifierHubRuntime = `
function readBoolean(ctx, key, fallback) {
    const value = ctx.config.get(key)
    return typeof value === 'boolean' ? value : fallback
}

function readNumber(ctx, key, fallback, min, max) {
    const value = ctx.config.get(key)
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(Math.max(Math.trunc(parsed), min), max)
}

function textConfig(ctx, key, fallback = '') {
    const value = ctx.config.get(key)
    return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function listFromValue(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => String(entry).trim()).filter(Boolean)
    }
    if (typeof value !== 'string') return []
    return value.split(/[\\n,]/).map((entry) => entry.trim()).filter(Boolean)
}

function listConfig(ctx, key) {
    return listFromValue(ctx.config.get(key))
}

function normalizePath(value) {
    if (typeof value !== 'string') return ''
    let normalized = value.trim().split(String.fromCharCode(92)).join('/')
    while (normalized.includes('//')) normalized = normalized.split('//').join('/')
    while (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1)
    return normalized
}

function pathMatchesPrefix(actual, prefix) {
    const path = normalizePath(actual)
    const base = normalizePath(prefix)
    if (!path || !base) return false
    if (base === '/' || (base.length === 3 && base[1] === ':' && base[2] === '/' && /^[A-Za-z]$/.test(base[0]))) return path.startsWith(base)
    return path === base || path.startsWith(base + '/')
}

function matchesExactList(allowed, actual) {
    return allowed.length === 0 || (typeof actual === 'string' && allowed.includes(actual))
}

function matchesSessionFilters(ctx, event) {
    if (!matchesExactList(listConfig(ctx, 'agentNames'), event.session?.agent)) return false

    const prefixes = listConfig(ctx, 'sessionPathPrefixes')
    if (prefixes.length > 0 && !prefixes.some((prefix) => pathMatchesPrefix(event.session?.path, prefix))) {
        return false
    }
    return true
}

function truncate(value, maxLength) {
    if (typeof value !== 'string') return ''
    if (value.length <= maxLength) return value
    return value.slice(0, Math.max(0, maxLength - 1)) + '…'
}

function taskIsFailure(event) {
    const status = typeof event.task?.status === 'string' ? event.task.status.trim().toLowerCase() : ''
    return status === 'failed' || status === 'error' || status === 'killed' || status === 'aborted'
}

function shouldSend(ctx, event) {
    if (!matchesSessionFilters(ctx, event)) return false
    if (event.type === 'ready') return readBoolean(ctx, 'notifyReady', true)
    if (event.type === 'permission-request') return readBoolean(ctx, 'notifyPermissionRequest', true)
    if (event.type === 'task-notification') {
        return readBoolean(ctx, 'notifyTaskFailuresOnly', true) ? taskIsFailure(event) : true
    }
    if (event.type === 'session-completion') return readBoolean(ctx, 'notifySessionCompletion', true)
    return true
}

function eventTitle(ctx, event) {
    const prefix = textConfig(ctx, 'titlePrefix', 'HAPI')
    if (event.type === 'ready') return prefix + ' Ready for input'
    if (event.type === 'permission-request') return prefix + ' Permission request'
    if (event.type === 'task-notification') return taskIsFailure(event) ? prefix + ' Task failed' : prefix + ' Task notification'
    if (event.type === 'session-completion') return prefix + ' Session completed'
    return prefix + ' Notification'
}

function eventBody(ctx, event) {
    const session = event.session
    const maxTaskSummaryLength = readNumber(ctx, 'maxTaskSummaryLength', 2000, 80, 12000)
    const lines = [
        session.agent ? 'Agent: ' + session.agent : undefined,
        session.name ? 'Session: ' + session.name : 'Session: ' + session.id,
        session.namespace ? 'Namespace: ' + session.namespace : undefined,
        session.path ? 'Path: ' + session.path : undefined,
        event.task?.summary ? 'Task: ' + truncate(event.task.summary, maxTaskSummaryLength) : undefined,
        event.task?.status ? 'Status: ' + event.task.status : undefined,
        event.reason ? 'Reason: ' + event.reason : undefined,
        session.url
    ].filter(Boolean)
    return lines.join('\\n\\n')
}

export function activate(ctx) {
    ctx.notifications.registerChannel({
        async send(event) {
            if (!shouldSend(ctx, event)) return
            const sendKey = ctx.secrets.get('SERVERCHAN_SENDKEY')
            if (!sendKey) {
                ctx.logger.warn('SERVERCHAN_SENDKEY is not set; ServerChan notification skipped.')
                return
            }
            const url = 'https://sctapi.ftqq.com/' + encodeURIComponent(sendKey) + '.send'
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), readNumber(ctx, 'timeoutMs', 10000, 1000, 60000))
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        title: eventTitle(ctx, event),
                        desp: eventBody(ctx, event)
                    }),
                    signal: controller.signal
                })
                if (!response.ok) {
                    const text = await response.text().catch(() => '')
                    throw new Error('ServerChan send failed: HTTP ' + response.status + ' ' + response.statusText + (text ? ' - ' + truncate(text, 500) : ''))
                }
            } finally {
                clearTimeout(timeout)
            }
        }
    })
}
`.trim()

const runnerLaunchPresetsRuntime = `
function boolConfig(ctx, key, fallback) {
    const value = ctx.config.get(key)
    return typeof value === 'boolean' ? value : fallback
}

function textConfig(ctx, key) {
    const value = ctx.config.get(key)
    return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function listFromValue(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => String(entry).trim()).filter(Boolean)
    }
    if (typeof value !== 'string') return []
    return value
        .split(/[\\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
}

function listConfig(ctx, key) {
    return listFromValue(ctx.config.get(key))
}

function normalizePath(value) {
    if (typeof value !== 'string') return ''
    let normalized = value.trim().split(String.fromCharCode(92)).join('/')
    while (normalized.includes('//')) normalized = normalized.split('//').join('/')
    while (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1)
    return normalized
}

function pathMatchesPrefix(actual, prefix) {
    const path = normalizePath(actual)
    const base = normalizePath(prefix)
    if (!path || !base) return false
    if (base === '/' || (base.length === 3 && base[1] === ':' && base[2] === '/' && /^[A-Za-z]$/.test(base[0]))) return path.startsWith(base)
    return path === base || path.startsWith(base + '/')
}

function matchesAnyPrefix(prefixes, context) {
    return prefixes.find((prefix) => pathMatchesPrefix(context.cwd, prefix) || pathMatchesPrefix(context.directory, prefix))
}

function matchesList(list, actual) {
    return list.length === 0 || list.includes(actual)
}

function readManualFields(context) {
    const value = Array.isArray(context.manualFields)
        ? context.manualFields
        : context.pluginFields && context.pluginFields.spawnOptionManualFields
    if (!Array.isArray(value)) return []
    return value.map((entry) => String(entry)).filter(Boolean)
}

function isManual(context, field) {
    const manual = readManualFields(context)
    if (field === 'permissionMode' || field === 'yolo') {
        return manual.includes('permissionMode') || manual.includes('yolo')
    }
    return manual.includes(field)
}

function normalizeDefaultValue(value) {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed && trimmed !== '__none' && trimmed !== 'auto' ? trimmed : undefined
}

function normalizeRule(raw, fallbackName) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const defaults = raw.defaults && typeof raw.defaults === 'object' && !Array.isArray(raw.defaults)
        ? raw.defaults
        : raw
    return {
        id: String(raw.id || fallbackName),
        label: String(raw.label || raw.name || raw.id || fallbackName),
        enabled: raw.enabled !== false,
        applyToResume: raw.applyToResume === true,
        agentIds: listFromValue(raw.agentIds),
        directoryPrefixes: listFromValue(raw.directoryPrefixes),
        defaults: {
            model: normalizeDefaultValue(defaults.model),
            effort: normalizeDefaultValue(defaults.effort),
            modelReasoningEffort: normalizeDefaultValue(defaults.modelReasoningEffort),
            permissionMode: normalizeDefaultValue(defaults.permissionMode),
            yolo: typeof defaults.yolo === 'boolean' ? defaults.yolo : undefined
        }
    }
}

function defaultConfig(ctx, key) {
    const value = textConfig(ctx, key)
    return value && value !== '__none' && value !== 'auto' ? value : ''
}

function flatRule(ctx) {
    const defaults = {
        model: defaultConfig(ctx, 'model') || undefined,
        effort: defaultConfig(ctx, 'effort') || undefined,
        modelReasoningEffort: defaultConfig(ctx, 'modelReasoningEffort') || undefined,
        permissionMode: defaultConfig(ctx, 'permissionMode') || undefined
    }
    if (!defaults.model && !defaults.effort && !defaults.modelReasoningEffort && !defaults.permissionMode) return null
    return {
        id: 'default',
        label: 'Default preset',
        enabled: true,
        applyToResume: boolConfig(ctx, 'applyToResume', false),
        agentIds: listConfig(ctx, 'agentIds'),
        directoryPrefixes: listConfig(ctx, 'directoryPrefixes'),
        defaults
    }
}

function readRulesJson(ctx, diagnostics) {
    const text = textConfig(ctx, 'rulesJson')
    if (!text) return []
    try {
        const parsed = JSON.parse(text)
        if (!Array.isArray(parsed)) {
            diagnostics.push({ severity: 'warning', code: 'runner-launch-presets-invalid-json', message: 'rulesJson must be a JSON array.' })
            return []
        }
        return parsed.map((rule, index) => normalizeRule(rule, 'rule-' + (index + 1))).filter(Boolean)
    } catch (error) {
        diagnostics.push({ severity: 'warning', code: 'runner-launch-presets-invalid-json', message: 'rulesJson parse failed: ' + (error instanceof Error ? error.message : String(error)) })
        return []
    }
}

function collectRules(ctx, diagnostics) {
    return [flatRule(ctx), ...readRulesJson(ctx, diagnostics)].filter(Boolean)
}

function ruleMatches(rule, context) {
    if (!rule.enabled) return false
    if (context.resumeSessionId && !rule.applyToResume) return false
    if (!matchesList(rule.agentIds, context.agent)) return false
    if (rule.directoryPrefixes.length > 0 && !matchesAnyPrefix(rule.directoryPrefixes, context)) return false
    return true
}

function specificity(rule) {
    const agentScore = rule.agentIds.length > 0 ? 100000 : 0
    const pathScore = rule.directoryPrefixes.reduce((max, entry) => Math.max(max, normalizePath(entry).length), 0)
    return agentScore + pathScore
}

function collectDefaults(ctx, context) {
    const diagnostics = []
    const matched = collectRules(ctx, diagnostics)
        .filter((rule) => ruleMatches(rule, context))
        .sort((left, right) => specificity(left) - specificity(right))
    const options = {}
    const applied = []
    for (const rule of matched) {
        const fields = []
        for (const key of ['model', 'effort', 'modelReasoningEffort', 'permissionMode', 'yolo']) {
            const value = rule.defaults[key]
            if (value === undefined || value === '') continue
            if (isManual(context, key)) continue
            if (key === 'model' && context.model) continue
            if (key === 'effort' && context.effort) continue
            if (key === 'modelReasoningEffort' && context.modelReasoningEffort) continue
            if (key === 'permissionMode' && context.permissionMode) continue
            if (key === 'yolo' && context.yolo !== undefined) continue
            options[key] = value
            fields.push(key)
        }
        applied.push({ label: rule.label, fields })
    }
    if (applied.length > 0) {
        diagnostics.push({
            severity: 'info',
            code: 'runner-launch-presets-applied',
            message: 'Runner launch presets matched ' + context.agent + ' in ' + context.cwd + ': ' + applied.map((entry) => entry.label).join(', ')
        })
    }
    return { options, diagnostics, matched }
}

export function activate(ctx) {
    ctx.runtime.registerSpawnOptionsProvider({
        id: 'runner-launch-presets',
        priority: -80,
        provide(context) {
            const result = collectDefaults(ctx, context)
            return {
                ...(Object.keys(result.options).length > 0 ? { options: result.options } : {}),
                applied: result.applied,
                diagnostics: result.diagnostics
            }
        }
    })
}
`.trim()

export const bundledCorePlugins: BundledCorePlugin[] = [
    {
        manifest: manifestBase({
            id: HAPI_CORE_SCHEDULE_SEND_PLUGIN_ID,
            version: HAPI_CORE_PLUGIN_VERSION,
            name: 'Schedule Send',
            description: 'First-party cross-runtime plugin that contributes a Web composer action and a Hub message-action handler backed by the core reliable delivery queue.',
            display: displayMetadata(
                'Schedule Send',
                '定时发送',
                'Adds a delay picker to the chat composer and routes scheduled delivery through the Hub.',
                '在聊天输入框添加延迟发送选择器，并通过 Hub 可靠投递队列安排发送。',
                [
                    '- Adds a delay picker to the chat composer.',
                    '- Validates scheduled-message requests in the Hub runtime.',
                    '- Uses HAPI reliable delivery so queued messages survive reloads.'
                ].join('\n'),
                [
                    '- 在聊天输入框提供延迟发送选择器。',
                    '- 由 Hub 运行时校验定时消息请求。',
                    '- 使用 HAPI 可靠投递队列，重载后仍可继续发送。'
                ].join('\n')
            ),
            capabilities: [{
                id: 'schedule-send',
                kind: 'chat.composer.messageAction',
                displayName: 'Schedule Send',
                description: 'Adds a delay picker to the chat composer and returns a Hub-owned message delivery plan.',
                display: labelMetadata(
                    'Schedule Send',
                    '定时发送',
                    'Adds a delay picker to the chat composer and returns a Hub-owned message delivery plan.',
                    '在聊天输入框添加延迟选择器，并返回由 Hub 管理的消息投递计划。'
                ),
                parts: {
                    web: {
                        required: true,
                        contributions: [{ type: 'composerAction', id: 'schedule-send' }]
                    },
                    hub: {
                        required: true,
                        contributions: [{ type: 'messageAction', id: 'schedule-send' }]
                    }
                }
            }],
            runtimes: {
                hub: { entry: 'dist/hub.js' }
            },
            contributions: {
                hub: {
                    messageActions: [{
                        id: 'schedule-send',
                        displayName: 'Schedule Send',
                        description: 'Plans delayed delivery for a user message.',
                        display: labelMetadata(
                            'Schedule Send',
                            '定时发送',
                            'Plans delayed delivery for a user message.',
                            '为用户消息创建延迟投递计划。'
                        )
                    }]
                },
                web: scheduleSendWebContributions
            },
            compatibility: {
                pluginApi: '>=0.1 <0.2',
                hub: {
                    extensionPoints: ['hub.messageAction', 'web.composerAction']
                }
            }
        }),
        files: [{ path: 'dist/hub.js', content: scheduleSendHubRuntime }]
    },
    {
        manifest: manifestBase({
            id: HAPI_CORE_SERVERCHAN_NOTIFIER_PLUGIN_ID,
            version: HAPI_CORE_PLUGIN_VERSION,
            name: 'ServerChan Notifier',
            description: 'First-party Hub plugin that sends selected HAPI notifications through ServerChan.',
            display: displayMetadata(
                'ServerChan Notifier',
                'Server 酱通知',
                'Sends selected HAPI notifications through ServerChan from the Hub runtime.',
                '通过 Hub 运行时把选定的 HAPI 通知发送到 Server 酱。',
                [
                    '- Registers a Hub notification channel backed by ServerChan.',
                    '- Lets you choose which HAPI events are forwarded.',
                    '- Filters notifications by agent and workspace with selectable recent values.',
                    '- Reads `SERVERCHAN_SENDKEY` from the Hub environment; Web never stores the secret.'
                ].join('\n'),
                [
                    '- 注册由 Server 酱驱动的 Hub 通知通道。',
                    '- 可配置需要转发的 HAPI 事件类型。',
                    '- 可用最近值选择 Agent 和工作区过滤通知。',
                    '- 从 Hub 环境变量读取 `SERVERCHAN_SENDKEY`，Web 不保存密钥。'
                ].join('\n')
            ),
            capabilities: [{
                id: 'serverchan-notifier',
                kind: 'notification.channel',
                displayName: 'ServerChan Notifier',
                description: 'Adds a configurable ServerChan notification channel backed by Hub plugin notifications.',
                display: labelMetadata(
                    'ServerChan Notifier',
                    'Server 酱通知',
                    'Adds a configurable ServerChan notification channel backed by Hub plugin notifications.',
                    '添加可配置的 Server 酱通知通道，由 Hub 插件通知能力驱动。'
                ),
                parts: {
                    web: {
                        required: true,
                        contributions: [{ type: 'settingsPanel', id: 'serverchan-notifier' }]
                    },
                    hub: {
                        required: true,
                        contributions: [{ type: 'notificationChannel', id: 'serverchan' }]
                    }
                }
            }],
            runtimes: {
                hub: { entry: 'dist/hub.js' }
            },
            contributions: {
                hub: {
                    notificationChannels: [{
                        id: 'serverchan',
                        displayName: 'ServerChan Notifier',
                        display: labelMetadata(
                            'ServerChan Notifier',
                            'Server 酱通知'
                        )
                    }]
                },
                web: {
                    settingsPanels: [{
                        id: 'serverchan-notifier',
                        title: {
                            en: 'ServerChan Notifier',
                            'zh-CN': 'Server 酱通知'
                        },
                        description: {
                            en: 'Send ready-for-input, permission, failed task, and session completion notifications via ServerChan.',
                            'zh-CN': '通过 Server 酱发送等待输入、权限请求、失败任务和会话完成通知。'
                        },
                        components: [
                            {
                                kind: 'text',
                                tone: 'info',
                                text: {
                                    en: 'Set SERVERCHAN_SENDKEY in the Hub environment, then enable this plugin on Hub. Legacy SERVERCHAN_NOTIFICATION no longer creates a core notification channel.',
                                    'zh-CN': '在 Hub 环境变量中设置 SERVERCHAN_SENDKEY 后启用此插件。旧的 SERVERCHAN_NOTIFICATION 不再创建核心通知通道。'
                                }
                            },
                            {
                                kind: 'schemaForm',
                                title: {
                                    en: 'Notification events',
                                    'zh-CN': '通知事件'
                                },
                                description: {
                                    en: 'Ready-for-input is enabled by default so phone pushes also arrive when the agent needs you.',
                                    'zh-CN': '默认打开“等待输入”，当 Agent 需要你继续操作时也会推送到手机。'
                                },
                                fields: [
                                    { key: 'notifyReady', label: { en: 'Ready-for-input events', 'zh-CN': '等待输入事件' }, type: 'boolean', defaultValue: true },
                                    { key: 'notifyPermissionRequest', label: { en: 'Permission requests', 'zh-CN': '权限请求' }, type: 'boolean', defaultValue: true },
                                    { key: 'notifyTaskFailuresOnly', label: { en: 'Only failed task notifications', 'zh-CN': '仅通知失败任务' }, type: 'boolean', defaultValue: true },
                                    { key: 'notifySessionCompletion', label: { en: 'Session completion', 'zh-CN': '会话完成' }, type: 'boolean', defaultValue: true }
                                ]
                            },
                            {
                                kind: 'schemaForm',
                                title: {
                                    en: 'Notification scope',
                                    'zh-CN': '通知范围'
                                },
                                description: {
                                    en: 'Leave a field empty to notify all. Choices come from recent sessions; custom values are still allowed.',
                                    'zh-CN': '某项留空表示全部。可选项来自最近会话，也可以手动添加。'
                                },
                                fields: [
                                    {
                                        key: 'agentNames',
                                        label: { en: 'Agents', 'zh-CN': 'Agent' },
                                        description: { en: 'Matches the agent label in notifications, for example Codex or Claude.', 'zh-CN': '匹配通知中的 Agent 名称，例如 Codex 或 Claude。' },
                                        type: 'multiSelect',
                                        optionsSource: 'sessions.agents'
                                    },
                                    {
                                        key: 'sessionPathPrefixes',
                                        label: { en: 'Workspaces', 'zh-CN': '工作区' },
                                        description: { en: 'Selected paths also match subdirectories. Empty = all workspaces.', 'zh-CN': '选择的路径会同时匹配其子目录。留空 = 全部工作区。' },
                                        type: 'multiSelect',
                                        optionsSource: 'sessions.workspaces'
                                    }
                                ]
                            },
                            {
                                kind: 'schemaForm',
                                title: {
                                    en: 'Advanced',
                                    'zh-CN': '高级'
                                },
                                fields: [
                                    { key: 'titlePrefix', label: { en: 'Title prefix', 'zh-CN': '标题前缀' }, type: 'text', defaultValue: 'HAPI' },
                                    { key: 'timeoutMs', label: { en: 'HTTP timeout ms', 'zh-CN': 'HTTP 超时毫秒' }, type: 'number', defaultValue: 10000 },
                                    { key: 'maxTaskSummaryLength', label: { en: 'Max task summary characters', 'zh-CN': '任务摘要最大字符数' }, type: 'number', defaultValue: 2000 }
                                ]
                            }
                        ]
                    }]
                }
            },
            permissions: {
                network: ['https://sctapi.ftqq.com'],
                secrets: ['SERVERCHAN_SENDKEY']
            },
            compatibility: {
                pluginApi: '>=0.1 <0.2',
                hub: {
                    extensionPoints: ['hub.notificationChannel', 'web.settingsPanel']
                }
            }
        }),
        files: [{ path: 'dist/hub.js', content: serverChanNotifierHubRuntime }]
    },
    {
        manifest: manifestBase({
            id: HAPI_CORE_RUNNER_LAUNCH_PRESETS_PLUGIN_ID,
            version: HAPI_CORE_PLUGIN_VERSION,
            name: 'Runner Launch Presets',
            description: 'First-party Runner plugin for applying default launch settings by agent and workspace.',
            display: displayMetadata(
                'Runner Launch Presets',
                'Runner 启动预设',
                'Applies default model, reasoning, and permission settings for Runner launches by agent and workspace.',
                '按 Agent 和工作区为 Runner 启动自动应用默认模型、思考强度和权限设置。',
                [
                    '- Applies launch defaults before agent command args are built.',
                    '- Matches all agents/workspaces or selected agents and workspace prefixes.',
                    '- Supports model, Claude effort, Codex reasoning effort, and permission/yolo defaults.',
                    '- User-selected fields in the New Session UI override presets.'
                ].join('\n'),
                [
                    '- 在构建 agent 启动参数前应用默认值。',
                    '- 可匹配全部或指定 Agent、指定工作区前缀。',
                    '- 支持模型、Claude effort、Codex reasoning effort、权限/yolo 默认值。',
                    '- 新建会话 UI 中用户手动选择的字段优先。'
                ].join('\n')
            ),
            capabilities: [{
                id: 'runner-launch-presets',
                kind: 'runner.spawnExtension',
                displayName: 'Runner Launch Presets',
                description: 'Applies configured launch defaults before an agent process starts.',
                display: labelMetadata(
                    'Runner Launch Presets',
                    'Runner 启动预设',
                    'Applies configured launch defaults before an agent process starts.',
                    '在 agent 进程启动前应用启动默认值。'
                ),
                parts: {
                    web: {
                        required: true,
                        contributions: [{ type: 'settingsPanel', id: 'runner-launch-presets' }]
                    },
                    runner: {
                        required: true,
                        target: 'selected-runner',
                        contributions: [
                            { type: 'spawnOptionsProvider', id: 'runner-launch-presets' }
                        ]
                    }
                }
            }],
            runtimes: {
                runner: { entry: 'dist/runner.js' }
            },
            contributions: {
                runner: {
                    spawnOptionsProviders: [{
                        id: 'runner-launch-presets',
                        displayName: 'Runner Launch Presets',
                        description: 'Applies default launch options before command args are built.',
                        display: labelMetadata(
                            'Runner Launch Presets',
                            'Runner 启动预设',
                            'Applies default launch options before command args are built.',
                            '在构建命令参数前应用启动默认值。'
                        )
                    }]
                },
                web: {
                    settingsPanels: [{
                        id: 'runner-launch-presets',
                        title: {
                            en: 'Runner Launch Presets',
                            'zh-CN': 'Runner 启动预设'
                        },
                        description: {
                            en: 'Set default launch options by agent and workspace. User choices in New Session override these defaults.',
                            'zh-CN': '按 Agent 和工作区设置默认启动参数。新建会话中用户手动选择的值会覆盖预设。'
                        },
                        components: [
                            {
                                id: 'runner-launch-presets-editor',
                                kind: 'runnerSpawnDefaultsEditor',
                                configKey: 'rulesJson'
                            }
                        ]
                    }]
                }
            },
            compatibility: {
                pluginApi: '>=0.1 <0.2',
                hub: {
                    extensionPoints: ['web.settingsPanel']
                },
                runner: {
                    extensionPoints: ['runner.spawnOptionsProvider']
                }
            },
            install: {
                runnerPlacement: 'compatible-runners',
                offlineRunnerPolicy: 'skip',
                minReadyRunnerCount: 1
            }
        }),
        files: [{ path: 'dist/runner.js', content: runnerLaunchPresetsRuntime }]
    }
]

export const defaultEnabledBundledPluginIds = [HAPI_CORE_SCHEDULE_SEND_PLUGIN_ID]
export const defaultEnabledBundledRunnerPluginIds = bundledCorePlugins
    .filter((plugin) => defaultEnabledBundledPluginIds.includes(plugin.manifest.id) && Boolean(plugin.manifest.runtimes?.runner))
    .map((plugin) => plugin.manifest.id)

export function getBundledCorePluginsRoot(hapiHome: string): string {
    return getBundledPluginsRoot(hapiHome, HAPI_BUNDLED_CORE_PLUGINS_DIR)
}

export async function prepareBundledCorePlugins(hapiHome: string): Promise<string> {
    return await prepareBundledPlugins({
        hapiHome,
        directoryName: HAPI_BUNDLED_CORE_PLUGINS_DIR,
        plugins: bundledCorePlugins,
        label: 'bundled core'
    })
}

export async function seedCorePluginsAsUserPlugins(hapiHome: string): Promise<void> {
    const statePath = getPluginStateFile(hapiHome)
    const stateResult = await readPluginState(statePath)
    if (stateResult.parseError) return

    const seededCorePluginIds = stateResult.state.seededCorePluginIds ?? {}
    const pluginsToSeed = bundledCorePlugins.filter((plugin) => seededCorePluginIds[plugin.manifest.id] !== true)
    if (pluginsToSeed.length === 0) return

    await materializeBundledPlugins({
        root: getUserPluginsDir(hapiHome),
        plugins: pluginsToSeed,
        label: 'core plugin seed',
        pruneExtraneous: false,
        skipExisting: true
    })

    const latestStateResult = await readPluginState(statePath)
    if (latestStateResult.parseError) return

    const nextState = latestStateResult.state
    const defaultEnabled = new Set(defaultEnabledBundledPluginIds)
    nextState.seededCorePluginIds = { ...(nextState.seededCorePluginIds ?? {}) }
    for (const plugin of pluginsToSeed) {
        const pluginId = plugin.manifest.id
        nextState.seededCorePluginIds[pluginId] = true
        const previous = nextState.enabled[pluginId]
        nextState.enabled[pluginId] = {
            ...(previous ?? {}),
            enabled: previous?.enabled ?? defaultEnabled.has(pluginId),
            install: previous?.install ?? {
                sourceType: 'user-home',
                version: plugin.manifest.version
            }
        }
    }
    try {
        await writePluginState(statePath, nextState)
    } catch (error) {
        if (error instanceof PluginStateLockError) return
        throw error
    }
}
