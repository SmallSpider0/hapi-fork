#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PluginManifestLiteSchema } from '@hapi/protocol/plugins'
import { PluginMarketplaceCatalogSchema } from '@hapi/protocol/plugins/marketplace'

const repoRoot = join(import.meta.dir, '..')
const pluginsRoot = join(repoRoot, 'plugins')
const catalogPath = join(repoRoot, 'marketplace/catalog.v1.json')
const generatedPath = join(repoRoot, 'shared/src/plugins/marketplaceSources.generated.ts')
const check = process.argv.includes('--check')

type SourceFile = { path: string; contentBase64: string }

function toPosix(path: string): string {
    return path.split(sep).join('/')
}

function isPathInside(parentPath: string, childPath: string): boolean {
    const rel = relative(parentPath, childPath)
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
}

function assertSafeRelativePath(path: string): void {
    const normalized = toPosix(path)
    if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
        throw new Error(`Unsafe path: ${path}`)
    }
    if (normalized.split('/').some((part) => part === '..')) {
        throw new Error(`Path must not contain traversal segments: ${path}`)
    }
}

function stableJson(value: unknown): string {
    return `${JSON.stringify(value, null, 4)}\n`
}

function sourceTreeChecksum(files: SourceFile[]): string {
    const hash = createHash('sha256')
    for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
        assertSafeRelativePath(file.path)
        hash.update(file.path)
        hash.update('\0')
        hash.update(Buffer.from(file.contentBase64, 'base64'))
        hash.update('\0')
    }
    return `sha256:${hash.digest('hex')}`
}

function walkFiles(root: string): SourceFile[] {
    const resolvedRoot = resolve(root)
    const result: SourceFile[] = []
    function walk(current: string): void {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const fullPath = join(current, entry.name)
            if (entry.isSymbolicLink()) {
                throw new Error(`Plugin source must not contain symlinks: ${fullPath}`)
            }
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.git') {
                    throw new Error(`Plugin source must not contain ${entry.name}: ${fullPath}`)
                }
                walk(fullPath)
                continue
            }
            if (!entry.isFile()) continue
            const rel = toPosix(relative(resolvedRoot, fullPath))
            assertSafeRelativePath(rel)
            if (rel === 'hapi.plugin.package.json') continue
            result.push({ path: rel, contentBase64: readFileSync(fullPath).toString('base64') })
        }
    }
    walk(resolvedRoot)
    return result.sort((left, right) => left.path.localeCompare(right.path))
}

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

function existingUpdatedAt(): string {
    if (!existsSync(catalogPath)) return new Date().toISOString()
    try {
        const parsed = PluginMarketplaceCatalogSchema.safeParse(readJson(catalogPath))
        if (parsed.success) return parsed.data.updatedAt
    } catch {
        // ignore and write a fresh timestamp below
    }
    return new Date().toISOString()
}

