import { logger as runnerLogger } from '@/ui/logger'
import { AgentDescriptorSchema, AgentIdSchema, type AgentDescriptor, type PluginDiagnostic } from '@hapi/protocol/plugins'
import type { AgentBackendFactory } from '@/agent/types'
import type {
    RunnerCommandResolverContribution,
    RunnerEnvironmentProviderContribution,
    RunnerSpawnHookContribution
} from './runnerExtensionPipeline'

export type Disposable = {
    dispose(): void | Promise<void>
}

export type PluginLogger = {
    debug(message: string, ...args: unknown[]): void
    info(message: string, ...args: unknown[]): void
    warn(message: string, ...args: unknown[]): void
    error(message: string, ...args: unknown[]): void
}

export type PluginConfigReader = {
    get<T = unknown>(key: string): T | undefined
    all(): Record<string, unknown>
}

export type PluginSecretReader = {
    get(name: string): string | undefined
}

export type RunnerPluginContext = {
    pluginId: string
    machineId: string
    logger: PluginLogger
    config: PluginConfigReader
    secrets: PluginSecretReader
    runtime: {
        registerEnvironmentProvider(provider: RunnerEnvironmentProviderContribution): Disposable
        registerCommandResolver(resolver: RunnerCommandResolverContribution): Disposable
        registerSpawnHook(hook: RunnerSpawnHookContribution): Disposable
        registerAgentAdapter(adapter: RunnerAgentAdapterContribution): Disposable
        registerAgentCapabilityProvider(provider: RunnerAgentCapabilityProviderContribution): Disposable
    }
}

export type RunnerPluginModule = {
    activate(ctx: RunnerPluginContext): void | Promise<void>
}

export type RunnerAgentAdapterContribution = {
    id: string
    priority?: number
    descriptor: AgentDescriptor
    createBackend: AgentBackendFactory
    dispose?: () => void | Promise<void>
}

export type RunnerAgentCapabilityProviderContext = {
    machineId: string
    agentId: string
}

export type RunnerAgentHistoryImportContext = RunnerAgentCapabilityProviderContext & {
    nativeSessionId: string
}

export type RunnerAgentCapabilityProviderContribution = {
    id: string
    agentId: string
    priority?: number
    provide?: (context: RunnerAgentCapabilityProviderContext) => unknown | Promise<unknown>
    importHistory?: (context: RunnerAgentHistoryImportContext) => unknown | Promise<unknown>
    dispose?: () => void | Promise<void>
}

export type RegisteredRuntimeContribution<T = unknown> = {
    type: 'environmentProvider' | 'commandResolver' | 'spawnHook' | 'agentAdapter' | 'agentCapabilityProvider'
    pluginId: string
    id: string
    priority: number
    order: number
    contribution: T
    disposed: boolean
}

export class RunnerPluginRegistry {
    private readonly contributions: RegisteredRuntimeContribution[] = []
    private readonly disposables: Disposable[] = []
    private nextContributionOrder = 0
    readonly diagnostics: PluginDiagnostic[] = []

    constructor(private readonly machineId: string) {}

    createContext(args: {
        pluginId: string
        config?: Record<string, unknown>
        declaredSecrets?: string[]
        env?: NodeJS.ProcessEnv
    }): { ctx: RunnerPluginContext; close(): void } {
        let acceptingRegistrations = true
        const declaredSecrets = new Set(args.declaredSecrets ?? [])
        const env = args.env ?? process.env
        for (const secretName of declaredSecrets) {
            if (!env[secretName]) {
                this.addDiagnostic('warning', 'missing-secret', `Declared secret ${secretName} is not set.`, args.pluginId)
            }
        }

        const register = (type: RegisteredRuntimeContribution['type'], contribution: unknown): Disposable => {
            if (!acceptingRegistrations) {
                throw new Error('Runner plugin runtime contributions can only be registered during activate(ctx).')
            }
            return this.registerContribution(type, args.pluginId, validateContribution(type, contribution))
        }

        const ctx: RunnerPluginContext = {
            pluginId: args.pluginId,
            machineId: this.machineId,
            logger: this.createLogger(args.pluginId, Array.from(declaredSecrets), env),
            config: {
                get: <T = unknown>(key: string): T | undefined => args.config?.[key] as T | undefined,
                all: (): Record<string, unknown> => ({ ...(args.config ?? {}) })
            },
            secrets: {
                get: (name: string): string | undefined => {
                    if (!declaredSecrets.has(name)) {
                        this.addDiagnostic('warning', 'undeclared-secret', `Plugin attempted to read undeclared secret ${name}.`, args.pluginId)
                        return undefined
                    }
                    return env[name]
                }
            },
            runtime: {
                registerEnvironmentProvider: (provider: unknown): Disposable => register('environmentProvider', provider),
                registerCommandResolver: (resolver: unknown): Disposable => register('commandResolver', resolver),
                registerSpawnHook: (hook: unknown): Disposable => register('spawnHook', hook),
                registerAgentAdapter: (adapter: unknown): Disposable => register('agentAdapter', adapter),
                registerAgentCapabilityProvider: (provider: unknown): Disposable => register('agentCapabilityProvider', provider)
            }
        }

        return {
            ctx,
            close: () => {
                acceptingRegistrations = false
            }
        }
    }

