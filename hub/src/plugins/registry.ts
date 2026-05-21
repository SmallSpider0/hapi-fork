import type { PluginDiagnostic } from '@hapi/protocol/plugins'
import type { NotificationChannel } from '../notifications/notificationTypes'
import { PluginNotificationChannelAdapter } from './notificationAdapter'
import type { Disposable, HubPluginContext, PluginLogger, PluginNotificationChannel } from './types'

type RegisteredNotificationChannel = {
    pluginId: string
    channel: PluginNotificationChannel
    disposed: boolean
    sanitizeError(error: unknown): Error
}

export class PluginRegistryLite {
    private readonly notificationChannels: RegisteredNotificationChannel[] = []
    private readonly disposables: Disposable[] = []
    readonly diagnostics: PluginDiagnostic[] = []

    constructor(private readonly publicUrl?: string) {}

    createContext(args: {
        pluginId: string
        config?: Record<string, unknown>
        declaredSecrets?: string[]
        env?: NodeJS.ProcessEnv
    }): { ctx: HubPluginContext; close(): void } {
        let acceptingRegistrations = true
        const declaredSecrets = new Set(args.declaredSecrets ?? [])
        const env = args.env ?? process.env
        for (const secretName of declaredSecrets) {
            if (!env[secretName]) {
                this.addDiagnostic('warning', 'missing-secret', `Declared secret ${secretName} is not set.`, args.pluginId)
            }
        }

        const ctx: HubPluginContext = {
            pluginId: args.pluginId,
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
            notifications: {
                registerChannel: (channel: PluginNotificationChannel): Disposable => {
                    if (!acceptingRegistrations) {
                        throw new Error('Plugin notification channels can only be registered during activate(ctx).')
                    }
                    return this.registerNotificationChannel(args.pluginId, channel, Array.from(declaredSecrets), env)
                }
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
            message: `[plugin:${pluginId}] ${message}`,
            ...(path ? { path } : {})
        })
    }

    getNotificationChannels(): NotificationChannel[] {
        return this.notificationChannels.map((entry) => new PluginNotificationChannelAdapter(
            entry.channel,
            () => entry.disposed,
            this.publicUrl,
            (error) => entry.sanitizeError(error)
        ))
    }

    async dispose(): Promise<void> {
        for (const disposable of [...this.disposables].reverse()) {
            try {
                await disposable.dispose()
            } catch (error) {
                console.error('[PluginRegistry] Dispose failed:', error)
            }
        }
        this.disposables.length = 0
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
                console.error('[PluginRegistry] Dispose failed:', error)
            }
        }
    }

    private registerNotificationChannel(
        pluginId: string,
        channel: PluginNotificationChannel,
        declaredSecrets: string[],
        env: NodeJS.ProcessEnv
    ): Disposable {
        const entry: RegisteredNotificationChannel = {
            pluginId,
            channel,
            disposed: false,
            sanitizeError: (error) => sanitizeError(error, declaredSecrets, env)
        }
        this.notificationChannels.push(entry)

        const disposable: Disposable = {
            dispose: async () => {
                if (entry.disposed) {
                    return
                }
                entry.disposed = true
                const index = this.notificationChannels.indexOf(entry)
                if (index >= 0) {
                    this.notificationChannels.splice(index, 1)
                }
                if (typeof channel.dispose === 'function') {
                    try {
                        await channel.dispose()
                    } catch (error) {
                        throw entry.sanitizeError(error)
                    }
                }
            }
        }
        this.disposables.push(disposable)
        return disposable
    }

    private createLogger(pluginId: string, declaredSecrets: string[], env: NodeJS.ProcessEnv): PluginLogger {
        const redactArgs = (args: unknown[]) => args.map((arg) => redactUnknown(arg, declaredSecrets, env))
        return {
            debug: (message, ...args) => console.debug(`[plugin:${pluginId}] ${redactText(message, declaredSecrets, env)}`, ...redactArgs(args)),
            info: (message, ...args) => console.info(`[plugin:${pluginId}] ${redactText(message, declaredSecrets, env)}`, ...redactArgs(args)),
            warn: (message, ...args) => console.warn(`[plugin:${pluginId}] ${redactText(message, declaredSecrets, env)}`, ...redactArgs(args)),
            error: (message, ...args) => console.error(`[plugin:${pluginId}] ${redactText(message, declaredSecrets, env)}`, ...redactArgs(args))
        }
    }
}

export function sanitizeError(error: unknown, declaredSecrets: string[], env: NodeJS.ProcessEnv = process.env): Error {
    if (error instanceof Error) {
        return new Error(redactText(error.message, declaredSecrets, env))
    }
    return new Error(redactText(String(error), declaredSecrets, env))
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
