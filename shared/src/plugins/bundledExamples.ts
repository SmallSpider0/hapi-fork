import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { HAPI_PLUGIN_API_VERSION, HAPI_PLUGIN_MANIFEST_FILE, type PluginManifestLite } from './manifest'

export const HAPI_BUNDLED_EXAMPLE_PLUGINS_DIR = 'bundled-example-plugins'

type BundledExamplePluginFile = {
    path: string
    content: string
}

export type BundledExamplePlugin = {
    manifest: PluginManifestLite
    files: BundledExamplePluginFile[]
}

function manifestBase(manifest: Omit<PluginManifestLite, 'pluginApiVersion' | 'version'> & { version?: string }): PluginManifestLite {
    return {
        ...manifest,
        version: manifest.version ?? '0.1.0',
        pluginApiVersion: HAPI_PLUGIN_API_VERSION
    }
}

const notificationLoggerHub = `export function activate(ctx) {
    const prefix = String(ctx.config.get('prefix') ?? '[hapi-example-notification]');
    ctx.notifications.registerChannel({
        async send(event) {
            ctx.logger.info(\`\${prefix} \${event.type} session=\${event.session.id} agent=\${event.session.agent ?? 'unknown'}\`);
        }
    });
}
`

const runnerEnvironmentRuntime = `export function activate(ctx) {
    const envValue = String(ctx.config.get('envValue') ?? 'enabled');
    ctx.runtime.registerEnvironmentProvider({
        id: 'example-environment',
        priority: 20,
        provide(context) {
            return {
                env: { EXAMPLE_RUNNER_ENV: envValue },
                diagnostics: [{
                    severity: 'info',
                    code: 'example-runner-environment',
                    message: \`Example runner environment applied for \${context.agent}\`
                }]
            };
        }
    });
    ctx.runtime.registerSpawnHook({
        id: 'example-spawn-audit',
        priority: 20,
        beforeSpawn(context) {
            return {
                diagnostics: [{
                    severity: 'info',
                    code: 'example-runner-spawn-audit',
                    message: \`Example spawn audit observed \${context.agent} in \${context.cwd}\`
                }]
            };
        }
    });
}
`

const echoAgentRuntime = `function createEchoBackend() {
    let permissionHandler = () => undefined;
    return {
        async initialize() {},
        async newSession() {
            return \`example-echo-\${Date.now()}\`;
        },
        async prompt(sessionId, content, onUpdate) {
            const text = content.map((entry) => entry && entry.type === 'text' ? entry.text : '').filter(Boolean).join('\\n').trim();
            onUpdate({ type: 'reasoning', text: 'Example Echo Agent is a bundled plugin used to validate dynamic agent adapters.' });
            onUpdate({ type: 'text', text: \`Echo from \${sessionId}: \${text || '(empty prompt)'}\` });
            onUpdate({ type: 'turn_complete', stopReason: 'completed' });
        },
        async cancelPrompt() {},
        async respondToPermission() {},
        onPermissionRequest(handler) {
            permissionHandler = typeof handler === 'function' ? handler : permissionHandler;
        },
        async disconnect() {}
    };
}

export function activate(ctx) {
    ctx.runtime.registerAgentAdapter({
        id: 'example:echo',
        descriptor: {
            id: 'example:echo',
            displayName: 'Example Echo Agent',
            description: 'A bundled plugin-backed agent that echoes prompts.',
            adapter: {
                runtime: 'runner',
                kind: 'custom-runner-plugin',
                contributionId: 'example-echo-agent'
            },
            capabilities: {
                supportsResume: false,
                supportsPlanMode: false,
                supportsFileContext: false,
                permissionModes: ['default', 'yolo'],
                models: ['echo-small']
            }
        },
        createBackend: createEchoBackend
    });
    ctx.runtime.registerAgentCapabilityProvider({
        id: 'example-echo-capabilities',
        agentId: 'example:echo',
        provide() {
            return {
                models: [{ id: 'echo-large', displayName: 'Echo Large', contextWindow: 8000 }],
                permissionModes: [{ mode: 'yolo', label: 'Example YOLO', risk: 'danger' }],
                profiles: [{ id: 'concise', displayName: 'Concise echo' }],
                sessions: [{ id: 'example-native-session', title: 'Example native session', importable: true }],
                usage: [{ scope: 'agent', totalTokens: 42, limitLabel: 'example quota' }],
                skills: [{ name: 'echo-review', description: 'Echo a review checklist.' }],
                slashCommands: [{ name: 'echo', description: 'Echo the current prompt.' }]
            };
        },
        importHistory() {
            return {
                messages: [
                    { role: 'user', content: 'Imported example prompt', createdAt: 1 },
                    { role: 'agent', content: 'Imported example response', createdAt: 2 }
                ]
            };
        }
    });
}
`

