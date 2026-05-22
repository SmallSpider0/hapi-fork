import { describe, expect, it } from 'bun:test'
import { HAPI_PLUGIN_API_VERSION, type PluginManifestLite } from '@hapi/protocol/plugins'
import { buildPluginInstallPlan, inferPluginInstallPositions } from './installPlanner'
import type { PluginInstallTargetCandidate } from './installPlanner'

function manifest(overrides: Partial<PluginManifestLite> = {}): PluginManifestLite {
    return {
        id: 'com.example.plugin',
        name: 'Example',
        version: '1.0.0',
        pluginApiVersion: HAPI_PLUGIN_API_VERSION,
        ...overrides
    }
}

function hubCandidate(plugins: PluginInstallTargetCandidate['plugins'] = []): PluginInstallTargetCandidate {
    return {
        target: {
            scope: 'hub',
            runtime: 'hub',
            active: true,
            hostInfo: {
                runtime: 'hub',
                hapiVersion: '0.18.4',
                pluginApiVersion: HAPI_PLUGIN_API_VERSION,
                os: 'linux',
                arch: 'x64',
                supportedExtensionPoints: ['hub.messageAction', 'web.composerAction']
            }
        },
        plugins
    }
}

function runnerCandidate(machineId: string, options: {
    hapiVersion?: string
    active?: boolean
    plugins?: PluginInstallTargetCandidate['plugins']
} = {}): PluginInstallTargetCandidate {
    return {
        target: {
            scope: `runner:${machineId}`,
            runtime: 'runner',
            machineId,
            active: options.active ?? true,
            ...(options.active === false ? { error: 'Runner is offline.' } : {}),
            hostInfo: {
                runtime: 'runner',
                hapiVersion: options.hapiVersion ?? '0.18.4',
                pluginApiVersion: HAPI_PLUGIN_API_VERSION,
                os: 'linux',
                arch: 'x64',
                supportedExtensionPoints: ['runner.spawnHook', 'agent.capabilityProvider']
            }
        },
        plugins: options.plugins ?? []
    }
}

function planFor(manifestValue: PluginManifestLite, candidates: PluginInstallTargetCandidate[]) {
    return buildPluginInstallPlan({
        planId: 'plan-1',
        now: 1,
        manifest: manifestValue,
        request: {
            filename: 'plugin.tgz',
            contentBase64: 'AA==',
            checksum: 'sha256:test',
            format: 'tgz'
        },
        packageFormat: 'tgz',
        candidates
    })
}

describe('plugin install planner', () => {
    it('routes Web-only descriptors through Hub installation', () => {
        const plugin = manifest({
            contributions: {
                web: {
                    composerActions: [{
                        id: 'schedule',
                        kind: 'pluginMessageAction',
                        label: 'Schedule',
                        icon: 'clock',
                        handler: { position: 'hub', actionId: 'schedule.send' },
                        ui: { kind: 'button' }
                    }]
                }
            }
        })

        expect(inferPluginInstallPositions(plugin)).toEqual(['web', 'hub'])
        const plan = planFor(plugin, [hubCandidate(), runnerCandidate('runner-1')])
        expect(plan.positions).toEqual(['web', 'hub'])
        expect(plan.targets.map((target) => target.target.scope)).toEqual(['hub'])
        expect(plan.blockingErrors).toEqual([])
    })

    it('plans Hub plus compatible Runner targets and skips incompatible Runner versions', () => {
        const plugin = manifest({
            runtimes: {
                hub: { entry: 'hub.js' },
                runner: { entry: 'runner.js' }
            },
            compatibility: {
                runner: { hapi: '>=0.18.4' }
            }
        })

        const plan = planFor(plugin, [
            hubCandidate(),
            runnerCandidate('runner-ok', { hapiVersion: '0.18.4' }),
            runnerCandidate('runner-old', { hapiVersion: '0.17.0' })
        ])

        expect(plan.positions).toEqual(['hub', 'runner'])
        expect(plan.targets.find((target) => target.target.scope === 'runner:runner-ok')?.action).toBe('install')
        expect(plan.targets.find((target) => target.target.scope === 'runner:runner-old')?.action).toBe('skip')
        expect(plan.blockingErrors).toEqual([])
    })

    it('blocks Runner-only installs when no compatible Runner is ready', () => {
        const plugin = manifest({
            runtimes: { runner: { entry: 'runner.js' } },
            compatibility: {
                runner: { hapi: '>=0.18.4' }
            }
        })

        const plan = planFor(plugin, [hubCandidate(), runnerCandidate('runner-old', { hapiVersion: '0.17.0' })])

        expect(plan.positions).toEqual(['runner'])
        expect(plan.blockingErrors).toContain('Plugin requires at least 1 compatible Runner target(s), but only 0 are ready.')
    })
})
