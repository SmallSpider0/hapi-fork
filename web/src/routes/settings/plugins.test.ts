import { describe, expect, it } from 'vitest'
import type { PluginListItem } from '@hapi/protocol/plugins/admin'
import { groupPluginListForDisplay } from './plugins'

function plugin(overrides: Partial<PluginListItem> & Pick<PluginListItem, 'id'>): PluginListItem {
    return {
        id: overrides.id,
        name: overrides.name ?? overrides.id,
        version: overrides.version ?? '0.1.0',
        description: overrides.description,
        source: overrides.source ?? 'bundled',
        status: overrides.status ?? 'disabled',
        enabled: overrides.enabled ?? false,
        active: overrides.active ?? false,
        rootPath: overrides.rootPath ?? `/plugins/${overrides.id}`,
        manifestPath: overrides.manifestPath ?? `/plugins/${overrides.id}/hapi.plugin.json`,
        runtimes: overrides.runtimes ?? {},
        diagnostics: overrides.diagnostics ?? [],
        target: overrides.target,
        configScope: overrides.configScope,
        updatedAt: overrides.updatedAt,
        install: overrides.install
    }
}

describe('groupPluginListForDisplay', () => {
    it('collapses the Hub descriptor mirror and Runner runtime row into one plugin group', () => {
        const groups = groupPluginListForDisplay([
            plugin({
                id: 'com.example.cross-runner',
                target: { scope: 'hub', runtime: 'hub', active: true, stale: false },
                runtimes: { runner: { entry: 'dist/runner.js', active: false } }
            }),
            plugin({
                id: 'com.example.cross-runner',
                target: { scope: 'runner:runner-1', runtime: 'runner', machineId: 'runner-1', active: true, stale: false },
                runtimes: { runner: { entry: 'dist/runner.js', active: false } }
            })
        ])

        expect(groups).toHaveLength(1)
        expect(groups[0]).toMatchObject({
            id: 'com.example.cross-runner',
            enabled: false,
            active: false,
            status: 'disabled',
            primary: {
                target: { scope: 'runner:runner-1' }
            }
        })
        expect(groups[0]?.plugins.map((entry) => entry.target?.scope).sort()).toEqual(['hub', 'runner:runner-1'])
    })

    it('surfaces the worst target status while preserving active/enabled aggregate flags', () => {
        const groups = groupPluginListForDisplay([
            plugin({
                id: 'com.example.cross',
                target: { scope: 'hub', runtime: 'hub', active: true, stale: false },
                runtimes: { hub: { entry: 'hub.js', active: true } },
                status: 'active',
                enabled: true,
                active: true
            }),
            plugin({
                id: 'com.example.cross',
                target: { scope: 'runner:runner-1', runtime: 'runner', machineId: 'runner-1', active: true, stale: false },
                runtimes: { runner: { entry: 'runner.js', active: false } },
                status: 'failed',
                enabled: true,
                active: false,
                diagnostics: [{ severity: 'error', code: 'boom', message: 'runner failed' }]
            })
        ])

        expect(groups).toHaveLength(1)
        expect(groups[0]).toMatchObject({
            id: 'com.example.cross',
            status: 'failed',
            enabled: true,
            active: true
        })
        expect(groups[0]?.diagnostics).toEqual([expect.objectContaining({ code: 'boom' })])
    })

    it('keeps different plugin ids as separate display groups', () => {
        const groups = groupPluginListForDisplay([
            plugin({ id: 'com.example.b', target: { scope: 'hub', runtime: 'hub', active: true, stale: false } }),
            plugin({ id: 'com.example.a', target: { scope: 'hub', runtime: 'hub', active: true, stale: false } })
        ])

        expect(groups.map((group) => group.id)).toEqual(['com.example.a', 'com.example.b'])
    })
})
