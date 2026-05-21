import { z } from 'zod'
import { PluginDiagnosticSchema, PluginStatusSchema } from './types'
import { PluginManifestLiteSchema, PluginRuntimeNameSchema } from './manifest'
import { RunnerExtensionContributionSummarySchema } from './runnerExtensions'

export const PluginAdminStatusSchema = PluginStatusSchema
export type PluginAdminStatus = z.infer<typeof PluginAdminStatusSchema>

export const PluginTargetMachineIdSchema = z.string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'machine id must contain only alphanumeric characters, dots, underscores, or dashes')
export type PluginTargetMachineId = z.infer<typeof PluginTargetMachineIdSchema>

export const PluginTargetScopeSchema = z.union([
    z.literal('hub'),
    z.literal('all-runners'),
    z.string().regex(/^runner:[A-Za-z0-9][A-Za-z0-9._-]*$/, 'scope must be hub, all-runners, or runner:<machineId>')
])
export type PluginTargetScope = z.infer<typeof PluginTargetScopeSchema>

export function runnerPluginTargetScope(machineId: string): PluginTargetScope {
    return `runner:${PluginTargetMachineIdSchema.parse(machineId)}` as PluginTargetScope
}

export function parseRunnerPluginTargetScope(scope: PluginTargetScope): string | null {
    return typeof scope === 'string' && scope.startsWith('runner:') ? scope.slice('runner:'.length) : null
}

export const PluginTargetSummarySchema = z.object({
    scope: PluginTargetScopeSchema,
    runtime: PluginRuntimeNameSchema,
    machineId: PluginTargetMachineIdSchema.optional(),
    displayName: z.string().optional(),
    active: z.boolean(),
    stale: z.boolean().optional(),
    updatedAt: z.number().optional(),
    error: z.string().optional()
}).strict()
export type PluginTargetSummary = z.infer<typeof PluginTargetSummarySchema>

export const PluginSecretStatusSchema = z.object({
    name: z.string().min(1),
    present: z.boolean()
}).strict()
export type PluginSecretStatus = z.infer<typeof PluginSecretStatusSchema>

export const PluginRuntimeSummarySchema = z.object({
    hub: z.object({
        entry: z.string().min(1),
        active: z.boolean()
    }).strict().optional(),
    runner: z.object({
        entry: z.string().min(1),
        active: z.boolean()
    }).strict().optional()
}).strict()
export type PluginRuntimeSummary = z.infer<typeof PluginRuntimeSummarySchema>

export const PluginDiagnosticViewSchema = PluginDiagnosticSchema.extend({
    pluginId: z.string().optional()
}).strict()
export type PluginDiagnosticView = z.infer<typeof PluginDiagnosticViewSchema>

export const PluginListItemSchema = z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    version: z.string().optional(),
    description: z.string().optional(),
    source: z.enum(['env', 'user-home']),
    status: PluginAdminStatusSchema,
    enabled: z.boolean(),
    active: z.boolean(),
    rootPath: z.string().min(1),
    manifestPath: z.string().min(1),
    runtimes: PluginRuntimeSummarySchema,
    diagnostics: z.array(PluginDiagnosticViewSchema),
    target: PluginTargetSummarySchema.optional(),
    updatedAt: z.number().optional()
}).strict()
export type PluginListItem = z.infer<typeof PluginListItemSchema>

export const PluginDetailSchema = PluginListItemSchema.extend({
    manifest: PluginManifestLiteSchema.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    permissions: z.object({
        network: z.array(z.string()),
        secrets: z.array(PluginSecretStatusSchema)
    }).strict(),
    contributions: z.object({
        notificationChannels: z.array(z.object({
            id: z.string().min(1),
            displayName: z.string().min(1)
        }).strict()),
        runner: z.object({
            environmentProviders: z.array(z.unknown()).optional(),
            commandResolvers: z.array(z.unknown()).optional(),
            spawnHooks: z.array(z.unknown()).optional()
        }).strict().optional(),
        agent: z.object({
            adapters: z.array(z.unknown()).optional(),
            capabilityProviders: z.array(z.unknown()).optional()
        }).strict().optional(),
        web: z.object({
            settingsPanels: z.array(z.unknown()).optional(),
            newSessionFields: z.array(z.unknown()).optional(),
            actions: z.array(z.unknown()).optional(),
            badges: z.array(z.unknown()).optional()
        }).strict().optional()
    }).strict(),
    runtimeEntryPaths: z.array(z.object({
        runtime: PluginRuntimeNameSchema,
        entry: z.string().min(1),
        resolvedPath: z.string().min(1),
        realPath: z.string().min(1)
    }).strict())
}).strict()
export type PluginDetail = z.infer<typeof PluginDetailSchema>

