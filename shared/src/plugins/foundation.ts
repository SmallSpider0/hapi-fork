import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, delimiter as platformDelimiter } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import {
    HAPI_PLUGIN_API_VERSION,
    HAPI_PLUGIN_MANIFEST_FILE,
    PluginManifestLiteSchema,
    RawPluginManifestLiteSchema,
    type PluginManifestLite,
    type PluginRuntimeName
} from './manifest'
import { PluginStateFileSchema, type PluginStateFile } from './state'
import type { PluginDiagnostic, PluginDiagnosticSeverity, PluginStatus } from './types'

export type PluginSource = 'env' | 'user-home'

export interface PluginSearchRoot {
    path: string
    source: PluginSource
    priority: number
    includeRootManifest: boolean
}

export interface PluginRuntimeEntryPath {
    runtime: PluginRuntimeName
    entry: string
    resolvedPath: string
    realPath: string
}

export interface DiscoveredPluginRecord {
    rootPath: string
    manifestPath: string
    source: PluginSource
    status: PluginStatus
    manifest?: PluginManifestLite
    diagnostics: PluginDiagnostic[]
    runtimeEntryPaths: PluginRuntimeEntryPath[]
    enabled?: boolean
    config?: Record<string, unknown>
}

export interface DiscoverPluginsOptions {
    hapiHome: string
    envPluginDirs?: string
    delimiter?: string
}

export interface PluginStateReadResult {
    state: PluginStateFile
    parseError?: string
    failClosed: boolean
}

export type PluginDirectoryInstallAction = 'installed' | 'overwritten'

export interface PluginDirectoryInstallResult {
    action: PluginDirectoryInstallAction
    sourcePath: string
    targetPath: string
    record: DiscoveredPluginRecord
}

export class PluginInstallError extends Error {
    constructor(
        readonly code: 'plugin-install-invalid-source' | 'plugin-install-target-exists' | 'plugin-install-unsafe-path' | 'plugin-install-invalid-target',
        message: string
    ) {
        super(message)
        this.name = 'PluginInstallError'
    }
}

export class PluginStateLockError extends Error {
    constructor(lockFile: string) {
        super(`Plugin state is locked by ${lockFile}`)
        this.name = 'PluginStateLockError'
    }
}

function diagnostic(
    code: string,
    message: string,
    severity: PluginDiagnosticSeverity = 'error',
    path?: string
): PluginDiagnostic {
    return { code, message, severity, ...(path ? { path } : {}) }
}

function describeZodError(error: z.ZodError): string {
    return error.issues
        .map((issue) => {
            const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
            return `${path}${issue.message}`
        })
        .join('; ')
}

export function expandHomePath(path: string): string {
    return path.replace(/^~(?=$|[/\\])/, homedir())
}

export function splitPluginDirs(raw: string | undefined, delimiter: string = platformDelimiter): string[] {
    if (!raw) {
        return []
    }
    return raw
        .split(delimiter)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
}

export function getPluginSearchRoots(options: DiscoverPluginsOptions): PluginSearchRoot[] {
    const roots: PluginSearchRoot[] = []
    let priority = 0

    for (const rawPath of splitPluginDirs(options.envPluginDirs, options.delimiter)) {
        roots.push({
            path: resolve(expandHomePath(rawPath)),
            source: 'env',
            priority,
            includeRootManifest: true
        })
        priority += 1
    }

    roots.push({
        path: resolve(expandHomePath(join(options.hapiHome, 'plugins'))),
        source: 'user-home',
        priority,
        includeRootManifest: false
    })

    return roots
}

function isPathInside(parentPath: string, childPath: string): boolean {
    const rel = relative(parentPath, childPath)
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await realpath(path)
        return true
    } catch {
        return false
    }
}

async function rejectSymlinks(path: string): Promise<void> {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) {
        throw new PluginInstallError('plugin-install-unsafe-path', `Plugin directory contains a symbolic link: ${path}`)
    }
    if (!stats.isDirectory()) {
        return
    }
    const entries = await readdir(path)
    for (const entry of entries) {
        await rejectSymlinks(join(path, entry))
    }
}

