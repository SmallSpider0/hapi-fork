import { describe, expect, it } from 'vitest'
import { PluginWebContributionsSchema, type PluginWebContributionView } from '@hapi/protocol/plugins'
import { collectDeliveryNotBeforeComposerActions } from './composerActions'

describe('composer action contributions', () => {
    it('accepts deliveryNotBefore composer actions in the plugin web schema', () => {
        const parsed = PluginWebContributionsSchema.safeParse({
            composerActions: [{
                id: 'schedule',
                kind: 'deliveryNotBefore',
                label: { en: 'Schedule', 'zh-CN': '定时' },
                icon: 'clock',
                maxDelayMs: 60_000,
                presets: [{ id: 'one-minute', label: '+1m', delayMs: 60_000 }]
            }]
        })

        expect(parsed.success).toBe(true)
    })

    it('collects plugin-provided delivery actions from web contribution inventories', () => {
        const contribution: PluginWebContributionView = {
            pluginId: 'com.example.scheduler',
            pluginName: 'Example Scheduler',
            target: 'hub',
            contributions: {
                composerActions: [{
                    id: 'custom-schedule',
                    kind: 'deliveryNotBefore',
                    label: 'Custom schedule',
                    icon: 'clock',
                    maxDelayMs: 120_000,
                    presets: [{ id: 'two-minutes', label: '+2m', delayMs: 120_000 }]
                }]
            }
        }

        const actions = collectDeliveryNotBeforeComposerActions([contribution])

        expect(actions[0]).toMatchObject({
            id: 'custom-schedule',
            pluginId: 'com.example.scheduler',
            presets: [{ id: 'two-minutes', label: '+2m', delayMs: 120_000 }]
        })
        expect(collectDeliveryNotBeforeComposerActions([])).toEqual([])
    })
})