export const PluginTargetInventorySchema = z.object({
    target: PluginTargetSummarySchema,
    plugins: z.array(PluginListItemSchema),
    error: z.string().optional()
}).strict()
export type PluginTargetInventory = z.infer<typeof PluginTargetInventorySchema>

export const RunnerPluginInventorySchema = z.object({
    machineId: PluginTargetMachineIdSchema,
    updatedAt: z.number(),
    plugins: z.array(PluginListItemSchema),
    diagnostics: z.array(PluginDiagnosticViewSchema).default([]),
    extensions: z.object({
        environmentProviders: z.array(RunnerExtensionContributionSummarySchema).default([]),
        commandResolvers: z.array(RunnerExtensionContributionSummarySchema).default([]),
        spawnHooks: z.array(RunnerExtensionContributionSummarySchema).default([])
    }).strict().optional()
}).strict()
export type RunnerPluginInventory = z.infer<typeof RunnerPluginInventorySchema>

export const PluginListResponseSchema = z.object({
    plugins: z.array(PluginListItemSchema),
    targets: z.array(PluginTargetInventorySchema).optional()
}).strict()
export type PluginListResponse = z.infer<typeof PluginListResponseSchema>

export const PluginDetailResponseSchema = z.object({
    plugin: PluginDetailSchema
}).strict()
export type PluginDetailResponse = z.infer<typeof PluginDetailResponseSchema>

export const PluginDiagnosticsResponseSchema = z.object({
    diagnostics: z.array(PluginDiagnosticViewSchema)
}).strict()
export type PluginDiagnosticsResponse = z.infer<typeof PluginDiagnosticsResponseSchema>

export const PluginReloadActionSchema = z.enum([
    'activated',
    'deactivated',
    'reloaded',
    'unchanged',
    'failed',
    'kept-previous'
])
export type PluginReloadAction = z.infer<typeof PluginReloadActionSchema>

export const PluginReloadItemSchema = z.object({
    id: z.string().min(1),
    action: PluginReloadActionSchema,
    status: PluginAdminStatusSchema,
    message: z.string().optional(),
    diagnostics: z.array(PluginDiagnosticViewSchema).default([])
}).strict()
export type PluginReloadItem = z.infer<typeof PluginReloadItemSchema>

export const PluginTargetActionResultSchema = z.object({
    target: PluginTargetSummarySchema,
    ok: z.boolean(),
    error: z.string().optional(),
    results: z.array(PluginReloadItemSchema).optional(),
    plugins: z.array(PluginListItemSchema).optional()
}).strict()
export type PluginTargetActionResult = z.infer<typeof PluginTargetActionResultSchema>

export const PluginReloadResultSchema = z.object({
    ok: z.boolean(),
    targetId: z.string().optional(),
    target: PluginTargetSummarySchema.optional(),
    targetResults: z.array(PluginTargetActionResultSchema).optional(),
    results: z.array(PluginReloadItemSchema),
    plugins: z.array(PluginListItemSchema)
}).strict()
export type PluginReloadResult = z.infer<typeof PluginReloadResultSchema>

export const PluginInstallActionSchema = z.enum(['installed', 'overwritten', 'unchanged'])
export type PluginInstallAction = z.infer<typeof PluginInstallActionSchema>

export const PluginInstallLocalRequestSchema = z.object({
    sourcePath: z.string().min(1),
    enable: z.boolean().optional(),
    reload: z.boolean().optional(),
    overwrite: z.boolean().optional()
}).strict()
export type PluginInstallLocalRequest = z.infer<typeof PluginInstallLocalRequestSchema>

export const PluginInstallResultSchema = z.object({
    ok: z.boolean(),
    action: PluginInstallActionSchema,
    plugin: PluginListItemSchema.optional(),
    pluginId: z.string().min(1).optional(),
    sourcePath: z.string().min(1).optional(),
    targetPath: z.string().min(1),
    diagnostics: z.array(PluginDiagnosticViewSchema).default([]),
    reload: PluginReloadResultSchema.optional(),
    plugins: z.array(PluginListItemSchema)
}).strict()
export type PluginInstallResult = z.infer<typeof PluginInstallResultSchema>

