import { basename, isAbsolute, relative, resolve } from 'node:path'
import { realpath, rm } from 'node:fs/promises'
import type {
    PluginDeleteResult,
    PluginDetail,
    PluginDiagnosticView,
    PluginListItem,
    PluginReloadItem,
    PluginReloadResult,
    PluginTargetSummary,
    RunnerPluginInventory,
    RunnerPluginUnsupportedInstallResult
} from '@hapi/protocol/plugins'
import {
    assertPluginConfigSafeForPersistence,
    sanitizePluginConfigForView
} from '@hapi/protocol/plugins'
import {
    applyPluginState,
    discoverPlugins,
    getPluginStateFile,
    getUserPluginsDir,
    readPluginState,
    writePluginState,
    type DiscoveredPluginRecord
} from '@hapi/protocol/plugins/foundation'
import type { PluginStateFile } from '@hapi/protocol/plugins'

export interface RunnerPluginManagerOptions {
    hapiHome: string
    machineId: string
    envPluginDirs?: string
    env?: NodeJS.ProcessEnv
}

type ReloadReason = 'startup' | 'manual' | 'state-change'

type InternalReloadResult = {
    records: DiscoveredPluginRecord[]
    items: PluginReloadItem[]
}

function pluginDisplayId(record: DiscoveredPluginRecord): string {
    return record.manifest?.id ?? basename(record.rootPath)
}

function diagnosticView(pluginId: string | undefined, diagnostic: { severity: 'info' | 'warning' | 'error'; code: string; message: string; path?: string }): PluginDiagnosticView {
    return {
        severity: diagnostic.severity,
        code: diagnostic.code,
        message: diagnostic.message,
        ...(diagnostic.path ? { path: diagnostic.path } : {}),
        ...(pluginId ? { pluginId } : {})
    }
}

function reloadItemIsOk(item: PluginReloadItem): boolean {
    if (item.action === 'failed' || item.action === 'kept-previous') {
        return false
    }
    return !['invalid', 'failed', 'reload-failed', 'blocked', 'incompatible'].includes(item.status)
}

function isPathInside(parentPath: string, childPath: string): boolean {
    const rel = relative(parentPath, childPath)
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
}

function assertDiscoveredRecordCanBeEnabled(
    record: DiscoveredPluginRecord,
    id: string
): asserts record is DiscoveredPluginRecord & { manifest: NonNullable<DiscoveredPluginRecord['manifest']> } {
    if (!record.manifest) {
        throw new Error(`Plugin ${id} was not found.`)
    }
    if (record.status !== 'validated') {
        throw new Error(`Plugin ${record.manifest.id} cannot be enabled while status is ${record.status}.`)
    }
}

export class RunnerPluginManager {
    private records: DiscoveredPluginRecord[] = []
    private managerDiagnostics: PluginDiagnosticView[] = []
    private reloadQueue: Promise<InternalReloadResult> = Promise.resolve({ records: [], items: [] })
    private disposed = false
    private lastInventoryUpdatedAt = Date.now()

    constructor(private readonly options: RunnerPluginManagerOptions) {
    }

    async start(): Promise<PluginReloadResult> {
        return await this.reload(undefined, 'startup')
    }

    listPlugins(): PluginListItem[] {
        return this.records.map((record) => this.toListItem(record))
    }

    getPlugin(id: string): PluginDetail | null {
        const record = this.records.find((entry) => pluginDisplayId(entry) === id || entry.manifest?.id === id)
        return record ? this.toDetail(record) : null
    }

    getDiagnostics(): PluginDiagnosticView[] {
        const recordDiagnostics = this.records.flatMap((record) => {
            const id = pluginDisplayId(record)
            return record.diagnostics.map((entry) => diagnosticView(id, entry))
        })
        return [...this.managerDiagnostics, ...recordDiagnostics]
    }

    getInventory(): RunnerPluginInventory {
        return {
            machineId: this.options.machineId,
            updatedAt: this.lastInventoryUpdatedAt,
            plugins: this.listPlugins(),
            diagnostics: this.getDiagnostics()
        }
    }

    async reload(targetId?: string, reason: ReloadReason = 'manual'): Promise<PluginReloadResult> {
        this.reloadQueue = this.reloadQueue
            .catch(() => ({ records: this.records, items: [] }))
            .then(() => this.performReload(targetId))
        const internal = await this.reloadQueue
        const target = this.targetSummary()
        return {
            ok: internal.items.every(reloadItemIsOk),
            ...(targetId ? { targetId } : {}),
            target,
            results: internal.items,
            plugins: this.listPlugins()
        }
    }

