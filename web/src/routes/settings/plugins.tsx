import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { usePlugins } from '@/hooks/queries/usePlugins'
import { usePluginActions } from '@/hooks/mutations/usePluginActions'
import { useTranslation } from '@/lib/use-translation'
import { localizedPluginDescription, localizedPluginName } from '@/lib/plugin-metadata'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { LoadingState } from '@/components/LoadingState'
import type { PluginInstallPlanResponse, PluginInstallResult, PluginListItem, PluginReloadResult } from '@hapi/protocol/plugins/admin'

type PluginFilter = 'all' | 'active' | 'enabled' | 'issues'
type BadgeVariant = 'default' | 'warning' | 'success' | 'destructive'
export type PluginDisplayGroup = {
    id: string
    name?: string
    version?: string
    description?: string
    display?: PluginListItem['display']
    source: PluginListItem['source']
    status: PluginListItem['status']
    enabled: boolean
    active: boolean
    diagnostics: PluginListItem['diagnostics']
    plugins: PluginListItem[]
    primary: PluginListItem
}
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

function pluginGroupHasIssue(group: PluginDisplayGroup): boolean {
    return group.diagnostics.some((diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'warning') || ['invalid', 'failed', 'reload-failed', 'blocked', 'incompatible'].includes(group.status)
}

function sourceLabel(t: (key: string) => string, source: string): string {
    return t(`settings.plugins.source.${source}`)
}

function pluginTargetLabel(t: (key: string, params?: Record<string, string | number>) => string, plugin: PluginListItem): string {
    if (!plugin.target) return t('settings.plugins.target.local')
    if (plugin.target.scope === 'hub') return t('settings.plugins.target.hub')
    if (plugin.target.runtime === 'runner') return t('settings.plugins.target.runner', { name: plugin.target.displayName ?? plugin.target.machineId ?? plugin.target.scope })
    return plugin.target.scope
}

function targetLabel(t: (key: string, params?: Record<string, string | number>) => string, target: { scope: string; runtime: string; displayName?: string; machineId?: string }): string {
    if (target.scope === 'hub') return t('settings.plugins.target.hub')
    if (target.runtime === 'runner') return t('settings.plugins.target.runner', { name: target.displayName ?? target.machineId ?? target.scope })
    return target.scope
}

function Chip(props: { icon?: ReactNode; label: string; variant?: BadgeVariant }) {
    return <Badge variant={props.variant ?? 'default'} className="gap-1 font-medium">{props.icon}{props.label}</Badge>
}

function uniqueStrings(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean)))
}

function groupTargetLabel(t: (key: string, params?: Record<string, string | number>) => string, group: PluginDisplayGroup): string {
    const labels = uniqueStrings(group.plugins.map((plugin) => pluginTargetLabel(t, plugin)))
    if (labels.length <= 2) return labels.join(' + ')
    return t('settings.plugins.target.count', { count: labels.length })
}

function groupSourceLabel(t: (key: string) => string, group: PluginDisplayGroup): string {
    return uniqueStrings(group.plugins.map((plugin) => sourceLabel(t, plugin.source))).join(' + ')
}

function groupVersionLabel(t: (key: string) => string, group: PluginDisplayGroup): string {
    const versions = uniqueStrings(group.plugins.map((plugin) => plugin.version ?? ''))
    if (versions.length === 0) return t('settings.plugins.unknown')
    return versions.join(' + ')
}

function pluginMeta(t: (key: string, params?: Record<string, string | number>) => string, group: PluginDisplayGroup, issueCount: number): string {
    const parts = [
        groupVersionLabel(t, group),
        groupSourceLabel(t, group),
        groupTargetLabel(t, group)
    ]
    if (issueCount > 0) {
        parts.push(t('settings.plugins.list.diagnostics', { count: issueCount }))
    }
    return parts.join(' · ')
}

const PLUGIN_STATUS_RANK: Record<PluginListItem['status'], number> = {
    invalid: 100,
    failed: 95,
    'reload-failed': 94,
    blocked: 90,
    incompatible: 85,
    degraded: 80,
    active: 70,
    enabled: 60,
    validated: 50,
    discovered: 40,
    disabled: 10
}

function pluginStatusRank(status: PluginListItem['status']): number {
    return PLUGIN_STATUS_RANK[status] ?? 0
}

