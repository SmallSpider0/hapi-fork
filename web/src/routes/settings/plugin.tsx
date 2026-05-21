import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { usePlugin } from '@/hooks/queries/usePlugin'
import { usePluginActions } from '@/hooks/mutations/usePluginActions'
import { useTranslation } from '@/lib/use-translation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { LoadingState } from '@/components/LoadingState'
import type { PluginDetail, PluginReloadResult } from '@hapi/protocol/plugins/admin'

type BadgeVariant = 'default' | 'warning' | 'success' | 'destructive'
type ResultState = {
    title: string
    lines: string[]
    tone: 'success' | 'warning' | 'error'
} | null

function BackIcon() {
    return <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
}

function PuzzleIcon() {
    return <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19.4 13.5a1.9 1.9 0 1 0 0-3.8H17V7.3A2.3 2.3 0 0 0 14.7 5h-2.4a1.9 1.9 0 1 0-3.8 0H6.3A2.3 2.3 0 0 0 4 7.3v2.2a1.9 1.9 0 1 1 0 3.8v2.4A2.3 2.3 0 0 0 6.3 18h2.2a1.9 1.9 0 1 0 3.8 0h2.4a2.3 2.3 0 0 0 2.3-2.3v-2.2z" /></svg>
}

function PowerIcon() {
    return <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.8 0" /></svg>
}

function ActivityIcon() {
    return <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
}

function FolderIcon() {
    return <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z" /></svg>
}

function AlertIcon() {
    return <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
}

function CheckIcon() {
    return <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
}

function statusVariant(status: string): BadgeVariant {
    if (['active', 'enabled', 'validated'].includes(status)) return 'success'
    if (['degraded', 'incompatible', 'blocked'].includes(status)) return 'warning'
    if (['failed', 'reload-failed', 'invalid'].includes(status)) return 'destructive'
    return 'default'
}

function severityVariant(severity: string): BadgeVariant {
    if (severity === 'error') return 'destructive'
    if (severity === 'warning') return 'warning'
    return 'default'
}

function sourceLabel(t: (key: string) => string, source: string): string {
    return t(`settings.plugins.source.${source}`)
}

function Chip(props: { icon?: ReactNode; label: string; variant?: BadgeVariant }) {
    return <Badge variant={props.variant ?? 'default'} className="gap-1 font-medium">{props.icon}{props.label}</Badge>
}

function formatConfig(value: unknown): string {
    return JSON.stringify(value ?? {}, null, 2)
}

function parseConfig(text: string, t: (key: string, params?: Record<string, string | number>) => string): Record<string, unknown> {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(t('settings.plugins.config.mustBeObject'))
    }
    const redactedPath = findRedactedPlaceholderPath(parsed)
    if (redactedPath) {
        throw new Error(t('settings.plugins.config.redactedPlaceholder', { path: redactedPath }))
    }
    return parsed as Record<string, unknown>
}

function findRedactedPlaceholderPath(value: unknown, path = '$'): string | null {
    if (value === '[REDACTED]') {
        return path
    }
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            const found = findRedactedPlaceholderPath(value[index], `${path}[${index}]`)
            if (found) return found
        }
        return null
    }
    if (value && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            const found = findRedactedPlaceholderPath(entry, `${path}.${key}`)
            if (found) return found
        }
    }
    return null
}

function reloadLines(t: (key: string, params?: Record<string, string | number>) => string, result: PluginReloadResult): string[] {
    if (result.results.length === 0) {
        return [t('settings.plugins.reloadResult.noChanges')]
    }
    return result.results.map((item) => `${item.id}: ${t(`settings.plugins.action.${item.action}`)} · ${t(`settings.plugins.status.${item.status}`)}${item.message ? ` — ${item.message}` : ''}`)
}

function ResultCard(props: { result: ResultState; onDismiss: () => void }) {
    if (!props.result) return null
    const toneClass = props.result.tone === 'error'
        ? 'border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] text-[var(--app-badge-error-text)]'
        : props.result.tone === 'warning'
            ? 'border-[var(--app-badge-warning-border)] bg-[var(--app-badge-warning-bg)] text-[var(--app-badge-warning-text)]'
            : 'border-[var(--app-badge-success-border)] bg-[var(--app-badge-success-bg)] text-[var(--app-badge-success-text)]'
    return (
        <div className={`rounded-xl border p-3 text-sm ${toneClass}`}>
            <div className="mb-1 flex items-center justify-between gap-3 font-medium">
                <span>{props.result.title}</span>
                <button type="button" className="text-xs opacity-80" onClick={props.onDismiss}>×</button>
            </div>
            <ul className="space-y-1">
                {props.result.lines.map((line, index) => <li key={`${line}-${index}`} className="break-all">{line}</li>)}
            </ul>
        </div>
    )
}

