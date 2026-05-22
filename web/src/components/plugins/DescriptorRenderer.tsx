import React, { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'
import {
    CorePluginActionIdSchema,
    WebDescriptorComponentSchema,
    WebLocalizedTextSchema,
    localizeWebText,
    type CorePluginActionId,
    type WebDescriptorComponent,
    type WebLocalizedText,
    type WebSchemaFormField,
} from '@hapi/protocol/plugins'

export type DescriptorActionHandler = (actionId: CorePluginActionId) => Promise<void> | void
export type DescriptorConfigSaveHandler = (config: Record<string, unknown>) => Promise<void> | void

type BadgeVariant = 'default' | 'success' | 'warning' | 'destructive'

type DescriptorBoundaryProps = {
    children: ReactNode
    fallback: ReactNode
}

type DescriptorBoundaryState = {
    error: Error | null
}

export class DescriptorBoundary extends React.Component<DescriptorBoundaryProps, DescriptorBoundaryState> {
    state: DescriptorBoundaryState = { error: null }

    static getDerivedStateFromError(error: Error): DescriptorBoundaryState {
        return { error }
    }

    render(): ReactNode {
        if (this.state.error) {
            return this.props.fallback
        }
        return this.props.children
    }
}

export function descriptorText(value: WebLocalizedText | undefined, locale = navigator.language || 'en'): string {
    if (!value) return ''
    return localizeWebText(value, locale)
}

function badgeVariant(variant?: string): BadgeVariant {
    if (variant === 'danger') return 'destructive'
    if (variant === 'success' || variant === 'warning') return variant
    return 'default'
}

function componentKey(component: WebDescriptorComponent, index: number): string {
    return component.id ?? `${component.kind}-${index}`
}

function valueIsBlank(value: unknown): boolean {
    return value === undefined || value === null || value === ''
}

function initialFieldValue(field: WebSchemaFormField, config: Record<string, unknown>): unknown {
    if (field.secret) return ''
    const current = config[field.key]
    if (current !== undefined && current !== '[REDACTED]') return current
    if (field.defaultValue !== undefined) return field.defaultValue
    if (field.type === 'boolean') return false
    return ''
}

function coerceFieldValue(field: WebSchemaFormField, value: unknown): unknown {
    if (field.type === 'boolean') return value === true
    if (field.type === 'number') {
        if (valueIsBlank(value)) return undefined
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : value
    }
    if (typeof value === 'string') return value
    return value ?? ''
}

function SchemaFormComponent(props: {
    component: Extract<WebDescriptorComponent, { kind: 'schemaForm' }>
    config: Record<string, unknown>
    disabled?: boolean
    onSaveConfig?: DescriptorConfigSaveHandler
}) {
    const { component, config } = props
    const { t, locale } = useTranslation()
    const [values, setValues] = useState<Record<string, unknown>>({})
    const [error, setError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        setValues(Object.fromEntries(component.fields.map((field) => [field.key, initialFieldValue(field, config)])))
        setError(null)
    }, [component, config])

    const requiredMissing = component.fields.find((field) => field.required && !field.secret && valueIsBlank(values[field.key]))

    const save = async () => {
        if (!props.onSaveConfig || props.disabled) return
        if (requiredMissing) {
            setError(t('settings.plugins.descriptor.required', { label: descriptorText(requiredMissing.label, locale) }))
            return
        }
        const nextConfig = { ...config }
        for (const field of component.fields) {
            if (field.secret) continue
            const value = coerceFieldValue(field, values[field.key])
            if (value === undefined || value === '') {
                delete nextConfig[field.key]
            } else {
                nextConfig[field.key] = value
            }
        }
        setSaving(true)
        setError(null)
        try {
            await props.onSaveConfig(nextConfig)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="space-y-3 rounded-lg border border-[var(--app-border)] p-3">
            {component.title ? <div className="font-medium">{descriptorText(component.title, locale)}</div> : null}
            {component.description ? <div className="text-sm text-[var(--app-hint)]">{descriptorText(component.description, locale)}</div> : null}
            <div className="space-y-3">
                {component.fields.map((field) => {
                    const value = values[field.key]
                    const label = descriptorText(field.label, locale)
                    const description = descriptorText(field.description, locale)
                    return (
                        <label key={field.key} className="block space-y-1 text-sm">
                            <span className="font-medium">{label}{field.required ? ' *' : ''}</span>
                            {description ? <span className="block text-xs text-[var(--app-hint)]">{description}</span> : null}
                            {field.secret ? (
                                <input
                                    type="password"
                                    value=""
                                    disabled
                                    placeholder={t('settings.plugins.descriptor.secretPlaceholder')}
                                    className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-sm text-[var(--app-hint)]"
                                />
                            ) : field.type === 'boolean' ? (
                                <input
                                    type="checkbox"
                                    checked={value === true}
                                    disabled={props.disabled || saving}
                                    onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.checked }))}
                                    className="accent-[var(--app-link)]"
                                />
                            ) : field.type === 'select' ? (
                                <select
                                    value={typeof value === 'string' ? value : ''}
                                    disabled={props.disabled || saving}
                                    onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                                    className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)]"
                                >
                                    <option value="">{t('settings.plugins.descriptor.select')}</option>
                                    {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{descriptorText(option.label, locale) || option.value}</option>)}
                                </select>
                            ) : (
                                <input
                                    type={field.type === 'number' ? 'number' : 'text'}
                                    value={typeof value === 'string' || typeof value === 'number' ? value : ''}
                                    disabled={props.disabled || saving}
                                    onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                                    className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)]"
                                />
                            )}
                        </label>
                    )
                })}
            </div>
            {error ? <div className="text-sm text-red-600">{error}</div> : null}
            {props.onSaveConfig ? (
                <Button type="button" size="sm" disabled={props.disabled || saving || Boolean(requiredMissing)} onClick={() => void save()}>
                    {saving ? t('settings.plugins.config.saving') : descriptorText(component.submitLabel, locale) || t('settings.plugins.config.saveAndReload')}
                </Button>
            ) : null}
        </div>
    )
}

