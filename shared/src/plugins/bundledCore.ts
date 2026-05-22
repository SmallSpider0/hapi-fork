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
        kind: 'deliveryNotBefore',
        label: {
            en: 'Schedule send',
            'zh-CN': '定时发送',
        },
        icon: 'clock',
        maxDelayMs: 7 * 24 * 60 * 60 * 1000,
        presets: [
            { id: 'plus-5m', label: '+5m', delayMs: 5 * 60 * 1000 },
            { id: 'plus-30m', label: '+30m', delayMs: 30 * 60 * 1000 },
            { id: 'plus-1h', label: '+1h', delayMs: 60 * 60 * 1000 },
            { id: 'plus-4h', label: '+4h', delayMs: 4 * 60 * 60 * 1000 },
        ],
    }],
}

export const bundledCorePlugins: BundledCorePlugin[] = [
    {
        manifest: manifestBase({
            id: HAPI_CORE_SCHEDULE_SEND_PLUGIN_ID,
            name: 'Schedule Send',
            description: 'First-party descriptor plugin that contributes the delayed-send composer action. The reliable delivery queue remains a Hub core primitive.',
            contributions: {
                web: scheduleSendWebContributions
            }
        }),
        files: []
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