function SectionCard(props: { title: string; description?: string; children: ReactNode }) {
    return (
        <Card className="border border-[var(--app-border)] bg-[var(--app-bg)]">
            <CardHeader>
                <CardTitle>{props.title}</CardTitle>
                {props.description ? <CardDescription>{props.description}</CardDescription> : null}
            </CardHeader>
            <CardContent>{props.children}</CardContent>
        </Card>
    )
}

function KeyValue(props: { label: string; value: ReactNode }) {
    return (
        <div className="grid gap-1 rounded-lg bg-[var(--app-subtle-bg)] p-2 text-sm sm:grid-cols-[8rem_1fr]">
            <div className="font-medium text-[var(--app-hint)]">{props.label}</div>
            <div className="min-w-0 break-all">{props.value}</div>
        </div>
    )
}

function DiagnosticsList(props: { plugin: PluginDetail; t: (key: string, params?: Record<string, string | number>) => string }) {
    const { plugin, t } = props
    if (plugin.diagnostics.length === 0) {
        return <div className="rounded-lg bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">{t('settings.plugins.diagnostics.empty')}</div>
    }
    return (
        <div className="space-y-2">
            {plugin.diagnostics.map((diagnostic, index) => (
                <div key={`${diagnostic.code}-${index}`} className="rounded-lg border border-[var(--app-border)] p-3 text-sm">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                        <Badge variant={severityVariant(diagnostic.severity)}>{t(`settings.plugins.diagnosticSeverity.${diagnostic.severity}`)}</Badge>
                        <span className="font-mono text-xs">{diagnostic.code}</span>
                    </div>
                    <div>{diagnostic.message}</div>
                    {diagnostic.path ? <div className="mt-1 break-all text-xs text-[var(--app-hint)]">{diagnostic.path}</div> : null}
                </div>
            ))}
        </div>
    )
}

