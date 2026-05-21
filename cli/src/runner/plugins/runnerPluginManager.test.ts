import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunnerPluginManager } from './runnerPluginManager'

function writeManifest(root: string, overrides: Record<string, unknown> = {}): void {
    writeFileSync(join(root, 'hapi.plugin.json'), JSON.stringify({
        id: 'com.example.runner',
        name: 'Runner Plugin',
        version: '0.1.0',
        pluginApiVersion: '0.1',
        runtimes: {
            runner: { entry: 'dist/runner.js' }
        },
        contributions: {
            runner: {
                environmentProviders: [{ id: 'env-provider', displayName: 'Env Provider' }]
            }
        },
        ...overrides
    }, null, 2))
}

function writeState(hapiHome: string, enabled = true): void {
    writeFileSync(join(hapiHome, 'plugins.json'), JSON.stringify({
        enabled: { 'com.example.runner': { enabled } }
    }, null, 2))
}

describe('RunnerPluginManager runtime', () => {
    let testDir: string
    let pluginRoot: string
    let runnerEntry: string
    let logFile: string

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'hapi-runner-plugin-manager-'))
        pluginRoot = join(testDir, 'plugins', 'com.example.runner')
        runnerEntry = join(pluginRoot, 'dist', 'runner.js')
        logFile = join(testDir, 'runner-events.jsonl')
        mkdirSync(join(pluginRoot, 'dist'), { recursive: true })
        writeFileSync(runnerEntry, 'throw new Error("runner runtime must not import while disabled")')
        writeManifest(pluginRoot)
    })

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true })
    })

    it('discovers Runner runtime declarations without importing disabled runner entry', async () => {
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })

        await manager.start()
        const plugins = manager.listPlugins()

        expect(plugins).toHaveLength(1)
        expect(plugins[0]).toMatchObject({
            id: 'com.example.runner',
            active: false,
            runtimes: { runner: { entry: 'dist/runner.js', active: false } },
            target: { scope: 'runner:runner-1', runtime: 'runner', machineId: 'runner-1', active: true, stale: false }
        })
        expect(manager.getInventory()).toMatchObject({ machineId: 'runner-1', plugins: [{ id: 'com.example.runner' }] })
    })

    it('activates enabled Runner plugins and writes Runner-local state/config', async () => {
        writeFileSync(runnerEntry, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                appendFileSync(log, JSON.stringify({ type: 'activate', machineId: ctx.machineId, label: ctx.config.get('label') }) + '\\n');
                ctx.runtime.registerEnvironmentProvider({ id: 'env' });
            }
        `)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })
        await manager.start()

        const result = await manager.enablePlugin('com.example.runner', { label: 'Runner' })
        const state = JSON.parse(readFileSync(join(testDir, 'plugins.json'), 'utf8')) as { enabled: Record<string, { enabled: boolean; config?: Record<string, unknown> }> }

        expect(result.ok).toBe(true)
        expect(result.results[0]).toMatchObject({ id: 'com.example.runner', action: 'activated', status: 'active' })
        expect(state.enabled['com.example.runner']).toEqual({ enabled: true, config: { label: 'Runner' } })
        expect(manager.listPlugins()[0]).toMatchObject({ status: 'active', enabled: true, active: true, runtimes: { runner: { active: true } } })
        expect(readFileSync(logFile, 'utf8')).toContain('"machineId":"runner-1"')
    })

    it('ignores Hub-runtime-only plugins in the Runner process', async () => {
        writeManifest(pluginRoot, {
            runtimes: { hub: { entry: 'dist/hub.js' } },
            contributions: { hub: { notificationChannels: [{ id: 'hub', displayName: 'Hub' }] } }
        })
        writeFileSync(join(pluginRoot, 'dist', 'hub.js'), 'throw new Error("Runner must not import Hub runtime")')
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })

        const result = await manager.start()

        expect(result.ok).toBe(true)
        expect(manager.listPlugins()[0]).toMatchObject({ id: 'com.example.runner', status: 'enabled', active: false, runtimes: { hub: { active: false } } })
    })

    it('keeps the previous active Runner plugin when reload activation fails', async () => {
        writeFileSync(runnerEntry, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                appendFileSync(log, 'activate-v1\\n');
                ctx.runtime.registerEnvironmentProvider({ dispose() { appendFileSync(log, 'dispose-v1\\n'); } });
            }
        `)
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })
        await manager.start()
        expect(manager.listPlugins()[0]?.active).toBe(true)

        writeFileSync(runnerEntry, 'export function activate() { throw new Error("boom") }')
        const result = await manager.reload('com.example.runner')

        expect(result.ok).toBe(false)
        expect(result.results[0]).toMatchObject({ action: 'kept-previous', status: 'reload-failed' })
        expect(manager.listPlugins()[0]).toMatchObject({ status: 'reload-failed', active: true })
        expect(readFileSync(logFile, 'utf8')).not.toContain('dispose-v1')
        await manager.dispose()
        expect(readFileSync(logFile, 'utf8')).toContain('dispose-v1')
    })

    it('disposes Runner resources on disable and shutdown without throwing on dispose failures', async () => {
        writeFileSync(runnerEntry, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export function activate(ctx) {
                ctx.runtime.registerEnvironmentProvider({ dispose() { appendFileSync(log, 'dispose-env\\n'); } });
                ctx.runtime.registerSpawnHook({ dispose() { throw new Error('dispose failed'); } });
            }
        `)
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })
        await manager.start()

        const result = await manager.disablePlugin('com.example.runner')
        await manager.dispose()

        expect(result.ok).toBe(true)
        expect(result.results[0]).toMatchObject({ action: 'deactivated', status: 'disabled' })
        expect(readFileSync(logFile, 'utf8')).toContain('dispose-env')
    })


    it('disposes a plugin activated while shutdown is requested', async () => {
        writeFileSync(runnerEntry, `
            import { appendFileSync } from 'node:fs';
            const log = ${JSON.stringify(logFile)};
            export async function activate(ctx) {
                await new Promise((resolve) => setTimeout(resolve, 20));
                ctx.runtime.registerEnvironmentProvider({ dispose() { appendFileSync(log, 'dispose-race\\n'); } });
            }
        `)
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })

        const reload = manager.start()
        await new Promise((resolve) => setTimeout(resolve, 5))
        await manager.dispose()
        await reload

        expect(manager.listPlugins()[0]?.active).not.toBe(true)
        expect(readFileSync(logFile, 'utf8')).toContain('dispose-race')
    })

    it('reports activation failures without crashing the Runner manager', async () => {
        writeFileSync(runnerEntry, 'export function activate() { throw new Error("activation failed") }')
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })

        const result = await manager.start()

        expect(result.ok).toBe(false)
        expect(manager.listPlugins()[0]).toMatchObject({ status: 'failed', active: false })
        expect(manager.getDiagnostics().some((diagnostic) => diagnostic.code === 'runner-plugin-activate-failed')).toBe(true)
    })

    it('does not import invalid Runner plugins', async () => {
        const marker = join(testDir, 'invalid-imported')
        writeFileSync(runnerEntry, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); export function activate() {}`)
        writeManifest(pluginRoot, { id: 'bad/id' })
        writeState(testDir)
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })

        const result = await manager.start()

        expect(result.ok).toBe(false)
        expect(existsSync(marker)).toBe(false)
        expect(manager.listPlugins()[0]).toMatchObject({ status: 'invalid', active: false })
    })
})
