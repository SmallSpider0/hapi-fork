import type {
    PluginHostInfo,
    PluginInstallPackageRequest,
    PluginInstallPlanResponse,
    PluginInstallPlanTarget,
    PluginInstallPosition,
    PluginListItem,
    PluginPackageFormat,
    PluginTargetSummary
} from '@hapi/protocol/plugins/admin'
import type { PluginManifestLite, PluginRuntimeName } from '@hapi/protocol/plugins'

export interface PluginInstallTargetCandidate {
    target: PluginTargetSummary
    plugins: PluginListItem[]
}

export interface BuildPluginInstallPlanOptions {
    planId: string
    now: number
    expiresAt?: number
    manifest: PluginManifestLite
    request: PluginInstallPackageRequest & {
        runnerSelection?: {
            mode?: 'compatible' | 'all' | 'selected'
            machineIds?: string[]
        }
    }
    packageFormat: PluginPackageFormat
    candidates: PluginInstallTargetCandidate[]
}

type NumericVersion = [number, number, number]

function hasEntries(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false
    return Object.values(value as Record<string, unknown>).some((entry) => Array.isArray(entry) ? entry.length > 0 : Boolean(entry))
}

export function inferPluginInstallPositions(manifest: PluginManifestLite): PluginInstallPosition[] {
    const capabilities = manifest.capabilities ?? []
    const hasWeb = hasEntries(manifest.contributions?.web)
        || capabilities.some((capability) => Boolean(capability.parts.web))
    const hasHub = Boolean(manifest.runtimes?.hub)
        || hasEntries(manifest.contributions?.hub)
        || hasEntries(manifest.contributions?.voice)
        || hasEntries(manifest.contributions?.deployment)
        || hasEntries(manifest.contributions?.integration)
        || capabilities.some((capability) => Boolean(capability.parts.hub))
        || hasWeb
    const hasRunner = Boolean(manifest.runtimes?.runner)
        || hasEntries(manifest.contributions?.runner)
        || hasEntries(manifest.contributions?.agent)
        || capabilities.some((capability) => Boolean(capability.parts.runner))

    const positions: PluginInstallPosition[] = []
    if (hasWeb) positions.push('web')
    if (hasHub) positions.push('hub')
    if (hasRunner) positions.push('runner')
    return positions.length > 0 ? positions : ['hub']
}

function parseNumericVersion(version: string): NumericVersion | null {
    const match = version.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
    if (!match) return null
    return [
        Number(match[1]),
        Number(match[2] ?? 0),
        Number(match[3] ?? 0)
    ]
}

function compareVersion(leftRaw: string, rightRaw: string): number | null {
    const left = parseNumericVersion(leftRaw)
    const right = parseNumericVersion(rightRaw)
    if (!left || !right) return null
    for (let index = 0; index < 3; index += 1) {
        if (left[index] > right[index]) return 1
        if (left[index] < right[index]) return -1
    }
    return 0
}

function satisfiesSimpleComparator(version: string, comparator: string): boolean {
    const trimmed = comparator.trim()
    if (!trimmed || trimmed === '*' || trimmed === 'x') return true

    if (trimmed.startsWith('^')) {
        const base = parseNumericVersion(trimmed.slice(1))
        if (!base) return false
        const lower = compareVersion(version, base.join('.'))
        if (lower === null || lower < 0) return false
        const upper: NumericVersion = base[0] === 0
            ? [0, base[1] + 1, 0]
            : [base[0] + 1, 0, 0]
        const upperCompare = compareVersion(version, upper.join('.'))
        return upperCompare !== null && upperCompare < 0
    }

    const match = trimmed.match(/^(<=|>=|<|>|=)?\s*(.+)$/)
    if (!match) return false
    const operator = match[1] ?? '='
    const target = match[2]
    const compare = compareVersion(version, target)
    if (compare === null) return false
    if (operator === '>=') return compare >= 0
    if (operator === '>') return compare > 0
    if (operator === '<=') return compare <= 0
    if (operator === '<') return compare < 0
    return compare === 0
}

export function satisfiesVersionRange(version: string, range: string | undefined): boolean {
    if (!range?.trim()) return true
    return range
        .split('||')
        .some((alternative) => alternative
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .every((comparator) => satisfiesSimpleComparator(version, comparator)))
}

