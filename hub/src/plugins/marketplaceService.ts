import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
    PluginMarketplaceCatalogSchema,
    type PluginMarketplaceCatalog,
    type PluginMarketplaceEntry,
    type PluginMarketplaceInstallRequest,
    type PluginMarketplaceRelease
} from '@hapi/protocol/plugins/marketplace'
import type { PluginInstallPlanRequest } from '@hapi/protocol/plugins/admin'
import { inspectPluginPackagePayload } from '@hapi/protocol/plugins/foundation'

export const DEFAULT_PLUGIN_MARKETPLACE_URL = 'https://raw.githubusercontent.com/tiann/hapi/main/marketplace/catalog.v1.json'

export type MarketplaceFetch = (url: string) => Promise<{
    ok: boolean
    status: number
    statusText: string
    text(): Promise<string>
    arrayBuffer(): Promise<ArrayBuffer>
}>

export interface PluginMarketplaceServiceOptions {
    sourceUrl?: string
    fetch?: MarketplaceFetch
    now?: () => number
    cacheTtlMs?: number
}

export interface MarketplaceCatalogSnapshot {
    sourceUrl: string
    fetchedAt: number
    catalog: PluginMarketplaceCatalog
}

export interface MarketplacePackageRequestResult {
    marketplace: {
        sourceUrl: string
        pluginId: string
        repo: string
        version: string
        assetUrl: string
        checksum: string
    }
    request: PluginInstallPlanRequest
}

type NumericVersion = [number, number, number]

function normalizeChecksum(checksum: string): string {
    const trimmed = checksum.trim().toLowerCase()
    return trimmed.startsWith('sha256:') ? trimmed : `sha256:${trimmed}`
}

