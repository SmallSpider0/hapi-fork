import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { PluginCapabilityView, PluginDeleteResult, PluginInstallResult, PluginListItem, PluginReloadResult } from '@hapi/protocol/plugins/admin'
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

function runnerInstallResult(machineId: string): PluginInstallResult {
    return {
        ok: true,
        action: 'installed',
        plugin: runnerPlugin,
        pluginId: runnerPlugin.id,
        targetPath: `/runner/${machineId}/plugins/${runnerPlugin.id}`,
        target: { scope: `runner:${machineId}`, runtime: 'runner', machineId, active: true, stale: false },
        diagnostics: [],
        plugins: [runnerPlugin]
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

function makeTgzPackage(pluginId = 'com.example.package', metadataPluginId = pluginId): { body: { filename: string; contentBase64: string; checksum: string; format: 'tgz' }; cleanup: () => void } {
    const testDir = mkdtempSync(join(tmpdir(), 'hapi-plugin-package-route-'))
    const pluginRoot = join(testDir, 'plugin')
    mkdirSync(pluginRoot, { recursive: true })
    const hubEntry = 'export function activate() {}'
    const pluginManifest = {
        id: pluginId,
        name: 'Package Plugin',
        version: '0.1.0',
        pluginApiVersion: '0.1',
        runtimes: { hub: { entry: 'hub.js' } }
    }
    const manifestText = JSON.stringify(pluginManifest, null, 2)
    writeFileSync(join(pluginRoot, 'hub.js'), hubEntry)
    writeFileSync(join(pluginRoot, 'hapi.plugin.json'), manifestText)
    writeFileSync(join(pluginRoot, 'hapi.plugin.package.json'), JSON.stringify({
        formatVersion: 'hapi-plugin-package/v1',
        manifest: { ...pluginManifest, id: metadataPluginId },
        checksum: 'provided-by-upload-request',
        files: [
            { path: './hapi.plugin.json', sha256: `sha256:${createHash('sha256').update(manifestText).digest('hex')}` },
            { path: './hub.js', sha256: `sha256:${createHash('sha256').update(hubEntry).digest('hex')}` }
        ],
        signature: { algorithm: 'test-none', value: 'unsigned-test' }
    }, null, 2))
    const packagePath = join(testDir, 'plugin.tgz')
    execFileSync('tar', ['-czf', packagePath, '-C', pluginRoot, '.'])
    const bytes = readFileSync(packagePath)
    return {
        body: {
            filename: 'plugin.tgz',
            contentBase64: bytes.toString('base64'),
            checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
            format: 'tgz'
        },
        cleanup: () => rmSync(testDir, { recursive: true, force: true })
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
                contributions: {
                    notificationChannels: [],
                    voice: { providers: [{ id: 'example-voice-provider', supportStatus: 'unsupported' }] },
                    deployment: { packs: [{ id: 'example-docker-pack', supportStatus: 'stub' }] },
                    integration: { protocolBridges: [{ id: 'example-mcp-bridge', protocol: 'mcp', supportStatus: 'unsupported' }] }
                },
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
        const detail = await detailResponse.json() as { plugin: { target?: { scope: string }; permissions: { secrets: Array<{ name: string; present: boolean }> }; contributions: { voice?: { providers?: Array<{ supportStatus?: string }> }; deployment?: { packs?: Array<{ supportStatus?: string }> }; integration?: { protocolBridges?: Array<{ protocol?: string }> } } } }
        expect(detail.plugin.target?.scope).toBe('hub')
        expect(detail.plugin.permissions.secrets).toEqual([expect.objectContaining({ name: 'TOKEN', present: false })])
        expect(detail.plugin.contributions.voice?.providers?.[0]?.supportStatus).toBe('unsupported')
        expect(detail.plugin.contributions.deployment?.packs?.[0]?.supportStatus).toBe('stub')
        expect(detail.plugin.contributions.integration?.protocolBridges?.[0]?.protocol).toBe('mcp')
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

    it('resolves capability readiness against the current session runner when sessionId is provided', async () => {
        const hubCapability: PluginCapabilityView = {
            pluginId: 'com.example.cross',
            pluginName: 'Cross Runtime',
            pluginVersion: '0.1.0',
            capabilityId: 'cross',
            kind: 'chat.composer.messageAction',
            status: 'missing-target',
            target: { scope: 'hub', runtime: 'hub', active: true, stale: false },
            parts: {
                web: { status: 'ready', required: true, declared: true, registered: true, active: true, diagnostics: [] },
                hub: { status: 'ready', required: true, declared: true, registered: true, active: true, diagnostics: [] },
                runner: { status: 'missing-target', required: true, declared: true, registered: false, active: false, diagnostics: [] }
            },
            web: {
                composerActions: [{
                    id: 'cross',
                    kind: 'pluginMessageAction',
                    label: 'Cross',
                    icon: 'clock',
                    handler: { position: 'hub', actionId: 'cross' },
                    ui: { kind: 'button' }
                }]
            },
            diagnostics: []
        }
        const runnerCapability: PluginCapabilityView = {
            ...hubCapability,
            target: { scope: 'runner:runner-other', runtime: 'runner', machineId: 'runner-other', active: true, stale: false },
            parts: {
                runner: { status: 'ready', required: true, declared: true, registered: true, active: true, diagnostics: [] },
                hub: { status: 'missing-target', required: true, declared: true, registered: false, active: false, diagnostics: [] },
                web: { status: 'ready', required: true, declared: true, registered: true, active: true, diagnostics: [] }
            }
        }
        const sessionRunner = makeMachine('runner-session', true, [])
        const otherRunner = makeMachine('runner-other', true, [])
        sessionRunner.runnerState!.pluginInventory = {
            machineId: 'runner-session',
            updatedAt: 1234,
            plugins: [],
            diagnostics: [],
            capabilities: []
        }
        otherRunner.runnerState!.pluginInventory = {
            machineId: 'runner-other',
            updatedAt: 1234,
            plugins: [],
            diagnostics: [],
            capabilities: [runnerCapability]
        }
        const app = createApp(
            { collectCapabilities: () => [hubCapability] } as never,
            {
                getSessionByNamespace: (sessionId: string) => sessionId === 'session-1'
                    ? { id: 'session-1', namespace: 'default', active: true, metadata: { machineId: 'runner-session' } }
                    : undefined,
                getMachineByNamespace: (machineId: string) => machineId === 'runner-session' ? sessionRunner : undefined,
                getMachinesByNamespace: () => [sessionRunner, otherRunner],
                listRunnerPlugins: async (machineId: string) => machineId === 'runner-other'
                    ? otherRunner.runnerState!.pluginInventory!
                    : sessionRunner.runnerState!.pluginInventory!
            } as never
        )
        const auth = await token()

        const globalResponse = await app.request('/api/plugins/capabilities', { headers: { authorization: `Bearer ${auth}` } })
        const sessionResponse = await app.request('/api/plugins/capabilities?sessionId=session-1', { headers: { authorization: `Bearer ${auth}` } })

        expect(globalResponse.status).toBe(200)
        expect(sessionResponse.status).toBe(200)
        const globalPayload = await globalResponse.json() as { capabilities: PluginCapabilityView[] }
        const sessionPayload = await sessionResponse.json() as { capabilities: PluginCapabilityView[] }
        expect(globalPayload.capabilities[0]?.status).toBe('ready')
        expect(sessionPayload.capabilities[0]?.status).toBe('missing-target')
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

    it('requires explicit target scope for install-local', async () => {
        const app = createApp({ installLocalPlugin: async () => installResult('installed') } as never)
        const response = await app.request('/api/plugins/install-local', {
            method: 'POST',
            headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
            body: JSON.stringify({ sourcePath: '/tmp/plugin' })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Plugin install requires target=hub, target=runner:<machineId>, or target=all-runners.' })
    })

    it('routes Runner local directory browsing through Runner RPC and rejects offline targets', async () => {
        const online = makeMachine('runner-online', true)
        const offline = makeMachine('runner-offline', false)
        const calls: string[] = []
        const app = createApp({ listLocalDirectory: async () => { throw new Error('Hub manager must not browse Runner paths') } } as never, {
            getMachineByNamespace: (machineId: string) => machineId === 'runner-online' ? online : offline,
            listRunnerPluginDirectory: async (machineId: string, path?: string) => {
                calls.push(`${machineId}:${path}`)
                return { success: true, path: path ?? '/runner', entries: [] }
            }
        } as never)
        const headers = { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' }

        const ok = await app.request('/api/plugins/local-directory?target=runner:runner-online', {
            method: 'POST',
            headers,
            body: JSON.stringify({ path: '/runner/plugins' })
        })
        const offlineResponse = await app.request('/api/plugins/local-directory?target=runner:runner-offline', {
            method: 'POST',
            headers,
            body: JSON.stringify({ path: '/runner/plugins' })
        })

        expect(ok.status).toBe(200)
        expect(calls).toEqual(['runner-online:/runner/plugins'])
        expect(offlineResponse.status).toBe(503)
        expect(await offlineResponse.json()).toEqual({ error: 'Runner target is offline' })
    })

    it('forwards runner install-local to Runner RPC without reading Hub local paths', async () => {
        const online = makeMachine('runner-1', true)
        const managerCalls: string[] = []
        const runnerCalls: string[] = []
        const app = createApp({
            installLocalPlugin: async (sourcePath: string) => {
                managerCalls.push(sourcePath)
                return installResult('installed')
            }
        } as never, {
            getMachineByNamespace: () => online,
            installRunnerPluginLocal: async (machineId: string, body: { sourcePath: string }) => {
                runnerCalls.push(`${machineId}:${body.sourcePath}`)
                return runnerInstallResult(machineId)
            }
        } as never)

        const response = await app.request('/api/plugins/install-local?target=runner:runner-1', {
            method: 'POST',
            headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
            body: JSON.stringify({ sourcePath: '/runner/local/plugin', enable: true })
        })

        expect(response.status).toBe(200)
        expect(managerCalls).toEqual([])
        expect(runnerCalls).toEqual(['runner-1:/runner/local/plugin'])
    })

    it('returns per-target install results for partial all-runners failures', async () => {
        const online = makeMachine('runner-online', true)
        const offline = makeMachine('runner-offline', false)
        const app = createApp({ listPlugins: () => [] } as never, {
            getMachinesByNamespace: () => [online, offline],
            installRunnerPluginLocal: async (machineId: string) => runnerInstallResult(machineId)
        } as never)

        const response = await app.request('/api/plugins/install-local?target=all-runners', {
            method: 'POST',
            headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
            body: JSON.stringify({ sourcePath: '/runner/local/plugin' })
        })

        expect(response.status).toBe(200)
        const payload = await response.json() as PluginInstallResult
        expect(payload.ok).toBe(false)
        expect(payload.targetResults).toHaveLength(2)
        expect(payload.targetResults?.find((entry) => entry.target.scope === 'runner:runner-online')?.ok).toBe(true)
        expect(payload.targetResults?.find((entry) => entry.target.scope === 'runner:runner-offline')?.error).toBe('Runner target is offline')
    })

    it('prevalidates uploaded package checksums before Runner distribution', async () => {
        const online = makeMachine('runner-1', true)
        const calls: string[] = []
        const app = createApp({ listPlugins: () => [] } as never, {
            getMachineByNamespace: () => online,
            installRunnerPluginPackage: async (machineId: string) => {
                calls.push(machineId)
                return runnerInstallResult(machineId)
            }
        } as never)

        const response = await app.request('/api/plugins/install-package?target=runner:runner-1', {
            method: 'POST',
            headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                filename: 'plugin.tgz',
                contentBase64: Buffer.from('not-a-package').toString('base64'),
                checksum: 'sha256:deadbeef'
            })
        })

        expect(response.status).toBe(400)
        expect((await response.json() as { error: string }).error).toContain('checksum mismatch')
        expect(calls).toEqual([])
    })

    it('prevalidates uploaded package manifest metadata before Runner distribution', async () => {
        const online = makeMachine('runner-1', true)
        const calls: string[] = []
        const packageFixture = makeTgzPackage('com.example.package', 'com.example.mismatch')
        try {
            const app = createApp({ listPlugins: () => [] } as never, {
                getMachineByNamespace: () => online,
                installRunnerPluginPackage: async (machineId: string) => {
                    calls.push(machineId)
                    return runnerInstallResult(machineId)
                }
            } as never)

            const response = await app.request('/api/plugins/install-package?target=runner:runner-1', {
                method: 'POST',
                headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
                body: JSON.stringify(packageFixture.body)
            })

            expect(response.status).toBe(400)
            expect((await response.json() as { error: string }).error).toContain('metadata does not match')
            expect(calls).toEqual([])
        } finally {
            packageFixture.cleanup()
        }
    })

    it('returns per-target results for uploaded package all-runners distribution', async () => {
        const online = makeMachine('runner-online', true)
        const offline = makeMachine('runner-offline', false)
        const packageFixture = makeTgzPackage()
        try {
            const app = createApp({ listPlugins: () => [] } as never, {
                getMachinesByNamespace: () => [online, offline],
                installRunnerPluginPackage: async (machineId: string) => runnerInstallResult(machineId)
            } as never)

            const response = await app.request('/api/plugins/install-package?target=all-runners', {
                method: 'POST',
                headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
                body: JSON.stringify(packageFixture.body)
            })

            expect(response.status).toBe(200)
            const payload = await response.json() as PluginInstallResult
            expect(payload.ok).toBe(false)
            expect(payload.targetResults).toHaveLength(2)
            expect(payload.targetResults?.find((entry) => entry.target.scope === 'runner:runner-online')?.ok).toBe(true)
            expect(payload.targetResults?.find((entry) => entry.target.scope === 'runner:runner-offline')?.error).toBe('Runner target is offline')
        } finally {
            packageFixture.cleanup()
        }
    })

    it('keeps Hub and Runner delete actions isolated by target', async () => {
        const online = makeMachine('runner-1', true)
        const calls: string[] = []
        const app = createApp({
            deletePlugin: async (id: string) => {
                calls.push(`hub:${id}`)
                return deleteResult()
            }
        } as never, {
            getMachineByNamespace: () => online,
            deleteRunnerPlugin: async (machineId: string, id: string) => {
                calls.push(`runner:${machineId}:${id}`)
                return { ...deleteResult(), target: { scope: `runner:${machineId}`, runtime: 'runner', machineId, active: true, stale: false } }
            }
        } as never)
        const headers = { authorization: `Bearer ${await token()}` }

        const hubDelete = await app.request('/api/plugins/com.example.plugin?target=hub', { method: 'DELETE', headers })
        const runnerDelete = await app.request('/api/plugins/com.example.plugin?target=runner:runner-1', { method: 'DELETE', headers })

        expect(hubDelete.status).toBe(200)
        expect(runnerDelete.status).toBe(200)
        expect(calls).toEqual(['hub:com.example.plugin', 'runner:runner-1:com.example.plugin'])
    })

    it('returns per-target delete results for all-runners', async () => {
        const online = makeMachine('runner-online', true)
        const offline = makeMachine('runner-offline', false)
        const app = createApp({ listPlugins: () => [] } as never, {
            getMachinesByNamespace: () => [online, offline],
            deleteRunnerPlugin: async (machineId: string, id: string) => ({
                ...deleteResult(),
                pluginId: id,
                rootPath: `/runner/${machineId}/plugins/${id}`,
                target: { scope: `runner:${machineId}`, runtime: 'runner', machineId, active: true, stale: false }
            })
        } as never)

        const response = await app.request('/api/plugins/com.example.plugin?target=all-runners', {
            method: 'DELETE',
            headers: { authorization: `Bearer ${await token()}` }
        })

        expect(response.status).toBe(200)
        const payload = await response.json() as PluginDeleteResult
        expect(payload.ok).toBe(false)
        expect(payload.targetResults).toHaveLength(2)
        expect(payload.targetResults?.find((entry) => entry.target.scope === 'runner:runner-online')?.deleted).toBe(true)
        expect(payload.targetResults?.find((entry) => entry.target.scope === 'runner:runner-offline')?.error).toBe('Runner target is offline')
    })

    it('updates Hub and Runner plugin config through isolated target paths', async () => {
        const online = makeMachine('runner-1', true)
        const calls: string[] = []
        const app = createApp({
            updatePluginConfig: async (id: string, config: Record<string, unknown>) => {
                calls.push(`hub:${id}:${String(config.label)}`)
                return reloadResult('reloaded')
            }
        } as never, {
            getMachineByNamespace: () => online,
            updateRunnerPluginConfig: async (machineId: string, id: string, config: Record<string, unknown>) => {
                calls.push(`runner:${machineId}:${id}:${String(config.label)}`)
                return runnerReloadResult(machineId)
            }
        } as never)
        const headers = { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' }

        const hubConfig = await app.request('/api/plugins/com.example.plugin/config?target=hub', {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ config: { label: 'hub' } })
        })
        const runnerConfig = await app.request('/api/plugins/com.example.plugin/config?target=runner:runner-1', {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ config: { label: 'runner' } })
        })

        expect(hubConfig.status).toBe(200)
        expect(runnerConfig.status).toBe(200)
        expect(calls).toEqual(['hub:com.example.plugin:hub', 'runner:runner-1:com.example.plugin:runner'])
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
        expect((await app.request('/api/plugins/install-local?target=hub', { method: 'POST', headers, body: JSON.stringify({ sourcePath: '/tmp/plugin' }) })).status).toBe(200)
        expect((await app.request('/api/plugins/local-directory', { method: 'POST', headers, body: JSON.stringify({ path: '/tmp' }) })).status).toBe(200)
        expect((await app.request('/api/plugins/com.example.plugin', { method: 'DELETE', headers })).status).toBe(200)
        expect((await app.request('/api/plugins/install-example', { method: 'POST', headers, body: JSON.stringify({ enable: true }) })).status).toBe(404)
        const invalidInstall = await app.request('/api/plugins/install-local?target=hub', {
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
