import { z } from 'zod'

export const PluginStateEntrySchema = z.object({
    enabled: z.boolean(),
    config: z.record(z.string(), z.unknown()).optional()
}).strict()

export const PluginStateFileSchema = z.object({
    enabled: z.record(z.string(), PluginStateEntrySchema).default({})
}).strict()

export type PluginStateEntry = z.infer<typeof PluginStateEntrySchema>
export type PluginStateFile = z.infer<typeof PluginStateFileSchema>
