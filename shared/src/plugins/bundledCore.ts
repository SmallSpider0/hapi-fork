import { HAPI_PLUGIN_API_VERSION, type PluginManifestLite } from './manifest'
import type { PluginWebContributions } from './webDescriptors'
import { getBundledPluginsRoot, prepareBundledPlugins, type BundledPlugin } from './bundledMaterialize'

export const HAPI_BUNDLED_CORE_PLUGINS_DIR = 'bundled-core-plugins'
export const HAPI_CORE_SCHEDULE_SEND_PLUGIN_ID = 'com.hapi.core.schedule-send'

export type BundledCorePlugin = BundledPlugin

function manifestBase(manifest: Omit<PluginManifestLite, 'pluginApiVersion' | 'version'> & { version?: string }): PluginManifestLite {
    return {
        ...manifest,
        version: manifest.version ?? '0.1.0',
        pluginApiVersion: HAPI_PLUGIN_API_VERSION
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

export const bundledCorePlugins: BundledCorePlugin[] = [
    {
        manifest: manifestBase({
            id: HAPI_CORE_SCHEDULE_SEND_PLUGIN_ID,
            name: 'Schedule Send',
            description: 'First-party cross-runtime plugin that contributes a Web composer action and a Hub message-action handler backed by the core reliable delivery queue.',
            capabilities: [{
                id: 'schedule-send',
                kind: 'chat.composer.messageAction',
                displayName: 'Schedule Send',
                description: 'Adds a delay picker to the chat composer and returns a Hub-owned message delivery plan.',
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
                        description: 'Plans delayed delivery for a user message.'
                    }]
                },
                web: scheduleSendWebContributions
            }
        }),
        files: [{ path: 'dist/hub.js', content: scheduleSendHubRuntime }]
    }
]

export const defaultEnabledBundledPluginIds = bundledCorePlugins.map((plugin) => plugin.manifest.id)

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
