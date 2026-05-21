import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '../sync/syncEngine'
import { HubPluginManager } from './pluginManager'
import { writePluginState } from '@hapi/protocol/plugins/foundation'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type JsonRecord = Record<string, unknown>

function createSession(): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: { path: '/tmp/project', host: 'host', flavor: 'codex' },
        metadataVersion: 0,
        agentState: { requests: {} },
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null
    }
}

function readJsonl(file: string): JsonRecord[] {
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as JsonRecord)
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'com.example.plugin',
        name: 'Plugin',
        version: '0.1.0',
        pluginApiVersion: '0.1',
        runtimes: { hub: { entry: 'dist/hub.js' } },
        contributions: { hub: { notificationChannels: [{ id: 'test', displayName: 'Test' }] } },
        ...overrides
    }
}

function writeManifest(root: string, value: Record<string, unknown>): void {
    writeFileSync(join(root, 'hapi.plugin.json'), JSON.stringify(value, null, 2))
}

function writePlugin(root: string, source: string): void {
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist', 'hub.js'), source)
}

describe('HubPluginManager', () => {
    let testDir: string
    let hapiHome: string
    let pluginRoot: string
    let logFile: string

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'hapi-plugin-manager-'))
        hapiHome = join(testDir, 'hapi-home')
        pluginRoot = join(hapiHome, 'plugins', 'com.example.plugin')
        logFile = join(testDir, 'events.jsonl')
        mkdirSync(pluginRoot, { recursive: true })
    })

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true })
    })

    it('activates enabled plugins and disables them without a Hub restart', async () => {
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            const write = (value) => appendFileSync(log, JSON.stringify(value) + '\\n');
            export function activate(ctx) {
                write({ type: 'activate', config: ctx.config.get('label') });
                ctx.notifications.registerChannel({
                    async send(event) { write({ type: 'send', eventType: event.type, label: ctx.config.get('label') }); },
                    async dispose() { write({ type: 'dispose', label: ctx.config.get('label') }); }
                });
            }
        `)
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true, config: { label: 'v1' } } }
        })

        const manager = new HubPluginManager({ hapiHome, watch: false })
        await manager.start()
        await manager.getNotificationChannel().sendReady(createSession())
        await manager.disablePlugin('com.example.plugin')
        await manager.getNotificationChannel().sendReady(createSession())
        await manager.dispose()

        const events = readJsonl(logFile)
        expect(events.filter((event) => event.type === 'send')).toHaveLength(1)
        expect(events).toContainEqual({ type: 'dispose', label: 'v1' })
        expect(manager.listPlugins()[0]?.active).toBe(false)
    })

    it('reloads changed config and sends with the new active instance', async () => {
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            const write = (value) => appendFileSync(log, JSON.stringify(value) + '\\n');
            export function activate(ctx) {
                ctx.notifications.registerChannel({
                    async send(event) { write({ type: 'send', label: ctx.config.get('label') }); },
                    async dispose() { write({ type: 'dispose', label: ctx.config.get('label') }); }
                });
            }
        `)
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true, config: { label: 'v1' } } }
        })

        const manager = new HubPluginManager({ hapiHome, watch: false })
        await manager.start()
        await manager.getNotificationChannel().sendReady(createSession())
        const result = await manager.updatePluginConfig('com.example.plugin', { label: 'v2' })
        await manager.getNotificationChannel().sendReady(createSession())
        await manager.dispose()

        expect(result.results[0]?.action).toBe('reloaded')
        expect(readJsonl(logFile).filter((event) => event.type === 'send').map((event) => event.label)).toEqual(['v1', 'v2'])
    })

    it('keeps the previous active instance when reload activation fails', async () => {
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                ctx.notifications.registerChannel({ async send() { appendFileSync(log, JSON.stringify({ type: 'old-send' }) + '\\n'); } });
            }
        `)
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })

        const manager = new HubPluginManager({ hapiHome, watch: false, env: { PLUGIN_SECRET: 'super-secret' } })
        await manager.start()
        await sleep(5)
        writePlugin(pluginRoot, `export function activate() { throw new Error('boom super-secret'); }`)
        writeManifest(pluginRoot, manifest({ version: '0.1.1', permissions: { secrets: ['PLUGIN_SECRET'] } }))
        const result = await manager.reload('com.example.plugin')
        await manager.getNotificationChannel().sendReady(createSession())
        await manager.dispose()

        expect(result.results[0]?.action).toBe('kept-previous')
        expect(result.results[0]?.status).toBe('reload-failed')
        expect(JSON.stringify(result)).not.toContain('super-secret')
        expect(readJsonl(logFile)).toContainEqual({ type: 'old-send' })
    })

    it('does not import disabled or invalid plugins during reload', async () => {
        writePlugin(pluginRoot, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(logFile)}, 'imported'); export function activate() {}`)
        writeManifest(pluginRoot, manifest({ id: 'bad/id' }))
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'bad/id': { enabled: true } }
        })

        const manager = new HubPluginManager({ hapiHome, watch: false })
        await manager.start()
        await Promise.all([manager.reload(), manager.reload()])
        await manager.dispose()

        expect(existsSync(logFile)).toBe(false)
        expect(manager.listPlugins()[0]?.status).toBe('invalid')
    })

    it('reports incompatible reloads as not ok and refuses enablement', async () => {
        writePlugin(pluginRoot, 'export function activate() {}')
        writeManifest(pluginRoot, manifest({ compatibility: { os: ['darwin'] } }))

        const manager = new HubPluginManager({ hapiHome, watch: false })
        const result = await manager.start()
        await expect(manager.enablePlugin('com.example.plugin')).rejects.toThrow('cannot be enabled')
        await manager.dispose()

        expect(result.ok).toBe(false)
        expect(result.results[0]?.status).toBe('incompatible')
    })

    it('rejects redacted placeholders in config updates', async () => {
        writePlugin(pluginRoot, 'export function activate() {}')
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true, config: { apiToken: 'secret-value' } } }
        })

        const manager = new HubPluginManager({ hapiHome, watch: false })
        await manager.start()
        await expect(manager.updatePluginConfig('com.example.plugin', { apiToken: '[REDACTED]' })).rejects.toThrow('redacted placeholder')
        await manager.dispose()
    })

    it('deletes user-home plugin files and removes saved state', async () => {
        writePlugin(pluginRoot, 'export function activate(ctx) { ctx.notifications.registerChannel({ async dispose() {} }) }')
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true, config: { label: 'v1' } } }
        })

        const manager = new HubPluginManager({ hapiHome, watch: false })
        await manager.start()
        expect(manager.listPlugins()[0]?.active).toBe(true)
        const result = await manager.deletePlugin('com.example.plugin')
        await manager.dispose()

        expect(result.deleted).toBe(true)
        expect(result.plugins.some((entry) => entry.id === 'com.example.plugin')).toBe(false)
        expect(existsSync(pluginRoot)).toBe(false)
        const state = JSON.parse(readFileSync(join(hapiHome, 'plugins.json'), 'utf8')) as { enabled: Record<string, unknown> }
        expect(state.enabled['com.example.plugin']).toBeUndefined()
    })

    it('installs local plugin directories into the user plugin directory', async () => {
        const sourceRoot = join(testDir, 'source-plugin')
        mkdirSync(sourceRoot, { recursive: true })
        writePlugin(sourceRoot, 'export function activate() {}')
        writeManifest(sourceRoot, manifest({ id: 'com.local.installed', name: 'Local Plugin' }))

        const manager = new HubPluginManager({ hapiHome, watch: false })
        await manager.start()
        const result = await manager.installLocalPlugin(sourceRoot, { reload: true })
        await manager.dispose()

        expect(result.action).toBe('installed')
        expect(result.pluginId).toBe('com.local.installed')
        expect(result.plugin?.enabled).toBe(false)
        expect(existsSync(join(hapiHome, 'plugins', 'com.local.installed', 'hapi.plugin.json'))).toBe(true)
    })

    it('lists Hub-local directories for plugin install browsing', async () => {
        writePlugin(pluginRoot, 'export function activate() {}')
        writeManifest(pluginRoot, manifest())
        const manager = new HubPluginManager({ hapiHome, watch: false })
        await manager.start()
        const result = await manager.listLocalDirectory(join(hapiHome, 'plugins'))
        await manager.dispose()

        expect(result.success).toBe(true)
        expect(result.entries?.find((entry) => entry.name === 'com.example.plugin')?.hasPluginManifest).toBe(true)
    })

    it('reloads changed entry files through explicit reload', async () => {
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                ctx.notifications.registerChannel({ async send() { appendFileSync(log, JSON.stringify({ version: 'v1' }) + '\\n'); } });
            }
        `)
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })

        const manager = new HubPluginManager({ hapiHome, watch: false })
        await manager.start()
        await manager.getNotificationChannel().sendReady(createSession())
        await sleep(5)
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                ctx.notifications.registerChannel({ async send() { appendFileSync(log, JSON.stringify({ version: 'v2' }) + '\\n'); } });
            }
        `)
        const result = await manager.reload('com.example.plugin')
        await manager.getNotificationChannel().sendReady(createSession())
        await manager.dispose()

        expect(result.results[0]?.action).toBe('reloaded')
        expect(readJsonl(logFile).map((event) => event.version)).toEqual(['v1', 'v2'])
    })

    it('watches plugins.json and applies debounced reloads when available', async () => {
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                ctx.notifications.registerChannel({ async send(event) { appendFileSync(log, JSON.stringify({ type: 'send', eventType: event.type }) + '\\n'); } });
            }
        `)
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: false } }
        })

        const manager = new HubPluginManager({ hapiHome, watch: true, watchDebounceMs: 20 })
        await manager.start()
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })
        await sleep(250)
        await manager.getNotificationChannel().sendReady(createSession())
        await manager.dispose()

        expect(readJsonl(logFile)).toContainEqual({ type: 'send', eventType: 'ready' })
    })

    it('watches nested hub entry directory changes and reloads them when available', async () => {
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                ctx.notifications.registerChannel({ async send() { appendFileSync(log, JSON.stringify({ version: 'v1' }) + '\\n'); } });
            }
        `)
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })

        const manager = new HubPluginManager({ hapiHome, watch: true, watchDebounceMs: 20 })
        await manager.start()
        await manager.getNotificationChannel().sendReady(createSession())
        await sleep(5)
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                ctx.notifications.registerChannel({ async send() { appendFileSync(log, JSON.stringify({ version: 'v2' }) + '\\n'); } });
            }
        `)
        await sleep(300)
        await manager.getNotificationChannel().sendReady(createSession())
        await manager.dispose()

        expect(readJsonl(logFile).map((event) => event.version)).toEqual(['v1', 'v2'])
    })

})