    async enablePlugin(id: string, config?: Record<string, unknown>, shouldReload = true): Promise<PluginReloadResult> {
        const state = await this.readWritableState()
        const record = await this.findDiscoveredRecord(id)
        if (!record) throw new Error(`Plugin ${id} was not found.`)
        assertDiscoveredRecordCanBeEnabled(record, id)
        assertPluginConfigSafeForPersistence(config, record.manifest.permissions?.secrets ?? [], record.manifest.id)
        const previous = state.enabled[record.manifest.id]
        state.enabled[record.manifest.id] = {
            enabled: true,
            ...(config ?? previous?.config ? { config: config ?? previous?.config } : {})
        }
        await writePluginState(getPluginStateFile(this.options.hapiHome), state)
        return shouldReload ? await this.reload(record.manifest.id, 'state-change') : this.currentNoopResult(record.manifest.id)
    }

    async disablePlugin(id: string, shouldReload = true): Promise<PluginReloadResult> {
        const state = await this.readWritableState()
        const record = await this.findDiscoveredRecord(id)
        const pluginId = record?.manifest?.id ?? id
        const previous = state.enabled[pluginId]
        state.enabled[pluginId] = {
            enabled: false,
            ...(previous?.config ? { config: previous.config } : {})
        }
        await writePluginState(getPluginStateFile(this.options.hapiHome), state)
        return shouldReload ? await this.reload(pluginId, 'state-change') : this.currentNoopResult(pluginId)
    }

    async updatePluginConfig(id: string, config: Record<string, unknown>, shouldReload = true): Promise<PluginReloadResult> {
        const state = await this.readWritableState()
        const record = await this.findDiscoveredRecord(id)
        if (!record) throw new Error(`Plugin ${id} was not found.`)
        assertDiscoveredRecordCanBeEnabled(record, id)
        assertPluginConfigSafeForPersistence(config, record.manifest.permissions?.secrets ?? [], record.manifest.id)
        const previous = state.enabled[record.manifest.id]
        state.enabled[record.manifest.id] = {
            enabled: previous?.enabled === true,
            config
        }
        await writePluginState(getPluginStateFile(this.options.hapiHome), state)
        return shouldReload ? await this.reload(record.manifest.id, 'state-change') : this.currentNoopResult(record.manifest.id)
    }

    installPrepareUnsupported(): RunnerPluginUnsupportedInstallResult {
        return {
            ok: false,
            code: 'unsupported-runtime',
            message: 'Runner plugin install distribution is not supported in this phase. Install the plugin on the Runner machine and reload that target.'
        }
    }

    installCommitUnsupported(): RunnerPluginUnsupportedInstallResult {
        return this.installPrepareUnsupported()
    }

    async deletePlugin(id: string, shouldReload = true): Promise<PluginDeleteResult> {
        const record = await this.findDiscoveredRecord(id)
        if (!record) {
            throw new Error(`Plugin ${id} was not found.`)
        }
        if (record.source !== 'user-home') {
            throw new Error(`Plugin ${id} cannot be deleted because it is from ${record.source}. Only user-home plugins can be deleted.`)
        }

        const pluginId = pluginDisplayId(record)
        const statePluginId = record.status === 'blocked' ? undefined : record.manifest?.id
        const userPluginsDir = getUserPluginsDir(this.options.hapiHome)
        const [userPluginsRealPath, rootRealPath] = await Promise.all([
            realpath(userPluginsDir),
            realpath(record.rootPath)
        ])
        if (!isPathInside(userPluginsRealPath, rootRealPath)) {
            throw new Error(`Plugin ${pluginId} cannot be deleted because its path is outside the user plugin directory.`)
        }

        const nextState = statePluginId ? await this.readWritableState() : null
        if (nextState && statePluginId) {
            delete nextState.enabled[statePluginId]
        }
        if (nextState) {
            await writePluginState(getPluginStateFile(this.options.hapiHome), nextState)
        }
        await rm(rootRealPath, { recursive: true, force: true })
        const reloadResult = shouldReload ? await this.reload(pluginId, 'state-change') : undefined
        return {
            ok: reloadResult?.ok ?? true,
            pluginId,
            rootPath: rootRealPath,
            deleted: true,
            target: this.targetSummary(),
            ...(reloadResult ? { reload: reloadResult } : {}),
            plugins: this.listPlugins()
        }
    }

    async dispose(): Promise<void> {
        this.disposed = true
    }