export const PluginDeleteResultSchema = z.object({
    ok: z.boolean(),
    pluginId: z.string().min(1),
    rootPath: z.string().min(1),
    deleted: z.boolean(),
    target: PluginTargetSummarySchema.optional(),
    reload: PluginReloadResultSchema.optional(),
    plugins: z.array(PluginListItemSchema)
}).strict()
export type PluginDeleteResult = z.infer<typeof PluginDeleteResultSchema>

export const PluginLocalDirectoryListRequestSchema = z.object({
    path: z.string().optional()
}).strict()
export type PluginLocalDirectoryListRequest = z.infer<typeof PluginLocalDirectoryListRequestSchema>

export const PluginLocalDirectoryEntrySchema = z.object({
    name: z.string().min(1),
    type: z.enum(['file', 'directory', 'other']),
    size: z.number().optional(),
    modified: z.number().optional(),
    hasPluginManifest: z.boolean().optional()
}).strict()
export type PluginLocalDirectoryEntry = z.infer<typeof PluginLocalDirectoryEntrySchema>

export const PluginLocalDirectoryListResponseSchema = z.object({
    success: z.boolean(),
    path: z.string().optional(),
    parentPath: z.string().optional(),
    hasPluginManifest: z.boolean().optional(),
    entries: z.array(PluginLocalDirectoryEntrySchema).optional(),
    error: z.string().optional()
}).strict()
export type PluginLocalDirectoryListResponse = z.infer<typeof PluginLocalDirectoryListResponseSchema>

export const PluginEnableRequestSchema = z.object({
    config: z.record(z.string(), z.unknown()).optional(),
    reload: z.boolean().optional()
}).strict()
export type PluginEnableRequest = z.infer<typeof PluginEnableRequestSchema>

export const PluginDisableRequestSchema = z.object({
    reload: z.boolean().optional()
}).strict()
export type PluginDisableRequest = z.infer<typeof PluginDisableRequestSchema>

export const PluginConfigUpdateRequestSchema = z.object({
    config: z.record(z.string(), z.unknown())
}).strict()
export type PluginConfigUpdateRequest = z.infer<typeof PluginConfigUpdateRequestSchema>

export const RunnerPluginsListRequestSchema = z.object({}).strict()
export type RunnerPluginsListRequest = z.infer<typeof RunnerPluginsListRequestSchema>

export const RunnerPluginsInspectRequestSchema = z.object({
    pluginId: z.string().min(1)
}).strict()
export type RunnerPluginsInspectRequest = z.infer<typeof RunnerPluginsInspectRequestSchema>

export const RunnerPluginsEnableRequestSchema = z.object({
    pluginId: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
    reload: z.boolean().optional()
}).strict()
export type RunnerPluginsEnableRequest = z.infer<typeof RunnerPluginsEnableRequestSchema>

export const RunnerPluginsDisableRequestSchema = z.object({
    pluginId: z.string().min(1),
    reload: z.boolean().optional()
}).strict()
export type RunnerPluginsDisableRequest = z.infer<typeof RunnerPluginsDisableRequestSchema>

export const RunnerPluginsConfigUpdateRequestSchema = z.object({
    pluginId: z.string().min(1),
    config: z.record(z.string(), z.unknown())
}).strict()
export type RunnerPluginsConfigUpdateRequest = z.infer<typeof RunnerPluginsConfigUpdateRequestSchema>

export const RunnerPluginsReloadRequestSchema = z.object({
    pluginId: z.string().min(1).optional()
}).strict()
export type RunnerPluginsReloadRequest = z.infer<typeof RunnerPluginsReloadRequestSchema>

export const RunnerPluginsInstallPrepareRequestSchema = z.object({
    pluginId: z.string().min(1).optional(),
    manifest: PluginManifestLiteSchema.optional()
}).strict()
export type RunnerPluginsInstallPrepareRequest = z.infer<typeof RunnerPluginsInstallPrepareRequestSchema>

export const RunnerPluginsInstallCommitRequestSchema = z.object({
    token: z.string().min(1).optional()
}).strict()
export type RunnerPluginsInstallCommitRequest = z.infer<typeof RunnerPluginsInstallCommitRequestSchema>

export const RunnerPluginUnsupportedInstallResultSchema = z.object({
    ok: z.literal(false),
    code: z.literal('unsupported-runtime'),
    message: z.string()
}).strict()
export type RunnerPluginUnsupportedInstallResult = z.infer<typeof RunnerPluginUnsupportedInstallResultSchema>

export const RunnerPluginsDeleteRequestSchema = z.object({
    pluginId: z.string().min(1),
    reload: z.boolean().optional()
}).strict()
export type RunnerPluginsDeleteRequest = z.infer<typeof RunnerPluginsDeleteRequestSchema>
