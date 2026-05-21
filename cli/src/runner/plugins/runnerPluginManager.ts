import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
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
import { redactText, RunnerPluginRegistry, type RegisteredRuntimeContribution, type RunnerPluginModule } from './runnerPluginRegistry'
import type { HappyCliSpawnPlan } from '@/utils/spawnHappyCLI'
import type { SpawnSessionOptions } from '@/modules/common/rpcTypes'
import {
    resolveRunnerPluginSpawnPlan,
    runRunnerPluginAfterSpawnHooks,
    runRunnerPluginExitHooks,
    type RegisteredRunnerContribution,
    type RunnerCommandResolverContribution,
    type RunnerEnvironmentProviderContribution,
    type RunnerSpawnHookContribution
} from './runnerExtensionPipeline'
import type { RunnerResolvedSpawnPlan, RunnerSpawnContext } from '@hapi/protocol/plugins'

export interface RunnerPluginManagerOptions {
    hapiHome: string
    machineId: string
    envPluginDirs?: string
    env?: NodeJS.ProcessEnv
}

type ActiveRunnerPluginInstance = {
    pluginId: string
    registry: RunnerPluginRegistry
    record: DiscoveredPluginRecord
    signature: string
    loadedAt: number
}

type ReloadReason = 'startup' | 'manual' | 'state-change'

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

