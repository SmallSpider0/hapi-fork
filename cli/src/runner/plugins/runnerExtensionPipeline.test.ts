import { describe, expect, it, vi } from 'vitest'
import { mergePathValue, resolveRunnerPluginSpawnPlan } from './runnerExtensionPipeline'

describe('runner plugin extension pipeline', () => {
    const baseInput = {
        machineId: 'runner-1',
        agent: 'codex',
        options: { directory: '/repo', agent: 'codex' as const },
        basePlan: {
            command: '/opt/hapi/current',
            args: ['codex', '--hapi-starting-mode', 'remote', '--started-by', 'runner'],
            displayArgs: ['codex', '--hapi-starting-mode', 'remote', '--started-by', 'runner'],
            mode: 'compiled' as const,
            cwd: '/repo',
            env: { PATH: '/usr/bin', SECRET_TOKEN: 'secret', HAPI_INVOKED_CWD: '/repo' }
        },
        timeoutMs: 20,
        pathDelimiter: ':'
    }

    it('merges environment provider output without leaking secret values into diagnostics', async () => {
        const result = await resolveRunnerPluginSpawnPlan({
            ...baseInput,
            environmentProviders: [{
                pluginId: 'com.example.env',
                id: 'env',
                priority: 0,
                order: 0,
                contribution: {
                    id: 'env',
                    provide: () => ({
                        env: { TOOL_HOME: '/opt/tool', HAPI_INVOKED_CWD: 'secret' },
                        pathPrepend: ['/opt/tool/bin']
                    })
                }
            }],
            commandResolvers: [],
            spawnHooks: []
        })

        expect(result.env.TOOL_HOME).toBe('/opt/tool')
        expect(result.env.PATH).toBe('/opt/tool/bin:/usr/bin')
        expect(result.env.HAPI_INVOKED_CWD).toBe('/repo')
        expect(JSON.stringify(result.diagnostics)).not.toContain('secret')
        expect(result.diagnostics.map((entry) => entry.code)).toContain('runner-extension-env-protected')
    })

    it('applies valid command resolver proposals and rejects invalid ones', async () => {
        const result = await resolveRunnerPluginSpawnPlan({
            ...baseInput,
            environmentProviders: [],
            commandResolvers: [
                {
                    pluginId: 'com.example.bad',
                    id: 'bad',
                    priority: 0,
                    order: 0,
                    contribution: {
                        id: 'bad',
                        resolve: () => ({ args: ['plugins', 'list'] })
                    }
                },
                {
                    pluginId: 'com.example.good',
                    id: 'good',
                    priority: 10,
                    order: 1,
                    contribution: {
                        id: 'good',
                        resolve: () => ({ args: ['codex', '--model', 'gpt-5.5'] })
                    }
                }
            ],
            spawnHooks: []
        })

        expect(result.command).toBe('/opt/hapi/current')
        expect(result.displayArgs).toEqual(['codex', '--model', 'gpt-5.5'])
        expect(result.args).toEqual(['codex', '--model', 'gpt-5.5'])
        expect(result.diagnostics.map((entry) => entry.code)).toContain('runner-extension-command-disallowed')
    })

    it('rewrites the display HAPI args tail in development mode while Core keeps the executable', async () => {
        const result = await resolveRunnerPluginSpawnPlan({
            ...baseInput,
            basePlan: {
                command: '/usr/bin/bun',
                args: ['--cwd', '/repo/cli', '/repo/cli/src/index.ts', 'codex'],
                displayArgs: ['codex'],
                mode: 'development',
                cwd: '/repo',
                env: {}
            },
            environmentProviders: [],
            commandResolvers: [{
                pluginId: 'com.example.cmd',
                id: 'cmd',
                priority: 0,
                order: 0,
                contribution: { id: 'cmd', resolve: () => ({ args: ['codex', '--model', 'gpt-5.5'] }) }
            }],
            spawnHooks: []
        })

        expect(result.command).toBe('/usr/bin/bun')
        expect(result.args).toEqual(['--cwd', '/repo/cli', '/repo/cli/src/index.ts', 'codex', '--model', 'gpt-5.5'])
        expect(result.displayArgs).toEqual(['codex', '--model', 'gpt-5.5'])
    })

    it('uses the current display arg tail when multiple development-mode resolvers override args', async () => {
        const result = await resolveRunnerPluginSpawnPlan({
            ...baseInput,
            basePlan: {
                command: '/usr/bin/bun',
                args: ['--cwd', '/repo/cli', '/repo/cli/src/index.ts', 'codex'],
                displayArgs: ['codex'],
                mode: 'development',
                cwd: '/repo',
                env: {}
            },
            environmentProviders: [],
            commandResolvers: [
                {
                    pluginId: 'com.example.first',
                    id: 'cmd',
                    priority: 0,
                    order: 0,
                    contribution: { id: 'cmd', resolve: () => ({ args: ['codex', '--model', 'a'] }) }
                },
                {
                    pluginId: 'com.example.second',
                    id: 'cmd',
                    priority: 1,
                    order: 1,
                    contribution: { id: 'cmd', resolve: () => ({ args: ['codex', '--model', 'b'] }) }
                }
            ],
            spawnHooks: []
        })

        expect(result.args).toEqual(['--cwd', '/repo/cli', '/repo/cli/src/index.ts', 'codex', '--model', 'b'])
        expect(result.displayArgs).toEqual(['codex', '--model', 'b'])
    })

    it('continues on throwing beforeSpawn hook unless hook explicitly blocks', async () => {
        const result = await resolveRunnerPluginSpawnPlan({
            ...baseInput,
            environmentProviders: [],
            commandResolvers: [],
            spawnHooks: [
                {
                    pluginId: 'com.example.throw',
                    id: 'throw',
                    priority: 0,
                    order: 0,
                    contribution: {
                        id: 'throw',
                        beforeSpawn: () => { throw new Error('boom') }
                    }
                },
                {
                    pluginId: 'com.example.block',
                    id: 'block',
                    priority: 1,
                    order: 1,
                    contribution: {
                        id: 'block',
                        beforeSpawn: () => ({ block: { reason: 'policy' } })
                    }
                }
            ]
        })

        expect(result.blocked).toEqual({ reason: 'policy' })
        expect(result.diagnostics.map((entry) => entry.code)).toContain('runner-extension-before-spawn-failed')
    })

    it('uses deterministic priority for env conflicts', async () => {
        const result = await resolveRunnerPluginSpawnPlan({
            ...baseInput,
            environmentProviders: [
                {
                    pluginId: 'com.example.high',
                    id: 'env',
                    priority: 10,
                    order: 0,
                    contribution: { id: 'env', provide: () => ({ env: { TOOL: 'high' } }) }
                },
                {
                    pluginId: 'com.example.low',
                    id: 'env',
                    priority: 0,
                    order: 1,
                    contribution: { id: 'env', provide: () => ({ env: { TOOL: 'low' } }) }
                }
            ],
            commandResolvers: [],
            spawnHooks: []
        })

        expect(result.env.TOOL).toBe('high')
    })

    it('isolates timed out providers', async () => {
        vi.useFakeTimers()
        try {
            const pending = resolveRunnerPluginSpawnPlan({
                ...baseInput,
                environmentProviders: [{
                    pluginId: 'com.example.slow',
                    id: 'slow',
                    priority: 0,
                    order: 0,
                    contribution: { id: 'slow', provide: () => new Promise(() => undefined) }
                }],
                commandResolvers: [],
                spawnHooks: []
            })
            await vi.advanceTimersByTimeAsync(25)
            const result = await pending
            expect(result.diagnostics.map((entry) => entry.code)).toContain('runner-extension-environment-failed')
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('mergePathValue', () => {
    it('merges Linux and macOS PATH with colon delimiter', () => {
        expect(mergePathValue({ base: '/usr/bin:/bin', prepend: ['/opt/bin'], append: ['/custom/bin'], delimiter: ':' }))
            .toBe('/opt/bin:/usr/bin:/bin:/custom/bin')
    })

    it('merges Windows PATH with semicolon delimiter', () => {
        expect(mergePathValue({ base: 'C:\\Windows;C:\\Tools', prepend: ['D:\\Agent\\bin'], append: ['E:\\Extra'], delimiter: ';' }))
            .toBe('D:\\Agent\\bin;C:\\Windows;C:\\Tools;E:\\Extra')
    })
})
