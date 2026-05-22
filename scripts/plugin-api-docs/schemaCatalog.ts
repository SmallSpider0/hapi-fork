import type { ZodType } from 'zod'
import {
    AgentCapabilityProviderResultSchema,
    AgentCapabilityProviderSnapshotSchema,
    AgentDescriptorSchema,
    AgentHistoryImportResultSchema,
    PluginConfigScopeSchema,
    PluginConfigUpdateRequestSchema,
    PluginCapabilitiesResponseSchema,
    PluginCapabilityViewSchema,
    PluginDeleteResultSchema,
    PluginDetailResponseSchema,
    PluginDiagnosticsResponseSchema,
    PluginDisableRequestSchema,
    PluginEnableRequestSchema,
    PluginInstallLocalRequestSchema,
    PluginInstallPackageRequestSchema,
    PluginInstallResultSchema,
    PluginListResponseSchema,
    PluginLocalDirectoryListRequestSchema,
    PluginLocalDirectoryListResponseSchema,
    PluginManifestLiteSchema,
    PluginNotificationEventSchema,
    PluginReloadResultSchema,
    PluginStateFileSchema,
    PluginTargetScopeSchema,
    PluginWebContributionsSchema,
    PluginWebContributionViewSchema,
    RunnerCommandResolverProposalSchema,
    RunnerEnvironmentProposalSchema,
    RunnerPluginInventorySchema,
    RunnerResolvedSpawnPlanSchema,
    RunnerSpawnContextSchema,
    RunnerSpawnHookProposalSchema
} from '../../shared/src/plugins'

export type SchemaGroup = 'manifest' | 'admin' | 'runtime' | 'runner' | 'agent' | 'web' | 'state'

export type SchemaDoc = {
    id: string
    title: string
    group: SchemaGroup
    description: string
    schema: ZodType
}