function sha256(buffer: Buffer): string {
    return `sha256:${createHash('sha256').update(buffer).digest('hex')}`
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
    }
    if (value && typeof value === 'object') {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
            .join(',')}}`
    }
    return JSON.stringify(value)
}

function parseNumericVersion(version: string): NumericVersion {
    const match = version.trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/)
    if (!match) return [0, 0, 0]
    return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(leftRaw: string, rightRaw: string): number {
    const left = parseNumericVersion(leftRaw)
    const right = parseNumericVersion(rightRaw)
    for (let index = 0; index < 3; index += 1) {
        if (left[index] > right[index]) return 1
        if (left[index] < right[index]) return -1
    }
    return leftRaw.localeCompare(rightRaw)
}

function isFileUrl(url: string): boolean {
    return url.startsWith('file://')
}

function isHttpUrl(url: string): boolean {
    return url.startsWith('https://') || url.startsWith('http://')
}

export class PluginMarketplaceService {
    private snapshot: MarketplaceCatalogSnapshot | null = null
    private readonly sourceUrl: string
    private readonly fetchImpl: MarketplaceFetch
    private readonly now: () => number
    private readonly cacheTtlMs: number

    constructor(options: PluginMarketplaceServiceOptions = {}) {
        this.sourceUrl = options.sourceUrl?.trim() || process.env.HAPI_PLUGIN_MARKETPLACE_URL?.trim() || DEFAULT_PLUGIN_MARKETPLACE_URL
        this.fetchImpl = options.fetch ?? (async (url) => await fetch(url))
        this.now = options.now ?? (() => Date.now())
        this.cacheTtlMs = options.cacheTtlMs ?? 10 * 60 * 1000
    }

    async getCatalog(options: { force?: boolean } = {}): Promise<MarketplaceCatalogSnapshot> {
        const now = this.now()
        if (!options.force && this.snapshot && now - this.snapshot.fetchedAt < this.cacheTtlMs) {
            return this.snapshot
        }
        const raw = await this.readText(this.sourceUrl)
        const parsed = PluginMarketplaceCatalogSchema.parse(JSON.parse(raw) as unknown)
        this.snapshot = {
            sourceUrl: this.sourceUrl,
            fetchedAt: now,
            catalog: parsed
        }
        return this.snapshot
    }

    async getEntry(pluginId: string, options: { force?: boolean } = {}): Promise<{ snapshot: MarketplaceCatalogSnapshot; entry: PluginMarketplaceEntry }> {
        const snapshot = await this.getCatalog(options)
        const entry = snapshot.catalog.plugins.find((plugin) => plugin.id === pluginId)
        if (!entry) {
            throw new Error(`Marketplace plugin ${pluginId} was not found.`)
        }
        return { snapshot, entry }
    }

    selectRelease(entry: PluginMarketplaceEntry, version?: string): PluginMarketplaceRelease {
        const candidates = entry.releases
            .filter((release) => !release.yanked)
            .sort((left, right) => compareVersions(right.version, left.version))
        if (version) {
            const exact = candidates.find((release) => release.version === version)
            if (!exact) {
                throw new Error(`Marketplace plugin ${entry.id} version ${version} was not found or has been yanked.`)
            }
            return exact
        }
        const latest = candidates[0]
        if (!latest) {
            throw new Error(`Marketplace plugin ${entry.id} has no installable releases.`)
        }
        return latest
    }

    async buildInstallPlanRequest(pluginId: string, request: PluginMarketplaceInstallRequest = {}): Promise<MarketplacePackageRequestResult> {
        const { snapshot, entry } = await this.getEntry(pluginId)
        const release = this.selectRelease(entry, request.version)
        const bytes = await this.downloadPackage(release)
        const checksum = sha256(bytes)
        if (normalizeChecksum(release.package.checksum) !== checksum) {
            throw new Error(`Marketplace package checksum mismatch for ${entry.id} ${release.version}: expected ${normalizeChecksum(release.package.checksum)}, got ${checksum}.`)
        }
        const packageRequest = {
            filename: release.package.filename,
            contentBase64: bytes.toString('base64'),
            checksum,
            format: release.package.format,
            ...(request.enable !== undefined ? { enable: request.enable } : {}),
            ...(request.reload !== undefined ? { reload: request.reload } : {}),
            ...(request.overwrite !== undefined ? { overwrite: request.overwrite } : {}),
            ...(request.runnerSelection ? { runnerSelection: request.runnerSelection } : {}),
            installSource: {
                type: 'marketplace' as const,
                sourceUrl: snapshot.sourceUrl,
                pluginId: entry.id,
                repo: entry.repo,
                version: release.version,
                assetUrl: release.package.url
            }
        } satisfies PluginInstallPlanRequest

        const inspection = await inspectPluginPackagePayload(packageRequest)
        if (stableStringify(inspection.manifest) !== stableStringify(release.manifest)) {
            throw new Error(`Marketplace catalog manifest does not match package manifest for ${entry.id} ${release.version}.`)
        }

        return {
            marketplace: {
                sourceUrl: snapshot.sourceUrl,
                pluginId: entry.id,
                repo: entry.repo,
                version: release.version,
                assetUrl: release.package.url,
                checksum
            },
            request: packageRequest
        }
    }

    private async readText(sourceUrl: string): Promise<string> {
        if (isFileUrl(sourceUrl)) {
            return await readFile(fileURLToPath(sourceUrl), 'utf8')
        }
        if (!isHttpUrl(sourceUrl)) {
            return await readFile(sourceUrl, 'utf8')
        }
        const response = await this.fetchImpl(sourceUrl)
        if (!response.ok) {
            throw new Error(`Marketplace catalog fetch failed: HTTP ${response.status} ${response.statusText}`)
        }
        return await response.text()
    }

    private async downloadPackage(release: PluginMarketplaceRelease): Promise<Buffer> {
        if (isFileUrl(release.package.url)) {
            return await readFile(fileURLToPath(release.package.url))
        }
        if (!isHttpUrl(release.package.url)) {
            return await readFile(release.package.url)
        }
        const response = await this.fetchImpl(release.package.url)
        if (!response.ok) {
            throw new Error(`Marketplace package download failed: HTTP ${response.status} ${response.statusText}`)
        }
        return Buffer.from(await response.arrayBuffer())
    }
}