function compatibilityProblems(manifest: PluginManifestLite, runtime: PluginRuntimeName, hostInfo: PluginHostInfo | undefined): string[] {
    if (!hostInfo) {
        return ['Target did not report plugin host information. Upgrade this Runner before installing cross-runtime plugins.']
    }

    const problems: string[] = []
    const global = manifest.compatibility
    const runtimeCompatibility = runtime === 'hub' ? global?.hub : global?.runner
    const hapiRanges = [global?.hapi, runtimeCompatibility?.hapi].filter((entry): entry is string => Boolean(entry))
    for (const range of hapiRanges) {
        if (!satisfiesVersionRange(hostInfo.hapiVersion, range)) {
            problems.push(`${runtime} HAPI version ${hostInfo.hapiVersion} does not satisfy ${range}.`)
        }
    }
    const pluginApiRanges = [global?.pluginApi, runtimeCompatibility?.pluginApi].filter((entry): entry is string => Boolean(entry))
    for (const range of pluginApiRanges) {
        if (!satisfiesVersionRange(hostInfo.pluginApiVersion, range)) {
            problems.push(`${runtime} plugin API version ${hostInfo.pluginApiVersion} does not satisfy ${range}.`)
        }
    }
    const osList = runtimeCompatibility?.os ?? global?.os
    if (osList && !osList.includes(hostInfo.os as 'darwin' | 'linux' | 'win32')) {
        problems.push(`${runtime} OS ${hostInfo.os} is not in supported OS list: ${osList.join(', ')}.`)
    }
    const archList = runtimeCompatibility?.arch ?? global?.arch
    if (archList && !archList.includes(hostInfo.arch)) {
        problems.push(`${runtime} arch ${hostInfo.arch} is not in supported arch list: ${archList.join(', ')}.`)
    }
    const extensionPoints = runtimeCompatibility?.extensionPoints ?? []
    const supported = new Set(hostInfo.supportedExtensionPoints)
    for (const extensionPoint of extensionPoints) {
        if (!supported.has(extensionPoint)) {
            problems.push(`${runtime} does not support extension point ${extensionPoint}.`)
        }
    }
    return problems
}

function existingPluginVersion(plugins: PluginListItem[], pluginId: string): string | undefined {
    return plugins.find((plugin) => plugin.id === pluginId)?.version
}

function selectedRunnerMode(options: BuildPluginInstallPlanOptions): 'compatible' | 'all' | 'selected' {
    if (options.request.runnerSelection?.mode) {
        return options.request.runnerSelection.mode
    }
    const placement = options.manifest.install?.runnerPlacement
    if (placement === 'all-runners') return 'all'
    if (placement === 'selected-runners') return 'selected'
    return 'compatible'
}

function createTargetPlan(options: {
    manifest: PluginManifestLite
    candidate: PluginInstallTargetCandidate
    required: boolean
    overwrite: boolean
    compatibleMode: boolean
}): PluginInstallPlanTarget {
    const runtime = options.candidate.target.runtime
    const offline = options.candidate.target.active !== true || Boolean(options.candidate.target.error)
    const existingVersion = existingPluginVersion(options.candidate.plugins, options.manifest.id)
    const incompatibilities = offline
        ? [options.candidate.target.error ?? 'Target is offline.']
        : compatibilityProblems(options.manifest, runtime, options.candidate.target.hostInfo)
    if (incompatibilities.length > 0) {
        const shouldBlock = options.required && !options.compatibleMode
        return {
            target: options.candidate.target,
            runtime,
            required: options.required,
            compatible: false,
            status: offline ? 'offline' : 'incompatible',
            action: shouldBlock ? 'block' : 'skip',
            ...(existingVersion ? { existingVersion } : {}),
            reason: incompatibilities.join(' ')
        }
    }

    if (existingVersion && existingVersion !== options.manifest.version && !options.overwrite) {
        const shouldBlock = options.required && !options.compatibleMode
        return {
            target: options.candidate.target,
            runtime,
            required: options.required,
            compatible: false,
            status: 'conflict',
            action: shouldBlock ? 'block' : 'skip',
            existingVersion,
            reason: `Plugin ${options.manifest.id} ${existingVersion} is already installed. Enable overwrite to replace it with ${options.manifest.version}.`
        }
    }

    return {
        target: options.candidate.target,
        runtime,
        required: options.required,
        compatible: true,
        status: 'compatible',
        action: existingVersion
            ? existingVersion === options.manifest.version ? 'unchanged' : 'overwrite'
            : 'install',
        ...(existingVersion ? { existingVersion } : {})
    }
}

