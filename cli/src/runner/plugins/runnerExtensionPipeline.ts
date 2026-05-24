import { delimiter, isAbsolute, win32 } from 'node:path'
import type { SpawnSessionOptions } from '@/modules/common/rpcTypes'
import type { HappyCliSpawnPlan } from '@/utils/spawnHappyCLI'
import type { PluginDiagnostic } from '@hapi/protocol/plugins'
import {
    RunnerCommandResolverProposalSchema,
    RunnerEnvironmentProposalSchema,
    RunnerResolvedSpawnOptionsSchema,
    RunnerSpawnContextSchema,
    RunnerSpawnHookProposalSchema,
    RunnerSpawnOptionsContextSchema,
    RunnerSpawnOptionsProviderProposalSchema,
    type RunnerCommandResolverProposal,
    type RunnerCommandResolverContribution,
    type RunnerEnvironmentProposal,
    type RunnerEnvironmentProviderContribution,
    type RunnerResolvedSpawnOptions,
    type RunnerSpawnOptionsAppliedEntry,
    type RunnerExtensionAuditEvent,
    type RunnerResolvedSpawnPlan,
    type RunnerSpawnOptionDefaults,
    type RunnerSpawnContext,
    type RunnerSpawnHookContribution,
    type RunnerSpawnHookProposal,
    type RunnerSpawnOptionsContext,
    type RunnerSpawnOptionsProviderContribution
} from '@hapi/protocol/plugins'

const DEFAULT_EXTENSION_TIMEOUT_MS = 1000
const PROTECTED_ENV_KEYS = new Set([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CODEX_HOME',
    'HAPI_CLI_EXECUTABLE',
    'HAPI_INVOKED_CWD'
])
const ALLOWED_HAPI_SUBCOMMANDS = new Set(['claude', 'codex', 'cursor', 'gemini', 'opencode', 'agent-plugin'])

type MaybePromise<T> = T | Promise<T>

export type {
    RunnerCommandResolverContribution,
    RunnerEnvironmentProviderContribution,
    RunnerSpawnOptionsProviderContribution,
    RunnerSpawnHookContribution
} from '@hapi/protocol/plugins'

export type RegisteredRunnerContribution<T> = {
    pluginId: string
    id: string
    order: number
    priority: number
    contribution: T
}

export type RunnerSpawnBasePlan = {
    command: string
    args: string[]
    displayArgs: string[]
    mode: HappyCliSpawnPlan['mode']
    cwd: string
    env: NodeJS.ProcessEnv
}

export type ResolveRunnerSpawnPlanInput = {
    machineId: string
    options: SpawnSessionOptions
    agent: string
    basePlan: RunnerSpawnBasePlan
    environmentProviders: RegisteredRunnerContribution<RunnerEnvironmentProviderContribution>[]
    commandResolvers: RegisteredRunnerContribution<RunnerCommandResolverContribution>[]
    spawnHooks: RegisteredRunnerContribution<RunnerSpawnHookContribution>[]
    timeoutMs?: number
    pathDelimiter?: string
}

export type ResolveRunnerSpawnOptionsInput = {
    machineId: string
    options: SpawnSessionOptions
    agent: string
    cwd: string
    spawnOptionsProviders: RegisteredRunnerContribution<RunnerSpawnOptionsProviderContribution>[]
    timeoutMs?: number
}

function contributionSort<T>(left: RegisteredRunnerContribution<T>, right: RegisteredRunnerContribution<T>): number {
    return left.priority - right.priority
        || left.pluginId.localeCompare(right.pluginId)
        || left.id.localeCompare(right.id)
        || left.order - right.order
}

function diagnostic(severity: PluginDiagnostic['severity'], code: string, message: string): PluginDiagnostic {
    return { severity, code, message }
}

function contributionDiagnostic(
    entry: { pluginId: string; id: string },
    severity: PluginDiagnostic['severity'],
    code: string,
    message: string
): PluginDiagnostic & { pluginId: string } {
    return { pluginId: entry.pluginId, severity, code, message }
}

function contributionLabel(entry: { pluginId: string; id: string }): string {
    return `${entry.pluginId}:${entry.id}`
}

function withTimeout<T>(work: MaybePromise<T>, timeoutMs: number, label: string): Promise<T> {
    let timeout: NodeJS.Timeout | null = null
    return Promise.race([
        Promise.resolve(work),
        new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
        })
    ]).finally(() => {
        if (timeout) clearTimeout(timeout)
    })
}

function isCrossPlatformAbsolutePath(value: string): boolean {
    return isAbsolute(value) || win32.isAbsolute(value)
}

function normalizeBaseEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function envKeyIsProtected(key: string): boolean {
    return key.startsWith('HAPI_') || PROTECTED_ENV_KEYS.has(key)
}

export function mergePathValue(args: {
    base?: string
    prepend?: string[]
    append?: string[]
    delimiter?: string
}): string {
    const separator = args.delimiter ?? delimiter
    const current = args.base ? args.base.split(separator).filter(Boolean) : []
    const next = [...(args.prepend ?? []), ...current, ...(args.append ?? [])]
    const seen = new Set<string>()
    return next.filter((entry) => {
        if (seen.has(entry)) return false
        seen.add(entry)
        return true
    }).join(separator)
}

function buildContext(input: ResolveRunnerSpawnPlanInput, plan: RunnerSpawnBasePlan): RunnerSpawnContext {
    return RunnerSpawnContextSchema.parse({
        machineId: input.machineId,
        agent: input.agent,
        directory: input.options.directory,
        cwd: plan.cwd,
        args: plan.displayArgs,
        envKeys: Object.keys(plan.env).filter((key) => typeof plan.env[key] === 'string').sort(),
        ...(input.options.sessionType ? { sessionType: input.options.sessionType } : {}),
        ...(input.options.worktreeName ? { worktreeName: input.options.worktreeName } : {}),
        ...(input.options.resumeSessionId ? { resumeSessionId: input.options.resumeSessionId } : {}),
        ...(input.options.model ? { model: input.options.model } : {}),
        ...(input.options.effort ? { effort: input.options.effort } : {}),
        ...(input.options.modelReasoningEffort ? { modelReasoningEffort: input.options.modelReasoningEffort } : {}),
        ...(input.options.permissionMode ? { permissionMode: input.options.permissionMode } : {}),
        ...(input.options.yolo !== undefined ? { yolo: input.options.yolo } : {}),
        ...(input.options.manualFields?.length ? { manualFields: input.options.manualFields } : {}),
        ...(input.options.pluginFields ? { pluginFields: input.options.pluginFields } : {})
    })
}

function buildOptionsContext(input: ResolveRunnerSpawnOptionsInput, options: SpawnSessionOptions): RunnerSpawnOptionsContext {
    return RunnerSpawnOptionsContextSchema.parse({
        machineId: input.machineId,
        agent: input.agent,
        directory: options.directory,
        cwd: input.cwd,
        ...(options.sessionType ? { sessionType: options.sessionType } : {}),
        ...(options.worktreeName ? { worktreeName: options.worktreeName } : {}),
        ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.modelReasoningEffort ? { modelReasoningEffort: options.modelReasoningEffort } : {}),
        ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
        ...(options.yolo !== undefined ? { yolo: options.yolo } : {}),
        ...(options.manualFields?.length ? { manualFields: options.manualFields } : {}),
        ...(options.pluginFields ? { pluginFields: options.pluginFields } : {})
    })
}

function proposalFields(proposal: RunnerSpawnOptionDefaults): string[] {
    return (Object.entries(proposal) as Array<[keyof RunnerSpawnOptionDefaults, unknown]>)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
}

function applySpawnOptionsProposal(args: {
    entry: { pluginId: string; id: string }
    options: SpawnSessionOptions
    proposal: RunnerSpawnOptionDefaults
    audit: RunnerExtensionAuditEvent[]
}): string[] {
    const source = contributionLabel(args.entry)
    const fields: string[] = []
    for (const [key, value] of Object.entries(args.proposal) as Array<[keyof RunnerSpawnOptionDefaults, unknown]>) {
        if (value === undefined) continue
        ;(args.options as unknown as Record<string, unknown>)[key] = value
        fields.push(key)
        args.audit.push({
            phase: 'spawnOptions',
            pluginId: args.entry.pluginId,
            contributionId: args.entry.id,
            field: `options.${key}`,
            message: `${source} set launch option ${key}`
        })
    }
    return fields
}

function stripControlOnlySpawnOptions(options: SpawnSessionOptions): SpawnSessionOptions {
    const clean = { ...options } as SpawnSessionOptions & { machineId?: unknown }
    delete clean.machineId
    return clean
}