export default function PluginPage() {
    const { pluginId } = useParams({ from: '/settings/plugins/$pluginId' })
    const { api } = useAppContext()
    const goBack = useAppGoBack()
    const navigate = useNavigate()
    const { t } = useTranslation()
    const { plugin, isLoading, error } = usePlugin(api, pluginId)
    const actions = usePluginActions(api)
    const [configText, setConfigText] = useState('{}')
    const [initialConfigText, setInitialConfigText] = useState('{}')
    const [result, setResult] = useState<ResultState>(null)
    const [configError, setConfigError] = useState<string | null>(null)
    const [enableDialogOpen, setEnableDialogOpen] = useState(false)
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

    useEffect(() => {
        const next = formatConfig(plugin?.config ?? {})
        setConfigText(next)
        setInitialConfigText(next)
        setConfigError(null)
    }, [plugin])

    const dirtyConfig = configText !== initialConfigText
    const issueCount = useMemo(() => plugin?.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info').length ?? 0, [plugin])
    const canEnablePlugin = plugin ? !['invalid', 'incompatible', 'blocked'].includes(plugin.status) : false
    const canDeletePlugin = plugin?.source === 'user-home'

    const showReloadResult = (title: string, reloadResult: PluginReloadResult) => {
        setResult({
            title,
            tone: reloadResult.ok ? 'success' : 'warning',
            lines: reloadLines(t, reloadResult)
        })
    }

    const runAction = async (title: string, work: () => Promise<PluginReloadResult>): Promise<boolean> => {
        try {
            showReloadResult(title, await work())
            return true
        } catch (err) {
            setResult({ title: t('settings.plugins.error.title'), tone: 'error', lines: [err instanceof Error ? err.message : String(err)] })
            return false
        }
    }

    const enable = async () => {
        if (!plugin) return
        showReloadResult(t('settings.plugins.action.enable'), await actions.enablePlugin(plugin.id))
    }

    const disable = async () => {
        if (!plugin) return
        await runAction(t('settings.plugins.action.disable'), async () => await actions.disablePlugin(plugin.id))
    }

    const reload = async () => {
        if (!plugin) return
        await runAction(t('settings.plugins.action.reload'), async () => await actions.reloadPlugin(plugin.id))
    }

    const deletePlugin = async () => {
        if (!plugin) return
        await actions.deletePlugin(plugin.id)
        navigate({ to: '/settings/plugins', replace: true })
    }

    const saveConfig = async () => {
        if (!plugin) return
        try {
            const parsed = parseConfig(configText, t)
            setConfigError(null)
            const saved = await runAction(t('settings.plugins.action.configSaved'), async () => await actions.saveConfig(plugin.id, parsed))
            if (!saved) {
                return
            }
            const formatted = formatConfig(parsed)
            setConfigText(formatted)
            setInitialConfigText(formatted)
        } catch (err) {
            setConfigError(err instanceof Error ? err.message : t('settings.plugins.config.invalidJson'))
        }
    }

    const formatConfigText = () => {
        try {
            const parsed = parseConfig(configText, t)
            setConfigText(formatConfig(parsed))
            setConfigError(null)
        } catch (err) {
            setConfigError(err instanceof Error ? err.message : t('settings.plugins.config.invalidJson'))
        }
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto flex w-full max-w-content items-center gap-2 border-b border-[var(--app-border)] p-3">
                    <Button type="button" variant="secondary" size="sm" onClick={goBack} className="h-8 w-8 rounded-full p-0"><BackIcon /></Button>
                    <div className="min-w-0 flex-1">
                        <div className="font-semibold">{t('settings.plugins.detail.title')}</div>
                        <div className="truncate text-xs text-[var(--app-hint)]">{pluginId}</div>
                    </div>
                    {plugin ? <Button type="button" variant="outline" size="sm" disabled={actions.isPending} onClick={() => void reload()}>{t('settings.plugins.action.reload')}</Button> : null}
                </div>
            </div>
            <div className="app-scroll-y min-h-0 flex-1">
                <div className="mx-auto w-full max-w-content space-y-3 p-3">
                    {isLoading ? <LoadingState label={t('settings.plugins.detail.loading')} className="p-2" /> : null}
                    {error ? <div className="rounded-xl border border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] p-3 text-sm text-[var(--app-badge-error-text)]">{error}</div> : null}
                    <ResultCard result={result} onDismiss={() => setResult(null)} />
                    {plugin ? (
                        <>
                            <Card className="overflow-hidden border border-[var(--app-border)] bg-[var(--app-bg)]">
                                <div className="bg-gradient-to-br from-[var(--app-secondary-bg)] to-[var(--app-bg)] p-4">
                                    <div className="flex gap-3">
                                        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-[var(--app-bg)] text-[var(--app-link)] shadow-sm"><PuzzleIcon /></div>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <h2 className="truncate text-xl font-semibold">{plugin.name ?? plugin.id}</h2>
                                                <Badge variant={statusVariant(plugin.status)}>{t(`settings.plugins.status.${plugin.status}`)}</Badge>
                                            </div>
                                            <div className="mt-1 text-sm text-[var(--app-hint)]">{t('settings.plugins.detail.meta', { id: plugin.id, version: plugin.version ?? t('settings.plugins.unknown'), status: t(`settings.plugins.status.${plugin.status}`) })}</div>
                                            {plugin.description ? <p className="mt-2 text-sm text-[var(--app-hint)]">{plugin.description}</p> : null}
                                            <div className="mt-3 flex flex-wrap gap-1.5">
                                                <Chip icon={<PowerIcon />} label={plugin.enabled ? t('settings.plugins.state.enabled') : t('settings.plugins.state.disabled')} variant={plugin.enabled ? 'success' : 'default'} />
                                                <Chip icon={<ActivityIcon />} label={plugin.active ? t('settings.plugins.state.active') : t('settings.plugins.state.inactive')} variant={plugin.active ? 'success' : 'default'} />
                                                <Chip icon={<FolderIcon />} label={sourceLabel(t, plugin.source)} />
                                                <Chip icon={issueCount > 0 ? <AlertIcon /> : <CheckIcon />} label={issueCount > 0 ? t('settings.plugins.list.diagnostics', { count: issueCount }) : t('settings.plugins.list.noDiagnostics')} variant={issueCount > 0 ? 'warning' : 'success'} />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </Card>

                            <SectionCard title={t('settings.plugins.detail.actions')} description={t('settings.plugins.detail.actionsDescription')}>
                                <div className="flex flex-wrap gap-2">
                                    {plugin.enabled ? (
                                        <Button type="button" variant="destructive" disabled={actions.isPending} onClick={() => void disable()}>{t('settings.plugins.action.disable')}</Button>
                                    ) : (
                                        <Button type="button" disabled={actions.isPending || !canEnablePlugin} onClick={() => setEnableDialogOpen(true)}>{t('settings.plugins.action.enable')}</Button>
                                    )}
                                    <Button type="button" variant="outline" disabled={actions.isPending} onClick={() => void reload()}>{plugin.status === 'reload-failed' ? t('settings.plugins.action.retryReload') : t('settings.plugins.action.reload')}</Button>
                                    <Button type="button" variant="destructive" disabled={actions.isPending || !canDeletePlugin} onClick={() => setDeleteDialogOpen(true)}>{t('settings.plugins.action.delete')}</Button>
                                </div>
                                {!plugin.enabled && !canEnablePlugin ? <div className="mt-2 text-sm text-[var(--app-hint)]">{t('settings.plugins.action.cannotEnableStatus', { status: t(`settings.plugins.status.${plugin.status}`) })}</div> : null}
                                {!canDeletePlugin ? <div className="mt-2 text-sm text-[var(--app-hint)]">{t('settings.plugins.action.cannotDeleteSource', { source: sourceLabel(t, plugin.source) })}</div> : null}
                            </SectionCard>

                            <SectionCard title={t('settings.plugins.detail.overview')}>
                                <div className="space-y-2">
                                    <KeyValue label={t('settings.plugins.detail.idLabel')} value={plugin.id} />
                                    <KeyValue label={t('settings.plugins.detail.sourceLabel')} value={sourceLabel(t, plugin.source)} />
                                    <KeyValue label={t('settings.plugins.detail.rootLabel')} value={plugin.rootPath} />
                                    <KeyValue label={t('settings.plugins.detail.manifestLabel')} value={plugin.manifestPath} />
                                </div>
                            </SectionCard>

                            <SectionCard title={t('settings.plugins.detail.runtime')} description={t('settings.plugins.detail.runtimeDescription')}>
                                <div className="space-y-2">
                                    {plugin.runtimeEntryPaths.length === 0 ? <div className="text-sm text-[var(--app-hint)]">{t('settings.plugins.none')}</div> : plugin.runtimeEntryPaths.map((entry) => (
                                        <div key={`${entry.runtime}-${entry.realPath}`} className="rounded-lg border border-[var(--app-border)] p-3 text-sm">
                                            <div className="mb-2 flex flex-wrap items-center gap-2">
                                                <Badge>{entry.runtime}</Badge>
                                                <Badge variant={plugin.runtimes.hub?.active ? 'success' : 'default'}>{plugin.runtimes.hub?.active ? t('settings.plugins.state.active') : t('settings.plugins.state.inactive')}</Badge>
                                            </div>
                                            <KeyValue label={t('settings.plugins.detail.hubEntryLabel')} value={entry.entry} />
                                            <div className="mt-2"><KeyValue label={t('settings.plugins.detail.resolvedPathLabel')} value={entry.resolvedPath} /></div>
                                            <div className="mt-2"><KeyValue label={t('settings.plugins.detail.realPathLabel')} value={entry.realPath} /></div>
                                        </div>
                                    ))}
                                </div>
                            </SectionCard>

                            <SectionCard title={t('settings.plugins.detail.contributions')}>
                                {plugin.contributions.notificationChannels.length === 0 ? <div className="text-sm text-[var(--app-hint)]">{t('settings.plugins.detail.noContributions')}</div> : (
                                    <div className="flex flex-wrap gap-2">
                                        {plugin.contributions.notificationChannels.map((channel) => <Chip key={channel.id} icon={<ActivityIcon />} label={`${channel.displayName} · ${channel.id}`} variant="success" />)}
                                    </div>
                                )}
                            </SectionCard>

                            <SectionCard title={t('settings.plugins.detail.permissions')} description={t('settings.plugins.detail.permissionsDescription')}>
                                <div className="space-y-3">
                                    <div>
                                        <div className="mb-1 text-sm font-medium">{t('settings.plugins.detail.networkLabel')}</div>
                                        {plugin.permissions.network.length === 0 ? <div className="text-sm text-[var(--app-hint)]">{t('settings.plugins.permissions.networkEmpty')}</div> : <div className="flex flex-wrap gap-2">{plugin.permissions.network.map((entry) => <Chip key={entry} label={entry} variant="warning" />)}</div>}
                                    </div>
                                    <div>
                                        <div className="mb-1 text-sm font-medium">{t('settings.plugins.detail.secretsLabel')}</div>
                                        {plugin.permissions.secrets.length === 0 ? <div className="text-sm text-[var(--app-hint)]">{t('settings.plugins.permissions.secretsEmpty')}</div> : <div className="flex flex-wrap gap-2">{plugin.permissions.secrets.map((secret) => <Chip key={secret.name} label={`${secret.name}: ${secret.present ? t('settings.plugins.secret.present') : t('settings.plugins.secret.missing')}`} variant={secret.present ? 'success' : 'warning'} />)}</div>}
                                    </div>
                                </div>
                            </SectionCard>

                            <SectionCard title={t('settings.plugins.config.title')} description={t('settings.plugins.config.description')}>
                                <div className="space-y-2">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <label className="text-sm font-medium" htmlFor="plugin-config-json">{t('settings.plugins.config.textareaLabel')}</label>
                                        {dirtyConfig ? <Badge variant="warning">{t('settings.plugins.config.unsaved')}</Badge> : <Badge variant="success">{t('settings.plugins.config.saved')}</Badge>}
                                    </div>
                                    <textarea
                                        id="plugin-config-json"
                                        value={configText}
                                        onChange={(event) => setConfigText(event.target.value)}
                                        className="min-h-48 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3 font-mono text-xs text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--app-button)]"
                                    />
                                    {configError ? <div className="text-sm text-red-600">{configError}</div> : null}
                                    <div className="flex flex-wrap gap-2">
                                        <Button type="button" disabled={actions.isPending || !dirtyConfig} onClick={() => void saveConfig()}>{actions.isPending ? t('settings.plugins.config.saving') : t('settings.plugins.config.saveAndReload')}</Button>
                                        <Button type="button" variant="outline" onClick={formatConfigText}>{t('settings.plugins.config.format')}</Button>
                                        <Button type="button" variant="outline" disabled={!dirtyConfig} onClick={() => { setConfigText(initialConfigText); setConfigError(null) }}>{t('settings.plugins.config.reset')}</Button>
                                    </div>
                                </div>
                            </SectionCard>

                            <SectionCard title={t('settings.plugins.diagnostics.title')}>
                                <DiagnosticsList plugin={plugin} t={t} />
                            </SectionCard>

                            <details className="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-sm">
                                <summary className="cursor-pointer font-medium">{t('settings.plugins.detail.developerDetails')}</summary>
                                <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-[var(--app-subtle-bg)] p-3 text-xs">{JSON.stringify(plugin.manifest ?? {}, null, 2)}</pre>
                            </details>

                            <ConfirmDialog
                                isOpen={enableDialogOpen}
                                onClose={() => setEnableDialogOpen(false)}
                                title={t('settings.plugins.confirm.enable.title')}
                                description={t('settings.plugins.confirm.enable.description')}
                                confirmLabel={t('settings.plugins.confirm.enable.confirm')}
                                confirmingLabel={t('settings.plugins.confirm.enable.confirming')}
                                onConfirm={enable}
                                isPending={actions.isPending}
                            />
                            <ConfirmDialog
                                isOpen={deleteDialogOpen}
                                onClose={() => setDeleteDialogOpen(false)}
                                title={t('settings.plugins.confirm.delete.title')}
                                description={t('settings.plugins.confirm.delete.description', { id: plugin.id, path: plugin.rootPath })}
                                confirmLabel={t('settings.plugins.confirm.delete.confirm')}
                                confirmingLabel={t('settings.plugins.confirm.delete.confirming')}
                                onConfirm={deletePlugin}
                                isPending={actions.isPending}
                                destructive
                            />
                        </>
                    ) : null}
                </div>
            </div>
        </div>
    )
}