    private async performReload(targetId: string | undefined): Promise<InternalReloadResult> {
        if (this.disposed) {
            return { records: this.records, items: [] }
        }

        const items: PluginReloadItem[] = []
        const managerDiagnostics: PluginDiagnosticView[] = []
        const stateResult = await readPluginState(getPluginStateFile(this.options.hapiHome))
        const discovered = await discoverPlugins({
            hapiHome: this.options.hapiHome,
            envPluginDirs: this.options.envPluginDirs ?? this.options.env?.HAPI_PLUGIN_DIRS
        })
        const records = applyPluginState(discovered, stateResult.state, stateResult.failClosed)

        if (stateResult.parseError) {
            managerDiagnostics.push({
                severity: 'error',
                code: 'plugin-state-parse-error',
                message: `Failed to parse plugins.json; all plugins disabled: ${stateResult.parseError}`
            })
        }

        for (const record of records) {
            const id = pluginDisplayId(record)
            if (targetId && id !== targetId && record.manifest?.id !== targetId) {
                continue
            }
            items.push({
                id,
                action: 'unchanged',
                status: record.status,
                diagnostics: record.diagnostics.map((entry) => diagnosticView(id, entry))
            })
        }

        this.records = records
        this.managerDiagnostics = managerDiagnostics
        this.lastInventoryUpdatedAt = Date.now()
        return { records, items }
    }

    private async findDiscoveredRecord(id: string): Promise<DiscoveredPluginRecord | null> {
        const discovered = await discoverPlugins({
            hapiHome: this.options.hapiHome,
            envPluginDirs: this.options.envPluginDirs ?? this.options.env?.HAPI_PLUGIN_DIRS
        })
        return discovered.find((record) => pluginDisplayId(record) === id || record.manifest?.id === id) ?? null
    }

    private async readWritableState(): Promise<PluginStateFile> {
        const stateResult = await readPluginState(getPluginStateFile(this.options.hapiHome))
        if (stateResult.parseError) {
            throw new Error(`Cannot update plugins.json while it is invalid: ${stateResult.parseError}`)
        }
        return stateResult.state
    }

    private currentNoopResult(targetId: string): PluginReloadResult {
        return {
            ok: true,
            targetId,
            target: this.targetSummary(),
            results: [{ id: targetId, action: 'unchanged', status: 'enabled', diagnostics: [] }],
            plugins: this.listPlugins()
        }
    }

    private targetSummary(): PluginTargetSummary {
        return {
            scope: `runner:${this.options.machineId}`,
            runtime: 'runner',
            machineId: this.options.machineId,
            active: true,
            stale: false,
            updatedAt: this.lastInventoryUpdatedAt
        }
    }

    private toListItem(record: DiscoveredPluginRecord): PluginListItem {
        const id = pluginDisplayId(record)
        return {
            id,
            name: record.manifest?.name,
            version: record.manifest?.version,
            description: record.manifest?.description,
            source: record.source,
            status: record.status,
            enabled: record.enabled === true,
            active: false,
            rootPath: record.rootPath,
            manifestPath: record.manifestPath,
            runtimes: {
                ...(record.manifest?.runtimes?.hub ? {
                    hub: {
                        entry: record.manifest.runtimes.hub.entry,
                        active: false
                    }
                } : {}),
                ...(record.manifest?.runtimes?.runner ? {
                    runner: {
                        entry: record.manifest.runtimes.runner.entry,
                        active: false
                    }
                } : {})
            },
            diagnostics: record.diagnostics.map((entry) => diagnosticView(id, entry)),
            target: this.targetSummary()
        }
    }

    private toDetail(record: DiscoveredPluginRecord): PluginDetail {
        const item = this.toListItem(record)
        const declaredSecrets = record.manifest?.permissions?.secrets ?? []
        return {
            ...item,
            manifest: record.manifest,
            config: sanitizePluginConfigForView(record.config, declaredSecrets),
            permissions: {
                network: record.manifest?.permissions?.network ?? [],
                secrets: declaredSecrets.map((name) => ({
                    name,
                    present: Boolean((this.options.env ?? process.env)[name])
                }))
            },
            contributions: {
                notificationChannels: record.manifest?.contributions?.hub?.notificationChannels ?? [],
                ...(record.manifest?.contributions?.runner ? { runner: record.manifest.contributions.runner } : {}),
                ...(record.manifest?.contributions?.agent ? { agent: record.manifest.contributions.agent } : {}),
                ...(record.manifest?.contributions?.web ? { web: record.manifest.contributions.web } : {})
            },
            runtimeEntryPaths: record.runtimeEntryPaths
        }
    }
}
