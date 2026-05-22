import { z } from 'zod'
import { AgentIdSchema } from './agentDescriptors'

const DescriptorIdSchema = z.string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'descriptor id must contain only alphanumeric characters, dots, underscores, dashes, or colons')

const FieldKeySchema = z.string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'field key must contain only alphanumeric characters, dots, underscores, or dashes')

export const WebLocalizedTextSchema = z.union([
    z.string().min(1),
    z.record(z.string().min(1), z.string().min(1))
])
export type WebLocalizedText = z.infer<typeof WebLocalizedTextSchema>

export const CorePluginActionIdSchema = z.enum([
    'plugin.enable',
    'plugin.disable',
    'plugin.reload',
    'plugin.delete'
])
export type CorePluginActionId = z.infer<typeof CorePluginActionIdSchema>

const WebComponentBaseSchema = z.object({
    id: DescriptorIdSchema.optional()
}).strict()

export const WebDescriptorPrimitiveValueSchema = z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null()
])
export type WebDescriptorPrimitiveValue = z.infer<typeof WebDescriptorPrimitiveValueSchema>

export const WebSchemaFormFieldSchema = z.object({
    key: FieldKeySchema,
    label: WebLocalizedTextSchema,
    description: WebLocalizedTextSchema.optional(),
    type: z.enum(['text', 'number', 'boolean', 'select']).default('text'),
    required: z.boolean().optional(),
    secret: z.boolean().optional(),
    defaultValue: WebDescriptorPrimitiveValueSchema.optional(),
    options: z.array(z.object({
        value: z.string().min(1),
        label: WebLocalizedTextSchema.optional()
    }).strict()).optional()
}).strict().superRefine((field, ctx) => {
    if (field.type === 'select' && (!field.options || field.options.length === 0)) {
        ctx.addIssue({ code: 'custom', message: 'select fields require at least one option', path: ['options'] })
    }
})
export type WebSchemaFormField = z.infer<typeof WebSchemaFormFieldSchema>

export const WebTextComponentSchema = WebComponentBaseSchema.extend({
    kind: z.literal('text'),
    text: WebLocalizedTextSchema,
    tone: z.enum(['default', 'muted', 'info', 'warning', 'danger']).optional()
}).strict()

export const WebBadgeComponentSchema = WebComponentBaseSchema.extend({
    kind: z.literal('badge'),
    label: WebLocalizedTextSchema,
    variant: z.enum(['default', 'success', 'warning', 'danger']).optional()
}).strict()

export const WebTableComponentSchema = WebComponentBaseSchema.extend({
    kind: z.literal('table'),
    columns: z.array(z.object({
        key: FieldKeySchema,
        label: WebLocalizedTextSchema
    }).strict()).min(1).max(12),
    rows: z.array(z.record(z.string(), WebDescriptorPrimitiveValueSchema)).max(100).default([])
}).strict()

export const WebActionButtonComponentSchema = WebComponentBaseSchema.extend({
    kind: z.literal('actionButton'),
    label: WebLocalizedTextSchema,
    actionId: CorePluginActionIdSchema,
    variant: z.enum(['default', 'secondary', 'danger']).optional(),
    confirm: z.object({
        title: WebLocalizedTextSchema,
        description: WebLocalizedTextSchema.optional(),
        confirmLabel: WebLocalizedTextSchema.optional()
    }).strict().optional()
}).strict()

export const WebSchemaFormComponentSchema = WebComponentBaseSchema.extend({
    kind: z.literal('schemaForm'),
    title: WebLocalizedTextSchema.optional(),
    description: WebLocalizedTextSchema.optional(),
    submitLabel: WebLocalizedTextSchema.optional(),
    fields: z.array(WebSchemaFormFieldSchema).min(1).max(50)
}).strict()

export const WebDescriptorComponentSchema = z.discriminatedUnion('kind', [
    WebTextComponentSchema,
    WebBadgeComponentSchema,
    WebTableComponentSchema,
    WebActionButtonComponentSchema,
    WebSchemaFormComponentSchema
])
export type WebDescriptorComponent = z.infer<typeof WebDescriptorComponentSchema>

