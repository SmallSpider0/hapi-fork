import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { usePlugins } from '@/hooks/queries/usePlugins'
import { usePluginActions } from '@/hooks/mutations/usePluginActions'
import { useTranslation } from '@/lib/use-translation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { LoadingState } from '@/components/LoadingState'
import type { PluginInstallResult, PluginListItem, PluginReloadResult, PluginTargetInventory, PluginTargetScope } from '@hapi/protocol/plugins/admin'

type PluginFilter = 'all' | 'active' | 'enabled' | 'issues'
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
    return <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19.4 13.5a1.9 1.9 0 1 0 0-3.8H17V7.3A2.3 2.3 0 0 0 14.7 5h-2.4a1.9 1.9 0 1 0-3.8 0H6.3A2.3 2.3 0 0 0 4 7.3v2.2a1.9 1.9 0 1 1 0 3.8v2.4A2.3 2.3 0 0 0 6.3 18h2.2a1.9 1.9 0 1 0 3.8 0h2.4a2.3 2.3 0 0 0 2.3-2.3v-2.2z" /></svg>
}

function CheckIcon() {
    return <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
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

function statusVariant(status: string): BadgeVariant {
    if (['active', 'enabled', 'validated'].includes(status)) return 'success'
    if (['degraded', 'incompatible', 'blocked'].includes(status)) return 'warning'
    if (['failed', 'reload-failed', 'invalid'].includes(status)) return 'destructive'
    return 'default'
}

function pluginHasIssue(plugin: PluginListItem): boolean {
    return plugin.diagnostics.some((diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'warning') || ['invalid', 'failed', 'reload-failed', 'blocked', 'incompatible'].includes(plugin.status)
}

function sourceLabel(t: (key: string) => string, source: string): string {
    return t(`settings.plugins.source.${source}`)
}

function pluginTargetLabel(plugin: PluginListItem): string {
    if (!plugin.target) return 'Local'
    if (plugin.target.scope === 'hub') return 'Hub'
    if (plugin.target.runtime === 'runner') return `Runner · ${plugin.target.displayName ?? plugin.target.machineId ?? plugin.target.scope}`
    return plugin.target.scope
}

function pluginRuntimeLabel(plugin: PluginListItem): string {
    const runtimes = Object.keys(plugin.runtimes)
    return runtimes.length > 0 ? runtimes.join(' + ') : 'No runtime'
}

function Chip(props: { icon?: ReactNode; label: string; variant?: BadgeVariant }) {
    return <Badge variant={props.variant ?? 'default'} className="gap-1 font-medium">{props.icon}{props.label}</Badge>
}

function formatReloadLines(t: (key: string, params?: Record<string, string | number>) => string, result?: PluginReloadResult): string[] {
    if (!result || result.results.length === 0) {
        return [t('settings.plugins.reloadResult.noChanges')]
    }
    return result.results.map((item) => `${item.id}: ${t(`settings.plugins.action.${item.action}`)} · ${t(`settings.plugins.status.${item.status}`)}${item.message ? ` — ${item.message}` : ''}`)
}

function formatInstallResult(t: (key: string, params?: Record<string, string | number>) => string, result: PluginInstallResult): ResultState {
    return {
        title: t('settings.plugins.install.resultTitle'),
        tone: result.ok ? 'success' : 'warning',
        lines: [
            t('settings.plugins.install.resultAction', { action: t(`settings.plugins.install.action.${result.action}`), id: result.pluginId ?? t('settings.plugins.unknown') }),
            t('settings.plugins.install.resultTarget', { path: result.targetPath ?? (result.targetResults ? `${result.targetResults.length} targets` : t('settings.plugins.unknown')) }),
            ...formatReloadLines(t, result.reload)
        ]
    }
}

function formatReloadResult(t: (key: string, params?: Record<string, string | number>) => string, result: PluginReloadResult): ResultState {
    return {
        title: t('settings.plugins.result.title'),
        tone: result.ok ? 'success' : 'warning',
        lines: formatReloadLines(t, result)
    }
}

function ResultCard(props: { result: ResultState; onDismiss: () => void }) {
    if (!props.result) return null
    const toneClass = props.result.tone === 'error'
        ? 'border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] text-[var(--app-badge-error-text)]'
        : props.result.tone === 'warning'
            ? 'border-[var(--app-badge-warning-border)] bg-[var(--app-badge-warning-bg)] text-[var(--app-badge-warning-text)]'
            : 'border-[var(--app-badge-success-border)] bg-[var(--app-badge-success-bg)] text-[var(--app-badge-success-text)]'
    return (
        <div className={`mb-3 rounded-xl border p-3 text-sm ${toneClass}`}>
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

function PluginCard(props: {
    plugin: PluginListItem
    onClick: () => void
    t: (key: string, params?: Record<string, string | number>) => string
}) {
    const { plugin, t } = props
    const issueCount = plugin.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info').length
    return (
        <button
            type="button"
            onClick={props.onClick}
            className="group flex w-full gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-left shadow-sm transition hover:border-[var(--app-link)] hover:bg-[var(--app-subtle-bg)]"
        >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--app-secondary-bg)] text-[var(--app-link)]"><PuzzleIcon /></div>
            <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                        <div className="truncate font-medium">{plugin.name ?? plugin.id}</div>
                        <div className="truncate text-xs text-[var(--app-hint)]">{t('settings.plugins.list.meta', { id: plugin.id, version: plugin.version ?? t('settings.plugins.unknown'), source: sourceLabel(t, plugin.source) })}</div>
                    </div>
                    <Badge variant={statusVariant(plugin.status)}>{t(`settings.plugins.status.${plugin.status}`)}</Badge>
                </div>
                {plugin.description ? <div className="line-clamp-2 text-sm text-[var(--app-hint)]">{plugin.description}</div> : null}
                <div className="flex flex-wrap gap-1.5">
                    <Chip label={pluginTargetLabel(plugin)} variant={plugin.target?.active === false ? 'warning' : 'default'} />
                    <Chip label={pluginRuntimeLabel(plugin)} />
                    <Chip icon={<PowerIcon />} label={plugin.enabled ? t('settings.plugins.state.enabled') : t('settings.plugins.state.disabled')} variant={plugin.enabled ? 'success' : 'default'} />
                    <Chip icon={<ActivityIcon />} label={plugin.active ? t('settings.plugins.state.active') : t('settings.plugins.state.inactive')} variant={plugin.active ? 'success' : 'default'} />
                    <Chip icon={<FolderIcon />} label={sourceLabel(t, plugin.source)} />
                    <Chip icon={issueCount > 0 ? <AlertIcon /> : <CheckIcon />} label={issueCount > 0 ? t('settings.plugins.list.diagnostics', { count: issueCount }) : t('settings.plugins.list.noDiagnostics')} variant={issueCount > 0 ? 'warning' : 'success'} />
                </div>
            </div>
        </button>
    )
}

function EmptyState(props: {
    filtered: boolean
    t: (key: string, params?: Record<string, string | number>) => string
}) {
    const title = props.filtered ? props.t('settings.plugins.empty.filteredTitle') : props.t('settings.plugins.empty.title')
    const description = props.filtered ? props.t('settings.plugins.empty.filteredDescription') : props.t('settings.plugins.empty.description')
    return (
        <Card className="border border-dashed border-[var(--app-border)] bg-[var(--app-bg)]">
            <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--app-secondary-bg)] text-[var(--app-link)]"><PuzzleIcon /></div>
                <div>
                    <div className="font-semibold">{title}</div>
                    <div className="mt-1 max-w-sm text-sm text-[var(--app-hint)]">{description}</div>
                </div>
            </CardContent>
        </Card>
    )
}

