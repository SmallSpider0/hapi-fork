import { HAPI_PLUGIN_API_VERSION, type PluginDisplayMetadata, type PluginLocalizedTextMetadata, type PluginManifestLite } from './manifest'
import type { PluginWebContributions } from './webDescriptors'
import { getBundledPluginsRoot, prepareBundledPlugins, type BundledPlugin } from './bundledMaterialize'

export const HAPI_BUNDLED_CORE_PLUGINS_DIR = 'bundled-core-plugins'
export const HAPI_CORE_SCHEDULE_SEND_PLUGIN_ID = 'com.hapi.core.schedule-send'
export const HAPI_CORE_SERVERCHAN_NOTIFIER_PLUGIN_ID = 'com.hapi.core.serverchan-notifier'
export const HAPI_CORE_RUNNER_ENV_PROFILES_PLUGIN_ID = 'com.hapi.core.runner-env-profiles'
export const HAPI_CORE_RUNNER_SPAWN_GUARD_PLUGIN_ID = 'com.hapi.core.runner-spawn-guard'

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

function taskIsFailure(event) {
    const status = typeof event.task?.status === 'string' ? event.task.status.trim().toLowerCase() : ''
    return status === 'failed' || status === 'error' || status === 'killed' || status === 'aborted'
}

function shouldSend(ctx, event) {
    if (event.type === 'ready') return readBoolean(ctx, 'notifyReady', false)
    if (event.type === 'permission-request') return readBoolean(ctx, 'notifyPermissionRequest', true)
    if (event.type === 'task-notification') {
        return readBoolean(ctx, 'notifyTaskFailuresOnly', true) ? taskIsFailure(event) : true
    }
    if (event.type === 'session-completion') return readBoolean(ctx, 'notifySessionCompletion', true)
    return true
}

