import { logger as runnerLogger } from '@/ui/logger'
import type { PluginDiagnostic } from '@hapi/protocol/plugins'

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
        registerEnvironmentProvider(provider: unknown): Disposable
        registerCommandResolver(resolver: unknown): Disposable
        registerSpawnHook(hook: unknown): Disposable
    }
}

export type RunnerPluginModule = {
    activate(ctx: RunnerPluginContext): void | Promise<void>
}

type RegisteredRuntimeContribution = {
    type: 'environmentProvider' | 'commandResolver' | 'spawnHook'
    pluginId: string
    contribution: unknown
    disposed: boolean
}

export class RunnerPluginRegistry {
    private readonly contributions: RegisteredRuntimeContribution[] = []
    private readonly disposables: Disposable[] = []
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
            return this.registerContribution(type, args.pluginId, contribution)
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
                registerSpawnHook: (hook: unknown): Disposable => register('spawnHook', hook)
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

    private registerContribution(type: RegisteredRuntimeContribution['type'], pluginId: string, contribution: unknown): Disposable {
        const entry: RegisteredRuntimeContribution = {
            type,
            pluginId,
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