const spawnPolicyRuntime = `export function activate(ctx) {
    ctx.runtime.registerSpawnHook({
        id: 'example-spawn-policy',
        priority: -10,
        beforeSpawn(context) {
            const blockedAgent = ctx.config.get('blockedAgent');
            if (typeof blockedAgent === 'string' && blockedAgent && context.agent === blockedAgent) {
                return {
                    block: { reason: \`Example policy blocked agent \${context.agent}\` },
                    diagnostics: [{
                        severity: 'warning',
                        code: 'example-policy-blocked',
                        message: \`Example policy blocked \${context.agent}\`
                    }]
                };
            }
            return {
                diagnostics: [{
                    severity: 'info',
                    code: 'example-policy-checked',
                    message: \`Example policy allowed \${context.agent}\`
                }]
            };
        }
    });
}
`

export const bundledExamplePlugins: BundledExamplePlugin[] = [
    {
        manifest: manifestBase({
            id: 'com.hapi.examples.notification-logger',
            name: 'Example Notification Logger',
            description: 'Logs notification events through the Hub plugin notification channel extension point.',
            runtimes: { hub: { entry: 'dist/hub.js' } },
            contributions: {
                hub: {
                    notificationChannels: [{ id: 'logger', displayName: 'Example Logger' }]
                },
                web: {
                    settingsPanels: [{
                        id: 'notification-logger',
                        title: 'Example Notification Logger',
                        description: 'Hub runtime sample for outbound notification channels.',
                        components: [
                            { kind: 'text', text: 'Enable this plugin on the Hub target to log notification events.' },
                            {
                                kind: 'schemaForm',
                                title: 'Logger options',
                                fields: [{ key: 'prefix', label: 'Log prefix', type: 'text', defaultValue: '[hapi-example-notification]' }]
                            }
                        ]
                    }]
                }
            }
        }),
        files: [{ path: 'dist/hub.js', content: notificationLoggerHub }]
    },
    {
        manifest: manifestBase({
            id: 'com.hapi.examples.runner-environment',
            name: 'Example Runner Environment',
            description: 'Adds a visible environment variable and spawn audit diagnostic in the Runner runtime.',
            runtimes: { runner: { entry: 'dist/runner.js' } },
            contributions: {
                runner: {
                    environmentProviders: [{ id: 'example-environment', displayName: 'Example Environment Provider' }],
                    spawnHooks: [{ id: 'example-spawn-audit', displayName: 'Example Spawn Audit' }]
                },
                web: {
                    settingsPanels: [{
                        id: 'runner-environment',
                        title: 'Example Runner Environment',
                        components: [
                            { kind: 'text', text: 'Enable on a Runner target to set EXAMPLE_RUNNER_ENV for spawned sessions.' },
                            {
                                kind: 'schemaForm',
                                title: 'Environment options',
                                fields: [{ key: 'envValue', label: 'Environment value', type: 'text', defaultValue: 'enabled' }]
                            }
                        ]
                    }]
                }
            }
        }),
        files: [{ path: 'dist/runner.js', content: runnerEnvironmentRuntime }]
    },
    {
        manifest: manifestBase({
            id: 'com.hapi.examples.echo-agent',
            name: 'Example Echo Agent',
            description: 'Registers a plugin-backed echo agent and capability provider.',
            runtimes: { runner: { entry: 'dist/runner.js' } },
            contributions: {
                agent: {
                    adapters: [{ id: 'example-echo-agent', displayName: 'Example Echo Agent Adapter' }],
                    capabilityProviders: [{ id: 'example-echo-capabilities', displayName: 'Example Echo Capabilities' }]
                },
                web: {
                    settingsPanels: [{
                        id: 'echo-agent',
                        title: 'Example Echo Agent',
                        components: [
                            { kind: 'text', text: 'Enable on a Runner target, then choose Example Echo Agent in New Session.' },
                            { kind: 'badge', label: 'Agent adapter + capability provider', variant: 'success' }
                        ]
                    }],
                    newSessionFields: [{
                        id: 'echo-prefix',
                        key: 'echoPrefix',
                        label: 'Echo prefix',
                        description: 'Example agent-specific new session field.',
                        agentIds: ['example:echo'],
                        type: 'text',
                        defaultValue: 'Echo'
                    }]
                }
            }
        }),
        files: [{ path: 'dist/runner.js', content: echoAgentRuntime }]
    },
    {
        manifest: manifestBase({
            id: 'com.hapi.examples.web-descriptor',
            name: 'Example Web Descriptor',
            description: 'Descriptor-only sample for settings panels, actions, badges, and New Session fields.',
            contributions: {
                web: {
                    settingsPanels: [{
                        id: 'web-descriptor',
                        title: 'Example Web Descriptor',
                        description: 'This plugin has no runtime entry; Web renders only validated descriptors.',
                        components: [
                            { kind: 'text', text: 'Declarative Web descriptors do not execute plugin JavaScript in the browser.', tone: 'info' },
                            {
                                kind: 'table',
                                columns: [{ key: 'point', label: 'Contribution point' }, { key: 'status', label: 'Status' }],
                                rows: [
                                    { point: 'settingsPanels', status: 'rendered on plugin detail' },
                                    { point: 'newSessionFields', status: 'rendered after Runner target enable' },
                                    { point: 'actions', status: 'limited to core plugin actions' }
                                ]
                            }
                        ]
                    }],
                    newSessionFields: [{
                        id: 'example-web-note',
                        key: 'webDescriptorNote',
                        label: 'Example descriptor note',
                        type: 'text',
                        defaultValue: 'descriptor-only'
                    }],
                    actions: [{ id: 'reload-self', label: 'Reload plugin', actionId: 'plugin.reload' }],
                    badges: [{ id: 'descriptor-only', label: 'Descriptor-only', variant: 'success' }]
                }
            }
        }),
        files: []
    },
    {
        manifest: manifestBase({
            id: 'com.hapi.examples.spawn-policy',
            name: 'Example Spawn Policy',
            description: 'Runner spawn policy sample that can block a configured agent.',
            runtimes: { runner: { entry: 'dist/runner.js' } },
            contributions: {
                runner: {
                    spawnHooks: [{ id: 'example-spawn-policy', displayName: 'Example Spawn Policy' }]
                },
                web: {
                    settingsPanels: [{
                        id: 'spawn-policy',
                        title: 'Example Spawn Policy',
                        components: [
                            { kind: 'text', text: 'Set blockedAgent to demonstrate a policy hook that can block spawn.' },
                            {
                                kind: 'schemaForm',
                                title: 'Policy options',
                                fields: [{ key: 'blockedAgent', label: 'Blocked agent id', type: 'text' }]
                            }
                        ]
                    }]
                }
            }
        }),
        files: [{ path: 'dist/runner.js', content: spawnPolicyRuntime }]
    },
    {
        manifest: manifestBase({
            id: 'com.hapi.examples.voice-provider-stub',
            name: 'Example Voice Provider Stub',
            description: 'Documents the missing voice provider extension point with a descriptor-only plugin.',
            contributions: {
                voice: {
                    providers: [{
                        id: 'example-voice-provider',
                        displayName: 'Example Voice Provider',
                        description: 'Schema-visible stub; runtime support requires a future voice provider API.',
                        supportStatus: 'unsupported',
                        limitations: ['No voice provider runtime extension point is available yet.']
                    }]
                },
                web: {
                    settingsPanels: [{
                        id: 'voice-provider-stub',
                        title: 'Example Voice Provider Stub',
                        components: [
                            { kind: 'text', text: 'Voice provider plugins need a future voice.provider extension point before they can run.', tone: 'warning' },
                            { kind: 'badge', label: 'Foundation gap', variant: 'warning' }
                        ]
                    }]
                }
            }
        }),
        files: []
    },
    {
        manifest: manifestBase({
            id: 'com.hapi.examples.deployment-pack-stub',
            name: 'Example Deployment Pack Stub',
            description: 'Descriptor-only deployment recipe sample for Docker/Zeabur style packs.',
            contributions: {
                deployment: {
                    packs: [{
                        id: 'example-docker-pack',
                        displayName: 'Example Docker Pack',
                        description: 'Schema-visible deployment pack stub; no runtime installer is executed.',
                        supportStatus: 'stub',
                        limitations: ['No deployment pack installer runtime is available yet.']
                    }]
                },
                web: {
                    settingsPanels: [{
                        id: 'deployment-pack-stub',
                        title: 'Example Deployment Pack Stub',
                        components: [{
                            kind: 'table',
                            columns: [{ key: 'item', label: 'Checklist' }, { key: 'value', label: 'Example value' }],
                            rows: [
                                { item: 'compose file', value: 'docker-compose.yml' },
                                { item: 'health probe', value: '/api/health' },
                                { item: 'env checklist', value: 'CLI_API_TOKEN, DATA_DIR' }
                            ]
                        }]
                    }]
                }
            }
        }),
        files: []
    },
    {
        manifest: manifestBase({
            id: 'com.hapi.examples.mcp-bridge-stub',
            name: 'Example MCP Bridge Stub',
            description: 'Descriptor-only integration protocol sample for future MCP/A2A extension points.',
            contributions: {
                integration: {
                    protocolBridges: [{
                        id: 'example-mcp-bridge',
                        displayName: 'Example MCP Bridge',
                        description: 'Schema-visible protocol bridge stub; runtime support requires future MCP/A2A hooks.',
                        protocol: 'mcp',
                        supportStatus: 'unsupported',
                        limitations: ['No Hub protocol bridge extension point is available yet.']
                    }]
                },
                web: {
                    settingsPanels: [{
                        id: 'mcp-bridge-stub',
                        title: 'Example MCP Bridge Stub',
                        components: [
                            { kind: 'text', text: 'MCP/A2A plugins need future hub.mcpServer/eventSubscriber extension points.', tone: 'warning' },
                            { kind: 'badge', label: 'Protocol bridge stub', variant: 'warning' }
                        ]
                    }]
                }
            }
        }),
        files: []
    }
]

