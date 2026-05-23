import { describe, expect, it } from 'vitest'
import { builtinAgentDescriptors } from '@hapi/protocol/plugins'
import {
    commonPermissionModesForAgents,
    parseRunnerLaunchPresetConfig,
    resolveRunnerLaunchPresetDrafts,
    serializeRunnerLaunchPresetConfig,
    type RunnerLaunchPresetDraft
} from './RunnerLaunchPresetsEditor'

describe('RunnerLaunchPresetsEditor helpers', () => {
    it('stores all-agent/all-workspace mode as empty scope instead of copying every option', () => {
        const presets: RunnerLaunchPresetDraft[] = [{
            id: 'all-default',
            label: 'All default',
            enabled: true,
            agentMode: 'all',
            agentIds: ['codex', 'claude'],
            directoryMode: 'all',
            directoryPrefixes: ['/repo'],
            applyToResume: false,
            defaults: { permissionMode: 'default', model: 'gpt-5-codex' }
        }]

        const serialized = serializeRunnerLaunchPresetConfig(presets)
        const rules = JSON.parse(String(serialized.rulesJson)) as Array<Record<string, unknown>>
        expect(rules[0]?.agentIds).toBeUndefined()
        expect(rules[0]?.directoryPrefixes).toBeUndefined()
        expect(rules[0]?.defaults).toEqual({ permissionMode: 'default', model: 'gpt-5-codex' })
    })

    it('migrates legacy flat config into a visual preset and serializes to rulesJson', () => {
        const parsed = parseRunnerLaunchPresetConfig({
            agentIds: 'codex',
            directoryPrefixes: '/repo',
            permissionMode: 'yolo',
            modelReasoningEffort: 'xhigh'
        })
        expect(parsed.presets[0]).toMatchObject({
            agentMode: 'selected',
            agentIds: ['codex'],
            directoryMode: 'selected',
            directoryPrefixes: ['/repo'],
            defaults: { permissionMode: 'yolo', modelReasoningEffort: 'xhigh' }
        })

        const serialized = serializeRunnerLaunchPresetConfig(parsed.presets, { agentIds: 'codex', permissionMode: 'yolo' })
        expect(serialized.agentIds).toBeUndefined()
        expect(serialized.permissionMode).toBeUndefined()
        expect(typeof serialized.rulesJson).toBe('string')
    })

    it('filters permission modes to the common modes for selected agents', () => {
        const descriptors = builtinAgentDescriptors()
        expect(commonPermissionModesForAgents(['codex', 'gemini'], descriptors, [])).toEqual(['default', 'read-only', 'safe-yolo', 'yolo'])
        expect(commonPermissionModesForAgents(['codex', 'claude'], descriptors, [])).toEqual(['default'])
    })

    it('resolves draft presets by specificity for test matching', () => {
        const presets: RunnerLaunchPresetDraft[] = [
            {
                id: 'all',
                label: 'All',
                enabled: true,
                agentMode: 'all',
                agentIds: [],
                directoryMode: 'all',
                directoryPrefixes: [],
                applyToResume: false,
                defaults: { model: 'base', permissionMode: 'default' }
            },
            {
                id: 'codex-repo',
                label: 'Codex Repo',
                enabled: true,
                agentMode: 'selected',
                agentIds: ['codex'],
                directoryMode: 'selected',
                directoryPrefixes: ['/repo'],
                applyToResume: false,
                defaults: { model: 'gpt-5-codex', permissionMode: 'yolo' }
            }
        ]
        const result = resolveRunnerLaunchPresetDrafts(presets, { agent: 'codex', directory: '/repo/app' })
        expect(result.matched.map((preset) => preset.id)).toEqual(['all', 'codex-repo'])
        expect(result.options).toEqual({ model: 'gpt-5-codex', permissionMode: 'yolo' })
    })
})
