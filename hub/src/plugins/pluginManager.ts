import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import type {
    PluginDeleteResult,
    PluginDetail,
    PluginDiagnosticView,
    PluginInstallAction,
    PluginInstallLocalRequest,
    PluginInstallResult,
    PluginInstallPackageRequest,
    PluginListItem,
    PluginLocalDirectoryEntry,
    PluginLocalDirectoryListResponse,
    PluginReloadItem,
    PluginReloadResult
} from '@hapi/protocol/plugins'
import {
    applyPluginState,
    discoverPlugins,
    expandHomePath,
    getPluginStateFile,
    getUserPluginsDir,
    installPluginFromDirectory,
    installPluginFromPackage,
    readPluginState,
    writePluginState,
    type DiscoveredPluginRecord
} from '@hapi/protocol/plugins/foundation'
import { HAPI_PLUGIN_MANIFEST_FILE, assertPluginConfigSafeForPersistence, sanitizePluginConfigForView } from '@hapi/protocol/plugins'
import type { PluginInstallMetadata, PluginStateFile } from '@hapi/protocol/plugins'
import type { NotificationChannel, TaskNotification } from '../notifications/notificationTypes'
import type { Session } from '../sync/syncEngine'
import type { SessionEndReason } from '@hapi/protocol'
import { PluginRegistryLite, redactText } from './registry'
import type { HubPluginModule } from './types'

export interface HubPluginManagerOptions {
    hapiHome: string
    publicUrl?: string
    envPluginDirs?: string
    env?: NodeJS.ProcessEnv
    watch?: boolean
    watchDebounceMs?: number
}

type ActivePluginInstance = {
    pluginId: string
    registry: PluginRegistryLite
    record: DiscoveredPluginRecord
    signature: string
    loadedAt: number
}

type ReloadReason = 'startup' | 'manual' | 'state-change' | 'watch'

type InternalReloadResult = {
    records: DiscoveredPluginRecord[]
    items: PluginReloadItem[]
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

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
    }
    if (value && typeof value === 'object') {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
            .join(',')}}`
    }
    return JSON.stringify(value)
}


async function materializeReloadImportPath(realPath: string, pluginId: string, signature: string): Promise<string> {
    const hash = createHash('sha256').update(signature).digest('hex').slice(0, 16)
    const safePluginId = pluginId.replace(/[^A-Za-z0-9._-]/g, '_')
    const shadowPath = join(dirname(realPath), `.hapi-reload-${safePluginId}-${hash}.mjs`)
    await mkdir(dirname(shadowPath), { recursive: true })
    await writeFile(shadowPath, await readFile(realPath, 'utf8'))
    return shadowPath
}

async function safeMtime(path: string): Promise<number> {
    try {
        return (await stat(path)).mtimeMs
    } catch {
        return 0
    }
}

async function safePathExists(path: string): Promise<boolean> {
    try {
        await stat(path)
        return true
    } catch {
        return false
    }
}

function isPathInside(parentPath: string, childPath: string): boolean {
    const rel = relative(parentPath, childPath)
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
}

function sortLocalDirectoryEntries<T extends { name: string; type: string }>(entries: T[]): T[] {
    return entries.sort((left, right) => {
        if (left.type === 'directory' && right.type !== 'directory') return -1
        if (left.type !== 'directory' && right.type === 'directory') return 1
        return left.name.localeCompare(right.name)
    })
}

function pluginDisplayId(record: DiscoveredPluginRecord): string {
    const id = record.manifest?.id ?? basename(record.rootPath)
    if (record.manifest && record.status !== 'blocked') {
        return id
    }
    const hash = createHash('sha256').update(record.rootPath).digest('hex').slice(0, 8)
    return `${id}#${hash}`
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

function reloadItemIsOk(item: PluginReloadItem): boolean {
    if (item.action === 'failed' || item.action === 'kept-previous') {
        return false
    }
    return !['invalid', 'failed', 'reload-failed', 'blocked', 'incompatible'].includes(item.status)
}

export class HubPluginManager {
    private readonly activePlugins = new Map<string, ActivePluginInstance>()
    private records: DiscoveredPluginRecord[] = []
    private managerDiagnostics: PluginDiagnosticView[] = []
    private reloadQueue: Promise<InternalReloadResult> = Promise.resolve({ records: [], items: [] })
    private watchers: FSWatcher[] = []
    private watchTimer: NodeJS.Timeout | null = null
    private disposed = false
    private readonly notificationChannel: NotificationChannel

    constructor(private readonly options: HubPluginManagerOptions) {
        this.notificationChannel = this.createNotificationMultiplexer()
    }

