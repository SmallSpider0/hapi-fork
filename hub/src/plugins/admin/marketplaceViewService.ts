import type { PluginListItem } from '@hapi/protocol/plugins/admin'
import type { PluginMarketplaceEntry, PluginMarketplaceEntryView } from '@hapi/protocol/plugins/marketplace'
import { compareMarketplaceVersions } from '../marketplaceService'

export function marketplaceEntryMatches(entry: PluginMarketplaceEntry, filters: {
    query?: string
    category?: string
    runtime?: string
}): boolean {
    if (filters.category && !(entry.categories ?? []).some((category) => category === filters.category)) {
        return false
    }
    if (filters.runtime && !(entry.runtimes ?? []).some((runtime) => runtime === filters.runtime)) {
        return false
    }
    if (!filters.query) {
        return true
    }
    const query = filters.query.toLowerCase()
    const haystack = [
        entry.id,
        entry.name,
        entry.description ?? '',
        entry.repo,
        ...(entry.keywords ?? [])
    ].join('\n').toLowerCase()
    return haystack.includes(query)
}

export function latestMarketplaceVersion(entry: PluginMarketplaceEntry): string | undefined {
    return [...entry.releases]
        .filter((release) => !release.yanked)
        .sort((left, right) => compareMarketplaceVersions(right.version, left.version))[0]?.version
}

export function marketplaceEntriesWithInstallState(entries: PluginMarketplaceEntry[], plugins: PluginListItem[]): PluginMarketplaceEntryView[] {
    const installedById = new Map<string, PluginListItem[]>()
    for (const plugin of plugins) {
        const existing = installedById.get(plugin.id) ?? []
        existing.push(plugin)
        installedById.set(plugin.id, existing)
    }
    return entries.map((entry) => {
        const installedPlugins = installedById.get(entry.id) ?? []
        if (installedPlugins.length === 0) return entry
        const installedVersions = Array.from(new Set(installedPlugins.map((plugin) => plugin.version).filter((version): version is string => Boolean(version))))
        const latestVersion = latestMarketplaceVersion(entry)
        return {
            ...entry,
            installed: {
                ...(installedVersions.length > 0 ? { version: installedVersions.join(' + ') } : {}),
                enabled: installedPlugins.some((plugin) => plugin.enabled),
                yanked: installedVersions.some((version) => entry.releases.find((candidate) => candidate.version === version)?.yanked !== undefined),
                updateAvailable: installedVersions.some((version) => Boolean(latestVersion && compareMarketplaceVersions(latestVersion, version) > 0))
            }
        }
    })
}
