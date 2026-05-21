import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, SyncEngine, SyncEvent, SyncEventListener } from '../sync/syncEngine'
import type { NotificationChannel, TaskNotification } from '../notifications/notificationTypes'
import { NotificationHub } from '../notifications/notificationHub'
import { loadHubPluginRuntime } from './hubPluginRuntime'
import { writePluginState } from '@hapi/protocol/plugins/foundation'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type JsonRecord = Record<string, unknown>

class FakeSyncEngine {
    private readonly listeners: Set<SyncEventListener> = new Set()
    private readonly sessions: Map<string, Session> = new Map()

    subscribe(listener: SyncEventListener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    getSession(sessionId: string): Session | undefined {
        return this.sessions.get(sessionId)
    }

    setSession(session: Session): void {
        this.sessions.set(session.id, session)
    }

    emit(event: SyncEvent): void {
        for (const listener of this.listeners) {
            listener(event)
        }
    }
}

class StubChannel implements NotificationChannel {
    readonly readySessions: Session[] = []

    async sendReady(session: Session): Promise<void> {
        this.readySessions.push(session)
    }

    async sendPermissionRequest(_session: Session): Promise<void> {}
    async sendTaskNotification(_session: Session, _notification: TaskNotification): Promise<void> {}
}

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: {
            path: '/repo/example',
            host: 'test-host',
            name: 'Example Session',
            flavor: 'codex',
            tools: ['SecretTool']
        },
        metadataVersion: 0,
        agentState: {
            requests: {
                req1: { tool: 'Edit', arguments: { secret: 'must-not-leak' }, createdAt: 1 }
            }
        },
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        ...overrides
    }
}

function writeManifest(root: string, manifest: Record<string, unknown>): void {
    writeFileSync(join(root, 'hapi.plugin.json'), JSON.stringify(manifest, null, 2))
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

function readJsonl(file: string): JsonRecord[] {
    if (!existsSync(file)) {
        return []
    }
    return readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as JsonRecord)
}

function writePlugin(root: string, source: string): void {
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist/hub.js'), source)
}