function textConfig(ctx, key, fallback = '') {
    const value = ctx.config.get(key)
    return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function eventTitle(ctx, event) {
    const prefix = textConfig(ctx, 'titlePrefix', 'HAPI')
    if (event.type === 'ready') return prefix + ' Ready for input'
    if (event.type === 'permission-request') return prefix + ' Permission request'
    if (event.type === 'task-notification') return taskIsFailure(event) ? prefix + ' Task failed' : prefix + ' Task notification'
    if (event.type === 'session-completion') return prefix + ' Session completed'
    return prefix + ' Notification'
}

function eventBody(event) {
    const session = event.session
    const lines = [
        session.agent ? 'Agent: ' + session.agent : undefined,
        session.name ? 'Session: ' + session.name : 'Session: ' + session.id,
        session.path ? 'Path: ' + session.path : undefined,
        event.task?.summary ? 'Task: ' + event.task.summary : undefined,
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
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    title: eventTitle(ctx, event),
                    desp: eventBody(event)
                })
            })
            if (!response.ok) {
                const text = await response.text().catch(() => '')
                throw new Error('ServerChan send failed: HTTP ' + response.status + ' ' + response.statusText + (text ? ' - ' + text : ''))
            }
        }
    })
}
`.trim()

const runnerEnvProfilesRuntime = `
function textConfig(ctx, key) {
    const value = ctx.config.get(key)
    return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function listConfig(ctx, key) {
    return textConfig(ctx, key)
        .split(/[\\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
}

function matchesList(values, actual) {
    return values.length === 0 || values.includes(actual)
}

function matchesPrefix(prefixes, context) {
    if (prefixes.length === 0) return true
    return prefixes.some((prefix) => context.cwd.startsWith(prefix) || context.directory.startsWith(prefix))
}

function addIfPresent(env, key, value) {
    if (value) env[key] = value
}

export function activate(ctx) {
    ctx.runtime.registerEnvironmentProvider({
        id: 'runner-env-profiles',
        priority: -20,
        provide(context) {
            if (!matchesList(listConfig(ctx, 'agentIds'), context.agent)) return {}
            if (!matchesPrefix(listConfig(ctx, 'directoryPrefixes'), context)) return {}

            const env = {}
            addIfPresent(env, 'HTTP_PROXY', textConfig(ctx, 'httpProxy'))
            addIfPresent(env, 'HTTPS_PROXY', textConfig(ctx, 'httpsProxy'))
            addIfPresent(env, 'NO_PROXY', textConfig(ctx, 'noProxy'))
            addIfPresent(env, 'GOPROXY', textConfig(ctx, 'goProxy'))
            addIfPresent(env, 'NPM_CONFIG_REGISTRY', textConfig(ctx, 'npmRegistry'))
            const pathPrepend = listConfig(ctx, 'pathPrepend')

            if (Object.keys(env).length === 0 && pathPrepend.length === 0) return {}
            return {
                env,
                ...(pathPrepend.length > 0 ? { pathPrepend } : {}),
                diagnostics: [{
                    severity: 'info',
                    code: 'runner-env-profiles-applied',
                    message: 'Runner environment profile applied to ' + context.agent + ' in ' + context.cwd
                }]
            }
        }
    })
}
`.trim()

const runnerSpawnGuardRuntime = `
function boolConfig(ctx, key, fallback) {
    const value = ctx.config.get(key)
    return typeof value === 'boolean' ? value : fallback
}

function textConfig(ctx, key) {
    const value = ctx.config.get(key)
    return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function listConfig(ctx, key) {
    return textConfig(ctx, key)
        .split(/[\\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
}

function matchesAgent(list, agent) {
    return list.length > 0 && list.includes(agent)
}

function matchesPrefix(prefixes, context) {
    return prefixes.find((prefix) => context.cwd.startsWith(prefix) || context.directory.startsWith(prefix))
}

function usesBypassMode(context) {
    return context.yolo === true
        || context.permissionMode === 'yolo'
        || context.permissionMode === 'bypassPermissions'
}

export function activate(ctx) {
    ctx.runtime.registerSpawnHook({
        id: 'runner-spawn-guard',
        priority: -100,
        beforeSpawn(context) {
            if (matchesAgent(listConfig(ctx, 'blockedAgentIds'), context.agent)) {
                return {
                    block: { reason: 'Runner Spawn Guard blocked agent ' + context.agent },
                    diagnostics: [{ severity: 'warning', code: 'runner-spawn-guard-agent-blocked', message: 'Blocked agent ' + context.agent }]
                }
            }

            const blockedPrefix = matchesPrefix(listConfig(ctx, 'blockedDirectoryPrefixes'), context)
            if (blockedPrefix) {
                return {
                    block: { reason: 'Runner Spawn Guard blocked workspace ' + blockedPrefix },
                    diagnostics: [{ severity: 'warning', code: 'runner-spawn-guard-directory-blocked', message: 'Blocked workspace prefix ' + blockedPrefix }]
                }
            }

            if (boolConfig(ctx, 'blockBypassPermissions', false) && usesBypassMode(context)) {
                return {
                    block: { reason: 'Runner Spawn Guard blocked bypass/yolo permission mode.' },
                    diagnostics: [{ severity: 'warning', code: 'runner-spawn-guard-bypass-blocked', message: 'Blocked bypass/yolo permission mode for ' + context.agent }]
                }
            }

            return {}
        }
    })
}
`.trim()

export const bundledCorePlugins: BundledCorePlugin[] = [
    {
        manifest: manifestBase({
            id: HAPI_CORE_SCHEDULE_SEND_PLUGIN_ID,
            name: 'Schedule Send',
            description: 'First-party cross-runtime plugin that contributes a Web composer action and a Hub message-action handler backed by the core reliable delivery queue.',
            display: displayMetadata(
                'Schedule Send',
                '定时发送',
                'Adds a delay picker to the chat composer and routes scheduled delivery through the Hub.',
                '在聊天输入框添加延迟发送选择器，并通过 Hub 可靠投递队列安排发送。',
                [
                    '### What it adds',
                    '- Adds a delay picker to the chat composer.',
                    '- Validates scheduled-message requests in the Hub runtime.',
                    '- Uses HAPI reliable delivery so queued messages survive reloads.'
                ].join('\n'),
                [
                    '### 功能',
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
            }
        }),
        files: [{ path: 'dist/hub.js', content: scheduleSendHubRuntime }]
    },
    {
        manifest: manifestBase({
            id: HAPI_CORE_SERVERCHAN_NOTIFIER_PLUGIN_ID,
            name: 'ServerChan Notifier',
            description: 'First-party Hub plugin that sends selected HAPI notifications through ServerChan.',
            display: displayMetadata(
                'ServerChan Notifier',
                'Server 酱通知',
                'Sends selected HAPI notifications through ServerChan from the Hub runtime.',
                '通过 Hub 运行时把选定的 HAPI 通知发送到 Server 酱。',
                [
                    '### What it adds',
                    '- Registers a Hub notification channel backed by ServerChan.',
                    '- Lets you choose which HAPI events are forwarded.',
                    '- Reads `SERVERCHAN_SENDKEY` from the Hub environment; Web never stores the secret.'
                ].join('\n'),
                [
                    '### 功能',
                    '- 注册由 Server 酱驱动的 Hub 通知通道。',
                    '- 可配置需要转发的 HAPI 事件类型。',
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
                            en: 'Send permission, failed task, and session completion notifications via ServerChan.',
                            'zh-CN': '通过 Server 酱发送权限请求、失败任务和会话完成通知。'
                        },
                        components: [
                            {
                                kind: 'text',
                                tone: 'info',
                                text: {
                                    en: 'Set SERVERCHAN_SENDKEY in the Hub environment, then enable this plugin on Hub.',
                                    'zh-CN': '在 Hub 环境变量中设置 SERVERCHAN_SENDKEY，然后在 Hub 启用此插件。'
                                }
                            },
                            {
                                kind: 'schemaForm',
                                title: {
                                    en: 'Notification filters',
                                    'zh-CN': '通知过滤'
                                },
                                fields: [
                                    { key: 'titlePrefix', label: { en: 'Title prefix', 'zh-CN': '标题前缀' }, type: 'text', defaultValue: 'HAPI' },
                                    { key: 'notifyPermissionRequest', label: { en: 'Permission requests', 'zh-CN': '权限请求' }, type: 'boolean', defaultValue: true },
                                    { key: 'notifyTaskFailuresOnly', label: { en: 'Only failed task notifications', 'zh-CN': '仅通知失败任务' }, type: 'boolean', defaultValue: true },
                                    { key: 'notifySessionCompletion', label: { en: 'Session completion', 'zh-CN': '会话完成' }, type: 'boolean', defaultValue: true },
                                    { key: 'notifyReady', label: { en: 'Ready-for-input events', 'zh-CN': '等待输入事件' }, type: 'boolean', defaultValue: false }
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
            id: HAPI_CORE_RUNNER_ENV_PROFILES_PLUGIN_ID,
            name: 'Runner Environment Profiles',
            description: 'First-party Runner plugin for applying non-secret proxy, registry, and PATH environment profiles before spawning agents.',
            display: displayMetadata(
                'Runner Environment Profiles',
                'Runner 环境配置',
                'Applies non-secret proxy, registry, and PATH profiles before Runner-spawned agents start.',
                '在 Runner 启动 agent 前应用非敏感的代理、包源和 PATH 环境配置。',
                [
                    '### What it adds',
                    '- Applies HTTP proxy, registry, and PATH values before spawning agents.',
                    '- Supports agent-id and workspace-prefix filters.',
                    '- Runs on selected Runner targets; values are non-secret config.'
                ].join('\n'),
                [
                    '### 功能',
                    '- 在启动 agent 前注入 HTTP 代理、包源和 PATH 等环境变量。',
                    '- 支持按 Agent ID 与工作区前缀限定生效范围。',
                    '- 在指定 Runner 目标运行；配置值不应包含密钥。'
                ].join('\n')
            ),
            capabilities: [{
                id: 'runner-env-profiles',
                kind: 'runner.spawnExtension',
                displayName: 'Runner Environment Profiles',
                description: 'Applies common non-secret environment variables to Runner-spawned agent processes.',
                display: labelMetadata(
                    'Runner Environment Profiles',
                    'Runner 环境配置',
                    'Applies common non-secret environment variables to Runner-spawned agent processes.',
                    '为 Runner 启动的 agent 进程应用常用非敏感环境变量。'
                ),
                parts: {
                    web: {
                        required: true,
                        contributions: [{ type: 'settingsPanel', id: 'runner-env-profiles' }]
                    },
                    runner: {
                        required: true,
                        target: 'selected-runner',
                        contributions: [{ type: 'environmentProvider', id: 'runner-env-profiles' }]
                    }
                }
            }],
            runtimes: {
                runner: { entry: 'dist/runner.js' }
            },
            contributions: {
                runner: {
                    environmentProviders: [{
                        id: 'runner-env-profiles',
                        displayName: 'Runner Environment Profiles',
                        description: 'Applies proxy, registry, and PATH settings to spawned agents.',
                        display: labelMetadata(
                            'Runner Environment Profiles',
                            'Runner 环境配置',
                            'Applies proxy, registry, and PATH settings to spawned agents.',
                            '为启动的 agent 应用代理、包源与 PATH 设置。'
                        )
                    }]
                },
                web: {
                    settingsPanels: [{
                        id: 'runner-env-profiles',
                        title: {
                            en: 'Runner Environment Profiles',
                            'zh-CN': 'Runner 环境配置'
                        },
                        description: {
                            en: 'Configure non-secret environment values for agents spawned on a Runner.',
                            'zh-CN': '为 Runner 启动的 agent 配置非敏感环境变量。'
                        },
                        components: [{
                            kind: 'schemaForm',
                            fields: [
                                { key: 'agentIds', label: { en: 'Agent ids (comma-separated, blank = all)', 'zh-CN': 'Agent ID（逗号分隔，留空表示全部）' }, type: 'text' },
                                { key: 'directoryPrefixes', label: { en: 'Workspace prefixes (comma/newline, blank = all)', 'zh-CN': '工作区前缀（逗号/换行，留空表示全部）' }, type: 'text' },
                                { key: 'httpProxy', label: 'HTTP_PROXY', type: 'text' },
                                { key: 'httpsProxy', label: 'HTTPS_PROXY', type: 'text' },
                                { key: 'noProxy', label: 'NO_PROXY', type: 'text', defaultValue: 'localhost,127.0.0.1,::1' },
                                { key: 'goProxy', label: 'GOPROXY', type: 'text' },
                                { key: 'npmRegistry', label: 'NPM registry', type: 'text' },
                                { key: 'pathPrepend', label: { en: 'PATH prepend entries', 'zh-CN': 'PATH 前置目录' }, type: 'text' }
                            ]
                        }]
                    }]
                }
            },
            compatibility: {
                pluginApi: '>=0.1 <0.2',
                runner: {
                    extensionPoints: ['runner.environmentProvider']
                }
            },
            install: {
                runnerPlacement: 'compatible-runners',
                offlineRunnerPolicy: 'skip',
                minReadyRunnerCount: 1
            }
        }),
        files: [{ path: 'dist/runner.js', content: runnerEnvProfilesRuntime }]
    },
    {
        manifest: manifestBase({
            id: HAPI_CORE_RUNNER_SPAWN_GUARD_PLUGIN_ID,
            name: 'Runner Spawn Guard',
            description: 'First-party Runner plugin for blocking risky agent spawns by agent id, workspace prefix, or bypass permission mode.',
            display: displayMetadata(
                'Runner Spawn Guard',
                'Runner 启动保护',
                'Blocks risky Runner agent launches by agent id, workspace prefix, or bypass permission mode.',
                '按 Agent ID、工作区前缀或 bypass 权限模式阻止高风险 Runner 启动。',
                [
                    '### What it adds',
                    '- Checks Runner spawn requests before the agent process starts.',
                    '- Can block specific agent ids or workspace prefixes.',
                    '- Can prevent yolo / bypass permission mode on selected Runners.'
                ].join('\n'),
                [
                    '### 功能',
                    '- 在 agent 进程启动前检查 Runner 启动请求。',
                    '- 可阻止指定 Agent ID 或工作区前缀。',
                    '- 可在选定 Runner 上禁止 yolo / bypass 权限模式。'
                ].join('\n')
            ),
            capabilities: [{
                id: 'runner-spawn-guard',
                kind: 'runner.spawnExtension',
                displayName: 'Runner Spawn Guard',
                description: 'Blocks configured Runner spawn requests before an agent process starts.',
                display: labelMetadata(
                    'Runner Spawn Guard',
                    'Runner 启动保护',
                    'Blocks configured Runner spawn requests before an agent process starts.',
                    '在 agent 进程启动前阻止符合规则的 Runner 启动请求。'
                ),
                parts: {
                    web: {
                        required: true,
                        contributions: [{ type: 'settingsPanel', id: 'runner-spawn-guard' }]
                    },
                    runner: {
                        required: true,
                        target: 'selected-runner',
                        contributions: [{ type: 'spawnHook', id: 'runner-spawn-guard' }]
                    }
                }
            }],
            runtimes: {
                runner: { entry: 'dist/runner.js' }
            },
            contributions: {
                runner: {
                    spawnHooks: [{
                        id: 'runner-spawn-guard',
                        displayName: 'Runner Spawn Guard',
                        description: 'Blocks risky spawn requests before execution.',
                        display: labelMetadata(
                            'Runner Spawn Guard',
                            'Runner 启动保护',
                            'Blocks risky spawn requests before execution.',
                            '在执行前阻止高风险启动请求。'
                        )
                    }]
                },
                web: {
                    settingsPanels: [{
                        id: 'runner-spawn-guard',
                        title: {
                            en: 'Runner Spawn Guard',
                            'zh-CN': 'Runner 启动保护'
                        },
                        description: {
                            en: 'Prevent remote agent starts in risky workspaces or modes.',
                            'zh-CN': '阻止在高风险工作区或权限模式下远程启动 agent。'
                        },
                        components: [{
                            kind: 'schemaForm',
                            fields: [
                                { key: 'blockedAgentIds', label: { en: 'Blocked agent ids', 'zh-CN': '禁止启动的 Agent ID' }, type: 'text' },
                                { key: 'blockedDirectoryPrefixes', label: { en: 'Blocked workspace prefixes', 'zh-CN': '禁止的工作区前缀' }, type: 'text' },
                                { key: 'blockBypassPermissions', label: { en: 'Block yolo / bypass permission mode', 'zh-CN': '阻止 yolo / bypass 权限模式' }, type: 'boolean', defaultValue: false }
                            ]
                        }]
                    }]
                }
            },
            compatibility: {
                pluginApi: '>=0.1 <0.2',
                runner: {
                    extensionPoints: ['runner.spawnHook']
                }
            },
            install: {
                runnerPlacement: 'compatible-runners',
                offlineRunnerPolicy: 'skip',
                minReadyRunnerCount: 1
            }
        }),
        files: [{ path: 'dist/runner.js', content: runnerSpawnGuardRuntime }]
    }
]

export const defaultEnabledBundledPluginIds = [HAPI_CORE_SCHEDULE_SEND_PLUGIN_ID]

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
