import {
    WebComposerActionDescriptorSchema,
    localizeWebText,
    type PluginWebContributionView,
    type WebComposerActionDescriptor,
} from '@hapi/protocol/plugins'

export type DeliveryNotBeforeComposerAction = WebComposerActionDescriptor & {
    pluginId: string
    pluginName?: string
}

export function collectDeliveryNotBeforeComposerActions(
    webContributions: PluginWebContributionView[] | undefined,
    options: { locale?: string } = {}
): DeliveryNotBeforeComposerAction[] {
    const actions: DeliveryNotBeforeComposerAction[] = []

    for (const contribution of webContributions ?? []) {
        for (const rawAction of contribution.contributions.composerActions ?? []) {
            const parsed = WebComposerActionDescriptorSchema.safeParse(rawAction)
            if (!parsed.success) continue
            if (parsed.data.kind !== 'deliveryNotBefore') continue
            actions.push({
                ...parsed.data,
                // Normalize labels early so descriptors with locale maps remain
                // renderable even when a plugin omitted the current locale.
                label: localizeWebText(parsed.data.label, options.locale),
                presets: parsed.data.presets.map((preset) => ({
                    ...preset,
                    label: localizeWebText(preset.label, options.locale),
                })),
                pluginId: contribution.pluginId,
                pluginName: contribution.pluginName,
            })
        }
    }

    return actions
}