function applyEnvPatch(args: {
    phase: RunnerExtensionAuditEvent['phase']
    entry: { pluginId: string; id: string }
    env: Record<string, string>
    proposal: { env?: Record<string, string>; pathPrepend?: string[]; pathAppend?: string[]; cwd?: string; diagnostics?: PluginDiagnostic[] }
    audit: RunnerExtensionAuditEvent[]
    diagnostics: PluginDiagnostic[]
    pathDelimiter: string
}): { cwd?: string } {
    const source = contributionLabel(args.entry)
    for (const [key, value] of Object.entries(args.proposal.env ?? {})) {
        if (envKeyIsProtected(key) || key.toUpperCase() === 'PATH') {
            args.diagnostics.push(contributionDiagnostic(args.entry, 'warning', 'runner-extension-env-protected', `${source} attempted to modify protected env ${key}; proposal ignored.`))
            continue
        }
        args.env[key] = value
        args.audit.push({ phase: args.phase, pluginId: args.entry.pluginId, contributionId: args.entry.id, field: `env.${key}`, message: `${source} set env ${key}` })
    }

    if (args.proposal.pathPrepend?.length || args.proposal.pathAppend?.length) {
        args.env.PATH = mergePathValue({
            base: args.env.PATH,
            prepend: args.proposal.pathPrepend,
            append: args.proposal.pathAppend,
            delimiter: args.pathDelimiter
        })
        args.audit.push({ phase: args.phase, pluginId: args.entry.pluginId, contributionId: args.entry.id, field: 'env.PATH', message: `${source} updated PATH segments` })
    }

    for (const pluginDiagnostic of args.proposal.diagnostics ?? []) {
        args.diagnostics.push({
            ...pluginDiagnostic,
            pluginId: args.entry.pluginId
        } as PluginDiagnostic & { pluginId: string })
    }

    if (args.proposal.cwd !== undefined) {
        if (!isCrossPlatformAbsolutePath(args.proposal.cwd)) {
            args.diagnostics.push(contributionDiagnostic(args.entry, 'warning', 'runner-extension-cwd-invalid', `${source} proposed a non-absolute cwd; proposal ignored.`))
            return {}
        }
        args.audit.push({ phase: args.phase, pluginId: args.entry.pluginId, contributionId: args.entry.id, field: 'cwd', message: `${source} proposed cwd ${args.proposal.cwd}` })
        return { cwd: args.proposal.cwd }
    }

    return {}
}

function validateContributionCommandProposal(
    entry: { pluginId: string; id: string },
    args: string[],
    diagnostics: PluginDiagnostic[]
): boolean {
    const source = contributionLabel(entry)
    if (args.length === 0) {
        diagnostics.push(contributionDiagnostic(entry, 'warning', 'runner-extension-command-empty', `${source} proposed empty args; proposal ignored.`))
        return false
    }
    if (!ALLOWED_HAPI_SUBCOMMANDS.has(args[0])) {
        diagnostics.push(contributionDiagnostic(entry, 'warning', 'runner-extension-command-disallowed', `${source} proposed disallowed HAPI subcommand ${args[0]}; proposal ignored.`))
        return false
    }
    if (args.some((arg) => arg.includes('\0'))) {
        diagnostics.push(contributionDiagnostic(entry, 'warning', 'runner-extension-command-invalid', `${source} proposed args containing NUL; proposal ignored.`))
        return false
    }
    return true
}

async function runEnvironmentProviders(input: ResolveRunnerSpawnPlanInput, state: {
    command: string
    args: string[]
    displayArgs: string[]
    cwd: string
    env: Record<string, string>
    diagnostics: PluginDiagnostic[]
    audit: RunnerExtensionAuditEvent[]
}): Promise<void> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_EXTENSION_TIMEOUT_MS
    for (const entry of [...input.environmentProviders].sort(contributionSort)) {
        if (!entry.contribution.provide) continue
        try {
            const context = buildContext(input, { ...input.basePlan, cwd: state.cwd, env: state.env, args: state.args, displayArgs: state.displayArgs, command: state.command })
            const parsed = RunnerEnvironmentProposalSchema.parse(await withTimeout(entry.contribution.provide(context), timeoutMs, contributionLabel(entry)))
            const cwdPatch = applyEnvPatch({
                phase: 'environment',
                entry,
                env: state.env,
                proposal: parsed,
                audit: state.audit,
                diagnostics: state.diagnostics,
                pathDelimiter: input.pathDelimiter ?? delimiter
            })
            if (cwdPatch.cwd) state.cwd = cwdPatch.cwd
        } catch (error) {
            state.diagnostics.push(contributionDiagnostic(entry, 'warning', 'runner-extension-environment-failed', `${contributionLabel(entry)} environment provider failed: ${error instanceof Error ? error.message : String(error)}`))
        }
    }
}

