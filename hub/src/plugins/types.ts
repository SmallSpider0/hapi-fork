import type { PluginNotificationEvent } from '@hapi/protocol/plugins'

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

export type PluginNotificationChannel = {
    send(event: PluginNotificationEvent): void | Promise<void>
    dispose?(): void | Promise<void>
}

export type HubPluginContext = {
    pluginId: string
    logger: PluginLogger
    config: PluginConfigReader
    secrets: PluginSecretReader
    notifications: {
        registerChannel(channel: PluginNotificationChannel): Disposable
    }
}

export type HubPluginModule = {
    activate(ctx: HubPluginContext): void | Promise<void>
}