    async start(): Promise<PluginReloadResult> {
        const result = await this.reload(undefined, 'startup')
        if (this.options.watch !== false) {
            this.resetWatchers()
        }
        return result
    }

    getNotificationChannel(): NotificationChannel {
        return this.notificationChannel
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
        const activeDiagnostics = Array.from(this.activePlugins.values()).flatMap((entry) =>
            entry.registry.diagnostics.map((diagnostic) => diagnosticView(entry.pluginId, diagnostic))
        )
        return [...this.managerDiagnostics, ...recordDiagnostics, ...activeDiagnostics]
    }

    async reload(targetId?: string, reason: ReloadReason = 'manual'): Promise<PluginReloadResult> {
        this.reloadQueue = this.reloadQueue
            .catch(() => ({ records: this.records, items: [] }))
            .then(() => this.performReload(targetId, reason))
        const internal = await this.reloadQueue
        return {
            ok: internal.items.every(reloadItemIsOk),
            ...(targetId ? { targetId } : {}),
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
            ...(config ?? previous?.config ? { config: config ?? previous?.config } : {}),
            ...(previous?.install ? { install: previous.install } : {})
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
            ...(previous?.config ? { config: previous.config } : {}),
            ...(previous?.install ? { install: previous.install } : {})
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
            config,
            ...(previous?.install ? { install: previous.install } : {})
        }
        await writePluginState(getPluginStateFile(this.options.hapiHome), state)
        return shouldReload ? await this.reload(record.manifest.id, 'state-change') : this.currentNoopResult(record.manifest.id)
    }

    async installLocalPlugin(sourcePath: string, options: Omit<PluginInstallLocalRequest, 'sourcePath'> = {}): Promise<PluginInstallResult> {
        const install = await installPluginFromDirectory({
            hapiHome: this.options.hapiHome,
            sourcePath,
            overwrite: options.overwrite === true
        })
        const pluginId = install.record.manifest!.id
        await this.recordInstallState(pluginId, {
            sourceType: 'hub-local-path',
            sourcePath: install.sourcePath,
            version: install.record.manifest!.version
        }, options.enable === true)

        return await this.buildInstallResult({
            action: install.action,
            pluginId,
            sourcePath: install.sourcePath,
            targetPath: install.targetPath,
            diagnostics: install.record.diagnostics.map((entry) => diagnosticView(pluginId, entry)),
            reload: options.reload !== false,
            reloadReason: options.enable === true ? 'state-change' : 'manual'
        })
    }

    async installPluginPackage(options: PluginInstallPackageRequest): Promise<PluginInstallResult> {
        const install = await installPluginFromPackage({
            hapiHome: this.options.hapiHome,
            filename: options.filename,
            contentBase64: options.contentBase64,
            checksum: options.checksum,
            format: options.format,
            manifest: options.manifest,
            overwrite: options.overwrite === true
        })
        const pluginId = install.record.manifest!.id
        await this.recordInstallState(pluginId, {
            sourceType: 'uploaded-package',
            checksum: install.checksum,
            packageFormat: install.packageFormat,
            version: install.record.manifest!.version
        }, options.enable === true)

        return await this.buildInstallResult({
            action: install.action,
            pluginId,
            sourcePath: options.filename,
            targetPath: install.targetPath,
            diagnostics: install.record.diagnostics.map((entry) => diagnosticView(pluginId, entry)),
            reload: options.reload !== false,
            reloadReason: options.enable === true ? 'state-change' : 'manual'
        })
    }