export function getBundledExamplePluginsRoot(hapiHome: string): string {
    return join(expandHomePath(hapiHome), HAPI_BUNDLED_EXAMPLE_PLUGINS_DIR)
}

function expandHomePath(path: string): string {
    return path.replace(/^~(?=$|[/\\])/, homedir())
}

function isPathInside(parentPath: string, childPath: string): boolean {
    const rel = relative(parentPath, childPath)
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
}

function isEnoent(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

async function ensureDirectory(path: string, label: string): Promise<void> {
    try {
        const stats = await lstat(path)
        if (stats.isSymbolicLink()) {
            throw new Error(`Refusing to use bundled example ${label} symbolic link: ${path}`)
        }
        if (!stats.isDirectory()) {
            throw new Error(`Refusing to use bundled example ${label} non-directory: ${path}`)
        }
        return
    } catch (error) {
        if (!isEnoent(error)) {
            throw error
        }
    }

    await mkdir(path, { recursive: true, mode: 0o700 })
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) {
        throw new Error(`Refusing to use bundled example ${label} symbolic link: ${path}`)
    }
    if (!stats.isDirectory()) {
        throw new Error(`Refusing to use bundled example ${label} non-directory: ${path}`)
    }
}

async function writeFileIfChanged(path: string, content: string): Promise<void> {
    try {
        const stats = await lstat(path)
        if (stats.isSymbolicLink()) {
            throw new Error(`Refusing to overwrite bundled example symlink: ${path}`)
        }
        if (stats.isFile()) {
            const current = await readFile(path, 'utf8')
            if (current === content) {
                return
            }
        }
    } catch (error) {
        if (!isEnoent(error)) {
            throw error
        }
    }
    await writeFile(path, content, 'utf8')
}

export async function prepareBundledExamplePlugins(hapiHome: string): Promise<string> {
    const root = getBundledExamplePluginsRoot(hapiHome)
    await ensureDirectory(root, 'root')
    const allowedIds = new Set(bundledExamplePlugins.map((plugin) => plugin.manifest.id))
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!allowedIds.has(entry.name)) {
            await rm(join(root, entry.name), { recursive: true, force: true })
        }
    }

    for (const plugin of bundledExamplePlugins) {
        const pluginRoot = join(root, plugin.manifest.id)
        await ensureDirectory(pluginRoot, `plugin directory for ${plugin.manifest.id}`)
        await writeFileIfChanged(join(pluginRoot, HAPI_PLUGIN_MANIFEST_FILE), `${JSON.stringify(plugin.manifest, null, 2)}\n`)
        for (const file of plugin.files) {
            const filePath = resolve(pluginRoot, file.path)
            if (!isPathInside(resolve(pluginRoot), filePath)) {
                throw new Error(`Bundled example file path escapes plugin root: ${file.path}`)
            }
            await ensureDirectory(dirname(filePath), `file directory for ${plugin.manifest.id}`)
            await writeFileIfChanged(filePath, file.content)
        }
    }

    return root
}
