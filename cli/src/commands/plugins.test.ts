import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type PluginsModule = typeof import('./plugins')

function writeManifest(root: string, overrides: Record<string, unknown> = {}) {
    writeFileSync(join(root, 'hapi.plugin.json'), JSON.stringify({
        id: 'com.example.plugin',
        name: 'Plugin',
        version: '0.1.0',
        pluginApiVersion: '0.1',
        runtimes: { hub: { entry: 'hub.js' } },
        ...overrides
    }, null, 2))
}

async function importPlugins(hapiHome: string): Promise<PluginsModule> {
    process.env.HAPI_HOME = hapiHome
    vi.resetModules()
    return await import('./plugins')
}

describe('hapi plugins command', () => {
    let testDir: string
    let hapiHome: string
    let pluginRoot: string
    let logs: string[]
    let errors: string[]

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'hapi-cli-plugins-'))
        hapiHome = join(testDir, 'home')
        pluginRoot = join(hapiHome, 'plugins', 'com.example.plugin')
        mkdirSync(pluginRoot, { recursive: true })
        logs = []
        errors = []
        vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })
        vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')) })
    })

    afterEach(() => {
        vi.restoreAllMocks()
        delete process.env.HAPI_HOME
        rmSync(testDir, { recursive: true, force: true })
    })

    it('lists discovered plugins as stable JSON', async () => {
        writeFileSync(join(pluginRoot, 'hub.js'), 'export function activate() {}')
        writeManifest(pluginRoot)
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['list', '--json'])

        const payload = JSON.parse(logs.join('\n')) as { plugins: Array<{ id: string; status: string; enabled: boolean }> }
        expect(payload.plugins).toMatchObject([{ id: 'com.example.plugin', status: 'disabled', enabled: false }])
    })

    it('enables and disables plugins with atomic plugins.json writes', async () => {
        writeFileSync(join(pluginRoot, 'hub.js'), 'export function activate() {}')
        writeManifest(pluginRoot)
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['enable', 'com.example.plugin', '--yes'])
        let state = JSON.parse(readFileSync(join(hapiHome, 'plugins.json'), 'utf8')) as { enabled: Record<string, { enabled: boolean }> }
        expect(state.enabled['com.example.plugin']?.enabled).toBe(true)

        await handlePluginsCommand(['disable', 'com.example.plugin', '--yes'])
        state = JSON.parse(readFileSync(join(hapiHome, 'plugins.json'), 'utf8')) as { enabled: Record<string, { enabled: boolean }> }
        expect(state.enabled['com.example.plugin']?.enabled).toBe(false)
        expect(existsSync(join(hapiHome, 'plugins.json.lock'))).toBe(false)
    })

    it('inspect and list do not import runtime code', async () => {
        const marker = join(testDir, 'imported')
        writeFileSync(join(pluginRoot, 'hub.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); export function activate() {}`)
        writeManifest(pluginRoot)
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['inspect', 'com.example.plugin', '--json'])
        await handlePluginsCommand(['list', '--json'])

        expect(existsSync(marker)).toBe(false)
    })

    it('sets config values without storing declared secrets', async () => {
        writeFileSync(join(pluginRoot, 'hub.js'), 'export function activate() {}')
        writeManifest(pluginRoot, { permissions: { secrets: ['PLUGIN_TOKEN'] } })
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['enable', 'com.example.plugin', '--yes', '--config', '{"url":"https://example.test"}'])
        await handlePluginsCommand(['config', 'set', 'com.example.plugin', 'retries', '3'])
        const state = JSON.parse(readFileSync(join(hapiHome, 'plugins.json'), 'utf8')) as { enabled: Record<string, { config: Record<string, unknown> }> }

        expect(state.enabled['com.example.plugin']?.config).toEqual({ url: 'https://example.test', retries: 3 })
        expect(JSON.stringify(state)).not.toContain('secret-value')
    })

    it('deletes user-home plugin files and state as JSON', async () => {
        writeFileSync(join(pluginRoot, 'hub.js'), 'export function activate() {}')
        writeManifest(pluginRoot)
        writeFileSync(join(hapiHome, 'plugins.json'), JSON.stringify({
            enabled: { 'com.example.plugin': { enabled: true, config: { label: 'v1' } } }
        }, null, 2))
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['delete', 'com.example.plugin', '--yes', '--json'])

        const payload = JSON.parse(logs.join('\n')) as { pluginId: string; deleted: boolean; rootPath: string }
        expect(payload.pluginId).toBe('com.example.plugin')
        expect(payload.deleted).toBe(true)
        expect(existsSync(pluginRoot)).toBe(false)
        const state = JSON.parse(readFileSync(join(hapiHome, 'plugins.json'), 'utf8')) as { enabled: Record<string, unknown> }
        expect(state.enabled['com.example.plugin']).toBeUndefined()
    })

    it('installs local plugin directories without importing runtime code', async () => {
        const sourceRoot = join(testDir, 'source-plugin')
        const marker = join(testDir, 'imported-by-install')
        mkdirSync(sourceRoot, { recursive: true })
        writeFileSync(join(sourceRoot, 'hub.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); export function activate() {}`)
        writeManifest(sourceRoot, { id: 'com.local.install' })
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['install-local', sourceRoot, '--json'])

        const payload = JSON.parse(logs.join('\n')) as { pluginId: string; action: string }
        expect(payload.pluginId).toBe('com.local.install')
        expect(payload.action).toBe('installed')
        expect(existsSync(join(hapiHome, 'plugins', 'com.local.install', 'hapi.plugin.json'))).toBe(true)
        expect(existsSync(marker)).toBe(false)
    })

    it('redacts config-shaped secrets when printing inspect and config output', async () => {
        writeFileSync(join(pluginRoot, 'hub.js'), 'export function activate() {}')
        writeManifest(pluginRoot, { permissions: { secrets: ['PLUGIN_TOKEN'] } })
        writeFileSync(join(hapiHome, 'plugins.json'), JSON.stringify({
            enabled: {
                'com.example.plugin': {
                    enabled: true,
                    config: {
                        url: 'https://example.test',
                        PLUGIN_TOKEN: 'secret-value',
                        nested: { webhookToken: 'nested-secret' }
                    }
                }
            }
        }, null, 2))
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['inspect', 'com.example.plugin', '--json'])
        await handlePluginsCommand(['config', 'get', 'com.example.plugin', '--json'])

        const output = logs.join('\n')
        expect(output).not.toContain('secret-value')
        expect(output).not.toContain('nested-secret')
        expect(output).toContain('[REDACTED]')
    })
})
