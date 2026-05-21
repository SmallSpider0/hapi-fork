import { Hono, type Context } from 'hono'
import {
    parseRunnerPluginTargetScope,
    PluginConfigUpdateRequestSchema,
    PluginDeleteResultSchema,
    PluginDisableRequestSchema,
    PluginEnableRequestSchema,
    PluginDetailResponseSchema,
    PluginDiagnosticsResponseSchema,
    PluginInstallLocalRequestSchema,
    PluginInstallResultSchema,
    PluginLocalDirectoryListRequestSchema,
    PluginLocalDirectoryListResponseSchema,
    PluginListResponseSchema,
    PluginReloadResultSchema,
    PluginTargetScopeSchema,
    type PluginDeleteResult,
    type PluginDetail,
    type PluginListItem,
    type PluginReloadResult,
    type PluginTargetActionResult,
    type PluginTargetInventory,
    type PluginTargetScope,
    type PluginTargetSummary,
    type RunnerPluginInventory
} from '@hapi/protocol/plugins/admin'
import { PluginInstallError, PluginStateLockError } from '@hapi/protocol/plugins/foundation'
import type { HubPluginManager } from '../../plugins/pluginManager'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'

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

function parseTarget(c: Context<WebAppEnv>): PluginTargetScope | null | Response {
    const raw = c.req.query('target')
    if (!raw) return null
    const parsed = PluginTargetScopeSchema.safeParse(raw)
    if (!parsed.success) {
        return c.json({ error: 'Invalid plugin target scope', issues: parsed.error.flatten() }, 400)
    }
    return parsed.data
}

function hubTargetSummary(): PluginTargetSummary {
    return {
        scope: 'hub',
        runtime: 'hub',
        active: true,
        stale: false,
        displayName: 'Hub',
        updatedAt: Date.now()
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

function hubInventory(manager: HubPluginManager): PluginTargetInventory {
    const target = hubTargetSummary()
    return {
        target,
        plugins: manager.listPlugins().map((plugin) => withTarget(plugin, target))
    }
}

function cachedRunnerInventory(machine: Machine, error?: string): PluginTargetInventory {
    const inventory = machine.runnerState?.pluginInventory
    const target = runnerTargetSummary(machine, inventory, error ?? (inventory ? undefined : 'No Runner plugin inventory has been reported yet.'))
    return {
        target,
        plugins: (inventory?.plugins ?? []).map((plugin) => withTarget(plugin, target)),
        ...(target.error ? { error: target.error } : {})
    }
}

function freshRunnerInventory(machine: Machine, inventory: RunnerPluginInventory): PluginTargetInventory {
    const target = runnerTargetSummary(machine, inventory)
    return {
        target,
        plugins: inventory.plugins.map((plugin) => withTarget(plugin, target))
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

export function createPluginsRoutes(
    getPluginManager: () => HubPluginManager | null,
    getSyncEngine: () => SyncEngine | null = () => null
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

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
        const target = parseTarget(c)
        if (target instanceof Response) return target
        if (target && target !== 'hub') {
            return c.json({ error: 'Local directory install is only available on the Hub target in this phase.' }, 400)
        }
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        const json = await c.req.json().catch(() => null)
        const parsed = PluginInstallLocalRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        try {
            const result = await manager.installLocalPlugin(parsed.data.sourcePath, parsed.data)
            return c.json(PluginInstallResultSchema.parse(result))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.post('/plugins/local-directory', async (c) => {
        const target = parseTarget(c)
        if (target instanceof Response) return target
        if (target && target !== 'hub') {
            return c.json({ error: 'Hub local directory browsing cannot browse a Runner filesystem; use a Runner-scoped install flow when distribution is implemented.' }, 400)
        }
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        const json = await c.req.json().catch(() => ({}))
        const parsed = PluginLocalDirectoryListRequestSchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        const result = await manager.listLocalDirectory(parsed.data.path)
        return c.json(PluginLocalDirectoryListResponseSchema.parse(result))
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
        if (target === 'all-runners') {
            return c.json({ error: 'Deleting across all runners is not supported in this phase.' }, 400)
        }
        if (target && target !== 'hub') {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) return engine
            const machineId = parseRunnerPluginTargetScope(target)
            const machine = machineId ? engine.getMachineByNamespace(machineId, c.get('namespace')) : undefined
            if (!machine) return c.json({ error: 'Runner target not found' }, 404)
            if (!machine.active) return c.json({ error: 'Runner target is offline' }, 503)
            try {
                const result = await engine.deleteRunnerPlugin(machine.id, c.req.param('id'))
                return c.json(PluginDeleteResultSchema.parse(result))
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
