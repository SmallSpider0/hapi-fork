import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { PluginDeleteResult, PluginInstallResult, PluginListItem, PluginReloadResult } from '@hapi/protocol/plugins/admin'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { HubPluginManager } from '../../plugins/pluginManager'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
import { createPluginsRoutes } from './plugins'

const secret = new TextEncoder().encode('test-secret-32-bytes-long-enough')

async function token(): Promise<string> {
    return await new SignJWT({ uid: 1, ns: 'default' })
        .setProtectedHeader({ alg: 'HS256' })
        .sign(secret)
}

const plugin: PluginListItem = {
    id: 'com.example.plugin',
    name: 'Plugin',
    version: '0.1.0',
    source: 'user-home',
    status: 'active',
    enabled: true,
    active: true,
    rootPath: '/tmp/hapi/plugins/com.example.plugin',
    manifestPath: '/tmp/hapi/plugins/com.example.plugin/hapi.plugin.json',
    runtimes: { hub: { entry: 'hub.js', active: true } },
    diagnostics: []
}

const runnerPlugin: PluginListItem = {
    id: 'com.example.runner',
    name: 'Runner Plugin',
    version: '0.1.0',
    source: 'user-home',
    status: 'enabled',
    enabled: true,
    active: false,
    rootPath: '/runner/plugins/com.example.runner',
    manifestPath: '/runner/plugins/com.example.runner/hapi.plugin.json',
    runtimes: { runner: { entry: 'runner.js', active: false } },
    diagnostics: []
}

function makeMachine(id: string, active: boolean, plugins: PluginListItem[] = [runnerPlugin]): Machine {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active,
        activeAt: Date.now(),
        metadata: { host: `${id}.host`, platform: 'linux', happyCliVersion: '0.0.0' },
        metadataVersion: 1,
        runnerState: {
            status: active ? 'running' : 'offline',
            pluginInventory: {
                machineId: id,
                updatedAt: 1234,
                plugins,
                diagnostics: []
            }
        },
        runnerStateVersion: 1
    }
}

function reloadResult(action: PluginReloadResult['results'][number]['action'] = 'unchanged'): PluginReloadResult {
    return {
        ok: true,
        results: [{ id: plugin.id, action, status: 'active', diagnostics: [] }],
        plugins: [plugin]
    }
}

function runnerReloadResult(machineId: string): PluginReloadResult {
    return {
        ok: true,
        target: { scope: `runner:${machineId}`, runtime: 'runner', machineId, active: true, stale: false },
        results: [{ id: runnerPlugin.id, action: 'unchanged', status: 'enabled', diagnostics: [] }],
        plugins: [runnerPlugin]
    }
}

function installResult(action: PluginInstallResult['action'] = 'installed'): PluginInstallResult {
    return {
        ok: true,
        action,
        plugin,
        pluginId: plugin.id,
        targetPath: plugin.rootPath,
        diagnostics: [],
        plugins: [plugin],
        reload: reloadResult('activated')
    }
}

function deleteResult(): PluginDeleteResult {
    return {
        ok: true,
        pluginId: plugin.id,
        rootPath: plugin.rootPath,
        deleted: true,
        plugins: [],
        reload: reloadResult('deactivated')
    }
}

function createApp(manager: Partial<HubPluginManager> | null, engine: Partial<SyncEngine> | null = null) {
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', createAuthMiddleware(secret))
    app.route('/api', createPluginsRoutes(() => manager as HubPluginManager | null, () => engine as SyncEngine | null))
    return app
}