function getActivate(value: unknown): RunnerPluginModule['activate'] | null {
    if (!value || typeof value !== 'object') {
        return null
    }
    const moduleObject = value as { activate?: unknown; default?: unknown }
    if (typeof moduleObject.activate === 'function') {
        return moduleObject.activate as RunnerPluginModule['activate']
    }
    if (typeof moduleObject.default === 'function') {
        return moduleObject.default as RunnerPluginModule['activate']
    }
    if (moduleObject.default && typeof moduleObject.default === 'object') {
        const defaultObject = moduleObject.default as { activate?: unknown }
        if (typeof defaultObject.activate === 'function') {
            return defaultObject.activate as RunnerPluginModule['activate']
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
    const shadowPath = `${realPath.slice(0, realPath.lastIndexOf('.')) || realPath}.hapi-runner-reload-${safePluginId}-${hash}.mjs`
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
    private readonly activePlugins = new Map<string, ActiveRunnerPluginInstance>()
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
        const activeDiagnostics = Array.from(this.activePlugins.values()).flatMap((entry) =>
            entry.registry.diagnostics.map((diagnostic) => diagnosticView(entry.pluginId, diagnostic))
        )
        return [...this.managerDiagnostics, ...recordDiagnostics, ...activeDiagnostics]
    }

    getInventory(): RunnerPluginInventory {
        return {
            machineId: this.options.machineId,
            updatedAt: this.lastInventoryUpdatedAt,
            plugins: this.listPlugins(),
            diagnostics: this.getDiagnostics(),
            extensions: {
                environmentProviders: this.collectContributionSummaries('environmentProvider'),
                commandResolvers: this.collectContributionSummaries('commandResolver'),
                spawnHooks: this.collectContributionSummaries('spawnHook')
            }
        }
    }

    async resolveSpawnPlan(args: {
        options: SpawnSessionOptions
        agent: string
        basePlan: HappyCliSpawnPlan
        cwd: string
        env: NodeJS.ProcessEnv
    }): Promise<RunnerResolvedSpawnPlan> {
        const result = await resolveRunnerPluginSpawnPlan({
            machineId: this.options.machineId,
            options: args.options,
            agent: args.agent,
            basePlan: {
                command: args.basePlan.command,
                args: args.basePlan.args,
                displayArgs: args.basePlan.displayArgs,
                mode: args.basePlan.mode,
                cwd: args.cwd,
                env: args.env
            },
            environmentProviders: this.collectEnvironmentProviders(),
            commandResolvers: this.collectCommandResolvers(),
            spawnHooks: this.collectSpawnHooks()
        })
        this.recordSpawnDiagnostics([
            ...result.diagnostics,
            ...result.audit.map((entry) => ({
                severity: 'info' as const,
                code: 'runner-extension-audit',
                pluginId: entry.pluginId,
                message: `[runner-plugin:${this.options.machineId}:${entry.pluginId}] ${entry.message}`
            }))
        ])
        return result
    }

    async notifyAfterSpawn(args: { context: RunnerSpawnContext; pid: number }): Promise<void> {
        await runRunnerPluginAfterSpawnHooks({
            baseContext: args.context,
            pid: args.pid,
            hooks: this.collectSpawnHooks(),
            onDiagnostic: (diagnostic) => this.recordSpawnDiagnostics([diagnostic])
        })
    }

    async notifyExit(args: { context: RunnerSpawnContext; pid: number; exitCode: number | null; signal: NodeJS.Signals | null }): Promise<void> {
        await runRunnerPluginExitHooks({
            baseContext: args.context,
            pid: args.pid,
            exitCode: args.exitCode,
            signal: args.signal,
            hooks: this.collectSpawnHooks(),
            onDiagnostic: (diagnostic) => this.recordSpawnDiagnostics([diagnostic])
        })
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
            target: this.targetSummary(),
            ...(reloadResult ? { reload: reloadResult } : {}),
            plugins: this.listPlugins()
        }
    }

    async dispose(): Promise<void> {
        this.disposed = true
        const instances = Array.from(this.activePlugins.values()).reverse()
        this.activePlugins.clear()
        await Promise.all(instances.map(async (instance) => {
            try {
                await instance.registry.dispose()
            } catch (error) {
                console.error('[RunnerPluginManager] Plugin dispose failed:', error)
            }
        }))
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
            } else if (!records.some((record) => record.manifest?.id === pluginId && record.status === 'enabled' && record.manifest.runtimes?.runner)) {
                await this.disposeActive(pluginId)
                items.push({
                    id: pluginId,
                    action: 'deactivated',
                    status: 'disabled',
                    message: 'Plugin is no longer enabled for the Runner runtime.',
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

            if (!record.manifest || record.status !== 'enabled' || !record.manifest.runtimes?.runner) {
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
                if (this.disposed) {
                    await activation.instance.registry.dispose()
                    items.push({
                        id: pluginId,
                        action: 'deactivated',
                        status: 'disabled',
                        message: 'Runner plugin manager disposed during activation.',
                        diagnostics: []
                    })
                    continue
                }
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
        this.lastInventoryUpdatedAt = Date.now()
        return { records, items }
    }

    private async activateRecord(record: DiscoveredPluginRecord, signature: string): Promise<{
        ok: true
        instance: ActiveRunnerPluginInstance
    } | {
        ok: false
        message: string
        diagnostics: PluginDiagnosticView[]
    }> {
        const pluginId = record.manifest!.id
        const runnerEntry = record.runtimeEntryPaths.find((entry) => entry.runtime === 'runner')
        if (!runnerEntry) {
            return {
                ok: false,
                message: 'Runner runtime entry is missing.',
                diagnostics: [{ pluginId, severity: 'error', code: 'missing-runner-entry', message: 'Runner runtime entry is missing.', path: record.manifestPath }]
            }
        }

        const declaredSecrets = record.manifest?.permissions?.secrets ?? []
        const registry = new RunnerPluginRegistry(this.options.machineId)
        try {
            const importPath = await materializeReloadImportPath(runnerEntry.realPath, pluginId, signature)
            const importUrl = `${pathToFileURL(importPath).href}?hapiRunnerPlugin=${encodeURIComponent(pluginId)}&signature=${encodeURIComponent(signature)}`
            const importedModule = await import(importUrl)
            const activate = getActivate(importedModule)
            if (!activate) {
                return {
                    ok: false,
                    message: 'Runner runtime entry must export activate(ctx).',
                    diagnostics: [{ pluginId, severity: 'error', code: 'invalid-runner-entry', message: 'Runner runtime entry must export activate(ctx).', path: record.manifestPath }]
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
            const message = redactText(`Failed to import or activate runner plugin: ${errorMessage(error)}`, declaredSecrets, this.options.env)
            return {
                ok: false,
                message,
                diagnostics: [{ pluginId, severity: 'error', code: 'runner-plugin-activate-failed', message, path: record.manifestPath }]
            }
        }
    }

    private async computeSignature(record: DiscoveredPluginRecord): Promise<string> {
        const runnerEntry = record.runtimeEntryPaths.find((entry) => entry.runtime === 'runner')
        return stableStringify({
            manifestPath: record.manifestPath,
            manifestMtime: await safeMtime(record.manifestPath),
            runnerEntry: runnerEntry?.realPath,
            runnerEntryMtime: runnerEntry ? await safeMtime(runnerEntry.realPath) : 0,
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
            target: this.targetSummary(),
            results: [{ id: targetId, action: 'unchanged', status: this.activePlugins.has(targetId) ? 'active' : 'enabled', diagnostics: [] }],
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

    private recordSpawnDiagnostics(diagnostics: PluginDiagnosticView[]): void {
        for (const diagnostic of diagnostics) {
            this.managerDiagnostics.push({
                severity: diagnostic.severity,
                code: diagnostic.code,
                message: diagnostic.message,
                ...(diagnostic.pluginId ? { pluginId: diagnostic.pluginId } : {}),
                ...(diagnostic.path ? { path: diagnostic.path } : {})
            })
        }
        if (this.managerDiagnostics.length > 500) {
            this.managerDiagnostics = this.managerDiagnostics.slice(-500)
        }
        if (diagnostics.length > 0) {
            this.lastInventoryUpdatedAt = Date.now()
        }
    }

    private collectEnvironmentProviders(): RegisteredRunnerContribution<RunnerEnvironmentProviderContribution>[] {
        return this.collectRegistryContributions((registry) => registry.getEnvironmentProviders())
    }

    private collectCommandResolvers(): RegisteredRunnerContribution<RunnerCommandResolverContribution>[] {
        return this.collectRegistryContributions((registry) => registry.getCommandResolvers())
    }

    private collectSpawnHooks(): RegisteredRunnerContribution<RunnerSpawnHookContribution>[] {
        return this.collectRegistryContributions((registry) => registry.getSpawnHooks())
    }

    private collectRegistryContributions<T>(
        getEntries: (registry: RunnerPluginRegistry) => RegisteredRuntimeContribution<T>[]
    ): RegisteredRunnerContribution<T>[] {
        return Array.from(this.activePlugins.values()).flatMap((instance) =>
            getEntries(instance.registry).map((entry) => ({
                pluginId: entry.pluginId,
                id: entry.id,
                order: entry.order,
                priority: entry.priority,
                contribution: entry.contribution
            }))
        )
    }

    private collectContributionSummaries(type: RegisteredRuntimeContribution['type']) {
        return Array.from(this.activePlugins.values()).flatMap((instance) => {
            const entries = type === 'environmentProvider'
                ? instance.registry.getEnvironmentProviders()
                : type === 'commandResolver'
                    ? instance.registry.getCommandResolvers()
                    : instance.registry.getSpawnHooks()
            return entries.map((entry) => ({
                pluginId: entry.pluginId,
                id: entry.id,
                type,
                priority: entry.priority,
                active: true
            }))
        })
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
                        active: false
                    }
                } : {}),
                ...(record.manifest?.runtimes?.runner ? {
                    runner: {
                        entry: record.manifest.runtimes.runner.entry,
                        active
                    }
                } : {})
            },
            diagnostics: [
                ...record.diagnostics.map((entry) => diagnosticView(id, entry)),
                ...(activeInstance?.registry.diagnostics.map((entry) => diagnosticView(id, entry)) ?? []),
                ...this.managerDiagnostics.filter((entry) => entry.pluginId === id)
            ],
            target: this.targetSummary(),
            ...(activeInstance ? { updatedAt: activeInstance.loadedAt } : {})
        }
    }

    private toDetail(record: DiscoveredPluginRecord): PluginDetail {
        const item = this.toListItem(record)
        const declaredSecrets = record.manifest?.permissions?.secrets ?? []
        const activeInstance = record.manifest ? this.activePlugins.get(record.manifest.id) : undefined
        const activeRunnerContributions = activeInstance ? {
            environmentProviders: activeInstance.registry.getEnvironmentProviders().map((entry) => ({
                id: entry.id,
                pluginId: entry.pluginId,
                priority: entry.priority,
                active: true
            })),
            commandResolvers: activeInstance.registry.getCommandResolvers().map((entry) => ({
                id: entry.id,
                pluginId: entry.pluginId,
                priority: entry.priority,
                active: true
            })),
            spawnHooks: activeInstance.registry.getSpawnHooks().map((entry) => ({
                id: entry.id,
                pluginId: entry.pluginId,
                priority: entry.priority,
                active: true
            }))
        } : undefined
        const manifestRunnerContributions = record.manifest?.contributions?.runner
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
                ...(manifestRunnerContributions || activeRunnerContributions ? {
                    runner: {
                        ...(manifestRunnerContributions ?? {}),
                        ...(activeRunnerContributions ? {
                            environmentProviders: [
                                ...(manifestRunnerContributions?.environmentProviders ?? []),
                                ...activeRunnerContributions.environmentProviders
                            ],
                            commandResolvers: [
                                ...(manifestRunnerContributions?.commandResolvers ?? []),
                                ...activeRunnerContributions.commandResolvers
                            ],
                            spawnHooks: [
                                ...(manifestRunnerContributions?.spawnHooks ?? []),
                                ...activeRunnerContributions.spawnHooks
                            ]
                        } : {})
                    }
                } : {}),
                ...(record.manifest?.contributions?.agent ? { agent: record.manifest.contributions.agent } : {}),
                ...(record.manifest?.contributions?.web ? { web: record.manifest.contributions.web } : {})
            },
            runtimeEntryPaths: record.runtimeEntryPaths
        }
    }
}