async function fileToBase64(file: File): Promise<string> {
    const buffer = await file.arrayBuffer()
    let binary = ''
    const bytes = new Uint8Array(buffer)
    const chunkSize = 0x8000
    for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
    }
    return btoa(binary)
}

async function fileSha256(file: File): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function packageFormat(filename: string): 'tgz' | 'zip' | undefined {
    const lowered = filename.toLowerCase()
    if (lowered.endsWith('.zip')) return 'zip'
    if (lowered.endsWith('.tgz') || lowered.endsWith('.tar.gz')) return 'tgz'
    return undefined
}

function targetOptions(targets: PluginTargetInventory[]): Array<{ value: PluginTargetScope; label: string }> {
    const options = new Map<PluginTargetScope, string>()
    options.set('hub', 'Hub')
    for (const target of targets) {
        options.set(target.target.scope, target.target.runtime === 'runner'
            ? `Runner · ${target.target.displayName ?? target.target.machineId ?? target.target.scope}`
            : 'Hub')
    }
    if ([...options.keys()].some((scope) => scope.startsWith('runner:'))) {
        options.set('all-runners', 'All runners')
    }
    return Array.from(options.entries()).map(([value, label]) => ({ value, label }))
}

export default function PluginsPage() {
    const { api } = useAppContext()
    const goBack = useAppGoBack()
    const navigate = useNavigate()
    const { t } = useTranslation()
    const { plugins, targets, isLoading, error, refetch } = usePlugins(api)
    const actions = usePluginActions(api)
    const [filter, setFilter] = useState<PluginFilter>('all')
    const [result, setResult] = useState<ResultState>(null)
    const [enableAfterInstall, setEnableAfterInstall] = useState(false)
    const [overwriteLocal, setOverwriteLocal] = useState(false)
    const [installTarget, setInstallTarget] = useState<PluginTargetScope>('hub')
    const [packageFile, setPackageFile] = useState<File | null>(null)

    const installTargetOptions = useMemo(() => targetOptions(targets), [targets])
    useEffect(() => {
        if (!installTargetOptions.some((option) => option.value === installTarget)) {
            setInstallTarget('hub')
        }
    }, [installTarget, installTargetOptions])

    const counts = useMemo(() => ({
        all: plugins.length,
        active: plugins.filter((plugin) => plugin.active).length,
        enabled: plugins.filter((plugin) => plugin.enabled).length,
        issues: plugins.filter(pluginHasIssue).length
    }), [plugins])

    const filtered = useMemo(() => plugins.filter((plugin) => {
        if (filter === 'active') return plugin.active
        if (filter === 'enabled') return plugin.enabled
        if (filter === 'issues') return pluginHasIssue(plugin)
        return true
    }), [filter, plugins])

    const runWithResult = async (work: () => Promise<ResultState>) => {
        try {
            setResult(await work())
        } catch (err) {
            setResult({
                title: t('settings.plugins.error.title'),
                tone: 'error',
                lines: [err instanceof Error ? err.message : String(err)]
            })
        }
    }

    const installPackage = async () => {
        if (!packageFile) {
            setResult({ title: t('settings.plugins.error.title'), tone: 'error', lines: [t('settings.plugins.install.packageRequired')] })
            return
        }
        const format = packageFormat(packageFile.name)
        if (!format) {
            setResult({ title: t('settings.plugins.error.title'), tone: 'error', lines: [t('settings.plugins.install.packageInvalid')] })
            return
        }
        await runWithResult(async () => formatInstallResult(t, await actions.installPackagePlugin({
            filename: packageFile.name,
            contentBase64: await fileToBase64(packageFile),
            checksum: await fileSha256(packageFile),
            format,
            enable: enableAfterInstall,
            overwrite: overwriteLocal,
            reload: true
        }, installTarget)))
    }

    const reloadAll = async () => {
        await runWithResult(async () => formatReloadResult(t, await actions.reloadPlugins()))
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto flex w-full max-w-content items-center gap-2 border-b border-[var(--app-border)] p-3">
                    <Button type="button" variant="secondary" size="sm" onClick={goBack} className="h-8 w-8 rounded-full p-0"><BackIcon /></Button>
                    <div className="min-w-0 flex-1">
                        <div className="font-semibold">{t('settings.plugins.title')}</div>
                        <div className="truncate text-xs text-[var(--app-hint)]">{t('settings.plugins.subtitle')}</div>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>{t('settings.plugins.refresh')}</Button>
                    <Button type="button" size="sm" disabled={actions.isPending} onClick={() => void reloadAll()}>{t('settings.plugins.reloadAll')}</Button>
                </div>
            </div>
            <div className="app-scroll-y min-h-0 flex-1">
                <div className="mx-auto w-full max-w-content space-y-3 p-3">
                    <Card className="border border-[var(--app-border)] bg-[var(--app-bg)]">
                        <CardContent className="space-y-2 p-3">
                            <div className="flex flex-wrap items-center gap-2">
                                <div className="shrink-0 text-sm font-semibold">{t('settings.plugins.install.title')}</div>
                                <label htmlFor="plugin-install-target" className="sr-only">{t('settings.plugins.install.target')}</label>
                                <select
                                    id="plugin-install-target"
                                    value={installTarget}
                                    onChange={(event) => setInstallTarget(event.target.value as PluginTargetScope)}
                                    className="h-8 min-w-[9rem] rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-sm text-[var(--app-fg)]"
                                >
                                    {installTargetOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                                </select>
                                <label
                                    htmlFor="plugin-package-file"
                                    className={`inline-flex h-8 items-center rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 text-sm font-medium text-[var(--app-fg)] transition ${actions.isPending ? 'pointer-events-none opacity-60' : 'cursor-pointer hover:bg-[var(--app-subtle-bg)]'}`}
                                >
                                    {t('settings.plugins.install.choosePackage')}
                                </label>
                                <input
                                    id="plugin-package-file"
                                    type="file"
                                    accept=".tgz,.tar.gz,.zip"
                                    disabled={actions.isPending}
                                    onChange={(event) => setPackageFile(event.target.files?.[0] ?? null)}
                                    className="sr-only"
                                />
                                <span className="min-w-0 flex-1 truncate text-sm text-[var(--app-hint)]" title={packageFile?.name ?? undefined}>
                                    {packageFile?.name ?? t('settings.plugins.install.noPackageSelected')}
                                </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                                <Button type="button" size="sm" disabled={actions.isPending || !packageFile} onClick={() => void installPackage()}>{t('settings.plugins.install.installPackage')}</Button>
                                <label className="inline-flex items-center gap-1.5 text-xs text-[var(--app-hint)]"><input type="checkbox" checked={enableAfterInstall} onChange={(event) => setEnableAfterInstall(event.target.checked)} />{t('settings.plugins.install.enableAfterInstall')}</label>
                                <label className="inline-flex items-center gap-1.5 text-xs text-[var(--app-hint)]"><input type="checkbox" checked={overwriteLocal} onChange={(event) => setOverwriteLocal(event.target.checked)} />{t('settings.plugins.install.overwriteExisting')}</label>
                            </div>
                        </CardContent>
                    </Card>

                    <ResultCard result={result} onDismiss={() => setResult(null)} />

                    <div className="flex flex-wrap gap-2" aria-label={t('settings.plugins.filterLabel')}>
                        {(['all', 'active', 'enabled', 'issues'] as const).map((entry) => (
                            <Button key={entry} type="button" size="sm" variant={filter === entry ? 'secondary' : 'outline'} onClick={() => setFilter(entry)}>
                                {t(`settings.plugins.filter.${entry}`)} · {counts[entry]}
                            </Button>
                        ))}
                    </div>

                    {error ? <div className="rounded-xl border border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] p-3 text-sm text-[var(--app-badge-error-text)]">{error}</div> : null}
                    {isLoading ? <LoadingState label={t('settings.plugins.loading')} className="p-2" /> : null}
                    {!isLoading && filtered.length === 0 ? <EmptyState filtered={filter !== 'all'} t={t} /> : null}
                    <div className="space-y-2">
                        {filtered.map((plugin) => (
                            <PluginCard
                                key={`${plugin.target?.scope ?? 'local'}-${plugin.id}-${plugin.manifestPath}`}
                                plugin={plugin}
                                t={t}
                                onClick={() => navigate({ to: '/settings/plugins/$pluginId', params: { pluginId: plugin.id }, search: plugin.target?.scope ? { target: plugin.target.scope } : {} })}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </div>
    )
}