describe('plugin admin routes', () => {
    it('requires API auth', async () => {
        const app = createApp({ listPlugins: () => [plugin] } as never)
        const response = await app.request('/api/plugins')
        expect(response.status).toBe(401)
    })

    it('returns plugin list and detail through shared DTOs', async () => {
        const app = createApp({
            listPlugins: () => [plugin],
            getPlugin: () => ({
                ...plugin,
                manifest: undefined,
                config: { url: 'https://example.test' },
                permissions: { network: ['https://example.test'], secrets: [{ name: 'TOKEN', present: false }] },
                contributions: { notificationChannels: [] },
                runtimeEntryPaths: []
            }),
            getDiagnostics: () => []
        } as never)
        const auth = await token()

        const listResponse = await app.request('/api/plugins?target=hub', { headers: { authorization: `Bearer ${auth}` } })
        expect(listResponse.status).toBe(200)
        const list = await listResponse.json() as { plugins: PluginListItem[]; targets: Array<{ target: { scope: string } }> }
        expect(list.plugins).toHaveLength(1)
        expect(list.plugins[0]).toMatchObject({ id: plugin.id, target: { scope: 'hub', runtime: 'hub', active: true } })
        expect(list.targets[0]?.target.scope).toBe('hub')

        const detailResponse = await app.request('/api/plugins/com.example.plugin', { headers: { authorization: `Bearer ${auth}` } })
        expect(detailResponse.status).toBe(200)
        const detail = await detailResponse.json() as { plugin: { target?: { scope: string }; permissions: { secrets: Array<{ name: string; present: boolean }> } } }
        expect(detail.plugin.target?.scope).toBe('hub')
        expect(detail.plugin.permissions.secrets).toEqual([{ name: 'TOKEN', present: false }])
    })

    it('aggregates Hub and Runner plugin inventories without reading Runner paths directly', async () => {
        const machine = makeMachine('runner-1', true)
        const calls: string[] = []
        const app = createApp(
            { listPlugins: () => [plugin] } as never,
            {
                getMachinesByNamespace: () => [machine],
                listRunnerPlugins: async (machineId: string) => {
                    calls.push(`rpc:${machineId}`)
                    return machine.runnerState!.pluginInventory!
                }
            } as never
        )
        const response = await app.request('/api/plugins', { headers: { authorization: `Bearer ${await token()}` } })

        expect(response.status).toBe(200)
        const payload = await response.json() as { plugins: PluginListItem[]; targets: Array<{ target: { scope: string } }> }
        expect(payload.plugins.map((entry) => entry.id).sort()).toEqual([plugin.id, runnerPlugin.id].sort())
        expect(payload.plugins.find((entry) => entry.id === runnerPlugin.id)?.target).toMatchObject({ scope: 'runner:runner-1', runtime: 'runner', active: true })
        expect(payload.targets.map((entry) => entry.target.scope).sort()).toEqual(['hub', 'runner:runner-1'])
        expect(calls).toEqual(['rpc:runner-1'])
    })

    it('returns stale cached Runner inventory while a Runner is offline', async () => {
        const cachedActive = { ...runnerPlugin, status: 'active' as const, active: true, runtimes: { runner: { entry: 'runner.js', active: true } } }
        const machine = makeMachine('runner-offline', false, [cachedActive])
        const app = createApp(
            { listPlugins: () => [] } as never,
            {
                getMachineByNamespace: () => machine,
                listRunnerPlugins: async () => { throw new Error('must not call offline runner RPC') }
            } as never
        )
        const response = await app.request('/api/plugins?target=runner:runner-offline', { headers: { authorization: `Bearer ${await token()}` } })

        expect(response.status).toBe(200)
        const payload = await response.json() as { plugins: PluginListItem[]; targets: Array<{ target: { active: boolean; stale?: boolean } }> }
        expect(payload.targets[0]?.target).toMatchObject({ active: false, stale: true })
        expect(payload.plugins[0]).toMatchObject({ id: runnerPlugin.id, active: false, runtimes: { runner: { active: false } } })
    })

    it('rejects all-runners for plugin detail instead of throwing', async () => {
        const app = createApp({ listPlugins: () => [], getPlugin: () => null } as never, { getMachinesByNamespace: () => [] } as never)

        const response = await app.request('/api/plugins/com.example.runner?target=all-runners', {
            headers: { authorization: `Bearer ${await token()}` }
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Plugin detail requires target=hub or target=runner:<machineId>.' })
    })

    it('reports all-runners partial failures per target', async () => {
        const online = makeMachine('runner-online', true)
        const offline = makeMachine('runner-offline', false)
        const app = createApp(
            { listPlugins: () => [] } as never,
            {
                getMachinesByNamespace: () => [online, offline],
                reloadRunnerPlugins: async (machineId: string) => runnerReloadResult(machineId)
            } as never
        )
        const response = await app.request('/api/plugins/reload?target=all-runners', {
            method: 'POST',
            headers: { authorization: `Bearer ${await token()}` }
        })

        expect(response.status).toBe(200)
        const payload = await response.json() as PluginReloadResult
        expect(payload.ok).toBe(false)
        expect(payload.targetResults).toHaveLength(2)
        expect(payload.targetResults?.find((entry) => entry.target.scope === 'runner:runner-online')?.ok).toBe(true)
        expect(payload.targetResults?.find((entry) => entry.target.scope === 'runner:runner-offline')?.error).toBe('Runner target is offline')
    })

    it('validates config bodies and calls manager actions', async () => {
        const calls: string[] = []
        const app = createApp({
            updatePluginConfig: async (id: string, config?: Record<string, unknown>) => {
                calls.push(`config:${id}`)
                if (config && 'apiKey' in config) throw new Error('Config for com.example.plugin must not store secret-like field apiKey; set secrets as environment variables instead.')
                return reloadResult('reloaded')
            },
            enablePlugin: async (id: string) => { calls.push(`enable:${id}`); return reloadResult('activated') },
            disablePlugin: async (id: string) => { calls.push(`disable:${id}`); return reloadResult('deactivated') },
            reload: async (id?: string) => { calls.push(`reload:${id ?? '*'}`); return reloadResult('unchanged') },
            installLocalPlugin: async (sourcePath: string) => { calls.push(`install-local:${sourcePath}`); return installResult('installed') },
            listLocalDirectory: async (path?: string) => { calls.push(`local-directory:${path ?? ''}`); return { success: true, path: path ?? '/tmp', entries: [] } },
            deletePlugin: async (id: string) => { calls.push(`delete:${id}`); return deleteResult() }
        } as never)
        const auth = await token()
        const headers = { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }

        const invalid = await app.request('/api/plugins/com.example.plugin/config', {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ config: 'nope' })
        })
        expect(invalid.status).toBe(400)

        expect((await app.request('/api/plugins/com.example.plugin/config', { method: 'PATCH', headers, body: JSON.stringify({ config: { label: 'v2' } }) })).status).toBe(200)
        expect((await app.request('/api/plugins/com.example.plugin/config', { method: 'PATCH', headers, body: JSON.stringify({ config: { apiKey: 'secret-value' } }) })).status).toBe(409)
        expect((await app.request('/api/plugins/com.example.plugin/enable', { method: 'POST', headers, body: JSON.stringify({}) })).status).toBe(200)
        expect((await app.request('/api/plugins/com.example.plugin/disable', { method: 'POST', headers, body: JSON.stringify({}) })).status).toBe(200)
        expect((await app.request('/api/plugins/com.example.plugin/reload', { method: 'POST', headers })).status).toBe(200)
        expect((await app.request('/api/plugins/reload', { method: 'POST', headers })).status).toBe(200)
        expect((await app.request('/api/plugins/install-local', { method: 'POST', headers, body: JSON.stringify({ sourcePath: '/tmp/plugin' }) })).status).toBe(200)
        expect((await app.request('/api/plugins/local-directory', { method: 'POST', headers, body: JSON.stringify({ path: '/tmp' }) })).status).toBe(200)
        expect((await app.request('/api/plugins/com.example.plugin', { method: 'DELETE', headers })).status).toBe(200)
        expect((await app.request('/api/plugins/install-example', { method: 'POST', headers, body: JSON.stringify({ enable: true }) })).status).toBe(404)
        const invalidInstall = await app.request('/api/plugins/install-local', {
            method: 'POST',
            headers,
            body: JSON.stringify({ sourcePath: '' })
        })
        expect(invalidInstall.status).toBe(400)
        expect(calls).toEqual([
            'config:com.example.plugin',
            'config:com.example.plugin',
            'enable:com.example.plugin',
            'disable:com.example.plugin',
            'reload:com.example.plugin',
            'reload:*',
            'install-local:/tmp/plugin',
            'local-directory:/tmp',
            'delete:com.example.plugin'
        ])
    })

    it('returns 503 when manager is unavailable', async () => {
        const app = createApp(null)
        const response = await app.request('/api/plugins', { headers: { authorization: `Bearer ${await token()}` } })
        expect(response.status).toBe(503)
    })
})
