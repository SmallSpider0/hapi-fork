import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

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
        delete process.env.CLI_API_TOKEN
        vi.doUnmock('@/api/pluginAdmin')
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


    it('refuses to persist declared, secret-shaped, or redacted config values', async () => {
        writeFileSync(join(pluginRoot, 'hub.js'), 'export function activate() {}')
        writeManifest(pluginRoot, { permissions: { secrets: ['PLUGIN_TOKEN'] } })
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await expect(handlePluginsCommand(['enable', 'com.example.plugin', '--yes', '--config', '{"nested":{"PLUGIN_TOKEN":"secret-value"}}'])).rejects.toThrow('declared secret')
        await expect(handlePluginsCommand(['enable', 'com.example.plugin', '--yes', '--config', '{"nested":{"webhookToken":"secret-value"}}'])).rejects.toThrow('secret-like field')
        await expect(handlePluginsCommand(['enable', 'com.example.plugin', '--yes', '--config', '{"nested":{"safe":"[REDACTED]"}}'])).rejects.toThrow('redacted placeholder')
        await handlePluginsCommand(['enable', 'com.example.plugin', '--yes', '--config', '{"url":"https://example.test"}'])

        const state = JSON.parse(readFileSync(join(hapiHome, 'plugins.json'), 'utf8')) as { enabled: Record<string, { config?: Record<string, unknown> }> }
        expect(JSON.stringify(state)).not.toContain('secret-value')
        expect(state.enabled['com.example.plugin']?.config).toEqual({ url: 'https://example.test' })
    })

    it('preserves scoped config when using legacy local config and enable commands', async () => {
        writeFileSync(join(pluginRoot, 'hub.js'), 'export function activate() {}')
        writeManifest(pluginRoot)
        writeFileSync(join(hapiHome, 'plugins.json'), JSON.stringify({
            enabled: {
                'com.example.plugin': {
                    enabled: false,
                    config: { label: 'legacy' },
                    configUpdatedAt: 1,
                    scopedConfig: {
                        'hub:com.example.plugin': { config: { label: 'Hub' }, updatedAt: 2 },
                        'runner:runner-1:com.example.plugin': { config: { label: 'Runner' }, updatedAt: 3 }
                    },
                    install: { sourceType: 'user-home', version: '0.1.0' }
                }
            }
        }, null, 2))
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['config', 'set', 'com.example.plugin', 'label', '"legacy-updated"'])
        await handlePluginsCommand(['enable', 'com.example.plugin', '--yes'])
        await handlePluginsCommand(['disable', 'com.example.plugin', '--yes'])

        const state = JSON.parse(readFileSync(join(hapiHome, 'plugins.json'), 'utf8')) as {
            enabled: Record<string, { config?: Record<string, unknown>; scopedConfig?: Record<string, { config: Record<string, unknown>; updatedAt?: number }>; install?: unknown }>
        }
        expect(state.enabled['com.example.plugin']?.config).toEqual({ label: 'legacy-updated' })
        expect(state.enabled['com.example.plugin']?.scopedConfig?.['hub:com.example.plugin']).toEqual({ config: { label: 'Hub' }, updatedAt: 2 })
        expect(state.enabled['com.example.plugin']?.scopedConfig?.['runner:runner-1:com.example.plugin']).toEqual({ config: { label: 'Runner' }, updatedAt: 3 })
        expect(state.enabled['com.example.plugin']?.install).toEqual({ sourceType: 'user-home', version: '0.1.0' })
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

    it('sends local install requests to the selected remote target without importing runtime code', async () => {
        const sourceRoot = join(testDir, 'source-plugin')
        const marker = join(testDir, 'imported-by-install')
        mkdirSync(sourceRoot, { recursive: true })
        writeFileSync(join(sourceRoot, 'hub.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); export function activate() {}`)
        writeManifest(sourceRoot, { id: 'com.local.install' })
        process.env.CLI_API_TOKEN = 'test-token'
        const installRemoteLocalPlugin = vi.fn(async () => ({
            ok: true,
            action: 'installed',
            pluginId: 'com.local.install',
            targetPath: '/runner/plugins/com.local.install',
            diagnostics: [],
            plugins: []
        }))
        vi.doMock('@/api/pluginAdmin', () => ({
            getRemotePlugin: vi.fn(),
            getRemotePlugins: vi.fn(),
            updateRemotePluginConfig: vi.fn(),
            reloadRemotePlugins: vi.fn(),
            installRemoteLocalPlugin,
            installRemotePackagePlugin: vi.fn()
        }))
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['install-local', sourceRoot, '--target', 'runner:runner-1', '--enable', '--reload', '--overwrite', '--json'])

        const payload = JSON.parse(logs.join('\n')) as { pluginId: string; action: string }
        expect(payload.pluginId).toBe('com.local.install')
        expect(payload.action).toBe('installed')
        expect(installRemoteLocalPlugin).toHaveBeenCalledWith('test-token', {
            sourcePath: sourceRoot,
            enable: true,
            reload: true,
            overwrite: true
        }, 120000, 'runner:runner-1')
        expect(existsSync(join(hapiHome, 'plugins', 'com.local.install', 'hapi.plugin.json'))).toBe(false)
        expect(existsSync(marker)).toBe(false)
    })

    it('uploads package installs with checksum and target scope', async () => {
        const packagePath = join(testDir, 'plugin.tgz')
        const content = Buffer.from('fake-package-bytes')
        writeFileSync(packagePath, content)
        process.env.CLI_API_TOKEN = 'test-token'
        const installRemotePackagePlugin = vi.fn(async () => ({
            ok: true,
            action: 'installed',
            pluginId: 'com.package.install',
            targetPath: '/hub/plugins/com.package.install',
            diagnostics: [],
            plugins: []
        }))
        vi.doMock('@/api/pluginAdmin', () => ({
            getRemotePlugin: vi.fn(),
            getRemotePlugins: vi.fn(),
            updateRemotePluginConfig: vi.fn(),
            reloadRemotePlugins: vi.fn(),
            installRemoteLocalPlugin: vi.fn(),
            installRemotePackagePlugin
        }))
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['install-package', packagePath, '--target', 'hub', '--json'])

        const expectedChecksum = `sha256:${createHash('sha256').update(content).digest('hex')}`
        expect(installRemotePackagePlugin).toHaveBeenCalledWith('test-token', expect.objectContaining({
            filename: 'plugin.tgz',
            contentBase64: content.toString('base64'),
            checksum: expectedChecksum,
            format: 'tgz',
            enable: false,
            reload: false,
            overwrite: false
        }), 120000, 'hub')
    })

    it('gets and sets remote scoped config with --target', async () => {
        process.env.CLI_API_TOKEN = 'test-token'
        const getRemotePlugin = vi.fn(async () => ({
            plugin: {
                id: 'com.example.plugin',
                config: { label: 'old' },
                configScope: 'runner:runner-1:com.example.plugin',
                configMetadata: {
                    scope: 'runner:runner-1:com.example.plugin',
                    pluginId: 'com.example.plugin',
                    runtime: 'runner',
                    target: { scope: 'runner:runner-1', runtime: 'runner', machineId: 'runner-1', active: true },
                    config: { label: 'old' },
                    source: 'scoped'
                }
            }
        }))
        const updateRemotePluginConfig = vi.fn(async () => ({ ok: true, results: [], plugins: [] }))
        vi.doMock('@/api/pluginAdmin', () => ({
            getRemotePlugin,
            getRemotePlugins: vi.fn(),
            updateRemotePluginConfig,
            reloadRemotePlugins: vi.fn(),
            installRemoteLocalPlugin: vi.fn(),
            installRemotePackagePlugin: vi.fn()
        }))
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['config', 'get', 'com.example.plugin', '--target', 'runner:runner-1', '--json'])
        await handlePluginsCommand(['config', 'set', 'com.example.plugin', 'label', '"new"', '--target', 'runner:runner-1', '--json'])

        expect(getRemotePlugin).toHaveBeenCalledWith('test-token', 'com.example.plugin', 5000, 'runner:runner-1')
        expect(updateRemotePluginConfig).toHaveBeenCalledWith('test-token', 'com.example.plugin', { config: { label: 'new' } }, 5000, 'runner:runner-1')
        expect(logs.join('\n')).not.toContain('secret-value')
    })

    it('passes --target to remote reload without treating the target value as a plugin id', async () => {
        process.env.CLI_API_TOKEN = 'test-token'
        const reloadRemotePlugins = vi.fn(async () => ({ ok: true, results: [], plugins: [] }))
        vi.doMock('@/api/pluginAdmin', () => ({
            getRemotePlugin: vi.fn(),
            getRemotePlugins: vi.fn(),
            updateRemotePluginConfig: vi.fn(),
            reloadRemotePlugins,
            installRemoteLocalPlugin: vi.fn(),
            installRemotePackagePlugin: vi.fn()
        }))
        const { handlePluginsCommand } = await importPlugins(hapiHome)

        await handlePluginsCommand(['reload', '--target', 'runner:runner-1', '--json'])

        expect(reloadRemotePlugins).toHaveBeenCalledWith('test-token', undefined, 5000, 'runner:runner-1')
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
                        nested: { webhookToken: 'nested-secret', apiKey: 'api-key-secret' }
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
        expect(output).not.toContain('api-key-secret')
        expect(output).toContain('[REDACTED]')
    })
})
