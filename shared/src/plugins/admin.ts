import { z } from 'zod'
import { PluginDiagnosticSchema, PluginStatusSchema } from './types'
import { PluginManifestLiteSchema } from './manifest'

export const PluginAdminStatusSchema = PluginStatusSchema
export type PluginAdminStatus = z.infer<typeof PluginAdminStatusSchema>

export const PluginSecretStatusSchema = z.object({
    name: z.string().min(1),
    present: z.boolean()
}).strict()
export type PluginSecretStatus = z.infer<typeof PluginSecretStatusSchema>

export const PluginRuntimeSummarySchema = z.object({
    hub: z.object({
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
        }).strict())
    }).strict(),
    runtimeEntryPaths: z.array(z.object({
        runtime: z.literal('hub'),
        entry: z.string().min(1),
        resolvedPath: z.string().min(1),
        realPath: z.string().min(1)
    }).strict())
}).strict()
export type PluginDetail = z.infer<typeof PluginDetailSchema>

export const PluginListResponseSchema = z.object({
    plugins: z.array(PluginListItemSchema)
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

export const PluginReloadResultSchema = z.object({
    ok: z.boolean(),
    targetId: z.string().optional(),
    results: z.array(PluginReloadItemSchema),
    plugins: z.array(PluginListItemSchema)
}).strict()
export type PluginReloadResult = z.infer<typeof PluginReloadResultSchema>

export const PluginInstallActionSchema = z.enum(['installed', 'overwritten', 'unchanged'])
export type PluginInstallAction = z.infer<typeof PluginInstallActionSchema>

export const PluginInstallExampleRequestSchema = z.object({
    enable: z.boolean().optional(),
    reload: z.boolean().optional(),
    overwrite: z.boolean().optional()
}).strict()
export type PluginInstallExampleRequest = z.infer<typeof PluginInstallExampleRequestSchema>

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