async function candidatePluginRoots(searchRoot: PluginSearchRoot): Promise<string[]> {
    if (!existsSync(searchRoot.path)) {
        return []
    }

    const manifestAtRoot = join(searchRoot.path, HAPI_PLUGIN_MANIFEST_FILE)
    if (searchRoot.includeRootManifest && existsSync(manifestAtRoot)) {
        return [searchRoot.path]
    }

    try {
        const entries = await readdir(searchRoot.path, { withFileTypes: true })
        return entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(searchRoot.path, entry.name))
            .filter((entryPath) => existsSync(join(entryPath, HAPI_PLUGIN_MANIFEST_FILE)))
            .sort((left, right) => left.localeCompare(right))
    } catch {
        return []
    }
}

async function validateRuntimeEntryPath(runtime: PluginRuntimeName, pluginRoot: string, entry: string, manifestPath: string): Promise<{
    entryPath?: PluginRuntimeEntryPath
    diagnostics: PluginDiagnostic[]
}> {
    const runtimeLabel = runtime === 'hub' ? 'Hub' : 'Runner'
    if (isAbsolute(entry)) {
        return { diagnostics: [diagnostic('entry-path-absolute', `${runtimeLabel} runtime entry must be a relative path.`, 'error', manifestPath)] }
    }

    const rootResolved = resolve(pluginRoot)
    const entryResolved = resolve(rootResolved, entry)
    if (!isPathInside(rootResolved, entryResolved)) {
        return { diagnostics: [diagnostic('entry-path-escape', `${runtimeLabel} runtime entry must stay under the plugin root.`, 'error', manifestPath)] }
    }

    try {
        const [rootRealPath, entryRealPath] = await Promise.all([
            realpath(rootResolved),
            realpath(entryResolved)
        ])

        if (!isPathInside(rootRealPath, entryRealPath)) {
            return { diagnostics: [diagnostic('entry-symlink-escape', `${runtimeLabel} runtime entry realpath must stay under the plugin root.`, 'error', manifestPath)] }
        }

        return {
            entryPath: {
                runtime,
                entry,
                resolvedPath: entryResolved,
                realPath: entryRealPath
            },
            diagnostics: []
        }
    } catch (error) {
        return {
            diagnostics: [diagnostic(
                'entry-path-missing',
                `${runtimeLabel} runtime entry could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
                'error',
                manifestPath
            )]
        }
    }
}


export async function validatePluginRoot(pluginRoot: string, source: PluginSource = 'user-home'): Promise<DiscoveredPluginRecord> {
    const rootPath = resolve(expandHomePath(pluginRoot))
    const manifestPath = join(rootPath, HAPI_PLUGIN_MANIFEST_FILE)
    const baseRecord = {
        rootPath,
        manifestPath,
        source,
        runtimeEntryPaths: []
    }

    let rawManifest: unknown
    try {
        rawManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
        const exists = await pathExists(manifestPath)
        return {
            ...baseRecord,
            status: 'invalid',
            diagnostics: [diagnostic(
                exists ? 'invalid-json' : 'missing-manifest',
                exists
                    ? `Manifest JSON is invalid: ${error instanceof Error ? error.message : String(error)}`
                    : `Missing ${HAPI_PLUGIN_MANIFEST_FILE}.`,
                'error',
                manifestPath
            )]
        }
    }

    const rawParsed = RawPluginManifestLiteSchema.safeParse(rawManifest)
    if (!rawParsed.success) {
        return {
            ...baseRecord,
            status: 'invalid',
            diagnostics: [diagnostic('invalid-manifest', describeZodError(rawParsed.error), 'error', manifestPath)]
        }
    }

    if (rawParsed.data.pluginApiVersion !== HAPI_PLUGIN_API_VERSION) {
        return {
            ...baseRecord,
            status: 'incompatible',
            diagnostics: [diagnostic(
                'plugin-api-version-mismatch',
                `Unsupported pluginApiVersion ${rawParsed.data.pluginApiVersion}; expected ${HAPI_PLUGIN_API_VERSION}.`,
                'error',
                manifestPath
            )]
        }
    }

    const parsed = PluginManifestLiteSchema.safeParse(rawManifest)
    if (!parsed.success) {
        return {
            ...baseRecord,
            status: 'invalid',
            diagnostics: [diagnostic('invalid-manifest', describeZodError(parsed.error), 'error', manifestPath)]
        }
    }

    const supportedOs = parsed.data.compatibility?.os
    if (supportedOs && !supportedOs.includes(process.platform as 'darwin' | 'linux' | 'win32')) {
        return {
            ...baseRecord,
            status: 'incompatible',
            manifest: parsed.data,
            diagnostics: [diagnostic(
                'os-incompatible',
                `Plugin supports ${supportedOs.join(', ')} but this platform is ${process.platform}.`,
                'error',
                manifestPath
            )]
        }
    }

    const runtimeEntryPaths: PluginRuntimeEntryPath[] = []
    const diagnostics: PluginDiagnostic[] = []
    const runtimeEntries: Array<{ runtime: PluginRuntimeName; entry?: string }> = [
        { runtime: 'hub', entry: parsed.data.runtimes?.hub?.entry },
        { runtime: 'runner', entry: parsed.data.runtimes?.runner?.entry }
    ]
    for (const runtimeEntry of runtimeEntries) {
        if (!runtimeEntry.entry) continue
        const entryResult = await validateRuntimeEntryPath(runtimeEntry.runtime, rootPath, runtimeEntry.entry, manifestPath)
        diagnostics.push(...entryResult.diagnostics)
        if (entryResult.entryPath) {
            runtimeEntryPaths.push(entryResult.entryPath)
        }
    }

    if (diagnostics.some((entry) => entry.severity === 'error')) {
        return {
            ...baseRecord,
            status: 'invalid',
            manifest: parsed.data,
            diagnostics,
            runtimeEntryPaths
        }
    }

    return {
        ...baseRecord,
        status: 'validated',
        manifest: parsed.data,
        diagnostics,
        runtimeEntryPaths
    }
}

export async function discoverPlugins(options: DiscoverPluginsOptions): Promise<DiscoveredPluginRecord[]> {
    const records: DiscoveredPluginRecord[] = []
    const searchRoots = getPluginSearchRoots(options)

    for (const searchRoot of searchRoots) {
        const roots = await candidatePluginRoots(searchRoot)
        for (const root of roots) {
            records.push(await validatePluginRoot(root, searchRoot.source))
        }
    }

    const firstById = new Map<string, DiscoveredPluginRecord>()
    for (const record of records) {
        if (!record.manifest) {
            continue
        }
        const first = firstById.get(record.manifest.id)
        if (!first) {
            firstById.set(record.manifest.id, record)
            continue
        }

        record.status = 'blocked'
        record.diagnostics.push(diagnostic(
            'duplicate-plugin-id',
            `Duplicate plugin id ${record.manifest.id}; first manifest at ${first.manifestPath} wins.`,
            'error',
            record.manifestPath
        ))
        first.diagnostics.push(diagnostic(
            'duplicate-plugin-id',
            `Duplicate plugin id ${record.manifest.id} also found at ${record.manifestPath}.`,
            'warning',
            first.manifestPath
        ))
    }

    return records
}


export function applyPluginState(
    records: DiscoveredPluginRecord[],
    state: PluginStateFile,
    failClosed = false
): DiscoveredPluginRecord[] {
    return records.map((record) => {
        if (!record.manifest || record.status !== 'validated') {
            return { ...record, enabled: false }
        }

        if (failClosed) {
            return { ...record, status: 'disabled', enabled: false }
        }

        const stateEntry = state.enabled[record.manifest.id]
        const enabled = stateEntry?.enabled === true
        return {
            ...record,
            status: enabled ? 'enabled' : 'disabled',
            enabled,
            ...(stateEntry?.config ? { config: stateEntry.config } : {})
        }
    })
}

export function getPluginStateFile(hapiHome: string): string {
    return join(expandHomePath(hapiHome), 'plugins.json')
}

export function getUserPluginsDir(hapiHome: string): string {
    return resolve(expandHomePath(join(hapiHome, 'plugins')))
}

export function getUserPluginInstallDir(hapiHome: string, pluginId: string): string {
    return join(getUserPluginsDir(hapiHome), pluginId)
}

export async function installPluginFromDirectory(options: {
    hapiHome: string
    sourcePath: string
    overwrite?: boolean
}): Promise<PluginDirectoryInstallResult> {
    const sourceResolved = resolve(expandHomePath(options.sourcePath))
    let sourceStats
    try {
        sourceStats = await lstat(sourceResolved)
    } catch (error) {
        throw new PluginInstallError(
            'plugin-install-invalid-source',
            `Plugin source path could not be resolved: ${error instanceof Error ? error.message : String(error)}`
        )
    }
    if (sourceStats.isSymbolicLink()) {
        throw new PluginInstallError('plugin-install-unsafe-path', `Plugin source path must not be a symbolic link: ${sourceResolved}`)
    }
    if (!sourceStats.isDirectory()) {
        throw new PluginInstallError('plugin-install-invalid-source', `Plugin source path is not a directory: ${sourceResolved}`)
    }

    let sourceRealPath: string
    try {
        sourceRealPath = await realpath(sourceResolved)
    } catch (error) {
        throw new PluginInstallError(
            'plugin-install-invalid-source',
            `Plugin source path could not be resolved: ${error instanceof Error ? error.message : String(error)}`
        )
    }

    await rejectSymlinks(sourceRealPath)
    const sourceRecord = await validatePluginRoot(sourceRealPath, 'user-home')
    if (!sourceRecord.manifest || sourceRecord.status !== 'validated') {
        const details = sourceRecord.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join('; ')
        throw new PluginInstallError('plugin-install-invalid-source', `Plugin source is not valid: ${details || sourceResolved}`)
    }

    const targetPath = getUserPluginInstallDir(options.hapiHome, sourceRecord.manifest.id)
    const targetParent = getUserPluginsDir(options.hapiHome)
    if (!isPathInside(targetParent, targetPath)) {
        throw new PluginInstallError('plugin-install-unsafe-path', `Plugin target path escapes the user plugin directory: ${targetPath}`)
    }

    if (isPathInside(sourceRealPath, targetPath) || isPathInside(targetPath, sourceRealPath)) {
        throw new PluginInstallError('plugin-install-unsafe-path', 'Plugin source and target paths must not contain each other.')
    }

    const targetExists = await pathExists(targetPath)
    if (targetExists) {
        const targetRealPath = await realpath(targetPath)
        if (isPathInside(sourceRealPath, targetRealPath) || isPathInside(targetRealPath, sourceRealPath)) {
            throw new PluginInstallError('plugin-install-unsafe-path', 'Plugin source and existing target paths must not contain each other.')
        }
        if (!options.overwrite) {
            throw new PluginInstallError('plugin-install-target-exists', `Plugin ${sourceRecord.manifest.id} is already installed at ${targetPath}.`)
        }
    }

    await mkdir(targetParent, { recursive: true, mode: 0o700 })
    if (targetExists) {
        await rm(targetPath, { recursive: true, force: true })
    }
    await cp(sourceRealPath, targetPath, { recursive: true, errorOnExist: true, force: false, dereference: false })

    const copiedRecord = await validatePluginRoot(targetPath, 'user-home')
    if (!copiedRecord.manifest || copiedRecord.status !== 'validated') {
        await rm(targetPath, { recursive: true, force: true }).catch(() => undefined)
        const details = copiedRecord.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join('; ')
        throw new PluginInstallError('plugin-install-invalid-target', `Copied plugin failed validation: ${details || targetPath}`)
    }

    return {
        action: targetExists ? 'overwritten' : 'installed',
        sourcePath: sourceRealPath,
        targetPath,
        record: copiedRecord
    }
}

export async function readPluginState(stateFile: string): Promise<PluginStateReadResult> {
    if (!existsSync(stateFile)) {
        return { state: { enabled: {} }, failClosed: false }
    }

    try {
        const rawState = JSON.parse(await readFile(stateFile, 'utf8'))
        const parsed = PluginStateFileSchema.safeParse(rawState)
        if (!parsed.success) {
            return {
                state: { enabled: {} },
                parseError: describeZodError(parsed.error),
                failClosed: true
            }
        }
        return { state: parsed.data, failClosed: false }
    } catch (error) {
        return {
            state: { enabled: {} },
            parseError: error instanceof Error ? error.message : String(error),
            failClosed: true
        }
    }
}

export async function writePluginState(stateFile: string, state: PluginStateFile): Promise<void> {
    const parsed = PluginStateFileSchema.parse(state)
    const dir = dirname(stateFile)
    await mkdir(dir, { recursive: true, mode: 0o700 })

    const lockFile = `${stateFile}.lock`
    const tmpFile = `${stateFile}.${process.pid}.${Date.now()}.tmp`
    let locked = false

    try {
        await writeFile(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 })
        locked = true
        await writeFile(tmpFile, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
        await rename(tmpFile, stateFile)
    } catch (error) {
        await rm(tmpFile, { force: true })
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new PluginStateLockError(lockFile)
        }
        throw error
    } finally {
        if (locked) {
            await unlink(lockFile).catch(() => undefined)
        }
    }
}
