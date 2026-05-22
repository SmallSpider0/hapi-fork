import { z } from 'zod'
import { PluginWebContributionsSchema } from './webDescriptors'

export const HAPI_PLUGIN_MANIFEST_FILE = 'hapi.plugin.json'
export const HAPI_PLUGIN_API_VERSION = '0.1'

export const PluginRuntimeNameSchema = z.enum(['hub', 'runner'])
export type PluginRuntimeName = z.infer<typeof PluginRuntimeNameSchema>

const PluginIdSchema = z.string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must start with an alphanumeric character and contain only alphanumeric characters, dots, underscores, or dashes')

const SemverSchema = z.string()
    .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, 'must be a semantic version')

const ContributionIdSchema = z.string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must start with an alphanumeric character and contain only alphanumeric characters, dots, underscores, or dashes')

const ContributionSupportStatusSchema = z.enum(['supported', 'unsupported', 'stub'])

const RuntimeEntrySchema = z.object({
    entry: z.string().min(1)
}).strict()

const HubRuntimeSchema = RuntimeEntrySchema
const RunnerRuntimeSchema = RuntimeEntrySchema

const HubNotificationChannelContributionSchema = z.object({
    id: ContributionIdSchema,
    displayName: z.string().min(1)
}).strict()

const GenericContributionDescriptorSchema = z.object({
    id: ContributionIdSchema,
    displayName: z.string().min(1).optional(),
    description: z.string().optional(),
    supportStatus: ContributionSupportStatusSchema.optional(),
    limitations: z.array(z.string().min(1)).max(20).optional()
}).passthrough()

const RunnerContributionSchema = z.object({
    environmentProviders: z.array(GenericContributionDescriptorSchema).optional(),
    commandResolvers: z.array(GenericContributionDescriptorSchema).optional(),
    spawnHooks: z.array(GenericContributionDescriptorSchema).optional()
}).strict()

const AgentContributionSchema = z.object({
    adapters: z.array(GenericContributionDescriptorSchema).optional(),
    capabilityProviders: z.array(GenericContributionDescriptorSchema).optional()
}).strict()

const VoiceContributionSchema = z.object({
    providers: z.array(GenericContributionDescriptorSchema).optional()
}).strict()

const DeploymentContributionSchema = z.object({
    packs: z.array(GenericContributionDescriptorSchema).optional()
}).strict()

const IntegrationContributionSchema = z.object({
    protocolBridges: z.array(GenericContributionDescriptorSchema).optional()
}).strict()

const WebContributionSchema = PluginWebContributionsSchema

const PluginManifestLiteBaseSchema = z.object({
    id: PluginIdSchema,
    name: z.string().min(1),
    version: SemverSchema,
    pluginApiVersion: z.string().min(1),
    description: z.string().optional(),
    runtimes: z.object({
        hub: HubRuntimeSchema.optional(),
        runner: RunnerRuntimeSchema.optional()
    }).strict().optional(),
    contributions: z.object({
        hub: z.object({
            notificationChannels: z.array(HubNotificationChannelContributionSchema).optional()
        }).strict().optional(),
        runner: RunnerContributionSchema.optional(),
        agent: AgentContributionSchema.optional(),
        voice: VoiceContributionSchema.optional(),
        deployment: DeploymentContributionSchema.optional(),
        integration: IntegrationContributionSchema.optional(),
        web: WebContributionSchema.optional()
    }).strict().optional(),
    config: z.object({
        schema: z.string().min(1).optional()
    }).strict().optional(),
    permissions: z.object({
        network: z.array(z.string().min(1)).optional(),
        secrets: z.array(z.string().min(1)).optional()
    }).strict().optional(),
    compatibility: z.object({
        hapi: z.string().min(1).optional(),
        os: z.array(z.enum(['darwin', 'linux', 'win32'])).optional()
    }).strict().optional()
}).strict()

export const RawPluginManifestLiteSchema = PluginManifestLiteBaseSchema

export const PluginManifestLiteSchema = PluginManifestLiteBaseSchema.extend({
    pluginApiVersion: z.literal(HAPI_PLUGIN_API_VERSION)
}).strict()

export type PluginManifestLite = z.infer<typeof PluginManifestLiteSchema>
export type RawPluginManifestLite = z.infer<typeof RawPluginManifestLiteSchema>