function DescriptorComponent(props: {
    component: WebDescriptorComponent
    config: Record<string, unknown>
    disabled?: boolean
    onAction?: DescriptorActionHandler
    onSaveConfig?: DescriptorConfigSaveHandler
}) {
    const { t, locale } = useTranslation()
    const parsed = WebDescriptorComponentSchema.safeParse(props.component)
    if (!parsed.success) {
        return <DescriptorError message={t('settings.plugins.descriptor.invalidComponent')} />
    }
    const component = parsed.data
    if (component.kind === 'text') {
        const tone = component.tone === 'danger'
            ? 'text-red-600'
            : component.tone === 'warning'
                ? 'text-amber-600'
                : component.tone === 'muted'
                    ? 'text-[var(--app-hint)]'
                    : ''
        return <div className={`text-sm ${tone}`}>{descriptorText(component.text, locale)}</div>
    }
    if (component.kind === 'badge') {
        return <Badge variant={badgeVariant(component.variant)}>{descriptorText(component.label, locale)}</Badge>
    }
    if (component.kind === 'table') {
        return (
            <div className="overflow-x-auto rounded-lg border border-[var(--app-border)]">
                <table className="min-w-full text-left text-sm">
                    <thead className="bg-[var(--app-subtle-bg)] text-xs text-[var(--app-hint)]">
                        <tr>{component.columns.map((column) => <th key={column.key} className="px-3 py-2 font-medium">{descriptorText(column.label, locale)}</th>)}</tr>
                    </thead>
                    <tbody>
                        {component.rows.map((row, index) => (
                            <tr key={index} className="border-t border-[var(--app-border)]">
                                {component.columns.map((column) => <td key={column.key} className="px-3 py-2">{String(row[column.key] ?? '')}</td>)}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        )
    }
    if (component.kind === 'actionButton') {
        const action = CorePluginActionIdSchema.safeParse(component.actionId)
        if (!action.success) {
            return <DescriptorError message={t('settings.plugins.descriptor.unsupportedAction')} />
        }
        const run = async () => {
            if (!props.onAction) return
            if (component.confirm) {
                const ok = window.confirm(`${descriptorText(component.confirm.title, locale)}${component.confirm.description ? `\n\n${descriptorText(component.confirm.description, locale)}` : ''}`)
                if (!ok) return
            }
            await props.onAction(action.data)
        }
        return (
            <Button type="button" size="sm" variant={component.variant === 'danger' ? 'destructive' : component.variant === 'secondary' ? 'outline' : 'default'} disabled={props.disabled} onClick={() => void run()}>
                {descriptorText(component.label, locale)}
            </Button>
        )
    }
    return <SchemaFormComponent component={component} config={props.config} disabled={props.disabled} onSaveConfig={props.onSaveConfig} />
}

function DescriptorError(props: { message: string }) {
    return <div className="rounded-lg border border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] p-3 text-sm text-[var(--app-badge-error-text)]">{props.message}</div>
}


function readSettingsPanels(contributions: unknown): unknown[] {
    if (!contributions || typeof contributions !== 'object') return []
    const panels = (contributions as { settingsPanels?: unknown }).settingsPanels
    return Array.isArray(panels) ? panels : []
}


function parsePanelShell(panel: unknown): { success: true; id: string; title: WebLocalizedText; description?: WebLocalizedText; components: unknown[] } | { success: false } {
    if (!panel || typeof panel !== 'object') return { success: false }
    const obj = panel as Record<string, unknown>
    const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id : ''
    const title = WebLocalizedTextSchema.safeParse(obj.title)
    const description = obj.description === undefined ? undefined : WebLocalizedTextSchema.safeParse(obj.description)
    const components = Array.isArray(obj.components) ? obj.components : null
    if (!id || !title.success || !components || (description && !description.success)) return { success: false }
    return {
        success: true,
        id,
        title: title.data,
        ...(description?.success ? { description: description.data } : {}),
        components
    }
}

export function PluginDescriptorPanels(props: {
    contributions: unknown
    config?: Record<string, unknown>
    disabled?: boolean
    onAction?: DescriptorActionHandler
    onSaveConfig?: DescriptorConfigSaveHandler
}) {
    const panels = readSettingsPanels(props.contributions)
    if (panels.length === 0) return null
    return <PluginSettingsPanels panels={panels} config={props.config} disabled={props.disabled} onAction={props.onAction} onSaveConfig={props.onSaveConfig} />
}

export function PluginSettingsPanels(props: {
    panels: unknown[]
    config?: Record<string, unknown>
    disabled?: boolean
    onAction?: DescriptorActionHandler
    onSaveConfig?: DescriptorConfigSaveHandler
}) {
    const { t, locale } = useTranslation()
    const parsed = useMemo(() => props.panels.map((panel) => parsePanelShell(panel)), [props.panels])

    return (
        <div className="space-y-3">
            {parsed.map((entry, index) => {
                if (!entry.success) {
                    return <DescriptorError key={`invalid-${index}`} message={t('settings.plugins.descriptor.invalidPanel')} />
                }
                const panel = entry
                return (
                    <DescriptorBoundary key={panel.id} fallback={<DescriptorError message={t('settings.plugins.descriptor.panelRenderFailed')} />}>
                        <div className="space-y-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
                            <div>
                                <div className="font-medium">{descriptorText(panel.title, locale)}</div>
                                {panel.description ? <div className="mt-1 text-sm text-[var(--app-hint)]">{descriptorText(panel.description, locale)}</div> : null}
                            </div>
                            <div className="space-y-3">
                                {panel.components.map((component, componentIndex) => {
                                    const parsedComponent = WebDescriptorComponentSchema.safeParse(component)
                                    if (!parsedComponent.success) {
                                        return <DescriptorError key={`invalid-component-${componentIndex}`} message={t('settings.plugins.descriptor.componentValidationFailed')} />
                                    }
                                    return (
                                        <DescriptorComponent
                                            key={componentKey(parsedComponent.data, componentIndex)}
                                            component={parsedComponent.data}
                                            config={props.config ?? {}}
                                            disabled={props.disabled}
                                            onAction={props.onAction}
                                            onSaveConfig={props.onSaveConfig}
                                        />
                                    )
                                })}
                            </div>
                        </div>
                    </DescriptorBoundary>
                )
            })}
        </div>
    )
}
