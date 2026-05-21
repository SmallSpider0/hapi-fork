import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

describe('RunnerPluginManager cold discovery', () => {
    let testDir: string
    let pluginRoot: string

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'hapi-runner-plugin-manager-'))
        pluginRoot = join(testDir, 'plugins', 'com.example.runner')
        mkdirSync(join(pluginRoot, 'dist'), { recursive: true })
        writeFileSync(join(pluginRoot, 'dist', 'runner.js'), 'throw new Error("runner runtime must not import during Phase4")')
        writeManifest(pluginRoot)
    })

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true })
    })

    it('discovers Runner runtime declarations without importing runner entry', async () => {
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

    it('updates Runner-local enable state and config through validated state writes', async () => {
        const manager = new RunnerPluginManager({ hapiHome: testDir, machineId: 'runner-1', env: {} })
        await manager.start()

        const result = await manager.enablePlugin('com.example.runner', { label: 'Runner' })
        const state = JSON.parse(readFileSync(join(testDir, 'plugins.json'), 'utf8')) as { enabled: Record<string, { enabled: boolean; config?: Record<string, unknown> }> }

        expect(result.ok).toBe(true)
        expect(state.enabled['com.example.runner']).toEqual({ enabled: true, config: { label: 'Runner' } })
        expect(manager.listPlugins()[0]).toMatchObject({ status: 'enabled', enabled: true, active: false })
    })
})