describe('Hub plugin notification runtime', () => {
    let testDir: string
    let hapiHome: string
    let pluginRoot: string
    let logFile: string

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'hapi-hub-plugin-runtime-'))
        hapiHome = join(testDir, 'hapi-home')
        pluginRoot = join(hapiHome, 'plugins', 'com.example.plugin')
        logFile = join(testDir, 'plugin-events.jsonl')
        mkdirSync(pluginRoot, { recursive: true })
    })

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true })
    })

    it('does not import disabled hub plugins', async () => {
        writePlugin(pluginRoot, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(logFile)}, 'imported'); export function activate() {}`)
        writeManifest(pluginRoot, manifest())

        const runtime = await loadHubPluginRuntime({ hapiHome })

        expect(runtime.notificationChannels).toHaveLength(0)
        expect(runtime.records[0]?.status).toBe('disabled')
        expect(existsSync(logFile)).toBe(false)
        await runtime.dispose()
    })

    it('does not import invalid manifests', async () => {
        writePlugin(pluginRoot, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(logFile)}, 'imported'); export function activate() {}`)
        writeManifest(pluginRoot, manifest({ id: 'bad/id' }))
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'bad/id': { enabled: true } }
        })

        const runtime = await loadHubPluginRuntime({ hapiHome })

        expect(runtime.records[0]?.status).toBe('invalid')
        expect(existsSync(logFile)).toBe(false)
        await runtime.dispose()
    })

    it('activates enabled hub plugins, sends narrow events, and disposes channels', async () => {
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            const write = (value) => appendFileSync(log, JSON.stringify(value) + '\\n');
            export async function activate(ctx) {
                write({ type: 'activate', config: ctx.config.get('serverUrl'), secret: ctx.secrets.get('BARK_TOKEN') });
                ctx.notifications.registerChannel({
                    async send(event) { write({ type: 'send', event }); },
                    async dispose() { write({ type: 'dispose' }); }
                });
            }
        `)
        writeManifest(pluginRoot, manifest({ permissions: { secrets: ['BARK_TOKEN'] } }))
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: {
                'com.example.plugin': {
                    enabled: true,
                    config: { serverUrl: 'https://api.day.app' }
                }
            }
        })

        const runtime = await loadHubPluginRuntime({
            hapiHome,
            publicUrl: 'https://hapi.example',
            env: { BARK_TOKEN: 'device-token' }
        })
        expect(runtime.notificationChannels).toHaveLength(1)
        expect(runtime.records[0]?.status).toBe('active')

        await runtime.notificationChannels[0]?.sendReady(createSession())
        await runtime.dispose()

        const events = readJsonl(logFile)
        expect(events[0]).toEqual({ type: 'activate', config: 'https://api.day.app', secret: 'device-token' })
        expect(events.at(-1)).toEqual({ type: 'dispose' })
        const sent = events.find((event) => event.type === 'send') as { event: JsonRecord }
        expect(sent.event.type).toBe('ready')
        expect(Object.keys(sent.event.session as JsonRecord).sort()).toEqual(['active', 'agent', 'id', 'name', 'namespace', 'path', 'url'])
        expect(sent.event.session).toMatchObject({
            id: 'session-1',
            namespace: 'default',
            active: true,
            name: 'Example Session',
            path: '/repo/example',
            agent: 'Codex',
            url: 'https://hapi.example/sessions/session-1'
        })
        expect(JSON.stringify(sent.event)).not.toContain('must-not-leak')
        expect(JSON.stringify(sent.event)).not.toContain('metadata')
        expect(JSON.stringify(sent.event)).not.toContain('agentState')
    })


    it('supports default function hub plugin exports', async () => {
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            export default function activate(ctx) {
                appendFileSync(${JSON.stringify(logFile)}, ctx.pluginId + '\\n');
                ctx.notifications.registerChannel({ async send() {} });
            }
        `)
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })

        const runtime = await loadHubPluginRuntime({ hapiHome })

        expect(runtime.records[0]?.status).toBe('active')
        expect(runtime.notificationChannels).toHaveLength(1)
        expect(readFileSync(logFile, 'utf8')).toContain('com.example.plugin')
        await runtime.dispose()
    })


    it('redacts declared secret values from plugin logger object arguments', async () => {
        writePlugin(pluginRoot, `
            export function activate(ctx) {
                ctx.logger.info('logger sees super-secret-value', { nested: ['safe', 'super-secret-value'] });
            }
        `)
        writeManifest(pluginRoot, manifest({ permissions: { secrets: ['PLUGIN_SECRET'] } }))
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })
        const consoleInfo = mock(() => undefined)
        const originalInfo = console.info
        console.info = consoleInfo
        try {
            const runtime = await loadHubPluginRuntime({ hapiHome, env: { PLUGIN_SECRET: 'super-secret-value' } })
            await runtime.dispose()
        } finally {
            console.info = originalInfo
        }

        const serializedCalls = JSON.stringify(consoleInfo.mock.calls)
        expect(serializedCalls).not.toContain('super-secret-value')
        expect(serializedCalls).toContain('[REDACTED]')
    })

    it('marks import failures as failed without leaking declared secret values', async () => {
        writePlugin(pluginRoot, `throw new Error('boom super-secret-value'); export function activate() {}`)
        writeManifest(pluginRoot, manifest({ permissions: { secrets: ['PLUGIN_SECRET'] } }))
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })

        const runtime = await loadHubPluginRuntime({ hapiHome, env: { PLUGIN_SECRET: 'super-secret-value' } })

        expect(runtime.records[0]?.status).toBe('failed')
        const serializedDiagnostics = JSON.stringify(runtime.diagnostics)
        expect(serializedDiagnostics).toContain('[REDACTED]')
        expect(serializedDiagnostics).not.toContain('super-secret-value')
        await runtime.dispose()
    })

    it('keeps Hub startup alive when activate throws', async () => {
        writePlugin(pluginRoot, `export async function activate() { throw new Error('activate failed') }`)
        writeManifest(pluginRoot, manifest())
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })

        const runtime = await loadHubPluginRuntime({ hapiHome })

        expect(runtime.records[0]?.status).toBe('failed')
        expect(runtime.notificationChannels).toHaveLength(0)
        expect(runtime.diagnostics.map((entry) => entry.code)).toContain('hub-plugin-activate-failed')
        await runtime.dispose()
    })

    it('emits missing secret diagnostics without secret values', async () => {
        writePlugin(pluginRoot, `export function activate() {}`)
        writeManifest(pluginRoot, manifest({ permissions: { secrets: ['MISSING_SECRET'] } }))
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })

        const runtime = await loadHubPluginRuntime({ hapiHome, env: {} })

        expect(runtime.diagnostics.map((entry) => entry.code)).toContain('missing-secret')
        expect(JSON.stringify(runtime.diagnostics)).not.toContain('undefined')
        await runtime.dispose()
    })

    it('isolates plugin channel send failures from other notification channels', async () => {
        writePlugin(pluginRoot, `
            export function activate(ctx) {
                ctx.notifications.registerChannel({ async send() { throw new Error('send failed super-secret-value') } });
            }
        `)
        writeManifest(pluginRoot, manifest({ permissions: { secrets: ['PLUGIN_SECRET'] } }))
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })
        const runtime = await loadHubPluginRuntime({ hapiHome, env: { PLUGIN_SECRET: 'super-secret-value' } })
        const engine = new FakeSyncEngine()
        const stub = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [runtime.notificationChannels[0]!, stub], {
            readyCooldownMs: 1,
            permissionDebounceMs: 1
        })
        const consoleError = mock(() => undefined)
        const originalError = console.error
        console.error = consoleError
        try {
            const session = createSession()
            engine.setSession(session)
            engine.emit({
                type: 'message-received',
                sessionId: session.id,
                message: {
                    id: 'message-1',
                    seq: 1,
                    localId: null,
                    createdAt: 0,
                    content: {
                        role: 'agent',
                        content: { id: 'event-1', type: 'event', data: { type: 'ready' } }
                    }
                }
            })
            await sleep(10)

            expect(stub.readySessions).toHaveLength(1)
            expect(consoleError).toHaveBeenCalled()
            const calls = consoleError.mock.calls as unknown as Array<[string, Error]>
            const loggedError = calls[0]?.[1]
            expect(loggedError?.message).not.toContain('super-secret-value')
            expect(loggedError?.message).toContain('[REDACTED]')
        } finally {
            console.error = originalError
            hub.stop()
            await runtime.dispose()
        }
    })

    it('continues disposing registrations after a channel dispose failure', async () => {
        writePlugin(pluginRoot, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                ctx.notifications.registerChannel({ async send() {}, async dispose() { appendFileSync(log, 'first\\n'); } });
                ctx.notifications.registerChannel({ async send() {}, async dispose() { throw new Error('dispose failed super-secret-value'); } });
            }
        `)
        writeManifest(pluginRoot, manifest({ permissions: { secrets: ['PLUGIN_SECRET'] } }))
        await writePluginState(join(hapiHome, 'plugins.json'), {
            enabled: { 'com.example.plugin': { enabled: true } }
        })
        const runtime = await loadHubPluginRuntime({ hapiHome, env: { PLUGIN_SECRET: 'super-secret-value' } })
        const consoleError = mock(() => undefined)
        const originalError = console.error
        console.error = consoleError
        try {
            await runtime.dispose()
        } finally {
            console.error = originalError
        }

        expect(readFileSync(logFile, 'utf8')).toContain('first')
        expect(consoleError).toHaveBeenCalled()
        const calls = consoleError.mock.calls as unknown as Array<[string, Error]>
        expect(calls[0]?.[1]?.message).not.toContain('super-secret-value')
        expect(calls[0]?.[1]?.message).toContain('[REDACTED]')
    })
})