export const schemaCatalog: SchemaDoc[] = [
    {
        id: 'plugin-manifest',
        title: 'PluginManifestLite',
        group: 'manifest',
        description: 'Cold-path hapi.plugin.json contract. Read before plugin code is imported.',
        schema: PluginManifestLiteSchema
    },
    {
        id: 'plugin-state-file',
        title: 'PluginStateFile',
        group: 'state',
        description: '$HAPI_HOME/plugins.json enable/config state. Secret values must not be stored here.',
        schema: PluginStateFileSchema
    },
    {
        id: 'plugin-target-scope',
        title: 'PluginTargetScope',
        group: 'admin',
        description: 'Target selector for Hub, one Runner, or all Runners.',
        schema: PluginTargetScopeSchema
    },
    {
        id: 'plugin-config-scope',
        title: 'PluginConfigScope',
        group: 'admin',
        description: 'Runtime/machine/agent-scoped config key.',
        schema: PluginConfigScopeSchema
    },
    {
        id: 'plugin-list-response',
        title: 'PluginListResponse',
        group: 'admin',
        description: 'Plugin inventory response for Hub and Runner targets.',
        schema: PluginListResponseSchema
    },
    {
        id: 'plugin-detail-response',
        title: 'PluginDetailResponse',
        group: 'admin',
        description: 'Detailed plugin metadata, diagnostics, permissions, config metadata, and contributions.',
        schema: PluginDetailResponseSchema
    },
    {
        id: 'plugin-diagnostics-response',
        title: 'PluginDiagnosticsResponse',
        group: 'admin',
        description: 'Flattened plugin diagnostics response.',
        schema: PluginDiagnosticsResponseSchema
    },
    {
        id: 'plugin-capabilities-response',
        title: 'PluginCapabilitiesResponse',
        group: 'admin',
        description: 'Aggregated capability readiness across Web, Hub, and Runner parts.',
        schema: PluginCapabilitiesResponseSchema
    },
    {
        id: 'plugin-capability-view',
        title: 'PluginCapabilityView',
        group: 'admin',
        description: 'One user-facing plugin capability with per-position part status and Web-safe descriptors.',
        schema: PluginCapabilityViewSchema
    },
    {
        id: 'plugin-reload-result',
        title: 'PluginReloadResult',
        group: 'admin',
        description: 'Reload/enable/disable/config result, including partial target results.',
        schema: PluginReloadResultSchema
    },
    {
        id: 'plugin-install-local-request',
        title: 'PluginInstallLocalRequest',
        group: 'admin',
        description: 'Install a plugin from a path local to the selected target machine.',
        schema: PluginInstallLocalRequestSchema
    },
    {
        id: 'plugin-install-package-request',
        title: 'PluginInstallPackageRequest',
        group: 'admin',
        description: 'Install a tgz/zip plugin package by upload payload.',
        schema: PluginInstallPackageRequestSchema
    },
    {
        id: 'plugin-install-result',
        title: 'PluginInstallResult',
        group: 'admin',
        description: 'Install result for Hub, one Runner, or all Runners.',
        schema: PluginInstallResultSchema
    },
    {
        id: 'plugin-delete-result',
        title: 'PluginDeleteResult',
        group: 'admin',
        description: 'Delete result for Hub, one Runner, or all Runners.',
        schema: PluginDeleteResultSchema
    },
    {
        id: 'plugin-enable-request',
        title: 'PluginEnableRequest',
        group: 'admin',
        description: 'Enable a plugin with optional non-secret config.',
        schema: PluginEnableRequestSchema
    },
    {
        id: 'plugin-disable-request',
        title: 'PluginDisableRequest',
        group: 'admin',
        description: 'Disable a plugin with optional reload control.',
        schema: PluginDisableRequestSchema
    },
    {
        id: 'plugin-config-update-request',
        title: 'PluginConfigUpdateRequest',
        group: 'admin',
        description: 'Replace a plugin scoped config object.',
        schema: PluginConfigUpdateRequestSchema
    },
    {
        id: 'plugin-local-directory-list-request',
        title: 'PluginLocalDirectoryListRequest',
        group: 'admin',
        description: 'List a local directory on the selected target machine for install browsing.',
        schema: PluginLocalDirectoryListRequestSchema
    },
    {
        id: 'plugin-local-directory-list-response',
        title: 'PluginLocalDirectoryListResponse',
        group: 'admin',
        description: 'Local directory listing result for install browsing.',
        schema: PluginLocalDirectoryListResponseSchema
    },
    {
        id: 'runner-plugin-inventory',
        title: 'RunnerPluginInventory',
        group: 'admin',
        description: 'Runner-reported plugin inventory published through machine state.',
        schema: RunnerPluginInventorySchema
    },
    {
        id: 'plugin-notification-event',
        title: 'PluginNotificationEvent',
        group: 'runtime',
        description: 'Narrow event DTO sent to Hub notification channels.',
        schema: PluginNotificationEventSchema
    },
    {
        id: 'runner-spawn-context',
        title: 'RunnerSpawnContext',
        group: 'runner',
        description: 'Runner spawn context visible to environment providers, command resolvers, and spawn hooks.',
        schema: RunnerSpawnContextSchema
    },
    {
        id: 'runner-environment-proposal',
        title: 'RunnerEnvironmentProposal',
        group: 'runner',
        description: 'Environment provider proposal. Core merges allowed fields only.',
        schema: RunnerEnvironmentProposalSchema
    },
    {
        id: 'runner-command-resolver-proposal',
        title: 'RunnerCommandResolverProposal',
        group: 'runner',
        description: 'Command resolver proposal. Final command construction remains core-owned.',
        schema: RunnerCommandResolverProposalSchema
    },
    {
        id: 'runner-spawn-hook-proposal',
        title: 'RunnerSpawnHookProposal',
        group: 'runner',
        description: 'Spawn hook proposal, including optional block reason.',
        schema: RunnerSpawnHookProposalSchema
    },
    {
        id: 'runner-resolved-spawn-plan',
        title: 'RunnerResolvedSpawnPlan',
        group: 'runner',
        description: 'Resolved spawn plan after Runner plugin extensions are applied and audited.',
        schema: RunnerResolvedSpawnPlanSchema
    },
    {
        id: 'agent-descriptor',
        title: 'AgentDescriptor',
        group: 'agent',
        description: 'Static agent descriptor used by plugin-backed agent adapters and Web selectors.',
        schema: AgentDescriptorSchema
    },
    {
        id: 'agent-capability-provider-result',
        title: 'AgentCapabilityProviderResult',
        group: 'agent',
        description: 'Dynamic agent capability provider output.',
        schema: AgentCapabilityProviderResultSchema
    },
    {
        id: 'agent-capability-provider-snapshot',
        title: 'AgentCapabilityProviderSnapshot',
        group: 'agent',
        description: 'Runner-published agent capability provider snapshot.',
        schema: AgentCapabilityProviderSnapshotSchema
    },
    {
        id: 'agent-history-import-result',
        title: 'AgentHistoryImportResult',
        group: 'agent',
        description: 'Normalized history import output for agent-native sessions.',
        schema: AgentHistoryImportResultSchema
    },
    {
        id: 'plugin-web-contributions',
        title: 'PluginWebContributions',
        group: 'web',
        description: 'Declarative Web descriptor contributions. Web never executes plugin JavaScript.',
        schema: PluginWebContributionsSchema
    },
    {
        id: 'plugin-web-contribution-view',
        title: 'PluginWebContributionView',
        group: 'web',
        description: 'Plugin Web contributions with plugin and target metadata.',
        schema: PluginWebContributionViewSchema
    }
]

export function findSchemaDoc(title: string): SchemaDoc {
    const match = schemaCatalog.find((entry) => entry.title === title)
    if (!match) {
        throw new Error(`Unknown plugin API schema: ${title}`)
    }
    return match
}
