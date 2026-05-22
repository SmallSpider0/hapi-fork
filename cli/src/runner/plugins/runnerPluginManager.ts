import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
    PluginDeleteResult,
    PluginDetail,
    PluginDiagnosticView,
    PluginInstallLocalRequest,
    PluginInstallPackageRequest,
    PluginInstallResult,
    PluginLocalDirectoryEntry,
    PluginLocalDirectoryListResponse,
    PluginListItem,
    PluginReloadItem,
    PluginReloadResult,
    PluginTargetSummary,
    PluginWebContributionView,
    RunnerPluginInventory,
    RunnerPluginUnsupportedInstallResult
} from '@hapi/protocol/plugins'
import {
    AgentCapabilityProviderResultSchema,
    AgentCapabilityProviderSnapshotSchema,
    AgentHistoryImportResultSchema,
    AgentDescriptorSchema,
    HAPI_PLUGIN_MANIFEST_FILE,
    assertPluginConfigSafeForPersistence,
    builtinAgentDescriptors,
    runnerPluginConfigScope,
    sanitizePluginConfigForView
} from '@hapi/protocol/plugins'
import { prepareBundledExamplePlugins } from '@hapi/protocol/plugins/bundledExamples'
import {
    applyPluginState,
    discoverPlugins,
    expandHomePath,
    getPluginStateFile,
    getUserPluginsDir,
    installPluginFromDirectory,
    installPluginFromPackage,
    readPluginState,
    resolvePluginScopedConfig,
    setPluginScopedConfig,
    writePluginState,
    type DiscoveredPluginRecord
} from '@hapi/protocol/plugins/foundation'
import type { PluginInstallMetadata, PluginStateFile } from '@hapi/protocol/plugins'
import { redactText, RunnerPluginRegistry, type RegisteredRuntimeContribution, type RunnerAgentAdapterContribution, type RunnerAgentCapabilityProviderContribution, type RunnerPluginModule } from './runnerPluginRegistry'
import type { HappyCliSpawnPlan } from '@/utils/spawnHappyCLI'
import type { SpawnSessionOptions } from '@/modules/common/rpcTypes'
import type { AgentBackendFactory } from '@/agent/types'
import {
    resolveRunnerPluginSpawnPlan,
    runRunnerPluginAfterSpawnHooks,
    runRunnerPluginExitHooks,
    type RegisteredRunnerContribution,
    type RunnerCommandResolverContribution,
    type RunnerEnvironmentProviderContribution,
    type RunnerSpawnHookContribution
} from './runnerExtensionPipeline'
import type { AgentCapabilityProviderResult, AgentCapabilityProviderSnapshot, AgentHistoryImportResult, AgentDescriptor, RunnerResolvedSpawnPlan, RunnerSpawnContext } from '@hapi/protocol/plugins'

export interface RunnerPluginManagerOptions {
    hapiHome: string
    machineId: string
    envPluginDirs?: string
    env?: NodeJS.ProcessEnv
    includeBundledExamples?: boolean
}

type ActiveRunnerPluginInstance = {
    pluginId: string
    registry: RunnerPluginRegistry
    record: DiscoveredPluginRecord
    signature: string
    loadedAt: number
}

type ReloadReason = 'startup' | 'manual' | 'state-change'
type RunnerExtensionRuntimeContributionType = Exclude<RegisteredRuntimeContribution['type'], 'agentAdapter' | 'agentCapabilityProvider'>
const BUILTIN_AGENT_IDS = new Set(builtinAgentDescriptors().map((descriptor) => descriptor.id))
const DEFAULT_CAPABILITY_PROVIDER_TIMEOUT_MS = 1000

function runtimeContributionSort<T>(
    left: RegisteredRunnerContribution<T>,
    right: RegisteredRunnerContribution<T>
): number {
    return left.priority - right.priority
        || left.pluginId.localeCompare(right.pluginId)
        || left.id.localeCompare(right.id)
        || left.order - right.order
}

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

function describeZodError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
    return error.issues
        .map((issue) => {
            const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
            return `${path}${issue.message}`
        })
        .join('; ')
}

function withTimeout<T>(work: Promise<T> | T, timeoutMs: number, label: string): Promise<T> {
    let timeout: NodeJS.Timeout | null = null
    return Promise.race([
        Promise.resolve(work),
        new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
        })
    ]).finally(() => {
        if (timeout) clearTimeout(timeout)
    })
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