export function buildPluginInstallPlan(options: BuildPluginInstallPlanOptions): PluginInstallPlanResponse {
    const positions = inferPluginInstallPositions(options.manifest)
    const needsHub = positions.includes('hub')
    const needsRunner = positions.includes('runner')
    const runnerMode = selectedRunnerMode(options)
    const selectedRunnerIds = new Set(options.request.runnerSelection?.machineIds ?? [])
    const compatibleMode = runnerMode === 'compatible'
    const offlineRunnerPolicy = options.manifest.install?.offlineRunnerPolicy ?? 'skip'
    const targets: PluginInstallPlanTarget[] = []
    const warnings: string[] = []
    const blockingErrors: string[] = []

    const hubCandidate = options.candidates.find((candidate) => candidate.target.runtime === 'hub')
    if (needsHub) {
        if (!hubCandidate) {
            blockingErrors.push('Plugin requires Hub installation, but Hub target was not available.')
        } else {
            targets.push(createTargetPlan({
                manifest: options.manifest,
                candidate: hubCandidate,
                required: true,
                overwrite: options.request.overwrite === true,
                compatibleMode: false
            }))
        }
    }

    const runnerCandidates = options.candidates
        .filter((candidate) => candidate.target.runtime === 'runner')
        .filter((candidate) => runnerMode !== 'selected' || (candidate.target.machineId ? selectedRunnerIds.has(candidate.target.machineId) : false))

    if (needsRunner) {
        if (runnerMode === 'selected' && selectedRunnerIds.size === 0) {
            warnings.push('Plugin suggests selected Runner placement, but no Runner was selected. Showing no Runner install target until selection is provided.')
        }
        if (runnerMode === 'selected') {
            const present = new Set(runnerCandidates.map((candidate) => candidate.target.machineId).filter((entry): entry is string => Boolean(entry)))
            for (const machineId of selectedRunnerIds) {
                if (!present.has(machineId)) {
                    blockingErrors.push(`Selected Runner ${machineId} was not found.`)
                }
            }
        }

        for (const candidate of runnerCandidates) {
            const required = runnerMode !== 'compatible'
            const targetPlan = createTargetPlan({
                manifest: options.manifest,
                candidate,
                required,
                overwrite: options.request.overwrite === true,
                compatibleMode
            })
            if (targetPlan.status === 'offline' && offlineRunnerPolicy === 'fail') {
                targets.push({ ...targetPlan, required: true, action: 'block' })
            } else {
                targets.push(targetPlan)
            }
        }

        const readyRunnerTargets = targets.filter((target) =>
            target.runtime === 'runner'
            && target.compatible
            && (target.action === 'install' || target.action === 'overwrite' || target.action === 'unchanged'))
        const minReadyRunnerCount = options.manifest.install?.minReadyRunnerCount ?? (needsRunner ? 1 : 0)
        if (readyRunnerTargets.length < minReadyRunnerCount) {
            blockingErrors.push(`Plugin requires at least ${minReadyRunnerCount} compatible Runner target(s), but only ${readyRunnerTargets.length} are ready.`)
        }
        if (runnerCandidates.length === 0 && minReadyRunnerCount > 0) {
            blockingErrors.push('Plugin requires Runner installation, but no Runner target was available.')
        }
        if (runnerMode === 'all' && targets.some((target) => target.runtime === 'runner' && !target.compatible)) {
            blockingErrors.push('Plugin requested all Runner placement, but at least one Runner target is not installable.')
        }
    }

    for (const target of targets) {
        if (target.action === 'block' && target.reason) {
            blockingErrors.push(`${target.target.displayName ?? target.target.scope}: ${target.reason}`)
        }
    }

    return {
        planId: options.planId,
        createdAt: options.now,
        ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
        plugin: {
            id: options.manifest.id,
            name: options.manifest.name,
            version: options.manifest.version,
            ...(options.manifest.description ? { description: options.manifest.description } : {})
        },
        source: {
            type: 'uploaded-package',
            filename: options.request.filename,
            checksum: options.request.checksum,
            format: options.packageFormat
        },
        positions,
        targets,
        warnings,
        blockingErrors: Array.from(new Set(blockingErrors))
    }
}
