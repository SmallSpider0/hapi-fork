import { HAPI_PLUGIN_API_VERSION, type PluginManifestLite } from './manifest'

export const EXAMPLE_NOTIFICATION_LOGGER_PLUGIN_ID = 'com.example.hapi.notification-logger'
export const EXAMPLE_NOTIFICATION_LOGGER_CHANNEL_ID = 'example-notification-logger'

export type ExamplePluginFile = {
    relativePath: string
    contents: string
}

export type ExampleNotificationLoggerFiles = {
    id: typeof EXAMPLE_NOTIFICATION_LOGGER_PLUGIN_ID
    manifest: PluginManifestLite
    defaultConfig: {
        logFile: string
    }
    files: ExamplePluginFile[]
}

export function createExampleNotificationLoggerFiles(options: { logFile: string }): ExampleNotificationLoggerFiles {
    const manifest: PluginManifestLite = {
        id: EXAMPLE_NOTIFICATION_LOGGER_PLUGIN_ID,
        name: 'Example Notification Logger',
        version: '0.1.0',
        pluginApiVersion: HAPI_PLUGIN_API_VERSION,
        description: 'Writes HAPI notification events to a local JSONL file for plugin development and testing.',
        runtimes: {
            hub: {
                entry: 'dist/hub.js'
            }
        },
        contributions: {
            hub: {
                notificationChannels: [{
                    id: EXAMPLE_NOTIFICATION_LOGGER_CHANNEL_ID,
                    displayName: 'Example Notification Logger'
                }]
            }
        },
        permissions: {
            network: [],
            secrets: []
        }
    }
    const hubRuntime = `import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const DEFAULT_LOG_FILE = ${JSON.stringify(options.logFile)}

async function appendJsonLine(path, value) {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, JSON.stringify(value) + '\\n', 'utf8')
}

export async function activate(ctx) {
    const configuredLogFile = ctx.config.get('logFile')
    const logFile = typeof configuredLogFile === 'string' && configuredLogFile.trim().length > 0
        ? configuredLogFile
        : DEFAULT_LOG_FILE

    ctx.notifications.registerChannel({
        async send(event) {
            await appendJsonLine(logFile, {
                timestamp: new Date().toISOString(),
                pluginId: ctx.pluginId,
                event
            })
        }
    })

    ctx.logger.info('Example notification logger writing events to %s', logFile)
}
`
    const readme = `# Example Notification Logger

This HAPI example plugin registers a notification channel and appends every notification event to a local JSONL file.

Default config:

\`\`\`json
${JSON.stringify({ logFile: options.logFile }, null, 2)}
\`\`\`
`

    return {
        id: EXAMPLE_NOTIFICATION_LOGGER_PLUGIN_ID,
        manifest,
        defaultConfig: {
            logFile: options.logFile
        },
        files: [{
            relativePath: 'hapi.plugin.json',
            contents: `${JSON.stringify(manifest, null, 2)}\n`
        }, {
            relativePath: 'dist/hub.js',
            contents: hubRuntime
        }, {
            relativePath: 'README.md',
            contents: readme
        }]
    }
}