    async listLocalDirectory(path?: string): Promise<PluginLocalDirectoryListResponse> {
        const requestedPath = path?.trim() ? path.trim() : this.options.hapiHome
        const resolvedPath = resolve(expandHomePath(requestedPath))
        try {
            const stats = await lstat(resolvedPath)
            if (!stats.isDirectory()) {
                return {
                    success: false,
                    path: resolvedPath,
                    error: `Path is not a directory: ${resolvedPath}`
                }
            }

            const [entries, hasPluginManifest] = await Promise.all([
                readdir(resolvedPath, { withFileTypes: true }),
                safePathExists(join(resolvedPath, HAPI_PLUGIN_MANIFEST_FILE))
            ])

            const mapped = await Promise.all(entries.map(async (entry): Promise<PluginLocalDirectoryEntry> => {
                const entryPath = join(resolvedPath, entry.name)
                const entryStats = await lstat(entryPath).catch(() => null)
                const type: PluginLocalDirectoryEntry['type'] = entry.isDirectory()
                    ? 'directory'
                    : entry.isFile()
                        ? 'file'
                        : 'other'
                return {
                    name: entry.name,
                    type,
                    ...(entryStats ? { size: entryStats.size, modified: entryStats.mtimeMs } : {}),
                    ...(type === 'directory' ? { hasPluginManifest: await safePathExists(join(entryPath, HAPI_PLUGIN_MANIFEST_FILE)) } : {})
                }
            }))

            return {
                success: true,
                path: resolvedPath,
                parentPath: dirname(resolvedPath),
                hasPluginManifest,
                entries: sortLocalDirectoryEntries(mapped)
            }
        } catch (error) {
            return {
                success: false,
                path: resolvedPath,
                error: error instanceof Error ? error.message : String(error)
            }
        }
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
        if (statePluginId) {
            await this.disposeActive(statePluginId)
        }
        await rm(rootRealPath, { recursive: true, force: true })
        const reloadResult = shouldReload ? await this.reload(pluginId, 'state-change') : undefined
        return {
            ok: reloadResult?.ok ?? true,
            pluginId,
            rootPath: rootRealPath,
            deleted: true,
            ...(reloadResult ? { reload: reloadResult } : {}),
            plugins: this.listPlugins()
        }
    }

    async dispose(): Promise<void> {
        this.disposed = true
        this.clearWatchers()
        if (this.watchTimer) {
            clearTimeout(this.watchTimer)
            this.watchTimer = null
        }
        const instances = Array.from(this.activePlugins.values()).reverse()
        this.activePlugins.clear()
        await Promise.all(instances.map(async (instance) => {
            try {
                await instance.registry.dispose()
            } catch (error) {
                console.error('[HubPluginManager] Plugin dispose failed:', error)
            }
        }))
    }

    private async recordInstallState(pluginId: string, metadata: Omit<PluginInstallMetadata, 'installedAt' | 'updatedAt'>, enable: boolean): Promise<void> {
        const state = await this.readWritableState()
        const previous = state.enabled[pluginId]
        const now = Date.now()
        state.enabled[pluginId] = {
            enabled: enable ? true : previous?.enabled === true,
            ...(previous?.config ? { config: previous.config } : {}),
            install: {
                ...metadata,
                installedAt: previous?.install?.installedAt ?? now,
                updatedAt: now
            }
        }
        await writePluginState(getPluginStateFile(this.options.hapiHome), state)
    }

    private async buildInstallResult(options: {
        action: PluginInstallAction
        pluginId: string
        sourcePath?: string
        targetPath: string
        diagnostics?: PluginDiagnosticView[]
        reload: boolean
        reloadReason: ReloadReason
    }): Promise<PluginInstallResult> {
        let reloadResult: PluginReloadResult | undefined
        if (options.reload) {
            reloadResult = await this.reload(options.pluginId, options.reloadReason)
        }

        const plugin = this.listPlugins().find((entry) => entry.id === options.pluginId)
        return {
            ok: reloadResult?.ok ?? true,
            action: options.action,
            ...(plugin ? { plugin } : {}),
            pluginId: options.pluginId,
            ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
            targetPath: options.targetPath,
            diagnostics: options.diagnostics ?? plugin?.diagnostics ?? [],
            ...(reloadResult ? { reload: reloadResult } : {}),
            plugins: this.listPlugins()
        }
    }

    private createNotificationMultiplexer(): NotificationChannel {
        const each = async (call: (channel: NotificationChannel) => Promise<void>): Promise<void> => {
            const channels = Array.from(this.activePlugins.values())
                .flatMap((entry) => entry.registry.getNotificationChannels())
            for (const channel of channels) {
                try {
                    await call(channel)
                } catch (error) {
                    console.error('[HubPluginManager] Plugin notification failed:', error)
                }
            }
        }
        return {
            sendReady: async (session: Session) => each((channel) => channel.sendReady(session)),
            sendPermissionRequest: async (session: Session) => each((channel) => channel.sendPermissionRequest(session)),
            sendTaskNotification: async (session: Session, notification: TaskNotification) => each((channel) => channel.sendTaskNotification(session, notification)),
            sendSessionCompletion: async (session: Session, reason: SessionEndReason) => each(async (channel) => {
                if (typeof channel.sendSessionCompletion === 'function') {
                    await channel.sendSessionCompletion(session, reason)
                }
            })
        }
    }