async function runCommandResolvers(input: ResolveRunnerSpawnPlanInput, state: {
    command: string
    args: string[]
    displayArgs: string[]
    cwd: string
    env: Record<string, string>
    diagnostics: PluginDiagnostic[]
    audit: RunnerExtensionAuditEvent[]
}): Promise<void> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_EXTENSION_TIMEOUT_MS
    for (const entry of [...input.commandResolvers].sort(contributionSort)) {
        if (!entry.contribution.resolve) continue
        const source = contributionLabel(entry)
        try {
            const context = buildContext(input, { ...input.basePlan, cwd: state.cwd, env: state.env, args: state.args, displayArgs: state.displayArgs, command: state.command })
            const parsed: RunnerCommandResolverProposal = RunnerCommandResolverProposalSchema.parse(await withTimeout(entry.contribution.resolve(context), timeoutMs, source))
            if (parsed.args && validateContributionCommandProposal(entry, parsed.args, state.diagnostics)) {
                const currentDisplayArgCount = state.displayArgs.length
                state.displayArgs = parsed.args
                state.args = input.basePlan.mode === 'development'
                    ? [...state.args.slice(0, state.args.length - currentDisplayArgCount), ...parsed.args]
                    : parsed.args
                state.audit.push({ phase: 'command', pluginId: entry.pluginId, contributionId: entry.id, field: 'args', message: `${source} proposed HAPI args` })
            }
            const cwdPatch = applyEnvPatch({
                phase: 'command',
                entry,
                env: state.env,
                proposal: parsed,
                audit: state.audit,
                diagnostics: state.diagnostics,
                pathDelimiter: input.pathDelimiter ?? delimiter
            })
            if (cwdPatch.cwd) state.cwd = cwdPatch.cwd
        } catch (error) {
            state.diagnostics.push(contributionDiagnostic(entry, 'warning', 'runner-extension-command-failed', `${source} command resolver failed: ${error instanceof Error ? error.message : String(error)}`))
        }
    }
}

async function runBeforeSpawnHooks(input: ResolveRunnerSpawnPlanInput, state: {
    command: string
    args: string[]
    displayArgs: string[]
    cwd: string
    env: Record<string, string>
    diagnostics: PluginDiagnostic[]
    audit: RunnerExtensionAuditEvent[]
}): Promise<{ blocked?: { reason: string } }> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_EXTENSION_TIMEOUT_MS
    for (const entry of [...input.spawnHooks].sort(contributionSort)) {
        if (!entry.contribution.beforeSpawn) continue
        const source = contributionLabel(entry)
        try {
            const context = buildContext(input, { ...input.basePlan, cwd: state.cwd, env: state.env, args: state.args, displayArgs: state.displayArgs, command: state.command })
            const parsed: RunnerSpawnHookProposal = RunnerSpawnHookProposalSchema.parse(await withTimeout(entry.contribution.beforeSpawn(context), timeoutMs, source))
            const cwdPatch = applyEnvPatch({
                phase: 'beforeSpawn',
                entry,
                env: state.env,
                proposal: parsed,
                audit: state.audit,
                diagnostics: state.diagnostics,
                pathDelimiter: input.pathDelimiter ?? delimiter
            })
            if (cwdPatch.cwd) state.cwd = cwdPatch.cwd
            if (parsed.block) {
                state.audit.push({ phase: 'beforeSpawn', pluginId: entry.pluginId, contributionId: entry.id, message: `${source} blocked spawn: ${parsed.block.reason}` })
                return { blocked: parsed.block }
            }
        } catch (error) {
            state.diagnostics.push(contributionDiagnostic(entry, 'warning', 'runner-extension-before-spawn-failed', `${source} beforeSpawn hook failed: ${error instanceof Error ? error.message : String(error)}`))
        }
    }
    return {}
}