const pluginDirs = existsSync(pluginsRoot)
    ? readdirSync(pluginsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    : []

const plugins = []
const embeddedSources: Record<string, { path: string; treeChecksum: string; files: SourceFile[] }> = {}

for (const dirName of pluginDirs) {
    const pluginRoot = join(pluginsRoot, dirName)
    const sourcePath = toPosix(relative(repoRoot, pluginRoot))
    if (!sourcePath.startsWith('plugins/')) {
        throw new Error(`Plugin source path must stay under plugins/: ${sourcePath}`)
    }
    if (basename(pluginRoot) !== dirName || !isPathInside(pluginsRoot, pluginRoot)) {
        throw new Error(`Invalid plugin source directory: ${pluginRoot}`)
    }

    const manifestPath = join(pluginRoot, 'hapi.plugin.json')
    const marketplacePath = join(pluginRoot, 'hapi.marketplace.json')
    if (!existsSync(manifestPath)) throw new Error(`Missing ${manifestPath}`)
    if (!existsSync(marketplacePath)) throw new Error(`Missing ${marketplacePath}`)

    const manifest = PluginManifestLiteSchema.parse(readJson(manifestPath))
    if (manifest.id !== dirName) {
        throw new Error(`${manifestPath}: manifest.id must match plugin directory name ${dirName}`)
    }
    const metadata = readJson(marketplacePath) as Record<string, unknown>
    const files = walkFiles(pluginRoot)
    const treeChecksum = sourceTreeChecksum(files)
    embeddedSources[manifest.id] = { path: sourcePath, treeChecksum, files }

    const runtimes = Array.from(new Set([
        ...Object.keys(manifest.runtimes ?? {}),
        ...((metadata.runtimes as string[] | undefined) ?? [])
    ])).sort()
    const capabilities = (metadata.capabilities as unknown[] | undefined)
        ?? (manifest.capabilities ?? []).map((capability) => ({
            kind: capability.kind,
            label: capability.displayName
        }))

    plugins.push({
        id: manifest.id,
        name: typeof metadata.name === 'string' ? metadata.name : manifest.name,
        ...(metadata.display ? { display: metadata.display } : manifest.display ? { display: manifest.display } : {}),
        ...(typeof metadata.description === 'string' ? { description: metadata.description } : manifest.description ? { description: manifest.description } : {}),
        repo: typeof metadata.repo === 'string' ? metadata.repo : 'tiann/hapi',
        ...(typeof metadata.homepage === 'string' ? { homepage: metadata.homepage } : {}),
        ...(metadata.author ? { author: metadata.author } : {}),
        ...(typeof metadata.license === 'string' ? { license: metadata.license } : {}),
        ...(Array.isArray(metadata.categories) ? { categories: metadata.categories } : {}),
        ...(Array.isArray(metadata.keywords) ? { keywords: metadata.keywords } : {}),
        ...(runtimes.length > 0 ? { runtimes } : {}),
        ...(Array.isArray(capabilities) && capabilities.length > 0 ? { capabilities } : {}),
        releases: [{
            version: manifest.version,
            tag: `hapi-source-${manifest.version}`,
            releasedAt: existingUpdatedAt(),
            manifest,
            source: {
                type: 'hapi-source',
                path: sourcePath,
                treeChecksum,
                embedded: true
            },
            ...(manifest.compatibility ? { compatibility: manifest.compatibility } : {})
        }]
    })
}

const catalog = PluginMarketplaceCatalogSchema.parse({
    schemaVersion: 'hapi-plugin-marketplace/v1',
    updatedAt: existingUpdatedAt(),
    plugins
})

const generatedModule = `// Generated by scripts/generate-marketplace-sources.ts. Do not edit by hand.\nimport type { PluginMarketplaceCatalog } from './marketplace'\n\nexport const EMBEDDED_PLUGIN_MARKETPLACE_URL = 'embedded://hapi-marketplace/catalog.v1.json'\n\nexport const embeddedPluginMarketplaceCatalog = ${JSON.stringify(catalog, null, 4)} satisfies PluginMarketplaceCatalog\n\nexport const embeddedPluginMarketplaceSources: Record<string, { path: string; treeChecksum: string; files: Array<{ path: string; contentBase64: string }> }> = ${JSON.stringify(embeddedSources, null, 4)}\n`

const nextFiles = new Map([
    [catalogPath, stableJson(catalog)],
    [generatedPath, generatedModule]
])

let changed = false
for (const [path, next] of nextFiles) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (current !== next) {
        changed = true
        if (check) {
            console.error(`[marketplace:generate] ${toPosix(relative(repoRoot, path))} is not up to date.`)
        } else {
            writeFileSync(path, next)
            console.log(`[marketplace:generate] wrote ${toPosix(relative(repoRoot, path))}`)
        }
    }
}

if (check && changed) {
    console.error('[marketplace:generate] Run bun run marketplace:generate to update generated marketplace files.')
    process.exit(1)
}

if (!changed) {
    console.log(`[marketplace:generate] OK: ${plugins.length} source plugin entries.`)
}