    private async performReload(targetId: string | undefined, reason: ReloadReason): Promise<InternalReloadResult> {
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

        const seenIds = new Set(records.filter((record) => record.manifest).map((record) => record.manifest!.id))
        for (const [pluginId, instance] of Array.from(this.activePlugins.entries())) {
            if (targetId && pluginId !== targetId) {
                continue
            }
            if (!seenIds.has(pluginId)) {
                await this.disposeActive(pluginId)
                items.push({
                    id: pluginId,
                    action: 'deactivated',
                    status: 'disabled',
                    message: 'Plugin is no longer discovered.',
                    diagnostics: []
                })
            } else if (!records.some((record) => record.manifest?.id === pluginId && record.status === 'enabled' && record.manifest.runtimes?.hub)) {
                await this.disposeActive(pluginId)
                items.push({
                    id: pluginId,
                    action: 'deactivated',
                    status: 'disabled',
                    message: 'Plugin is no longer enabled for the Hub runtime.',
                    diagnostics: []
                })
            } else {
                instance.record = records.find((record) => record.manifest?.id === pluginId) ?? instance.record
            }
        }

        for (const record of records) {
            const id = pluginDisplayId(record)
            if (targetId && id !== targetId && record.manifest?.id !== targetId) {
                continue
            }

            if (!record.manifest || record.status !== 'enabled' || !record.manifest.runtimes?.hub) {
                if (!items.some((item) => item.id === id)) {
                    items.push({
                        id,
                        action: 'unchanged',
                        status: record.status,
                        diagnostics: record.diagnostics.map((entry) => diagnosticView(id, entry))
                    })
                }
                continue
            }

            const pluginId = record.manifest.id
            const signature = await this.computeSignature(record)
            const existing = this.activePlugins.get(pluginId)
            if (existing && existing.signature === signature) {
                record.status = 'active'
                existing.record = record
                items.push({ id: pluginId, action: 'unchanged', status: 'active', diagnostics: [] })
                continue
            }

            const activation = await this.activateRecord(record, signature)
            if (activation.ok) {
                const action = existing ? 'reloaded' : 'activated'
                this.activePlugins.set(pluginId, activation.instance)
                record.status = 'active'
                if (existing) {
                    await existing.registry.dispose()
                }
                items.push({ id: pluginId, action, status: 'active', diagnostics: [] })
                continue
            }

            record.diagnostics.push(...activation.diagnostics.map((diagnostic) => ({
                severity: diagnostic.severity,
                code: diagnostic.code,
                message: diagnostic.message,
                ...(diagnostic.path ? { path: diagnostic.path } : {})
            })))
            if (existing) {
                record.status = 'reload-failed'
                existing.record = record
                items.push({
                    id: pluginId,
                    action: 'kept-previous',
                    status: 'reload-failed',
                    message: activation.message,
                    diagnostics: activation.diagnostics
                })
            } else {
                record.status = 'failed'
                items.push({
                    id: pluginId,
                    action: 'failed',
                    status: 'failed',
                    message: activation.message,
                    diagnostics: activation.diagnostics
                })
            }
        }

        this.records = records
        this.managerDiagnostics = managerDiagnostics
        if (reason === 'watch' || reason === 'manual' || reason === 'state-change') {
            this.resetWatchers()
        }
        return { records, items }
    }

    private async activateRecord(record: DiscoveredPluginRecord, signature: string): Promise<{
        ok: true
        instance: ActivePluginInstance
    } | {
        ok: false
        message: string
        diagnostics: PluginDiagnosticView[]
    }> {
        const pluginId = record.manifest!.id
        const hubEntry = record.runtimeEntryPaths.find((entry) => entry.runtime === 'hub')
        if (!hubEntry) {
            return {
                ok: false,
                message: 'Hub runtime entry is missing.',
                diagnostics: [{ pluginId, severity: 'error', code: 'missing-hub-entry', message: 'Hub runtime entry is missing.', path: record.manifestPath }]
            }
        }

        const declaredSecrets = record.manifest?.permissions?.secrets ?? []
        const registry = new PluginRegistryLite(this.options.publicUrl)
        try {
            const importPath = await materializeReloadImportPath(hubEntry.realPath, pluginId, signature)
            const importUrl = `${pathToFileURL(importPath).href}?hapiPlugin=${encodeURIComponent(pluginId)}&signature=${encodeURIComponent(signature)}`
            const importedModule = await import(importUrl)
            const activate = getActivate(importedModule)
            if (!activate) {
                return {
                    ok: false,
                    message: 'Hub runtime entry must export activate(ctx).',
                    diagnostics: [{ pluginId, severity: 'error', code: 'invalid-hub-entry', message: 'Hub runtime entry must export activate(ctx).', path: record.manifestPath }]
                }
            }

            const disposableStart = registry.getDisposableCount()
            const activation = registry.createContext({
                pluginId,
                config: record.config,
                declaredSecrets,
                env: this.options.env
            })
            try {
                await activate(activation.ctx)
                activation.close()
            } catch (error) {
                activation.close()
                await registry.disposeFrom(disposableStart)
                throw error
            }

            return {
                ok: true,
                instance: {
                    pluginId,
                    registry,
                    record,
                    signature,
                    loadedAt: Date.now()
                }
            }
        } catch (error) {
            await registry.dispose().catch(() => undefined)
            const message = redactText(`Failed to import or activate hub plugin: ${errorMessage(error)}`, declaredSecrets, this.options.env)
            return {
                ok: false,
                message,
                diagnostics: [{ pluginId, severity: 'error', code: 'hub-plugin-activate-failed', message, path: record.manifestPath }]
            }
        }
    }