function isHubDescriptorMirror(plugin: PluginListItem): boolean {
    return plugin.target?.scope === 'hub'
        && !plugin.runtimes.hub
        && Boolean(plugin.runtimes.runner)
}

function primaryPluginRank(plugin: PluginListItem): number {
    return (plugin.active ? 1000 : 0)
        + (plugin.enabled ? 500 : 0)
        + pluginStatusRank(plugin.status)
        + (isHubDescriptorMirror(plugin) ? -100 : 0)
        + (plugin.target?.runtime === 'runner' ? 10 : 0)
}

function comparePluginsForDisplay(left: PluginListItem, right: PluginListItem): number {
    return right.id.localeCompare(left.id)
        || (right.target?.scope ?? '').localeCompare(left.target?.scope ?? '')
}

function comparePluginGroupsForDisplay(left: PluginDisplayGroup, right: PluginDisplayGroup): number {
    return left.id.localeCompare(right.id)
}

export function groupPluginListForDisplay(plugins: PluginListItem[]): PluginDisplayGroup[] {
    const grouped = new Map<string, PluginListItem[]>()
    for (const plugin of plugins) {
        const existing = grouped.get(plugin.id)
        if (existing) {
            existing.push(plugin)
        } else {
            grouped.set(plugin.id, [plugin])
        }
    }

    return Array.from(grouped.entries())
        .map(([id, entries]) => {
            const sorted = [...entries].sort((left, right) =>
                primaryPluginRank(right) - primaryPluginRank(left)
                    || (left.target?.scope ?? '').localeCompare(right.target?.scope ?? '')
            )
            const primary = sorted[0]!
            const worst = [...sorted].sort((left, right) => pluginStatusRank(right.status) - pluginStatusRank(left.status))[0] ?? primary
            return {
                id,
                name: primary.name ?? sorted.find((plugin) => plugin.name)?.name,
                version: primary.version ?? sorted.find((plugin) => plugin.version)?.version,
                description: primary.description ?? sorted.find((plugin) => plugin.description)?.description,
                display: primary.display ?? sorted.find((plugin) => plugin.display)?.display,
                source: primary.source,
                status: worst.status,
                enabled: sorted.some((plugin) => plugin.enabled),
                active: sorted.some((plugin) => plugin.active),
                diagnostics: sorted.flatMap((plugin) => plugin.diagnostics),
                plugins: sorted.sort(comparePluginsForDisplay),
                primary
            }
        })
        .sort(comparePluginGroupsForDisplay)
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
            t('settings.plugins.install.resultTarget', { path: result.targetPath ?? (result.targetResults ? t('settings.plugins.install.targetCount', { count: result.targetResults.length }) : t('settings.plugins.unknown')) }),
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
    group: PluginDisplayGroup
    onClick: () => void
    t: (key: string, params?: Record<string, string | number>) => string
    locale: 'en' | 'zh-CN'
}) {
    const { group, t, locale } = props
    const issueCount = group.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info').length
    const name = localizedPluginName(group, locale)
    const description = localizedPluginDescription(group, locale)
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
                        <div className="truncate font-medium">{name}</div>
                        <div className="truncate text-xs text-[var(--app-hint)]">{pluginMeta(t, group, issueCount)}</div>
                    </div>
                    <Badge variant={statusVariant(group.status)}>{t(`settings.plugins.status.${group.status}`)}</Badge>
                </div>
                {description ? <div className="line-clamp-2 text-sm text-[var(--app-hint)]">{description}</div> : null}
                {group.plugins.length > 1 ? (
                    <div className="flex flex-wrap gap-1">
                        {group.plugins.map((plugin) => (
                            <Chip
                                key={`${group.id}-${plugin.target?.scope ?? 'local'}`}
                                label={pluginTargetLabel(t, plugin)}
                                variant={plugin.active ? 'success' : plugin.enabled ? 'warning' : 'default'}
                            />
                        ))}
                    </div>
                ) : null}
                {issueCount > 0 ? <div><Chip icon={<AlertIcon />} label={t('settings.plugins.list.diagnostics', { count: issueCount })} variant="warning" /></div> : null}
            </div>
        </button>
    )
}

