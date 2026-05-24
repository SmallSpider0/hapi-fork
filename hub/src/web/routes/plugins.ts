import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import {
    parseRunnerPluginTargetScope,
    PluginHostInfoSchema,
    PluginCapabilitiesResponseSchema,
    PluginConfigUpdateRequestSchema,
    PluginDeleteResultSchema,
    PluginDisableRequestSchema,
    PluginEnableRequestSchema,
    PluginDetailResponseSchema,
    PluginDiagnosticsResponseSchema,
    PluginInstallLocalRequestSchema,
    PluginInstallPackageRequestSchema,
    PluginInstallPlanRequestSchema,
    PluginInstallPlanResponseSchema,
    PluginInstallResultSchema,
    PluginLocalDirectoryListRequestSchema,
    PluginLocalDirectoryListResponseSchema,
    PluginListResponseSchema,
    PluginNotificationFilterOptionsResponseSchema,
    PluginReloadResultSchema,
    PluginTargetScopeSchema,
    type PluginDeleteResult,
    type PluginDetail,
    type PluginInstallPackageRequest,
    type PluginInstallResult,
    type PluginInstallPlanRequest,
    type PluginInstallPlanResponse,
    type PluginListItem,
    type PluginNotificationFilterOption,
    type PluginReloadResult,
    type PluginCapabilityPartStatus,
    type PluginCapabilityView,
    type PluginHostInfo,
    type PluginTargetActionResult,
    type PluginTargetInventory,
    type PluginTargetScope,
    type PluginTargetSummary,
    type RunnerPluginInventory
} from '@hapi/protocol/plugins/admin'
import {
    PluginMarketplaceDetailResponseSchema,
    PluginMarketplaceInstallPlanResponseSchema,
    PluginMarketplaceInstallRequestSchema,
    PluginMarketplaceListResponseSchema,
    type PluginMarketplaceEntry,
    type PluginMarketplaceEntryView
} from '@hapi/protocol/plugins/marketplace'
import { HAPI_PLUGIN_API_VERSION } from '@hapi/protocol/plugins'
import { PluginInstallError, PluginStateLockError, inspectPluginPackagePayload, validatePluginPackagePayload } from '@hapi/protocol/plugins/foundation'
import { buildPluginInstallPlan, type PluginInstallTargetCandidate } from '../../plugins/installPlanner'
import { PluginMarketplaceService, compareMarketplaceVersions } from '../../plugins/marketplaceService'
import type { HubPluginManager } from '../../plugins/pluginManager'
import { getAgentName } from '../../notifications/sessionInfo'
import type { Machine, Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import packageJson from '../../../../cli/package.json'

function errorStatus(error: unknown): 400 | 404 | 409 | 500 {
    if (error instanceof PluginStateLockError) {
        return 409
    }
    if (error instanceof PluginInstallError) {
        return error.code === 'plugin-install-target-exists' ? 409 : 400
    }
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('was not found')) {
        return 404
    }
    if (message.includes('plugins.json') || message.includes('must not store declared secret') || message.includes('secret-like field') || message.includes('redacted placeholder')) {
        return 409
    }
    if (message.includes('cannot be deleted')) {
        return 400
    }
    return 500
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function requirePluginManager(c: Context<WebAppEnv>, getPluginManager: () => HubPluginManager | null): HubPluginManager | Response {
    const manager = getPluginManager()
    if (!manager) {
        return c.json({ error: 'Plugin manager is not ready' }, 503)
    }
    return manager
}

function requireSyncEngine(c: Context<WebAppEnv>, getSyncEngine: () => SyncEngine | null): SyncEngine | Response {
    const engine = getSyncEngine()
    if (!engine) {
        return c.json({ error: 'Runner plugin targets are not connected' }, 503)
    }
    return engine
}

function requireMarketplaceService(c: Context<WebAppEnv>, getMarketplaceService: () => PluginMarketplaceService | null): PluginMarketplaceService | Response {
    const service = getMarketplaceService()
    if (!service) {
        return c.json({ error: 'Plugin marketplace is not ready' }, 503)
    }
    return service
}

function parseTarget(c: Context<WebAppEnv>): PluginTargetScope | null | Response {
    const raw = c.req.query('target')
    if (!raw) return null
    const parsed = PluginTargetScopeSchema.safeParse(raw)
    if (!parsed.success) {
        return c.json({ error: 'Invalid plugin target scope', issues: parsed.error.flatten() }, 400)
    }
    return parsed.data
}

function parseOptionalSessionId(c: Context<WebAppEnv>): string | null | Response {
    const raw = c.req.query('sessionId')
    if (raw === undefined) return null
    const sessionId = raw.trim()
    if (!sessionId) {
        return c.json({ error: 'Invalid sessionId' }, 400)
    }
    return sessionId
}

const HUB_SUPPORTED_EXTENSION_POINTS = [
    'hub.notificationChannel',
    'hub.messageAction',
    'hub.action',
    'web.settingsPanel',
    'web.newSessionField',
    'web.action',
    'web.badge',
    'web.composerAction'
]

function hubHostInfo(): PluginHostInfo {
    return PluginHostInfoSchema.parse({
        runtime: 'hub',
        hapiVersion: packageJson.version,
        pluginApiVersion: HAPI_PLUGIN_API_VERSION,
        os: process.platform,
        arch: process.arch,
        supportedExtensionPoints: HUB_SUPPORTED_EXTENSION_POINTS
    })
}

function hubTargetSummary(): PluginTargetSummary {
    return {
        scope: 'hub',
        runtime: 'hub',
        active: true,
        stale: false,
        displayName: 'Hub',
        updatedAt: Date.now(),
        hostInfo: hubHostInfo()
    }
}

function machineDisplayName(machine: Machine): string {
    return machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id
}

function runnerTargetSummary(machine: Machine, inventory?: RunnerPluginInventory, error?: string): PluginTargetSummary {
    return {
        scope: `runner:${machine.id}`,
        runtime: 'runner',
        machineId: machine.id,
        displayName: machineDisplayName(machine),
        active: machine.active,
        stale: !machine.active || Boolean(error),
        ...(inventory?.updatedAt ? { updatedAt: inventory.updatedAt } : {}),
        ...(inventory?.hostInfo ? { hostInfo: inventory.hostInfo } : {}),
        ...(error ? { error } : {})
    }
}

function withTarget(plugin: PluginListItem, target: PluginTargetSummary): PluginListItem {
    if (target.runtime !== 'runner' || target.active) {
        return { ...plugin, target }
    }
    return {
        ...plugin,
        target,
        active: false,
        runtimes: {
            ...plugin.runtimes,
            ...(plugin.runtimes.runner ? { runner: { ...plugin.runtimes.runner, active: false } } : {})
        }
    }
}

function aggregateCapabilityStatus(parts: PluginCapabilityView['parts']): PluginCapabilityView['status'] {
    const required = Object.values(parts).filter((part): part is PluginCapabilityPartStatus => Boolean(part) && part.required !== false)
    if (required.length === 0) {
        return 'ready'
    }
    const priority: PluginCapabilityView['status'][] = ['disabled', 'failed', 'incompatible', 'offline', 'missing-target', 'partial']
    for (const status of priority) {
        if (required.some((part) => part.status === status)) {
            return status
        }
    }
    return required.every((part) => part.status === 'ready') ? 'ready' : 'partial'
}

function betterCapabilityPart(left: PluginCapabilityPartStatus | undefined, right: PluginCapabilityPartStatus | undefined): PluginCapabilityPartStatus | undefined {
    if (!left) return right
    if (!right) return left
    if (left.status === 'missing-target' && right.status !== 'missing-target') return right
    if (left.status !== 'ready' && right.status === 'ready') return right
    if (left.active !== true && right.active === true) return right
    return left
}

function mergeWebContributions(left: PluginCapabilityView['web'], right: PluginCapabilityView['web']): PluginCapabilityView['web'] {
    if (!left) return right
    if (!right) return left
    return {
        ...(left.settingsPanels || right.settingsPanels ? { settingsPanels: [...(left.settingsPanels ?? []), ...(right.settingsPanels ?? [])] } : {}),
        ...(left.newSessionFields || right.newSessionFields ? { newSessionFields: [...(left.newSessionFields ?? []), ...(right.newSessionFields ?? [])] } : {}),
        ...(left.actions || right.actions ? { actions: [...(left.actions ?? []), ...(right.actions ?? [])] } : {}),
        ...(left.badges || right.badges ? { badges: [...(left.badges ?? []), ...(right.badges ?? [])] } : {}),
        ...(left.composerActions || right.composerActions ? { composerActions: [...(left.composerActions ?? []), ...(right.composerActions ?? [])] } : {})
    }
}

function mergeCapabilityViews(views: PluginCapabilityView[]): PluginCapabilityView[] {
    const byKey = new Map<string, PluginCapabilityView>()
    for (const view of views) {
        const key = `${view.pluginId}:${view.capabilityId}`
        const existing = byKey.get(key)
        if (!existing) {
            byKey.set(key, view)
            continue
        }
        const parts = {
            web: betterCapabilityPart(existing.parts.web, view.parts.web),
            hub: betterCapabilityPart(existing.parts.hub, view.parts.hub),
            runner: betterCapabilityPart(existing.parts.runner, view.parts.runner)
        }
        byKey.set(key, {
            ...existing,
            pluginName: existing.pluginName ?? view.pluginName,
            pluginVersion: existing.pluginVersion ?? view.pluginVersion,
            displayName: existing.displayName ?? view.displayName,
            description: existing.description ?? view.description,
            status: aggregateCapabilityStatus(parts),
            target: undefined,
            parts,
            web: mergeWebContributions(existing.web, view.web),
            diagnostics: [...existing.diagnostics, ...view.diagnostics]
        })
    }
    return Array.from(byKey.values())
}

function withCapabilityTarget(capability: PluginCapabilityView, target: PluginTargetSummary): PluginCapabilityView {
    const runnerPart = capability.parts.runner
    const nextRunnerPart = runnerPart
        ? {
            ...runnerPart,
            target,
            ...(target.runtime === 'runner' && (!target.active || target.error) ? {
                status: 'offline' as const,
                active: false
            } : {})
        }
        : undefined
    const parts = {
        ...capability.parts,
        ...(nextRunnerPart ? { runner: nextRunnerPart } : {})
    }
    return {
        ...capability,
        target,
        parts,
        status: aggregateCapabilityStatus(parts)
    }
}

function hubInventory(manager: HubPluginManager): PluginTargetInventory {
    const target = hubTargetSummary()
    return {
        target,
        plugins: manager.listPlugins().map((plugin) => withTarget(plugin, target)),
        webContributions: typeof manager.collectWebContributions === 'function'
            ? manager.collectWebContributions()
            : [],
        contributionStates: typeof manager.collectContributionStates === 'function'
            ? manager.collectContributionStates()
            : [],
        capabilities: typeof manager.collectCapabilities === 'function'
            ? manager.collectCapabilities()
            : []
    }
}

function cachedRunnerInventory(machine: Machine, error?: string): PluginTargetInventory {
    const inventory = machine.runnerState?.pluginInventory
    const target = runnerTargetSummary(machine, inventory, error ?? (inventory ? undefined : 'No Runner plugin inventory has been reported yet.'))
    return {
        target,
        plugins: (inventory?.plugins ?? []).map((plugin) => withTarget(plugin, target)),
        ...(inventory?.webContributions ? { webContributions: inventory.webContributions } : {}),
        ...(inventory?.contributionStates ? { contributionStates: inventory.contributionStates } : {}),
        ...(inventory?.capabilities ? { capabilities: inventory.capabilities.map((capability) => withCapabilityTarget(capability, target)) } : {}),
        ...(target.error ? { error: target.error } : {})
    }
}

function freshRunnerInventory(machine: Machine, inventory: RunnerPluginInventory): PluginTargetInventory {
    const target = runnerTargetSummary(machine, inventory)
    return {
        target,
        plugins: inventory.plugins.map((plugin) => withTarget(plugin, target)),
        webContributions: inventory.webContributions,
        contributionStates: inventory.contributionStates,
        capabilities: inventory.capabilities?.map((capability) => withCapabilityTarget(capability, target))
    }
}

async function loadRunnerInventory(engine: SyncEngine, machine: Machine): Promise<PluginTargetInventory> {
    if (!machine.active) {
        return cachedRunnerInventory(machine, 'Runner is offline; showing stale cached plugin inventory.')
    }
    try {
        return freshRunnerInventory(machine, await engine.listRunnerPlugins(machine.id))
    } catch (error) {
        return cachedRunnerInventory(machine, `Runner plugin RPC failed: ${errorMessage(error)}`)
    }
}

async function buildListPayload(options: {
    manager: HubPluginManager
    engine: SyncEngine | null
    namespace: string
    target: PluginTargetScope | null
}): Promise<{ payload?: unknown; response?: Response }> {
    const { manager, engine, namespace, target } = options
    if (target === 'hub') {
        const inventory = hubInventory(manager)
        return { payload: PluginListResponseSchema.parse({ plugins: inventory.plugins, targets: [inventory] }) }
    }

    const runnerMachineId = target ? parseRunnerPluginTargetScope(target) : null
    if (runnerMachineId) {
        if (!engine) {
            return { payload: PluginListResponseSchema.parse({ plugins: [], targets: [] }) }
        }
        const machine = engine.getMachineByNamespace(runnerMachineId, namespace)
        if (!machine) {
            return { payload: { error: 'Runner target not found' } }
        }
        const inventory = await loadRunnerInventory(engine, machine)
        return { payload: PluginListResponseSchema.parse({ plugins: inventory.plugins, targets: [inventory] }) }
    }

    const targets: PluginTargetInventory[] = []
    if (!target) {
        targets.push(hubInventory(manager))
    }

    if (engine) {
        const machines = engine.getMachinesByNamespace(namespace)
        const runnerInventories = await Promise.all(machines.map((machine) => loadRunnerInventory(engine, machine)))
        targets.push(...runnerInventories)
    }

    const plugins = targets.flatMap((entry) => entry.plugins)
    return { payload: PluginListResponseSchema.parse({ plugins, targets }) }
}

function fallbackDetailFromListItem(item: PluginListItem): PluginDetail {
    return {
        ...item,
        permissions: { network: [], secrets: [] },
        contributions: { notificationChannels: [] },
        runtimeEntryPaths: []
    }
}

async function getRunnerDetail(engine: SyncEngine, namespace: string, target: PluginTargetScope, pluginId: string): Promise<PluginDetail | Response> {
    const machineId = parseRunnerPluginTargetScope(target)
    if (!machineId) throw new Error('Runner target expected')
    const machine = engine.getMachineByNamespace(machineId, namespace)
    if (!machine) {
        return new Response(JSON.stringify({ error: 'Runner target not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    }
    if (machine.active) {
        try {
            return (await engine.inspectRunnerPlugin(machine.id, pluginId)).plugin
        } catch (error) {
            // fall through to stale cache if possible
        }
    }
    const inventory = cachedRunnerInventory(machine, machine.active ? 'Runner plugin RPC failed; showing cached detail.' : 'Runner is offline; showing stale cached plugin detail.')
    const item = inventory.plugins.find((plugin) => plugin.id === pluginId)
    if (!item) {
        return new Response(JSON.stringify({ error: 'Plugin not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    }
    return fallbackDetailFromListItem(item)
}

async function runRunnerReloadAction(options: {
    engine: SyncEngine
    namespace: string
    target: PluginTargetScope
    pluginId?: string
    action: (machineId: string) => Promise<PluginReloadResult>
}): Promise<PluginReloadResult | Response> {
    const { engine, namespace, target, action } = options
    const runnerMachineId = parseRunnerPluginTargetScope(target)
    if (runnerMachineId) {
        const machine = engine.getMachineByNamespace(runnerMachineId, namespace)
        if (!machine) return new Response(JSON.stringify({ error: 'Runner target not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
        if (!machine.active) return new Response(JSON.stringify({ error: 'Runner target is offline' }), { status: 503, headers: { 'content-type': 'application/json' } })
        return await action(machine.id)
    }

    if (target !== 'all-runners') {
        throw new Error('Runner target expected')
    }

    const machines = engine.getMachinesByNamespace(namespace)
    const targetResults: PluginTargetActionResult[] = []
    const results: PluginReloadResult['results'] = []
    const plugins: PluginListItem[] = []

    for (const machine of machines) {
        const cached = cachedRunnerInventory(machine)
        if (!machine.active) {
            targetResults.push({ target: cached.target, ok: false, error: 'Runner target is offline', plugins: cached.plugins })
            plugins.push(...cached.plugins)
            continue
        }
        try {
            const result = await action(machine.id)
            const targetSummary = runnerTargetSummary(machine, machine.runnerState?.pluginInventory)
            targetResults.push({ target: result.target ?? targetSummary, ok: result.ok, results: result.results, plugins: result.plugins })
            results.push(...result.results)
            plugins.push(...result.plugins.map((plugin) => withTarget(plugin, result.target ?? targetSummary)))
        } catch (error) {
            targetResults.push({ target: cached.target, ok: false, error: errorMessage(error), plugins: cached.plugins })
            plugins.push(...cached.plugins)
        }
    }

    return PluginReloadResultSchema.parse({
        ok: targetResults.every((entry) => entry.ok),
        targetResults,
        results,
        plugins
    })
}


async function runRunnerInstallAction(options: {
    engine: SyncEngine
    namespace: string
    target: PluginTargetScope
    action: (machineId: string) => Promise<PluginInstallResult>
}): Promise<PluginInstallResult | Response> {
    const { engine, namespace, target, action } = options
    const runnerMachineId = parseRunnerPluginTargetScope(target)
    if (runnerMachineId) {
        const machine = engine.getMachineByNamespace(runnerMachineId, namespace)
        if (!machine) return new Response(JSON.stringify({ error: 'Runner target not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
        if (!machine.active) return new Response(JSON.stringify({ error: 'Runner target is offline' }), { status: 503, headers: { 'content-type': 'application/json' } })
        const result = await action(machine.id)
        return PluginInstallResultSchema.parse({ ...result, target: result.target ?? runnerTargetSummary(machine, machine.runnerState?.pluginInventory) })
    }

    if (target !== 'all-runners') {
        throw new Error('Runner target expected')
    }

    const machines = engine.getMachinesByNamespace(namespace)
    const targetResults: NonNullable<PluginInstallResult['targetResults']> = []
    const plugins: PluginListItem[] = []

    for (const machine of machines) {
        const cached = cachedRunnerInventory(machine)
        if (!machine.active) {
            targetResults.push({ target: cached.target, ok: false, error: 'Runner target is offline', diagnostics: [], plugins: cached.plugins })
            plugins.push(...cached.plugins)
            continue
        }
        try {
            const result = await action(machine.id)
            const targetSummary = result.target ?? runnerTargetSummary(machine, machine.runnerState?.pluginInventory)
            targetResults.push({
                target: targetSummary,
                ok: result.ok,
                action: result.action,
                pluginId: result.pluginId,
                targetPath: result.targetPath,
                diagnostics: result.diagnostics,
                plugins: result.plugins
            })
            plugins.push(...result.plugins.map((plugin) => withTarget(plugin, targetSummary)))
        } catch (error) {
            targetResults.push({ target: cached.target, ok: false, error: errorMessage(error), diagnostics: [], plugins: cached.plugins })
            plugins.push(...cached.plugins)
        }
    }

    return PluginInstallResultSchema.parse({
        ok: targetResults.every((entry) => entry.ok),
        action: targetResults.find((entry) => entry.action)?.action ?? 'unchanged',
        targetResults,
        diagnostics: [],
        plugins
    })
}

async function runRunnerDeleteAction(options: {
    engine: SyncEngine
    namespace: string
    target: PluginTargetScope
    pluginId: string
    action: (machineId: string) => Promise<PluginDeleteResult>
}): Promise<PluginDeleteResult | Response> {
    const { engine, namespace, target, pluginId, action } = options
    const runnerMachineId = parseRunnerPluginTargetScope(target)
    if (runnerMachineId) {
        const machine = engine.getMachineByNamespace(runnerMachineId, namespace)
        if (!machine) return new Response(JSON.stringify({ error: 'Runner target not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
        if (!machine.active) return new Response(JSON.stringify({ error: 'Runner target is offline' }), { status: 503, headers: { 'content-type': 'application/json' } })
        const result = await action(machine.id)
        return PluginDeleteResultSchema.parse({ ...result, target: result.target ?? runnerTargetSummary(machine, machine.runnerState?.pluginInventory) })
    }

    if (target !== 'all-runners') {
        throw new Error('Runner target expected')
    }

    const machines = engine.getMachinesByNamespace(namespace)
    const targetResults: NonNullable<PluginDeleteResult['targetResults']> = []
    const plugins: PluginListItem[] = []

    for (const machine of machines) {
        const cached = cachedRunnerInventory(machine)
        if (!machine.active) {
            targetResults.push({ target: cached.target, ok: false, error: 'Runner target is offline', pluginId, plugins: cached.plugins })
            plugins.push(...cached.plugins)
            continue
        }
        try {
            const result = await action(machine.id)
            const targetSummary = result.target ?? runnerTargetSummary(machine, machine.runnerState?.pluginInventory)
            targetResults.push({
                target: targetSummary,
                ok: result.ok,
                pluginId: result.pluginId,
                rootPath: result.rootPath,
                deleted: result.deleted,
                plugins: result.plugins
            })
            plugins.push(...result.plugins.map((plugin) => withTarget(plugin, targetSummary)))
        } catch (error) {
            targetResults.push({ target: cached.target, ok: false, error: errorMessage(error), pluginId, plugins: cached.plugins })
            plugins.push(...cached.plugins)
        }
    }

    return PluginDeleteResultSchema.parse({
        ok: targetResults.every((entry) => entry.ok),
        pluginId,
        deleted: targetResults.length > 0 && targetResults.every((entry) => entry.ok && entry.deleted !== false),
        targetResults,
        plugins
    })
}

function requireExplicitInstallTarget(c: Context<WebAppEnv>, target: PluginTargetScope | null): PluginTargetScope | Response {
    if (!target) {
        return c.json({ error: 'Plugin install requires target=hub, target=runner:<machineId>, or target=all-runners.' }, 400)
    }
    return target
}

async function buildInstallTargetCandidates(options: {
    manager: HubPluginManager
    engine: SyncEngine | null
    namespace: string
}): Promise<PluginInstallTargetCandidate[]> {
    const candidates: PluginInstallTargetCandidate[] = []
    const hub = hubInventory(options.manager)
    candidates.push({ target: hub.target, plugins: hub.plugins })

    if (!options.engine) {
        return candidates
    }

    const machines = options.engine.getMachinesByNamespace(options.namespace)
    const runnerInventories = await Promise.all(machines.map((machine) => loadRunnerInventory(options.engine!, machine)))
    candidates.push(...runnerInventories.map((inventory) => ({
        target: inventory.target,
        plugins: inventory.plugins
    })))
    return candidates
}

async function createInstallPlan(options: {
    manager: HubPluginManager
    engine: SyncEngine | null
    namespace: string
    request: PluginInstallPlanRequest
    planId: string
    now: number
    expiresAt?: number
}): Promise<PluginInstallPlanResponse> {
    const inspection = await inspectPluginPackagePayload(options.request)
    const candidates = await buildInstallTargetCandidates({
        manager: options.manager,
        engine: options.engine,
        namespace: options.namespace
    })
    return PluginInstallPlanResponseSchema.parse(buildPluginInstallPlan({
        planId: options.planId,
        now: options.now,
        expiresAt: options.expiresAt,
        manifest: inspection.manifest,
        request: options.request,
        packageFormat: inspection.packageFormat,
        candidates
    }))
}

function installActionFromPlan(action: 'install' | 'overwrite' | 'unchanged'): PluginInstallResult['action'] {
    if (action === 'install') return 'installed'
    if (action === 'overwrite') return 'overwritten'
    return 'unchanged'
}

function isExecutablePlanAction(action: string): action is 'install' | 'overwrite' | 'unchanged' {
    return action === 'install' || action === 'overwrite' || action === 'unchanged'
}

function packageRequestFromPlan(request: PluginInstallPlanRequest): PluginInstallPackageRequest {
    const { runnerSelection: _runnerSelection, dryRun: _dryRun, ...packageRequest } = request
    return packageRequest
}

function marketplaceEntryMatches(entry: PluginMarketplaceEntry, filters: {
    query?: string
    category?: string
    runtime?: string
}): boolean {
    if (filters.category && !(entry.categories ?? []).some((category) => category === filters.category)) {
        return false
    }
    if (filters.runtime && !(entry.runtimes ?? []).some((runtime) => runtime === filters.runtime)) {
        return false
    }
    if (!filters.query) {
        return true
    }
    const query = filters.query.toLowerCase()
    const haystack = [
        entry.id,
        entry.name,
        entry.description ?? '',
        entry.repo,
        ...(entry.keywords ?? [])
    ].join('\n').toLowerCase()
    return haystack.includes(query)
}

function latestMarketplaceVersion(entry: PluginMarketplaceEntry): string | undefined {
    return [...entry.releases]
        .filter((release) => !release.yanked)
        .sort((left, right) => compareMarketplaceVersions(right.version, left.version))[0]?.version
}

function marketplaceEntriesWithInstallState(entries: PluginMarketplaceEntry[], plugins: PluginListItem[]): PluginMarketplaceEntryView[] {
    const installedById = new Map<string, PluginListItem[]>()
    for (const plugin of plugins) {
        const existing = installedById.get(plugin.id) ?? []
        existing.push(plugin)
        installedById.set(plugin.id, existing)
    }
    return entries.map((entry) => {
        const installedPlugins = installedById.get(entry.id) ?? []
        if (installedPlugins.length === 0) return entry
        const installedVersions = Array.from(new Set(installedPlugins.map((plugin) => plugin.version).filter((version): version is string => Boolean(version))))
        const latestVersion = latestMarketplaceVersion(entry)
        return {
            ...entry,
            installed: {
                ...(installedVersions.length > 0 ? { version: installedVersions.join(' + ') } : {}),
                enabled: installedPlugins.some((plugin) => plugin.enabled),
                yanked: installedVersions.some((version) => entry.releases.find((candidate) => candidate.version === version)?.yanked !== undefined),
                updateAvailable: installedVersions.some((version) => Boolean(latestVersion && compareMarketplaceVersions(latestVersion, version) > 0))
            }
        }
    })
}

type NotificationFilterOptionDraft = {
    value: string
    count: number
    lastSeenAt: number
}

function sessionLastSeenAt(session: Session): number {
    return Math.max(session.updatedAt ?? 0, session.activeAt ?? 0, session.createdAt ?? 0)
}

function addNotificationFilterOption(map: Map<string, NotificationFilterOptionDraft>, rawValue: unknown, lastSeenAt: number): void {
    if (typeof rawValue !== 'string') return
    const value = rawValue.trim()
    if (!value) return
    const existing = map.get(value)
    if (!existing) {
        map.set(value, { value, count: 1, lastSeenAt })
        return
    }
    existing.count += 1
    existing.lastSeenAt = Math.max(existing.lastSeenAt, lastSeenAt)
}

function ensureNotificationFilterOption(map: Map<string, NotificationFilterOptionDraft>, rawValue: unknown, lastSeenAt: number): void {
    if (typeof rawValue !== 'string') return
    const value = rawValue.trim()
    if (!value || map.has(value)) return
    map.set(value, { value, count: 0, lastSeenAt })
}

function notificationFilterOptions(map: Map<string, NotificationFilterOptionDraft>): PluginNotificationFilterOption[] {
    return Array.from(map.values())
        .sort((left, right) => right.count - left.count || right.lastSeenAt - left.lastSeenAt || left.value.localeCompare(right.value))
        .slice(0, 100)
        .map((entry) => ({
            value: entry.value,
            label: entry.value,
            ...(entry.count > 0 ? { count: entry.count } : {}),
            ...(entry.lastSeenAt > 0 ? { lastSeenAt: entry.lastSeenAt } : {})
        }))
}

function buildNotificationFilterOptions(engine: SyncEngine | null, namespace: string) {
    const namespaces = new Map<string, NotificationFilterOptionDraft>()
    const agents = new Map<string, NotificationFilterOptionDraft>()
    const workspaces = new Map<string, NotificationFilterOptionDraft>()

    const sessions = engine?.getSessionsByNamespace(namespace) ?? []
    if (sessions.length === 0) {
        ensureNotificationFilterOption(namespaces, namespace, Date.now())
    }

    for (const session of sessions) {
        const lastSeenAt = sessionLastSeenAt(session)
        addNotificationFilterOption(namespaces, session.namespace || namespace, lastSeenAt)
        addNotificationFilterOption(agents, getAgentName(session), lastSeenAt)
        addNotificationFilterOption(workspaces, session.metadata?.path, lastSeenAt)
    }

    if (!namespaces.has(namespace)) {
        ensureNotificationFilterOption(namespaces, namespace, Date.now())
    }

    return PluginNotificationFilterOptionsResponseSchema.parse({
        namespaces: notificationFilterOptions(namespaces),
        agents: notificationFilterOptions(agents),
        workspaces: notificationFilterOptions(workspaces)
    })
}

async function executeInstallPlan(options: {
    manager: HubPluginManager
    engine: SyncEngine | null
    namespace: string
    request: PluginInstallPlanRequest
    plan: PluginInstallPlanResponse
}): Promise<PluginInstallResult> {
    const targetResults: NonNullable<PluginInstallResult['targetResults']> = []
    const plugins: PluginListItem[] = []
    const attempted: Array<{ ok: boolean; action?: PluginInstallResult['action'] }> = []
    const executableTargets = options.plan.targets.filter((target) =>
        target.compatible
        && isExecutablePlanAction(target.action))

    for (const target of options.plan.targets.filter((entry) => entry.action === 'skip')) {
        targetResults.push({
            target: target.target,
            ok: false,
            error: target.reason ?? 'Target skipped by install plan.',
            pluginId: options.plan.plugin.id,
            diagnostics: [],
            plugins: target.runtime === 'hub'
                ? options.manager.listPlugins().map((plugin) => withTarget(plugin, target.target))
                : []
        })
    }

    for (const target of executableTargets) {
        if (target.runtime === 'hub') {
            try {
                if (target.action === 'unchanged') {
                    const reload = options.request.enable === true
                        ? await options.manager.enablePlugin(options.plan.plugin.id, undefined, options.request.reload !== false)
                        : undefined
                    const latestPlugins = options.manager.listPlugins().map((plugin) => withTarget(plugin, hubTargetSummary()))
                    plugins.push(...latestPlugins)
                    targetResults.push({
                        target: target.target,
                        ok: reload?.ok ?? true,
                        action: 'unchanged',
                        pluginId: options.plan.plugin.id,
                        diagnostics: [],
                        plugins: latestPlugins
                    })
                    attempted.push({ ok: reload?.ok ?? true, action: 'unchanged' })
                    continue
                }
                const result = await options.manager.installPluginPackage({
                    ...packageRequestFromPlan(options.request),
                    overwrite: target.action === 'overwrite' || options.request.overwrite === true
                })
                const targetSummary = hubTargetSummary()
                const latestPlugins = result.plugins.map((plugin) => withTarget(plugin, targetSummary))
                plugins.push(...latestPlugins)
                targetResults.push({
                    target: targetSummary,
                    ok: result.ok,
                    action: result.action,
                    pluginId: result.pluginId,
                    targetPath: result.targetPath,
                    diagnostics: result.diagnostics,
                    plugins: latestPlugins
                })
                attempted.push({ ok: result.ok, action: result.action })
            } catch (error) {
                const latestPlugins = options.manager.listPlugins().map((plugin) => withTarget(plugin, hubTargetSummary()))
                plugins.push(...latestPlugins)
                targetResults.push({
                    target: target.target,
                    ok: false,
                    error: errorMessage(error),
                    pluginId: options.plan.plugin.id,
                    diagnostics: [],
                    plugins: latestPlugins
                })
                attempted.push({ ok: false })
            }
            continue
        }

        const machineId = target.target.machineId
        if (!machineId || !options.engine) {
            targetResults.push({
                target: target.target,
                ok: false,
                error: 'Runner target is not available.',
                pluginId: options.plan.plugin.id,
                diagnostics: [],
                plugins: []
            })
            attempted.push({ ok: false })
            continue
        }
        const machine = options.engine.getMachineByNamespace(machineId, options.namespace)
        if (!machine) {
            targetResults.push({
                target: target.target,
                ok: false,
                error: 'Runner target was not found.',
                pluginId: options.plan.plugin.id,
                diagnostics: [],
                plugins: []
            })
            attempted.push({ ok: false })
            continue
        }
        try {
            if (target.action === 'unchanged') {
                const reload = options.request.enable === true
                    ? await options.engine.enableRunnerPlugin(machineId, options.plan.plugin.id, undefined, options.request.reload !== false)
                    : undefined
                const inventory = await loadRunnerInventory(options.engine, machine)
                const latestPlugins = inventory.plugins.map((plugin) => withTarget(plugin, inventory.target))
                plugins.push(...latestPlugins)
                targetResults.push({
                    target: inventory.target,
                    ok: reload?.ok ?? true,
                    action: 'unchanged',
                    pluginId: options.plan.plugin.id,
                    diagnostics: [],
                    plugins: latestPlugins
                })
                attempted.push({ ok: reload?.ok ?? true, action: 'unchanged' })
                continue
            }
            const result = await options.engine.installRunnerPluginPackage(machineId, {
                ...packageRequestFromPlan(options.request),
                overwrite: target.action === 'overwrite' || options.request.overwrite === true
            })
            const targetSummary = result.target ?? runnerTargetSummary(machine, machine.runnerState?.pluginInventory)
            const latestPlugins = result.plugins.map((plugin) => withTarget(plugin, targetSummary))
            plugins.push(...latestPlugins)
            targetResults.push({
                target: targetSummary,
                ok: result.ok,
                action: result.action,
                pluginId: result.pluginId,
                targetPath: result.targetPath,
                diagnostics: result.diagnostics,
                plugins: latestPlugins
            })
            attempted.push({ ok: result.ok, action: result.action })
        } catch (error) {
            const cached = cachedRunnerInventory(machine, errorMessage(error))
            plugins.push(...cached.plugins)
            targetResults.push({
                target: cached.target,
                ok: false,
                error: errorMessage(error),
                pluginId: options.plan.plugin.id,
                diagnostics: [],
                plugins: cached.plugins
            })
            attempted.push({ ok: false })
        }
    }

    const firstExecutableAction = executableTargets.find((target) => isExecutablePlanAction(target.action))?.action

    return PluginInstallResultSchema.parse({
        ok: attempted.every((entry) => entry.ok),
        action: attempted.find((entry) => entry.action)?.action ?? (firstExecutableAction && isExecutablePlanAction(firstExecutableAction) ? installActionFromPlan(firstExecutableAction) : 'unchanged'),
        pluginId: options.plan.plugin.id,
        targetResults,
        diagnostics: [],
        plugins
    })
}

export function createPluginsRoutes(
    getPluginManager: () => HubPluginManager | null,
    getSyncEngine: () => SyncEngine | null = () => null,
    getMarketplaceService?: () => PluginMarketplaceService | null
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const installPlans = new Map<string, { namespace: string; request: PluginInstallPlanRequest; expiresAt: number }>()
    const installPlanTtlMs = 10 * 60 * 1000
    const defaultMarketplaceService = new PluginMarketplaceService()
    const resolveMarketplaceService = getMarketplaceService ?? (() => defaultMarketplaceService)

    app.get('/plugins', async (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        const target = parseTarget(c)
        if (target instanceof Response) return target
        const { payload } = await buildListPayload({
            manager,
            engine: getSyncEngine(),
            namespace: c.get('namespace'),
            target
        })
        if (payload && typeof payload === 'object' && 'error' in payload) {
            return c.json(payload, 404)
        }
        return c.json(payload)
    })

    app.get('/plugins/diagnostics', (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        const target = parseTarget(c)
        if (target instanceof Response) return target
        if (target && target !== 'hub') {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine
            const machineId = parseRunnerPluginTargetScope(target)
            const machines = machineId
                ? [engine.getMachineByNamespace(machineId, c.get('namespace'))].filter((entry): entry is Machine => Boolean(entry))
                : engine.getMachinesByNamespace(c.get('namespace'))
            const diagnostics = machines.flatMap((machine) => machine.runnerState?.pluginInventory?.diagnostics ?? [])
            return c.json(PluginDiagnosticsResponseSchema.parse({ diagnostics }))
        }
        const payload = PluginDiagnosticsResponseSchema.parse({ diagnostics: manager.getDiagnostics() })
        return c.json(payload)
    })

    app.get('/plugins/notification-filter-options', (c) => {
        return c.json(buildNotificationFilterOptions(getSyncEngine(), c.get('namespace')))
    })

    app.get('/plugins/capabilities', async (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        const target = parseTarget(c)
        if (target instanceof Response) return target
        const sessionId = parseOptionalSessionId(c)
        if (sessionId instanceof Response) return sessionId

        if (target === 'hub') {
            return c.json(PluginCapabilitiesResponseSchema.parse({
                capabilities: typeof manager.collectCapabilities === 'function' ? manager.collectCapabilities() : []
            }))
        }

        const engine = getSyncEngine()
        const runnerMachineId = target ? parseRunnerPluginTargetScope(target) : null
        if (runnerMachineId) {
            if (!engine) {
                return c.json(PluginCapabilitiesResponseSchema.parse({ capabilities: [] }))
            }
            const machine = engine.getMachineByNamespace(runnerMachineId, c.get('namespace'))
            if (!machine) return c.json({ error: 'Runner target not found' }, 404)
            const inventory = await loadRunnerInventory(engine, machine)
            return c.json(PluginCapabilitiesResponseSchema.parse({ capabilities: inventory.capabilities ?? [] }))
        }

        if (sessionId && !target) {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine
            const session = engine.getSessionByNamespace(sessionId, c.get('namespace'))
            if (!session) {
                return c.json({ error: 'Session not found' }, 404)
            }
            const capabilities = typeof manager.collectCapabilities === 'function'
                ? [...manager.collectCapabilities()]
                : []
            const sessionMachineId = typeof session.metadata?.machineId === 'string'
                ? session.metadata.machineId
                : null
            if (sessionMachineId) {
                const machine = engine.getMachineByNamespace(sessionMachineId, c.get('namespace'))
                if (machine) {
                    const inventory = await loadRunnerInventory(engine, machine)
                    capabilities.push(...(inventory.capabilities ?? []))
                }
            }
            return c.json(PluginCapabilitiesResponseSchema.parse({ capabilities: mergeCapabilityViews(capabilities) }))
        }

        const capabilities = target === 'all-runners' || typeof manager.collectCapabilities !== 'function'
            ? []
            : [...manager.collectCapabilities()]
        if (engine && (!target || target === 'all-runners')) {
            const machines = engine.getMachinesByNamespace(c.get('namespace'))
            const inventories = await Promise.all(machines.map((machine) => loadRunnerInventory(engine, machine)))
            capabilities.push(...inventories.flatMap((inventory) => inventory.capabilities ?? []))
        }
        return c.json(PluginCapabilitiesResponseSchema.parse({ capabilities: mergeCapabilityViews(capabilities) }))
    })

    app.post('/plugins/reload', async (c) => {
        const target = parseTarget(c)
        if (target instanceof Response) return target
        if (target && target !== 'hub') {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine
            const result = await runRunnerReloadAction({
                engine,
                namespace: c.get('namespace'),
                target,
                action: async (machineId) => await engine.reloadRunnerPlugins(machineId)
            })
            return result instanceof Response ? result : c.json(PluginReloadResultSchema.parse(result))
        }
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        const result = await manager.reload()
        return c.json(PluginReloadResultSchema.parse({ ...result, target: hubTargetSummary(), plugins: result.plugins.map((plugin) => withTarget(plugin, hubTargetSummary())) }))
    })

    app.post('/plugins/install-local', async (c) => {
        const parsedTarget = parseTarget(c)
        if (parsedTarget instanceof Response) return parsedTarget
        const target = requireExplicitInstallTarget(c, parsedTarget)
        if (target instanceof Response) return target
        const json = await c.req.json().catch(() => null)
        const parsed = PluginInstallLocalRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        if (target === 'hub') {
            const manager = requirePluginManager(c, getPluginManager)
            if (manager instanceof Response) return manager
            try {
                return c.json(PluginInstallResultSchema.parse({
                    ...(await manager.installLocalPlugin(parsed.data.sourcePath, parsed.data)),
                    target: hubTargetSummary()
                }))
            } catch (error) {
                return c.json({ error: errorMessage(error) }, errorStatus(error))
            }
        }
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const result = await runRunnerInstallAction({
            engine,
            namespace: c.get('namespace'),
            target,
            action: async (machineId) => await engine.installRunnerPluginLocal(machineId, parsed.data)
        })
        return result instanceof Response ? result : c.json(PluginInstallResultSchema.parse(result))
    })

    app.post('/plugins/install-plan', async (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) return manager
        const json = await c.req.json().catch(() => null)
        const parsed = PluginInstallPlanRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        const planId = randomUUID()
        const now = Date.now()
        const expiresAt = now + installPlanTtlMs
        try {
            const plan = await createInstallPlan({
                manager,
                engine: getSyncEngine(),
                namespace: c.get('namespace'),
                request: parsed.data,
                planId,
                now,
                expiresAt
            })
            installPlans.set(planId, {
                namespace: c.get('namespace'),
                request: parsed.data,
                expiresAt
            })
            return c.json(PluginInstallPlanResponseSchema.parse(plan))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.post('/plugins/install-plan/:planId/execute', async (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) return manager
        const planId = c.req.param('planId')
        const stored = installPlans.get(planId)
        if (!stored || stored.namespace !== c.get('namespace')) {
            return c.json({ error: 'Plugin install plan not found or expired' }, 404)
        }
        if (stored.expiresAt <= Date.now()) {
            installPlans.delete(planId)
            return c.json({ error: 'Plugin install plan expired' }, 410)
        }
        try {
            const plan = await createInstallPlan({
                manager,
                engine: getSyncEngine(),
                namespace: c.get('namespace'),
                request: stored.request,
                planId,
                now: Date.now(),
                expiresAt: stored.expiresAt
            })
            if (plan.blockingErrors.length > 0) {
                return c.json({ error: 'Plugin install plan is blocked', plan }, 409)
            }
            const result = await executeInstallPlan({
                manager,
                engine: getSyncEngine(),
                namespace: c.get('namespace'),
                request: stored.request,
                plan
            })
            installPlans.delete(planId)
            return c.json(PluginInstallResultSchema.parse(result))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.post('/plugins/install-package', async (c) => {
        const parsedTarget = parseTarget(c)
        if (parsedTarget instanceof Response) return parsedTarget
        const target = requireExplicitInstallTarget(c, parsedTarget)
        if (target instanceof Response) return target
        const json = await c.req.json().catch(() => null)
        const parsed = PluginInstallPackageRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        try {
            await validatePluginPackagePayload({ ...parsed.data, inspectArchive: true })
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
        if (target === 'hub') {
            const manager = requirePluginManager(c, getPluginManager)
            if (manager instanceof Response) return manager
            try {
                return c.json(PluginInstallResultSchema.parse({
                    ...(await manager.installPluginPackage(parsed.data)),
                    target: hubTargetSummary()
                }))
            } catch (error) {
                return c.json({ error: errorMessage(error) }, errorStatus(error))
            }
        }
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const result = await runRunnerInstallAction({
            engine,
            namespace: c.get('namespace'),
            target,
            action: async (machineId) => await engine.installRunnerPluginPackage(machineId, parsed.data)
        })
        return result instanceof Response ? result : c.json(PluginInstallResultSchema.parse(result))
    })

    app.get('/plugins/marketplace', async (c) => {
        const service = requireMarketplaceService(c, resolveMarketplaceService)
        if (service instanceof Response) return service
        try {
            const snapshot = await service.getCatalog()
            const filters = {
                query: c.req.query('q')?.trim(),
                category: c.req.query('category')?.trim(),
                runtime: c.req.query('runtime')?.trim()
            }
            const entries = marketplaceEntriesWithInstallState(
                snapshot.catalog.plugins.filter((entry) => marketplaceEntryMatches(entry, filters)),
                getPluginManager()?.listPlugins() ?? []
            )
            return c.json(PluginMarketplaceListResponseSchema.parse({
                sourceUrl: snapshot.sourceUrl,
                fetchedAt: snapshot.fetchedAt,
                entries
            }))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.post('/plugins/marketplace/refresh', async (c) => {
        const service = requireMarketplaceService(c, resolveMarketplaceService)
        if (service instanceof Response) return service
        try {
            const snapshot = await service.getCatalog({ force: true })
            const entries = marketplaceEntriesWithInstallState(snapshot.catalog.plugins, getPluginManager()?.listPlugins() ?? [])
            return c.json(PluginMarketplaceListResponseSchema.parse({
                sourceUrl: snapshot.sourceUrl,
                fetchedAt: snapshot.fetchedAt,
                entries
            }))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.get('/plugins/marketplace/:id', async (c) => {
        const service = requireMarketplaceService(c, resolveMarketplaceService)
        if (service instanceof Response) return service
        try {
            const { snapshot, entry } = await service.getEntry(c.req.param('id'))
            const [entryView] = marketplaceEntriesWithInstallState([entry], getPluginManager()?.listPlugins() ?? [])
            return c.json(PluginMarketplaceDetailResponseSchema.parse({
                sourceUrl: snapshot.sourceUrl,
                fetchedAt: snapshot.fetchedAt,
                entry: entryView
            }))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.post('/plugins/marketplace/:id/install-plan', async (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) return manager
        const service = requireMarketplaceService(c, resolveMarketplaceService)
        if (service instanceof Response) return service
        const json = await c.req.json().catch(() => ({}))
        const parsed = PluginMarketplaceInstallRequestSchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        const planId = randomUUID()
        const now = Date.now()
        const expiresAt = now + installPlanTtlMs
        try {
            const marketplacePackage = await service.buildInstallPlanRequest(c.req.param('id'), parsed.data)
            const plan = await createInstallPlan({
                manager,
                engine: getSyncEngine(),
                namespace: c.get('namespace'),
                request: marketplacePackage.request,
                planId,
                now,
                expiresAt
            })
            installPlans.set(planId, {
                namespace: c.get('namespace'),
                request: marketplacePackage.request,
                expiresAt
            })
            return c.json(PluginMarketplaceInstallPlanResponseSchema.parse({
                marketplace: marketplacePackage.marketplace,
                plan
            }))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.post('/plugins/marketplace/:id/install', async (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) return manager
        const service = requireMarketplaceService(c, resolveMarketplaceService)
        if (service instanceof Response) return service
        const json = await c.req.json().catch(() => ({}))
        const parsed = PluginMarketplaceInstallRequestSchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        const now = Date.now()
        try {
            const marketplacePackage = await service.buildInstallPlanRequest(c.req.param('id'), parsed.data)
            const plan = await createInstallPlan({
                manager,
                engine: getSyncEngine(),
                namespace: c.get('namespace'),
                request: marketplacePackage.request,
                planId: randomUUID(),
                now
            })
            if (plan.blockingErrors.length > 0) {
                return c.json(PluginMarketplaceInstallPlanResponseSchema.parse({
                    marketplace: marketplacePackage.marketplace,
                    plan
                }), 409)
            }
            const result = await executeInstallPlan({
                manager,
                engine: getSyncEngine(),
                namespace: c.get('namespace'),
                request: marketplacePackage.request,
                plan
            })
            return c.json(PluginInstallResultSchema.parse(result))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.post('/plugins/local-directory', async (c) => {
        const target = parseTarget(c)
        if (target instanceof Response) return target
        const json = await c.req.json().catch(() => ({}))
        const parsed = PluginLocalDirectoryListRequestSchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        if (!target || target === 'hub') {
            const manager = requirePluginManager(c, getPluginManager)
            if (manager instanceof Response) return manager
            const result = await manager.listLocalDirectory(parsed.data.path)
            return c.json(PluginLocalDirectoryListResponseSchema.parse(result))
        }
        if (target === 'all-runners') {
            return c.json({ error: 'Directory browsing requires a single target; choose target=runner:<machineId>.' }, 400)
        }
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const machineId = parseRunnerPluginTargetScope(target)
        const machine = machineId ? engine.getMachineByNamespace(machineId, c.get('namespace')) : undefined
        if (!machine) return c.json({ error: 'Runner target not found' }, 404)
        if (!machine.active) return c.json({ error: 'Runner target is offline' }, 503)
        try {
            return c.json(PluginLocalDirectoryListResponseSchema.parse(await engine.listRunnerPluginDirectory(machine.id, parsed.data.path)))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, 500)
        }
    })

    app.get('/plugins/:id', async (c) => {
        const target = parseTarget(c)
        if (target instanceof Response) return target
        if (target && target !== 'hub') {
            if (target === 'all-runners') {
                return c.json({ error: 'Plugin detail requires target=hub or target=runner:<machineId>.' }, 400)
            }
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine
            const detail = await getRunnerDetail(engine, c.get('namespace'), target, c.req.param('id'))
            if (detail instanceof Response) return detail
            return c.json(PluginDetailResponseSchema.parse({ plugin: detail }))
        }
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        const plugin = manager.getPlugin(c.req.param('id'))
        if (!plugin) {
            return c.json({ error: 'Plugin not found' }, 404)
        }
        return c.json(PluginDetailResponseSchema.parse({ plugin: withTarget(plugin, hubTargetSummary()) }))
    })

    app.post('/plugins/:id/reload', async (c) => {
        const target = parseTarget(c)
        if (target instanceof Response) return target
        if (target && target !== 'hub') {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine
            const pluginId = c.req.param('id')
            const result = await runRunnerReloadAction({
                engine,
                namespace: c.get('namespace'),
                target,
                pluginId,
                action: async (machineId) => await engine.reloadRunnerPlugins(machineId, pluginId)
            })
            return result instanceof Response ? result : c.json(PluginReloadResultSchema.parse(result))
        }
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        const result = await manager.reload(c.req.param('id'))
        return c.json(PluginReloadResultSchema.parse({ ...result, target: hubTargetSummary() }))
    })

    app.post('/plugins/:id/enable', async (c) => {
        const target = parseTarget(c)
        if (target instanceof Response) return target
        const json = await c.req.json().catch(() => ({}))
        const parsed = PluginEnableRequestSchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        if (target && target !== 'hub') {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine
            const pluginId = c.req.param('id')
            const result = await runRunnerReloadAction({
                engine,
                namespace: c.get('namespace'),
                target,
                pluginId,
                action: async (machineId) => await engine.enableRunnerPlugin(machineId, pluginId, parsed.data.config, parsed.data.reload !== false)
            })
            return result instanceof Response ? result : c.json(PluginReloadResultSchema.parse(result))
        }
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        try {
            const result = await manager.enablePlugin(c.req.param('id'), parsed.data.config, parsed.data.reload !== false)
            return c.json(PluginReloadResultSchema.parse({ ...result, target: hubTargetSummary() }))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.post('/plugins/:id/disable', async (c) => {
        const target = parseTarget(c)
        if (target instanceof Response) return target
        const json = await c.req.json().catch(() => ({}))
        const parsed = PluginDisableRequestSchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        if (target && target !== 'hub') {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine
            const pluginId = c.req.param('id')
            const result = await runRunnerReloadAction({
                engine,
                namespace: c.get('namespace'),
                target,
                pluginId,
                action: async (machineId) => await engine.disableRunnerPlugin(machineId, pluginId, parsed.data.reload !== false)
            })
            return result instanceof Response ? result : c.json(PluginReloadResultSchema.parse(result))
        }
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        try {
            const result = await manager.disablePlugin(c.req.param('id'), parsed.data.reload !== false)
            return c.json(PluginReloadResultSchema.parse({ ...result, target: hubTargetSummary() }))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.delete('/plugins/:id', async (c) => {
        const target = parseTarget(c)
        if (target instanceof Response) return target
        if (target && target !== 'hub') {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine
            const pluginId = c.req.param('id')
            try {
                const result = await runRunnerDeleteAction({
                    engine,
                    namespace: c.get('namespace'),
                    target,
                    pluginId,
                    action: async (machineId) => await engine.deleteRunnerPlugin(machineId, pluginId)
                })
                return result instanceof Response ? result : c.json(PluginDeleteResultSchema.parse(result))
            } catch (error) {
                return c.json({ error: errorMessage(error) }, errorStatus(error))
            }
        }
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        try {
            const result = await manager.deletePlugin(c.req.param('id'))
            return c.json(PluginDeleteResultSchema.parse({ ...result, target: hubTargetSummary() }))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.patch('/plugins/:id/config', async (c) => {
        const target = parseTarget(c)
        if (target instanceof Response) return target
        const json = await c.req.json().catch(() => null)
        const parsed = PluginConfigUpdateRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        if (target && target !== 'hub') {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine
            const pluginId = c.req.param('id')
            const result = await runRunnerReloadAction({
                engine,
                namespace: c.get('namespace'),
                target,
                pluginId,
                action: async (machineId) => await engine.updateRunnerPluginConfig(machineId, pluginId, parsed.data.config)
            })
            return result instanceof Response ? result : c.json(PluginReloadResultSchema.parse(result))
        }
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        try {
            const result = await manager.updatePluginConfig(c.req.param('id'), parsed.data.config)
            return c.json(PluginReloadResultSchema.parse({ ...result, target: hubTargetSummary() }))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    return app
}