    private async computeSignature(record: DiscoveredPluginRecord): Promise<string> {
        const hubEntry = record.runtimeEntryPaths.find((entry) => entry.runtime === 'hub')
        return stableStringify({
            manifestPath: record.manifestPath,
            manifestMtime: await safeMtime(record.manifestPath),
            hubEntry: hubEntry?.realPath,
            hubEntryMtime: hubEntry ? await safeMtime(hubEntry.realPath) : 0,
            config: record.config ?? {},
            pluginApiVersion: record.manifest?.pluginApiVersion,
            version: record.manifest?.version
        })
    }

    private async disposeActive(pluginId: string): Promise<void> {
        const existing = this.activePlugins.get(pluginId)
        if (!existing) {
            return
        }
        this.activePlugins.delete(pluginId)
        await existing.registry.dispose()
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
            results: [{ id: targetId, action: 'unchanged', status: this.activePlugins.has(targetId) ? 'active' : 'enabled', diagnostics: [] }],
            plugins: this.listPlugins()
        }
    }

    private toListItem(record: DiscoveredPluginRecord): PluginListItem {
        const id = pluginDisplayId(record)
        const active = record.manifest && record.status !== 'blocked' ? this.activePlugins.has(record.manifest.id) : false
        const activeInstance = record.manifest ? this.activePlugins.get(record.manifest.id) : undefined
        return {
            id,
            name: record.manifest?.name,
            version: record.manifest?.version,
            description: record.manifest?.description,
            source: record.source,
            status: active && record.status === 'enabled' ? 'active' : record.status,
            enabled: record.enabled === true,
            active,
            rootPath: record.rootPath,
            manifestPath: record.manifestPath,
            runtimes: {
                ...(record.manifest?.runtimes?.hub ? {
                    hub: {
                        entry: record.manifest.runtimes.hub.entry,
                        active
                    }
                } : {}),
                ...(record.manifest?.runtimes?.runner ? {
                    runner: {
                        entry: record.manifest.runtimes.runner.entry,
                        active: false
                    }
                } : {})
            },
            diagnostics: [
                ...record.diagnostics.map((entry) => diagnosticView(id, entry)),
                ...(activeInstance?.registry.diagnostics.map((entry) => diagnosticView(id, entry)) ?? [])
            ],
            install: record.install ?? { sourceType: record.source, version: record.manifest?.version },
            ...(activeInstance ? { updatedAt: activeInstance.loadedAt } : {})
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

    private resetWatchers(): void {
        if (this.options.watch === false || this.disposed) {
            return
        }
        this.clearWatchers()
        const paths = new Set<string>([
            this.options.hapiHome,
            join(this.options.hapiHome, 'plugins'),
            ...this.records.map((record) => record.rootPath),
            ...this.records.flatMap((record) => record.runtimeEntryPaths.map((entry) => dirname(entry.realPath)))
        ])
        for (const path of paths) {
            try {
                const watcher = watch(path, { persistent: false }, (_eventType, filename) => {
                    if (filename && basename(String(filename)).startsWith('.hapi-reload-')) {
                        return
                    }
                    this.scheduleWatchReload()
                })
                this.watchers.push(watcher)
            } catch {
                // Watch support is best-effort; manual reload remains available.
            }
        }
    }

    private clearWatchers(): void {
        for (const watcher of this.watchers) {
            watcher.close()
        }
        this.watchers = []
    }

    private scheduleWatchReload(): void {
        if (this.disposed) {
            return
        }
        if (this.watchTimer) {
            clearTimeout(this.watchTimer)
        }
        this.watchTimer = setTimeout(() => {
            this.watchTimer = null
            this.reload(undefined, 'watch').catch((error) => {
                console.error('[HubPluginManager] Watch reload failed:', error)
            })
        }, this.options.watchDebounceMs ?? 300)
    }
}