function EmptyState(props: {
    filtered: boolean
    t: (key: string, params?: Record<string, string | number>) => string
}) {
    const title = props.filtered ? props.t('settings.plugins.empty.filteredTitle') : props.t('settings.plugins.empty.title')
    return (
        <Card className="border border-dashed border-[var(--app-border)] bg-[var(--app-bg)]">
            <CardContent className="flex items-center justify-center gap-3 p-6 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--app-secondary-bg)] text-[var(--app-link)]"><PuzzleIcon /></div>
                <div className="font-semibold">{title}</div>
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

function planActionVariant(action: string): BadgeVariant {
    if (action === 'install' || action === 'overwrite' || action === 'unchanged') return 'success'
    if (action === 'skip') return 'warning'
    return 'destructive'
}

function InstallPlanCard(props: {
    plan: PluginInstallPlanResponse | null
    t: (key: string, params?: Record<string, string | number>) => string
    locale: 'en' | 'zh-CN'
}) {
    if (!props.plan) return null
    const { plan, t } = props
    return (
        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-sm">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="font-medium">{t('settings.plugins.install.planTitle')}</div>
                    <div className="text-xs text-[var(--app-hint)]">{localizedPluginName(plan.plugin, props.locale)} · {plan.plugin.version}</div>
                </div>
                <div className="flex flex-wrap gap-1">
                    {plan.positions.map((position) => <Badge key={position} variant="default">{t(`settings.plugins.install.position.${position}`)}</Badge>)}
                </div>
            </div>
            {plan.warnings.length > 0 ? (
                <ul className="mb-2 space-y-1 rounded-lg border border-[var(--app-badge-warning-border)] bg-[var(--app-badge-warning-bg)] p-2 text-xs text-[var(--app-badge-warning-text)]">
                    {plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
            ) : null}
            {plan.blockingErrors.length > 0 ? (
                <ul className="mb-2 space-y-1 rounded-lg border border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] p-2 text-xs text-[var(--app-badge-error-text)]">
                    {plan.blockingErrors.map((blockingError) => <li key={blockingError}>{blockingError}</li>)}
                </ul>
            ) : null}
            <div className="space-y-2">
                {plan.targets.map((target) => (
                    <div key={target.target.scope} className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                                <div className="font-medium">{targetLabel(t, target.target)}</div>
                                <div className="text-xs text-[var(--app-hint)]">
                                    {target.target.hostInfo
                                        ? `${target.target.hostInfo.hapiVersion} · API ${target.target.hostInfo.pluginApiVersion} · ${target.target.hostInfo.os}/${target.target.hostInfo.arch}`
                                        : t('settings.plugins.install.hostUnknown')}
                                </div>
                            </div>
                            <div className="flex flex-wrap gap-1">
                                <Badge variant={target.compatible ? 'success' : 'warning'}>{t(`settings.plugins.install.status.${target.status}`)}</Badge>
                                <Badge variant={planActionVariant(target.action)}>{t(`settings.plugins.install.planAction.${target.action}`)}</Badge>
                            </div>
                        </div>
                        {target.reason ? <div className="mt-1 text-xs text-[var(--app-hint)]">{target.reason}</div> : null}
                    </div>
                ))}
            </div>
        </div>
    )
}

export default function PluginsPage() {
    const { api } = useAppContext()
    const goBack = useAppGoBack()
    const navigate = useNavigate()
    const { t, locale } = useTranslation()
    const { plugins, isLoading, error, refetch } = usePlugins(api)
    const actions = usePluginActions(api)
    const [filter, setFilter] = useState<PluginFilter>('all')
    const [result, setResult] = useState<ResultState>(null)
    const [enableAfterInstall, setEnableAfterInstall] = useState(false)
    const [overwriteLocal, setOverwriteLocal] = useState(false)
    const [packageFile, setPackageFile] = useState<File | null>(null)
    const [installPlan, setInstallPlan] = useState<PluginInstallPlanResponse | null>(null)

    const pluginGroups = useMemo(() => groupPluginListForDisplay(plugins), [plugins])

    useEffect(() => {
        setInstallPlan(null)
    }, [packageFile, enableAfterInstall, overwriteLocal])

    const counts = useMemo(() => ({
        all: pluginGroups.length,
        active: pluginGroups.filter((group) => group.active).length,
        enabled: pluginGroups.filter((group) => group.enabled).length,
        issues: pluginGroups.filter(pluginGroupHasIssue).length
    }), [pluginGroups])

    const filtered = useMemo(() => pluginGroups.filter((group) => {
        if (filter === 'active') return group.active
        if (filter === 'enabled') return group.enabled
        if (filter === 'issues') return pluginGroupHasIssue(group)
        return true
    }), [filter, pluginGroups])

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

    const createPackageInstallPlan = async (): Promise<PluginInstallPlanResponse | null> => {
        if (!packageFile) {
            setResult({ title: t('settings.plugins.error.title'), tone: 'error', lines: [t('settings.plugins.install.packageRequired')] })
            return null
        }
        const format = packageFormat(packageFile.name)
        if (!format) {
            setResult({ title: t('settings.plugins.error.title'), tone: 'error', lines: [t('settings.plugins.install.packageInvalid')] })
            return null
        }
        const plan = await actions.createInstallPlan({
            filename: packageFile.name,
            contentBase64: await fileToBase64(packageFile),
            checksum: await fileSha256(packageFile),
            format,
            enable: enableAfterInstall,
            overwrite: overwriteLocal,
            reload: true
        })
        setInstallPlan(plan)
        if (plan.blockingErrors.length > 0) {
            setResult({
                title: t('settings.plugins.install.planBlocked'),
                tone: 'warning',
                lines: plan.blockingErrors
            })
        } else {
            setResult({
                title: t('settings.plugins.install.planReady'),
                tone: 'success',
                lines: [t('settings.plugins.install.planTargets', { count: plan.targets.filter((target) => target.action !== 'skip' && target.action !== 'block').length })]
            })
        }
        return plan
    }

    const previewInstallPlan = async () => {
        await runWithResult(async () => {
            const plan = await createPackageInstallPlan()
            if (!plan) return { title: t('settings.plugins.error.title'), tone: 'error', lines: [t('settings.plugins.install.packageRequired')] }
            return {
                title: plan.blockingErrors.length > 0 ? t('settings.plugins.install.planBlocked') : t('settings.plugins.install.planReady'),
                tone: plan.blockingErrors.length > 0 ? 'warning' : 'success',
                lines: plan.blockingErrors.length > 0
                    ? plan.blockingErrors
                    : [t('settings.plugins.install.planTargets', { count: plan.targets.filter((target) => target.action !== 'skip' && target.action !== 'block').length })]
            }
        })
    }

    const installPackage = async () => {
        await runWithResult(async () => {
            const plan = installPlan ?? await createPackageInstallPlan()
            if (!plan) {
                return { title: t('settings.plugins.error.title'), tone: 'error', lines: [t('settings.plugins.install.packageRequired')] }
            }
            if (plan.blockingErrors.length > 0) {
                return { title: t('settings.plugins.install.planBlocked'), tone: 'warning', lines: plan.blockingErrors }
            }
            return formatInstallResult(t, await actions.executeInstallPlan(plan.planId))
        })
        setInstallPlan(null)
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
                                <Button type="button" variant="outline" size="sm" disabled={actions.isPending || !packageFile} onClick={() => void previewInstallPlan()}>{t('settings.plugins.install.previewPlan')}</Button>
                                <Button type="button" size="sm" disabled={actions.isPending || !packageFile || (installPlan?.blockingErrors.length ?? 0) > 0} onClick={() => void installPackage()}>{t('settings.plugins.install.installPackage')}</Button>
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                                <label className="inline-flex items-center gap-1.5 text-xs text-[var(--app-hint)]"><input type="checkbox" checked={enableAfterInstall} onChange={(event) => setEnableAfterInstall(event.target.checked)} />{t('settings.plugins.install.enableAfterInstall')}</label>
                                <label className="inline-flex items-center gap-1.5 text-xs text-[var(--app-hint)]"><input type="checkbox" checked={overwriteLocal} onChange={(event) => setOverwriteLocal(event.target.checked)} />{t('settings.plugins.install.overwriteExisting')}</label>
                            </div>
                            {packageFile ? (
                                <div className="w-full min-w-0 truncate text-xs text-[var(--app-hint)]" title={packageFile.name}>
                                    {t('settings.plugins.install.selectedPackage', { filename: packageFile.name })}
                                </div>
                            ) : null}
                            <InstallPlanCard plan={installPlan} t={t} locale={locale} />
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
                        {filtered.map((group) => (
                            <PluginCard
                                key={group.id}
                                group={group}
                                t={t}
                                locale={locale}
                                onClick={() => navigate({
                                    to: '/settings/plugins/$pluginId',
                                    params: { pluginId: group.id },
                                    search: group.primary.target?.scope ? { target: group.primary.target.scope } : {}
                                })}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </div>
    )
}