    addDiagnostic(severity: PluginDiagnostic['severity'], code: string, message: string, pluginId: string, path?: string): void {
        this.diagnostics.push({
            severity,
            code,
            message: `[runner-plugin:${this.machineId}:${pluginId}] ${message}`,
            ...(path ? { path } : {})
        })
    }

    async dispose(): Promise<void> {
        for (const disposable of [...this.disposables].reverse()) {
            try {
                await disposable.dispose()
            } catch (error) {
                runnerLogger.debug(`[RunnerPluginRegistry] Dispose failed on ${this.machineId}: ${redactText(error instanceof Error ? error.message : String(error), [], process.env)}`)
            }
        }
        this.disposables.length = 0
        this.contributions.length = 0
    }

    getDisposableCount(): number {
        return this.disposables.length
    }

    getEnvironmentProviders(): RegisteredRuntimeContribution<RunnerEnvironmentProviderContribution>[] {
        return this.getContributionsByType('environmentProvider')
    }

    getCommandResolvers(): RegisteredRuntimeContribution<RunnerCommandResolverContribution>[] {
        return this.getContributionsByType('commandResolver')
    }

    getSpawnHooks(): RegisteredRuntimeContribution<RunnerSpawnHookContribution>[] {
        return this.getContributionsByType('spawnHook')
    }

    getAgentAdapters(): RegisteredRuntimeContribution<RunnerAgentAdapterContribution>[] {
        return this.getContributionsByType('agentAdapter')
    }

    getAgentCapabilityProviders(): RegisteredRuntimeContribution<RunnerAgentCapabilityProviderContribution>[] {
        return this.getContributionsByType('agentCapabilityProvider')
    }

    async disposeFrom(startIndex: number): Promise<void> {
        const extras = this.disposables.splice(startIndex)
        for (const disposable of extras.reverse()) {
            try {
                await disposable.dispose()
            } catch (error) {
                runnerLogger.debug(`[RunnerPluginRegistry] Dispose failed on ${this.machineId}: ${redactText(error instanceof Error ? error.message : String(error), [], process.env)}`)
            }
        }
        this.contributions.splice(startIndex)
    }

    private registerContribution<T extends { id: string; priority?: number }>(
        type: RegisteredRuntimeContribution['type'],
        pluginId: string,
        contribution: T
    ): Disposable {
        const entry: RegisteredRuntimeContribution = {
            type,
            pluginId,
            id: contribution.id,
            priority: contribution.priority ?? 0,
            order: this.nextContributionOrder++,
            contribution,
            disposed: false
        }
        this.contributions.push(entry)

        const disposable: Disposable = {
            dispose: async () => {
                if (entry.disposed) {
                    return
                }
                entry.disposed = true
                const index = this.contributions.indexOf(entry)
                if (index >= 0) {
                    this.contributions.splice(index, 1)
                }
                if (contribution && typeof contribution === 'object' && 'dispose' in contribution && typeof contribution.dispose === 'function') {
                    await contribution.dispose()
                }
            }
        }
        this.disposables.push(disposable)
        return disposable
    }

    private getContributionsByType<T>(type: RegisteredRuntimeContribution['type']): RegisteredRuntimeContribution<T>[] {
        return this.contributions
            .filter((entry): entry is RegisteredRuntimeContribution<T> => entry.type === type && !entry.disposed)
            .map((entry) => ({ ...entry }))
    }

    private createLogger(pluginId: string, declaredSecrets: string[], env: NodeJS.ProcessEnv): PluginLogger {
        const prefix = `[runner-plugin:${this.machineId}:${pluginId}]`
        const redactArgs = (args: unknown[]) => args.map((arg) => redactUnknown(arg, declaredSecrets, env))
        return {
            debug: (message, ...args) => runnerLogger.debug(`${prefix} ${redactText(message, declaredSecrets, env)}`, ...redactArgs(args)),
            info: (message, ...args) => runnerLogger.debug(`${prefix} ${redactText(message, declaredSecrets, env)}`, ...redactArgs(args)),
            warn: (message, ...args) => runnerLogger.debug(`${prefix} ${redactText(message, declaredSecrets, env)}`, ...redactArgs(args)),
            error: (message, ...args) => runnerLogger.debug(`${prefix} ${redactText(message, declaredSecrets, env)}`, ...redactArgs(args))
        }
    }
}

