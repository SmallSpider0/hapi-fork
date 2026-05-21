import { pathToFileURL } from 'node:url'
import type { PluginDiagnostic } from '@hapi/protocol/plugins'
import {
    applyPluginState,
    discoverPlugins,
    getPluginStateFile,
    readPluginState,
    type DiscoveredPluginRecord
} from '@hapi/protocol/plugins/foundation'
import type { NotificationChannel } from '../notifications/notificationTypes'
import { PluginRegistryLite, redactText } from './registry'
import type { HubPluginModule } from './types'

export interface HubPluginRuntimeOptions {
    hapiHome: string
    publicUrl?: string
    envPluginDirs?: string
    env?: NodeJS.ProcessEnv
}

export interface HubPluginRuntime {
    records: DiscoveredPluginRecord[]
    diagnostics: PluginDiagnostic[]
    notificationChannels: NotificationChannel[]
    dispose(): Promise<void>
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message
    }
    return String(error)
}

function getActivate(value: unknown): HubPluginModule['activate'] | null {
    if (!value || typeof value !== 'object') {
        return null
    }
    const moduleObject = value as { activate?: unknown; default?: unknown }
    if (typeof moduleObject.activate === 'function') {
        return moduleObject.activate as HubPluginModule['activate']
    }
    if (typeof moduleObject.default === 'function') {
        return moduleObject.default as HubPluginModule['activate']
    }
    if (moduleObject.default && typeof moduleObject.default === 'object') {
        const defaultObject = moduleObject.default as { activate?: unknown }
        if (typeof defaultObject.activate === 'function') {
            return defaultObject.activate as HubPluginModule['activate']
        }
    }
    return null
}

export async function loadHubPluginRuntime(options: HubPluginRuntimeOptions): Promise<HubPluginRuntime> {
    const env = options.env ?? process.env
    const registry = new PluginRegistryLite(options.publicUrl)
    const stateResult = await readPluginState(getPluginStateFile(options.hapiHome))
    const discovered = await discoverPlugins({
        hapiHome: options.hapiHome,
        envPluginDirs: options.envPluginDirs ?? env.HAPI_PLUGIN_DIRS
    })
    const records = applyPluginState(discovered, stateResult.state, stateResult.failClosed)

    if (stateResult.parseError) {
        registry.diagnostics.push({
            severity: 'error',
            code: 'plugin-state-parse-error',
            message: `Failed to parse plugins.json; all plugins disabled: ${stateResult.parseError}`
        })
    }

    for (const record of records) {
        if (record.status !== 'enabled' || !record.manifest?.runtimes?.hub) {
            continue
        }
        const hubEntry = record.runtimeEntryPaths.find((entry) => entry.runtime === 'hub')
        if (!hubEntry) {
            continue
        }
        const declaredSecrets = record.manifest.permissions?.secrets ?? []
        try {
            const importUrl = `${pathToFileURL(hubEntry.realPath).href}?hapiPlugin=${encodeURIComponent(record.manifest.id)}&mtime=${Date.now()}`
            const importedModule = await import(importUrl)
            const activate = getActivate(importedModule)
            if (!activate) {
                record.status = 'failed'
                registry.addDiagnostic('error', 'invalid-hub-entry', 'Hub runtime entry must export activate(ctx).', record.manifest.id, record.manifestPath)
                continue
            }

            const disposableStart = registry.getDisposableCount()
            const activation = registry.createContext({
                pluginId: record.manifest.id,
                config: record.config,
                declaredSecrets,
                env
            })
            try {
                await activate(activation.ctx)
                record.status = 'active'
            } catch (error) {
                activation.close()
                await registry.disposeFrom(disposableStart)
                throw error
            }
            activation.close()
        } catch (error) {
            record.status = 'failed'
            registry.addDiagnostic(
                'error',
                'hub-plugin-activate-failed',
                redactText(`Failed to import or activate hub plugin: ${errorMessage(error)}`, declaredSecrets, env),
                record.manifest.id,
                record.manifestPath
            )
        }
    }

    return {
        records,
        diagnostics: registry.diagnostics,
        notificationChannels: registry.getNotificationChannels(),
        dispose: () => registry.dispose()
    }
}