export async function resolveRunnerPluginSpawnOptions(input: ResolveRunnerSpawnOptionsInput): Promise<RunnerResolvedSpawnOptions> {
    const options: SpawnSessionOptions = { ...stripControlOnlySpawnOptions(input.options), agent: input.agent }
    const diagnostics: PluginDiagnostic[] = []
    const audit: RunnerExtensionAuditEvent[] = []
    const applied: RunnerSpawnOptionsAppliedEntry[] = []
    const timeoutMs = input.timeoutMs ?? DEFAULT_EXTENSION_TIMEOUT_MS

    for (const entry of [...input.spawnOptionsProviders].sort(contributionSort)) {
        if (!entry.contribution.provide) continue
        const source = contributionLabel(entry)
        try {
            const context = buildOptionsContext(input, options)
            const parsed = RunnerSpawnOptionsProviderProposalSchema.parse(await withTimeout(entry.contribution.provide(context), timeoutMs, source))
            for (const pluginDiagnostic of parsed.diagnostics ?? []) {
                diagnostics.push({
                    ...pluginDiagnostic,
                    pluginId: entry.pluginId
                } as PluginDiagnostic & { pluginId: string })
            }
            if (parsed.options) {
                const fields = applySpawnOptionsProposal({
                    entry,
                    options,
                    proposal: parsed.options,
                    audit
                })
                if (!parsed.applied?.length && fields.length > 0) {
                    applied.push({
                        pluginId: entry.pluginId,
                        contributionId: entry.id,
                        label: entry.id,
                        fields
                    })
                }
            }
            for (const item of parsed.applied ?? []) {
                const fields = item.fields ?? (parsed.options ? proposalFields(parsed.options) : undefined)
                applied.push({
                    pluginId: entry.pluginId,
                    contributionId: entry.id,
                    label: item.label ?? entry.id,
                    ...(item.description ? { description: item.description } : {}),
                    ...(fields && fields.length > 0 ? { fields } : {})
                })
            }
        } catch (error) {
            diagnostics.push(contributionDiagnostic(entry, 'warning', 'runner-extension-spawn-options-failed', `${source} spawn options provider failed: ${error instanceof Error ? error.message : String(error)}`))
        }
    }

    return RunnerResolvedSpawnOptionsSchema.parse({ options, diagnostics, audit, applied })
}

export async function resolveRunnerPluginSpawnPlan(input: ResolveRunnerSpawnPlanInput): Promise<RunnerResolvedSpawnPlan> {
    const state = {
        command: input.basePlan.command,
        args: [...input.basePlan.args],
        displayArgs: [...input.basePlan.displayArgs],
        cwd: input.basePlan.cwd,
        env: normalizeBaseEnv(input.basePlan.env),
        diagnostics: [] as PluginDiagnostic[],
        audit: [] as RunnerExtensionAuditEvent[]
    }

    await runEnvironmentProviders(input, state)
    await runCommandResolvers(input, state)
    const beforeSpawn = await runBeforeSpawnHooks(input, state)

    return {
        command: state.command,
        args: state.args,
        displayArgs: state.displayArgs,
        cwd: state.cwd,
        env: state.env,
        diagnostics: state.diagnostics,
        audit: state.audit,
        ...(beforeSpawn.blocked ? { blocked: beforeSpawn.blocked } : {})
    }
}

export async function runRunnerPluginAfterSpawnHooks(args: {
    baseContext: RunnerSpawnContext
    pid: number
    hooks: RegisteredRunnerContribution<RunnerSpawnHookContribution>[]
    timeoutMs?: number
    onDiagnostic?: (diagnostic: PluginDiagnostic) => void
}): Promise<void> {
    const timeoutMs = args.timeoutMs ?? DEFAULT_EXTENSION_TIMEOUT_MS
    for (const entry of [...args.hooks].sort(contributionSort)) {
        if (!entry.contribution.afterSpawn) continue
        const source = contributionLabel(entry)
        try {
            await withTimeout(entry.contribution.afterSpawn({ ...args.baseContext, pid: args.pid }), timeoutMs, source)
        } catch (error) {
            args.onDiagnostic?.(contributionDiagnostic(entry, 'warning', 'runner-extension-after-spawn-failed', `${source} afterSpawn hook failed: ${error instanceof Error ? error.message : String(error)}`))
        }
    }
}

export async function runRunnerPluginExitHooks(args: {
    baseContext: RunnerSpawnContext
    pid: number
    exitCode: number | null
    signal: NodeJS.Signals | null
    hooks: RegisteredRunnerContribution<RunnerSpawnHookContribution>[]
    timeoutMs?: number
    onDiagnostic?: (diagnostic: PluginDiagnostic) => void
}): Promise<void> {
    const timeoutMs = args.timeoutMs ?? DEFAULT_EXTENSION_TIMEOUT_MS
    for (const entry of [...args.hooks].sort(contributionSort)) {
        if (!entry.contribution.onExit) continue
        const source = contributionLabel(entry)
        try {
            await withTimeout(entry.contribution.onExit({ ...args.baseContext, pid: args.pid, exitCode: args.exitCode, signal: args.signal }), timeoutMs, source)
        } catch (error) {
            args.onDiagnostic?.(contributionDiagnostic(entry, 'warning', 'runner-extension-on-exit-failed', `${source} onExit hook failed: ${error instanceof Error ? error.message : String(error)}`))
        }
    }
}