function validateContribution<T extends { id: string }>(type: RegisteredRuntimeContribution['type'], contribution: unknown): T {
    if (!contribution || typeof contribution !== 'object') {
        throw new Error(`${type} contribution must be an object.`)
    }
    const candidate = contribution as Record<string, unknown>
    if (typeof candidate.id !== 'string' || candidate.id.trim().length === 0) {
        throw new Error(`${type} contribution must have a non-empty id.`)
    }
    if (type === 'agentAdapter' || type === 'agentCapabilityProvider') {
        const parsedId = AgentIdSchema.safeParse(candidate.id)
        if (!parsedId.success) {
            throw new Error(`${type} contribution id must be a valid id.`)
        }
    } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate.id)) {
        throw new Error(`${type} contribution id must contain only alphanumeric characters, dots, underscores, or dashes.`)
    }
    if (candidate.priority !== undefined && (
        typeof candidate.priority !== 'number'
        || !Number.isInteger(candidate.priority)
        || candidate.priority < -1000
        || candidate.priority > 1000
    )) {
        throw new Error(`${type} contribution priority must be an integer between -1000 and 1000.`)
    }
    if (type === 'environmentProvider' && candidate.provide !== undefined && typeof candidate.provide !== 'function') {
        throw new Error('environmentProvider provide must be a function.')
    }
    if (type === 'commandResolver' && candidate.resolve !== undefined && typeof candidate.resolve !== 'function') {
        throw new Error('commandResolver resolve must be a function.')
    }
    if (type === 'spawnHook') {
        for (const method of ['beforeSpawn', 'afterSpawn', 'onExit']) {
            if (candidate[method] !== undefined && typeof candidate[method] !== 'function') {
                throw new Error(`spawnHook ${method} must be a function.`)
            }
        }
    }
    if (type === 'agentAdapter') {
        const descriptor = AgentDescriptorSchema.safeParse(candidate.descriptor)
        if (!descriptor.success) {
            throw new Error('agentAdapter descriptor is invalid.')
        }
        if (descriptor.data.id !== candidate.id) {
            throw new Error('agentAdapter id must match descriptor.id.')
        }
        if (descriptor.data.adapter.runtime !== 'runner') {
            throw new Error('agentAdapter descriptor runtime must be runner.')
        }
        if (typeof candidate.createBackend !== 'function') {
            throw new Error('agentAdapter createBackend must be a function.')
        }
    }
    if (type === 'agentCapabilityProvider') {
        const agentId = AgentIdSchema.safeParse(candidate.agentId)
        if (!agentId.success) {
            throw new Error('agentCapabilityProvider agentId must be a valid agent id.')
        }
        if (candidate.provide !== undefined && typeof candidate.provide !== 'function') {
            throw new Error('agentCapabilityProvider provide must be a function.')
        }
        if (candidate.importHistory !== undefined && typeof candidate.importHistory !== 'function') {
            throw new Error('agentCapabilityProvider importHistory must be a function.')
        }
        if (candidate.provide === undefined && candidate.importHistory === undefined) {
            throw new Error('agentCapabilityProvider must define provide or importHistory.')
        }
    }
    return contribution as T
}

export function redactText(value: string, declaredSecrets: string[], env: NodeJS.ProcessEnv = process.env): string {
    let redacted = value
    for (const secretName of declaredSecrets) {
        const secretValue = env[secretName]
        if (secretValue) {
            redacted = redacted.split(secretValue).join('[REDACTED]')
        }
    }
    return redacted
}

function redactUnknown(
    value: unknown,
    declaredSecrets: string[],
    env: NodeJS.ProcessEnv,
    seen: WeakSet<object> = new WeakSet()
): unknown {
    if (typeof value === 'string') {
        return redactText(value, declaredSecrets, env)
    }
    if (value instanceof Error) {
        return new Error(redactText(value.message, declaredSecrets, env))
    }
    if (Array.isArray(value)) {
        return value.map((entry) => redactUnknown(entry, declaredSecrets, env, seen))
    }
    if (value && typeof value === 'object') {
        if (seen.has(value)) {
            return '[Circular]'
        }
        seen.add(value)
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, redactUnknown(entry, declaredSecrets, env, seen)])
        )
    }
    return value
}