async function safePathExists(path: string): Promise<boolean> {
    try {
        await stat(path)
        return true
    } catch {
        return false
    }
}

function sortLocalDirectoryEntries<T extends { name: string; type: string }>(entries: T[]): T[] {
    return entries.sort((left, right) => {
        if (left.type === 'directory' && right.type !== 'directory') return -1
        if (left.type !== 'directory' && right.type === 'directory') return 1
        return left.name.localeCompare(right.name)
    })
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
    private capabilitySnapshots: AgentCapabilityProviderSnapshot[] = []
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
            return [
                ...record.diagnostics.map((entry) => diagnosticView(id, entry)),
                ...this.missingSecretDiagnostics(record)
            ]
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
            },
            webContributions: this.collectWebContributions()
        }
    }

    getAgentDescriptors(): AgentDescriptor[] {
        const pluginDescriptors = this.collectAgentAdapters().map((entry) => AgentDescriptorSchema.parse({
            ...entry.contribution.descriptor,
            source: 'plugin',
            pluginId: entry.pluginId,
            available: true
        }))
        const firstById = new Map<string, AgentDescriptor>()
        for (const descriptor of [...builtinAgentDescriptors(), ...pluginDescriptors]) {
            if (!firstById.has(descriptor.id)) {
                firstById.set(descriptor.id, descriptor)
            }
        }
        for (const snapshot of this.capabilitySnapshots) {
            const descriptor = firstById.get(snapshot.agentId)
            if (!descriptor) {
                continue
            }
            const modelIds = [
                ...(descriptor.capabilities.models ?? []),
                ...(snapshot.capabilities.models ?? []).map((model) => model.id)
            ]
            firstById.set(snapshot.agentId, AgentDescriptorSchema.parse({
                ...descriptor,
                capabilities: {
                    ...descriptor.capabilities,
                    models: Array.from(new Set(modelIds))
                }
            }))
        }
        return Array.from(firstById.values())
    }

    getAgentDescriptor(agentId: string): AgentDescriptor | null {
        return this.getAgentDescriptors().find((descriptor) => descriptor.id === agentId) ?? null
    }

    getAgentAdapterFactory(agentId: string): AgentBackendFactory | null {
        const match = this.collectAgentAdapters().find((entry) => entry.contribution.descriptor.id === agentId)
        return match?.contribution.createBackend ?? null
    }

    getAgentCapabilities(): AgentCapabilityProviderSnapshot[] {
        return this.capabilitySnapshots.map((snapshot) => AgentCapabilityProviderSnapshotSchema.parse(snapshot))
    }

    async importAgentHistory(args: { agentId: string; nativeSessionId: string; providerId?: string }): Promise<AgentHistoryImportResult> {
        const providers = this.collectAgentCapabilityProviders()
            .filter((entry) => entry.contribution.agentId === args.agentId)
            .filter((entry) => this.getPluginOwnedAgentDescriptor(entry.contribution.agentId, entry.pluginId))
            .filter((entry) => !args.providerId || entry.id === args.providerId)
            .filter((entry) => typeof entry.contribution.importHistory === 'function')
        if (providers.length === 0) {
            throw new Error(`No history importer is active for agent ${args.agentId}.`)
        }

        const provider = providers[0]
        try {
            const raw = await withTimeout(
                provider.contribution.importHistory!({
                    machineId: this.options.machineId,
                    agentId: args.agentId,
                    nativeSessionId: args.nativeSessionId
                }),
                DEFAULT_CAPABILITY_PROVIDER_TIMEOUT_MS,
                `${provider.pluginId}:${provider.id} history importer`
            )
            const parsed = AgentHistoryImportResultSchema.safeParse(raw)
            if (!parsed.success) {
                throw new Error(`history importer returned invalid messages: ${describeZodError(parsed.error)}`)
            }
            return parsed.data
        } catch (error) {
            this.recordCapabilityDiagnostics([{
                pluginId: provider.pluginId,
                severity: 'warning',
                code: 'agent-history-import-failed',
                message: `[runner-plugin:${this.options.machineId}:${provider.pluginId}] ${provider.id} history importer failed: ${errorMessage(error)}`
            }])
            throw error
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
        state.enabled[record.manifest.id] = config
            ? { ...setPluginScopedConfig(previous, runnerPluginConfigScope(this.options.machineId, record.manifest.id), config), enabled: true }
            : { ...previous, enabled: true }
        await writePluginState(getPluginStateFile(this.options.hapiHome), state)
        return shouldReload ? await this.reload(record.manifest.id, 'state-change') : this.currentNoopResult(record.manifest.id)
    }

    async disablePlugin(id: string, shouldReload = true): Promise<PluginReloadResult> {
        const state = await this.readWritableState()
        const record = await this.findDiscoveredRecord(id)
        const pluginId = record?.manifest?.id ?? id
        const previous = state.enabled[pluginId]
        state.enabled[pluginId] = {
            ...previous,
            enabled: false,
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
        state.enabled[record.manifest.id] = setPluginScopedConfig(previous, runnerPluginConfigScope(this.options.machineId, record.manifest.id), config)
        await writePluginState(getPluginStateFile(this.options.hapiHome), state)
        return shouldReload ? await this.reload(record.manifest.id, 'state-change') : this.currentNoopResult(record.manifest.id)
    }

    async installLocalPlugin(options: PluginInstallLocalRequest): Promise<PluginInstallResult> {
        const install = await installPluginFromDirectory({
            hapiHome: this.options.hapiHome,
            sourcePath: options.sourcePath,
            overwrite: options.overwrite === true
        })
        const pluginId = install.record.manifest!.id
        await this.recordInstallState(pluginId, {
            sourceType: 'runner-local-path',
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
                return { success: false, path: resolvedPath, error: `Path is not a directory: ${resolvedPath}` }
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
            return { success: false, path: resolvedPath, error: error instanceof Error ? error.message : String(error) }
        }
    }

    installPrepareUnsupported(): RunnerPluginUnsupportedInstallResult {
        return {
            ok: false,
            code: 'unsupported-runtime',
            message: 'Legacy prepare/commit install RPC is not supported. Use runner.plugins.install-local or runner.plugins.install-package for target-scoped installs.'
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
        const discovered = await this.discoverPluginRecords()
        const records = this.applyScopedRuntimeConfig(applyPluginState(discovered, stateResult.state, stateResult.failClosed), stateResult.state)

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

        const capabilityResult = await this.collectAgentCapabilitySnapshots()
        managerDiagnostics.push(...capabilityResult.diagnostics)
        this.capabilitySnapshots = capabilityResult.snapshots
        this.records = records
        this.managerDiagnostics = managerDiagnostics
        this.lastInventoryUpdatedAt = Date.now()
        return { records, items }
    }

    private applyScopedRuntimeConfig(records: DiscoveredPluginRecord[], state: PluginStateFile): DiscoveredPluginRecord[] {
        return records.map((record) => {
            if (!record.manifest || record.status === 'blocked') {
                return record
            }
            const resolved = resolvePluginScopedConfig(state.enabled[record.manifest.id], runnerPluginConfigScope(this.options.machineId, record.manifest.id))
            const baseRecord = { ...record }
            delete baseRecord.config
            delete baseRecord.configUpdatedAt
            delete baseRecord.configSource
            return {
                ...baseRecord,
                ...(resolved.config ? { config: resolved.config } : {}),
                ...(resolved.updatedAt ? { configUpdatedAt: resolved.updatedAt } : {}),
                configSource: resolved.source
            }
        })
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
        const discovered = await this.discoverPluginRecords()
        return discovered.find((record) => pluginDisplayId(record) === id || record.manifest?.id === id) ?? null
    }

    private async discoverPluginRecords(): Promise<DiscoveredPluginRecord[]> {
        const bundledDisabled = (this.options.env ?? process.env).HAPI_DISABLE_BUNDLED_EXAMPLE_PLUGINS === '1'
        const bundledPluginDirs = this.options.includeBundledExamples && !bundledDisabled
            ? [await prepareBundledExamplePlugins(this.options.hapiHome)]
            : undefined
        return await discoverPlugins({
            hapiHome: this.options.hapiHome,
            envPluginDirs: this.options.envPluginDirs ?? this.options.env?.HAPI_PLUGIN_DIRS,
            bundledPluginDirs
        })
    }

    private async readWritableState(): Promise<PluginStateFile> {
        const stateResult = await readPluginState(getPluginStateFile(this.options.hapiHome))
        if (stateResult.parseError) {
            throw new Error(`Cannot update plugins.json while it is invalid: ${stateResult.parseError}`)
        }
        return stateResult.state
    }

    private async recordInstallState(pluginId: string, metadata: Omit<PluginInstallMetadata, 'installedAt' | 'updatedAt'>, enable: boolean): Promise<void> {
        const state = await this.readWritableState()
        const previous = state.enabled[pluginId]
        const now = Date.now()
        state.enabled[pluginId] = {
            enabled: enable ? true : previous?.enabled === true,
            ...(previous?.config ? { config: previous.config } : {}),
            ...(previous?.configUpdatedAt ? { configUpdatedAt: previous.configUpdatedAt } : {}),
            ...(previous?.scopedConfig ? { scopedConfig: previous.scopedConfig } : {}),
            install: {
                ...metadata,
                installedAt: previous?.install?.installedAt ?? now,
                updatedAt: now
            }
        }
        await writePluginState(getPluginStateFile(this.options.hapiHome), state)
    }

    private async buildInstallResult(options: {
        action: 'installed' | 'overwritten'
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
            target: this.targetSummary(),
            diagnostics: options.diagnostics ?? plugin?.diagnostics ?? [],
            ...(reloadResult ? { reload: reloadResult } : {}),
            plugins: this.listPlugins()
        }
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

    private recordCapabilityDiagnostics(diagnostics: PluginDiagnosticView[]): void {
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

    private async collectAgentCapabilitySnapshots(): Promise<{
        snapshots: AgentCapabilityProviderSnapshot[]
        diagnostics: PluginDiagnosticView[]
    }> {
        const snapshots: AgentCapabilityProviderSnapshot[] = []
        const diagnostics: PluginDiagnosticView[] = []

        for (const entry of this.collectAgentCapabilityProviders()) {
            const label = `${entry.pluginId}:${entry.id}`
            const ownedDescriptor = this.getPluginOwnedAgentDescriptor(entry.contribution.agentId, entry.pluginId)
            if (!ownedDescriptor) {
                diagnostics.push({
                    pluginId: entry.pluginId,
                    severity: 'warning',
                    code: 'agent-capability-provider-agent-not-owned',
                    message: `[runner-plugin:${this.options.machineId}:${entry.pluginId}] ${label} targets agent ${entry.contribution.agentId}, but providers can only target agent adapters from the same plugin.`
                })
                continue
            }

            if (!entry.contribution.provide) {
                continue
            }

            const updatedAt = Date.now()
            try {
                const raw = await withTimeout(
                    entry.contribution.provide({
                        machineId: this.options.machineId,
                        agentId: entry.contribution.agentId
                    }),
                    DEFAULT_CAPABILITY_PROVIDER_TIMEOUT_MS,
                    `${label} capability provider`
                )
                const parsed = AgentCapabilityProviderResultSchema.safeParse(raw)
                if (!parsed.success) {
                    throw new Error(`capability provider returned invalid descriptors: ${describeZodError(parsed.error)}`)
                }

                const sanitized = this.sanitizeCapabilityProviderResult(entry, parsed.data, ownedDescriptor, diagnostics)
                const providerDiagnostics = sanitized.diagnostics ?? []
                snapshots.push(AgentCapabilityProviderSnapshotSchema.parse({
                    agentId: entry.contribution.agentId,
                    pluginId: entry.pluginId,
                    contributionId: entry.id,
                    updatedAt,
                    capabilities: sanitized,
                    diagnostics: providerDiagnostics
                }))
                diagnostics.push(...providerDiagnostics.map((diagnostic) => ({
                    pluginId: entry.pluginId,
                    severity: diagnostic.severity,
                    code: diagnostic.code,
                    message: `[runner-plugin:${this.options.machineId}:${entry.pluginId}] ${diagnostic.message}`,
                    ...(diagnostic.path ? { path: diagnostic.path } : {})
                })))
            } catch (error) {
                const diagnostic = {
                    pluginId: entry.pluginId,
                    severity: 'warning' as const,
                    code: 'agent-capability-provider-failed',
                    message: `[runner-plugin:${this.options.machineId}:${entry.pluginId}] ${label} capability provider failed: ${errorMessage(error)}`
                }
                diagnostics.push(diagnostic)
                snapshots.push(AgentCapabilityProviderSnapshotSchema.parse({
                    agentId: entry.contribution.agentId,
                    pluginId: entry.pluginId,
                    contributionId: entry.id,
                    updatedAt,
                    capabilities: {},
                    diagnostics: [{ severity: diagnostic.severity, code: diagnostic.code, message: diagnostic.message }]
                }))
            }
        }

        return { snapshots, diagnostics }
    }

    private getPluginOwnedAgentDescriptor(agentId: string, pluginId: string): AgentDescriptor | null {
        const adapter = this.collectAgentAdapters().find((entry) =>
            entry.pluginId === pluginId && entry.contribution.descriptor.id === agentId
        )
        return adapter ? AgentDescriptorSchema.parse({
            ...adapter.contribution.descriptor,
            source: 'plugin',
            pluginId,
            available: true
        }) : null
    }

    private sanitizeCapabilityProviderResult(
        entry: RegisteredRunnerContribution<RunnerAgentCapabilityProviderContribution>,
        result: AgentCapabilityProviderResult,
        ownerDescriptor: AgentDescriptor,
        diagnostics: PluginDiagnosticView[]
    ): AgentCapabilityProviderResult {
        const providerDiagnostics = [...(result.diagnostics ?? [])]
        const addDiagnostic = (code: string, message: string) => {
            const diagnostic = {
                severity: 'warning' as const,
                code,
                message
            }
            providerDiagnostics.push(diagnostic)
            diagnostics.push({
                pluginId: entry.pluginId,
                ...diagnostic,
                message: `[runner-plugin:${this.options.machineId}:${entry.pluginId}] ${message}`
            })
        }

        const allowedModes = new Set(ownerDescriptor.capabilities.permissionModes)
        const permissionModes = (result.permissionModes ?? []).filter((permissionMode) => {
            if (!allowedModes.has(permissionMode.mode)) {
                addDiagnostic(
                    'agent-capability-provider-permission-mode-not-owned',
                    `${entry.id} declared permission mode ${permissionMode.mode}, but the agent adapter descriptor does not allow it.`
                )
                return false
            }
            if ((permissionMode.mode === 'yolo' || permissionMode.mode === 'bypassPermissions') && permissionMode.risk !== 'danger') {
                addDiagnostic(
                    'agent-capability-provider-permission-mode-risk-missing',
                    `${entry.id} declared dangerous permission mode ${permissionMode.mode} without risk: danger.`
                )
                return false
            }
            return true
        })

        const usage = (result.usage ?? []).filter((usageEntry) => {
            if (usageEntry.scope === 'session' || usageEntry.sessionId) {
                addDiagnostic(
                    'agent-capability-provider-session-usage-rejected',
                    `${entry.id} returned session-scoped usage without a core session authorization context.`
                )
                return false
            }
            return true
        })

        return AgentCapabilityProviderResultSchema.parse({
            ...result,
            ...(permissionModes.length > 0 ? { permissionModes } : { permissionModes: undefined }),
            ...(usage.length > 0 ? { usage } : { usage: undefined }),
            diagnostics: providerDiagnostics
        })
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

    private collectAgentAdapters(): RegisteredRunnerContribution<RunnerAgentAdapterContribution>[] {
        return this.collectRegistryContributions((registry) => registry.getAgentAdapters())
            .filter((entry) => !BUILTIN_AGENT_IDS.has(entry.contribution.descriptor.id))
            .sort(runtimeContributionSort)
    }

    private collectAgentCapabilityProviders(): RegisteredRunnerContribution<RunnerAgentCapabilityProviderContribution>[] {
        return this.collectRegistryContributions((registry) => registry.getAgentCapabilityProviders())
            .sort(runtimeContributionSort)
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

    private collectContributionSummaries(type: RunnerExtensionRuntimeContributionType) {
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

    private collectWebContributions(): PluginWebContributionView[] {
        return this.records
            .filter((record) => record.enabled === true && record.manifest?.contributions?.web)
            .map((record) => ({
                pluginId: record.manifest!.id,
                pluginName: record.manifest!.name,
                target: this.targetSummary().scope,
                contributions: record.manifest!.contributions!.web!
            }))
    }


    private toListItem(record: DiscoveredPluginRecord): PluginListItem {
        const id = pluginDisplayId(record)
        const active = record.manifest && record.status !== 'blocked' ? this.activePlugins.has(record.manifest.id) : false
        const activeInstance = record.manifest ? this.activePlugins.get(record.manifest.id) : undefined
        const configScope = record.manifest && record.status !== 'blocked' ? runnerPluginConfigScope(this.options.machineId, record.manifest.id) : undefined
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
                ...this.missingSecretDiagnostics(record),
                ...(activeInstance?.registry.diagnostics.map((entry) => diagnosticView(id, entry)) ?? []),
                ...this.managerDiagnostics.filter((entry) => entry.pluginId === id)
            ],
            target: this.targetSummary(),
            ...(configScope ? { configScope } : {}),
            install: record.install ?? { sourceType: record.source, version: record.manifest?.version },
            ...(activeInstance ? { updatedAt: activeInstance.loadedAt } : {})
        }
    }

    private toDetail(record: DiscoveredPluginRecord): PluginDetail {
        const item = this.toListItem(record)
        const declaredSecrets = record.manifest?.permissions?.secrets ?? []
        const activeInstance = record.manifest ? this.activePlugins.get(record.manifest.id) : undefined
        const sanitizedConfig = sanitizePluginConfigForView(record.config, declaredSecrets)
        const configScope = record.manifest && record.status !== 'blocked' ? runnerPluginConfigScope(this.options.machineId, record.manifest.id) : undefined
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
        const activeAgentContributions = activeInstance ? {
            adapters: activeInstance.registry.getAgentAdapters().map((entry) => ({
                id: entry.id,
                pluginId: entry.pluginId,
                priority: entry.priority,
                active: true
            })),
            capabilityProviders: activeInstance.registry.getAgentCapabilityProviders().map((entry) => ({
                id: entry.id,
                agentId: entry.contribution.agentId,
                pluginId: entry.pluginId,
                priority: entry.priority,
                active: true
            }))
        } : undefined
        const manifestRunnerContributions = record.manifest?.contributions?.runner
        const manifestAgentContributions = record.manifest?.contributions?.agent
        return {
            ...item,
            manifest: record.manifest,
            config: sanitizedConfig,
            ...(configScope && record.manifest ? {
                configMetadata: {
                    scope: configScope,
                    pluginId: record.manifest.id,
                    runtime: 'runner',
                    target: this.targetSummary(),
                    config: sanitizedConfig ?? {},
                    ...(record.configUpdatedAt ? { updatedAt: record.configUpdatedAt } : {}),
                    source: record.configSource ?? 'empty'
                }
            } : {}),
            permissions: {
                network: record.manifest?.permissions?.network ?? [],
                secrets: this.secretStatuses(record)
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
                ...(manifestAgentContributions || activeAgentContributions ? {
                    agent: {
                        ...(manifestAgentContributions ?? {}),
                        ...(activeAgentContributions ? {
                            adapters: [
                                ...(manifestAgentContributions?.adapters ?? []),
                                ...activeAgentContributions.adapters
                            ],
                            capabilityProviders: [
                                ...(manifestAgentContributions?.capabilityProviders ?? []),
                                ...activeAgentContributions.capabilityProviders
                            ]
                        } : {})
                    }
                } : {}),
                ...(record.manifest?.contributions?.voice ? { voice: record.manifest.contributions.voice } : {}),
                ...(record.manifest?.contributions?.deployment ? { deployment: record.manifest.contributions.deployment } : {}),
                ...(record.manifest?.contributions?.integration ? { integration: record.manifest.contributions.integration } : {}),
                ...(record.manifest?.contributions?.web ? { web: record.manifest.contributions.web } : {})
            },
            runtimeEntryPaths: record.runtimeEntryPaths
        }
    }

    private secretStatuses(record: DiscoveredPluginRecord) {
        const target = this.targetSummary()
        const pluginId = record.manifest?.id
        const configScope = pluginId ? runnerPluginConfigScope(this.options.machineId, pluginId) : undefined
        return (record.manifest?.permissions?.secrets ?? []).map((name) => ({
            name,
            present: Boolean((this.options.env ?? process.env)[name]),
            required: true,
            lastChecked: Date.now(),
            target,
            ...(configScope ? { configScope } : {})
        }))
    }

    private missingSecretDiagnostics(record: DiscoveredPluginRecord): PluginDiagnosticView[] {
        if (!record.manifest || record.enabled !== true) {
            return []
        }
        const target = this.targetSummary()
        const configScope = runnerPluginConfigScope(this.options.machineId, record.manifest.id)
        return (record.manifest.permissions?.secrets ?? [])
            .filter((name) => !((this.options.env ?? process.env)[name]))
            .map((name) => ({
                pluginId: record.manifest!.id,
                severity: 'warning' as const,
                code: 'plugin-secret-missing',
                message: `Missing required secret ${name} for ${target.scope}. Set it in the Runner runtime environment.`,
                target,
                configScope
            }))
    }
}
