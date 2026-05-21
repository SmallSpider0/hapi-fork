import { z } from 'zod'

export const PluginInstallMetadataSchema = z.object({
    sourceType: z.enum(['env', 'user-home', 'hub-local-path', 'runner-local-path', 'uploaded-package']),
    sourcePath: z.string().min(1).optional(),
    checksum: z.string().min(1).optional(),
    packageFormat: z.enum(['tgz', 'zip']).optional(),
    version: z.string().min(1).optional(),
    installedAt: z.number().optional(),
    updatedAt: z.number().optional()
}).strict()

export type PluginInstallMetadata = z.infer<typeof PluginInstallMetadataSchema>

export const PluginStateEntrySchema = z.object({
    enabled: z.boolean(),
    config: z.record(z.string(), z.unknown()).optional(),
    install: PluginInstallMetadataSchema.optional()
}).strict()

export const PluginStateFileSchema = z.object({
    enabled: z.record(z.string(), PluginStateEntrySchema).default({})
}).strict()

export type PluginStateEntry = z.infer<typeof PluginStateEntrySchema>
export type PluginStateFile = z.infer<typeof PluginStateFileSchema>