export const WebSettingsPanelDescriptorSchema = z.object({
    id: DescriptorIdSchema,
    title: WebLocalizedTextSchema,
    description: WebLocalizedTextSchema.optional(),
    components: z.array(WebDescriptorComponentSchema).min(1).max(100)
}).strict()
export type WebSettingsPanelDescriptor = z.infer<typeof WebSettingsPanelDescriptorSchema>

export const WebNewSessionFieldDescriptorSchema = z.object({
    id: DescriptorIdSchema,
    key: FieldKeySchema,
    label: WebLocalizedTextSchema,
    description: WebLocalizedTextSchema.optional(),
    agentIds: z.array(AgentIdSchema).optional(),
    type: z.enum(['text', 'number', 'boolean', 'select']).default('text'),
    required: z.boolean().optional(),
    defaultValue: WebDescriptorPrimitiveValueSchema.optional(),
    options: z.array(z.object({
        value: z.string().min(1),
        label: WebLocalizedTextSchema.optional()
    }).strict()).optional()
}).strict().superRefine((field, ctx) => {
    if (field.type === 'select' && (!field.options || field.options.length === 0)) {
        ctx.addIssue({ code: 'custom', message: 'select fields require at least one option', path: ['options'] })
    }
})
export type WebNewSessionFieldDescriptor = z.infer<typeof WebNewSessionFieldDescriptorSchema>

export const WebActionDescriptorSchema = z.object({
    id: DescriptorIdSchema,
    label: WebLocalizedTextSchema,
    description: WebLocalizedTextSchema.optional(),
    actionId: CorePluginActionIdSchema,
    variant: z.enum(['default', 'secondary', 'danger']).optional()
}).strict()
export type WebActionDescriptor = z.infer<typeof WebActionDescriptorSchema>

export const WebBadgeDescriptorSchema = z.object({
    id: DescriptorIdSchema,
    label: WebLocalizedTextSchema,
    variant: z.enum(['default', 'success', 'warning', 'danger']).optional()
}).strict()
export type WebBadgeDescriptor = z.infer<typeof WebBadgeDescriptorSchema>

export const WebDeliveryDelayPresetSchema = z.object({
    id: DescriptorIdSchema.optional(),
    label: WebLocalizedTextSchema,
    delayMs: z.number().int().positive().max(7 * 24 * 60 * 60 * 1000)
}).strict()
export type WebDeliveryDelayPreset = z.infer<typeof WebDeliveryDelayPresetSchema>

export const WebComposerActionDescriptorSchema = z.object({
    id: DescriptorIdSchema,
    kind: z.literal('deliveryNotBefore'),
    label: WebLocalizedTextSchema,
    description: WebLocalizedTextSchema.optional(),
    icon: z.enum(['clock']).default('clock'),
    maxDelayMs: z.number().int().positive().max(7 * 24 * 60 * 60 * 1000).default(7 * 24 * 60 * 60 * 1000),
    presets: z.array(WebDeliveryDelayPresetSchema).min(1).max(12)
}).strict()
export type WebComposerActionDescriptor = z.infer<typeof WebComposerActionDescriptorSchema>

export const PluginWebContributionsSchema = z.object({
    settingsPanels: z.array(WebSettingsPanelDescriptorSchema).optional(),
    newSessionFields: z.array(WebNewSessionFieldDescriptorSchema).optional(),
    actions: z.array(WebActionDescriptorSchema).optional(),
    badges: z.array(WebBadgeDescriptorSchema).optional(),
    composerActions: z.array(WebComposerActionDescriptorSchema).optional()
}).strict()
export type PluginWebContributions = z.infer<typeof PluginWebContributionsSchema>

export const PluginWebContributionViewSchema = z.object({
    pluginId: z.string().min(1),
    pluginName: z.string().optional(),
    target: z.union([
        z.literal('hub'),
        z.literal('all-runners'),
        z.string().regex(/^runner:[A-Za-z0-9][A-Za-z0-9._-]*$/)
    ]).optional(),
    contributions: PluginWebContributionsSchema
}).strict()
export type PluginWebContributionView = z.infer<typeof PluginWebContributionViewSchema>

export function localizeWebText(value: WebLocalizedText, locale = 'en'): string {
    if (typeof value === 'string') return value
    return value[locale] ?? value.default ?? value.en ?? value['zh-CN'] ?? Object.values(value)[0] ?? ''
}
