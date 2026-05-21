import chalk from 'chalk'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { configuration } from '@/configuration'
import { readSettings } from '@/persistence'
import { initializeApiUrl } from '@/ui/apiUrlInit'
import { initializeToken } from '@/ui/tokenInit'
import { getRemotePlugins, reloadRemotePlugins } from '@/api/pluginAdmin'
import type { CommandDefinition } from './types'
import {
    applyPluginState,
    discoverPlugins,
    getPluginStateFile,
    getUserPluginInstallDir,
    installPluginFromDirectory,
    readPluginState,
    validatePluginRoot,
    writePluginState,
    type DiscoveredPluginRecord
} from '@hapi/protocol/plugins/foundation'
import { createExampleNotificationLoggerFiles } from '@hapi/protocol/plugins'
import type { PluginDiagnostic, PluginInstallAction, PluginInstallResult, PluginListItem, PluginListResponse, PluginReloadResult, PluginStateFile } from '@hapi/protocol/plugins'

function hasFlag(args: string[], flag: string): boolean {
    return args.includes(flag)
}

function valueAfter(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
}

function pluginId(record: DiscoveredPluginRecord): string {
    return record.manifest?.id ?? basename(record.rootPath)
}

async function loadLocalRecords(): Promise<{ records: DiscoveredPluginRecord[]; state: PluginStateFile; parseError?: string }> {
    const stateResult = await readPluginState(getPluginStateFile(configuration.happyHomeDir))
    const discovered = await discoverPlugins({
        hapiHome: configuration.happyHomeDir,
        envPluginDirs: process.env.HAPI_PLUGIN_DIRS
    })
    return {
        records: applyPluginState(discovered, stateResult.state, stateResult.failClosed),
        state: stateResult.state,
        parseError: stateResult.parseError
    }
}

function toLocalListItem(record: DiscoveredPluginRecord): PluginListItem {
    const id = pluginId(record)
    return {
        id,
        name: record.manifest?.name,
        version: record.manifest?.version,
        description: record.manifest?.description,
        source: record.source,
        status: record.status,
        enabled: record.enabled === true,
        active: false,
        rootPath: record.rootPath,
        manifestPath: record.manifestPath,
        runtimes: {
            ...(record.manifest?.runtimes?.hub ? { hub: { entry: record.manifest.runtimes.hub.entry, active: false } } : {})
        },
        diagnostics: record.diagnostics.map((diagnostic) => ({ ...diagnostic, pluginId: id }))
    }
}

async function tryRemoteList(): Promise<PluginListResponse | null> {
    try {
        await initializeApiUrl()
        if (!configuration.cliApiToken) {
            const settings = await readSettings()
            if (settings.cliApiToken) {
                configuration._setCliApiToken(settings.cliApiToken)
            }
        }
        if (!configuration.cliApiToken) {
            return null
        }
        return await getRemotePlugins(configuration.cliApiToken, 2000)
    } catch {
        return null
    }
}

function printTable(plugins: PluginListItem[]): void {
    const rows = plugins.map((plugin) => ({
        id: plugin.id,
        status: plugin.status,
        enabled: plugin.enabled ? 'yes' : 'no',
        active: plugin.active ? 'yes' : 'no',
        source: plugin.source,
        name: plugin.name ?? ''
    }))
    const widths = {
        id: Math.max(2, ...rows.map((row) => row.id.length)),
        status: Math.max(6, ...rows.map((row) => row.status.length)),
        enabled: 7,
        active: 6,
        source: Math.max(6, ...rows.map((row) => row.source.length))
    }
    console.log(`${'ID'.padEnd(widths.id)}  ${'STATUS'.padEnd(widths.status)}  ENABLED  ACTIVE  ${'SOURCE'.padEnd(widths.source)}  NAME`)
    for (const row of rows) {
        console.log(`${row.id.padEnd(widths.id)}  ${row.status.padEnd(widths.status)}  ${row.enabled.padEnd(widths.enabled)}  ${row.active.padEnd(widths.active)}  ${row.source.padEnd(widths.source)}  ${row.name}`)
    }
}

function findRecord(records: DiscoveredPluginRecord[], id: string): DiscoveredPluginRecord | undefined {
    return records.find((record) => pluginId(record) === id || record.manifest?.id === id)
}

function printDiagnostics(diagnostics: PluginDiagnostic[]): void {
    if (diagnostics.length === 0) {
        console.log(chalk.green('No diagnostics.'))
        return
    }
    for (const diagnostic of diagnostics) {
        const color = diagnostic.severity === 'error' ? chalk.red : diagnostic.severity === 'warning' ? chalk.yellow : chalk.gray
        console.log(color(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`))
        if (diagnostic.path) {
            console.log(chalk.gray(`  ${diagnostic.path}`))
        }
    }
}

function sanitizeConfigForView(config: Record<string, unknown> | undefined, declaredSecrets: string[] = []): Record<string, unknown> | undefined {
    if (!config) {
        return undefined
    }
    const secretKeys = new Set(declaredSecrets.map((key) => key.toLowerCase()))
    const sanitize = (value: unknown, key = ''): unknown => {
        const lowerKey = key.toLowerCase()
        if (secretKeys.has(lowerKey) || lowerKey.includes('secret') || lowerKey.includes('token') || lowerKey.includes('password')) {
            return '[REDACTED]'
        }
        if (Array.isArray(value)) {
            return value.map((entry) => sanitize(entry))
        }
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [entryKey, sanitize(entry, entryKey)]))
        }
        return value
    }
    return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, sanitize(value, key)]))
}


function ensureConfigHasNoDeclaredSecrets(config: Record<string, unknown> | undefined, declaredSecrets: string[], id: string): void {
    if (!config) return
    const secrets = new Set(declaredSecrets.map((secret) => secret.toLowerCase()))
    for (const key of Object.keys(config)) {
        if (secrets.has(key.toLowerCase())) {
            throw new Error(`Config for ${id} must not store declared secret ${key}; set it as an environment variable instead.`)
        }
    }
    const redactedPath = findRedactedPlaceholderPath(config)
    if (redactedPath) {
        throw new Error(`Config for ${id} contains a redacted placeholder at ${redactedPath}; replace it with a real value or remove the field before saving.`)
    }
}

function findRedactedPlaceholderPath(value: unknown, path = '$'): string | null {
    if (value === '[REDACTED]') {
        return path
    }
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            const found = findRedactedPlaceholderPath(value[index], `${path}[${index}]`)
            if (found) return found
        }
        return null
    }
    if (value && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            const found = findRedactedPlaceholderPath(entry, `${path}.${key}`)
            if (found) return found
        }
    }
    return null
}

function assertLocalRecordCanBeEnabled(record: DiscoveredPluginRecord, id: string): asserts record is DiscoveredPluginRecord & { manifest: NonNullable<DiscoveredPluginRecord['manifest']> } {
    if (!record.manifest) {
        throw new Error(`Plugin not found or invalid: ${id}`)
    }
    if (['invalid', 'incompatible', 'blocked'].includes(record.status)) {
        throw new Error(`Plugin ${record.manifest.id} cannot be enabled while status is ${record.status}.`)
    }
}

async function parseConfigArg(raw: string | undefined): Promise<Record<string, unknown> | undefined> {
    if (!raw) {
        return undefined
    }
    const text = raw.startsWith('@') ? await readFile(raw.slice(1), 'utf8') : raw
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Config must be a JSON object.')
    }
    return parsed as Record<string, unknown>
}

function parseValue(raw: string): unknown {
    try {
        return JSON.parse(raw) as unknown
    } catch {
        return raw
    }
}

async function confirmRisk(record: DiscoveredPluginRecord, action: 'enable' | 'disable', yes: boolean): Promise<void> {
    if (yes) {
        return
    }
    if (!process.stdin.isTTY) {
        throw new Error(`Refusing to ${action} plugin in non-TTY mode without --yes.`)
    }
    console.log(chalk.yellow('This plugin will run as trusted local code inside the HAPI Hub process.'))
    console.log(chalk.yellow('Permissions are declarations for review; they are not a sandbox enforcement boundary.'))
    console.log(chalk.gray(`Plugin: ${record.manifest?.name ?? pluginId(record)} (${pluginId(record)})`))
    console.log(chalk.gray(`Entry: ${record.manifest?.runtimes?.hub?.entry ?? '(none)'}`))
    console.log(chalk.gray(`Declared network access: ${(record.manifest?.permissions?.network ?? []).join(', ') || '(none)'}`))
    console.log(chalk.gray(`Declared secrets: ${(record.manifest?.permissions?.secrets ?? []).join(', ') || '(none)'}`))
    console.log(chalk.gray('Secret values are read from environment variables and are not stored in plugins.json.'))
    const rl = readline.createInterface({ input, output })
    try {
        const answer = await rl.question(`Type ${action} to continue: `)
        if (answer.trim() !== action) {
            throw new Error('Cancelled.')
        }
    } finally {
        rl.close()
    }
}

async function readWritableState(): Promise<PluginStateFile> {
    const result = await readPluginState(getPluginStateFile(configuration.happyHomeDir))
    if (result.parseError) {
        throw new Error(`Cannot update plugins.json while it is invalid: ${result.parseError}`)
    }
    return result.state
}

async function maybeReload(pluginId: string | undefined, requested: boolean, json: boolean, stateSavedMessage: string): Promise<void> {
    if (!requested) {
        console.log(chalk.green(stateSavedMessage))
        console.log(chalk.gray('Run hapi plugins reload or restart hapi hub to apply.'))
        return
    }
    try {
        await initializeApiUrl()
        await initializeToken()
        const result = await reloadRemotePlugins(configuration.cliApiToken, pluginId)
        if (json) {
            console.log(JSON.stringify(result, null, 2))
        } else {
            const keptPrevious = result.results.some((item) => item.action === 'kept-previous')
            if (result.ok && !keptPrevious) {
                console.log(chalk.green('Plugin state saved and Hub reload applied.'))
            } else {
                console.log(chalk.yellow('Plugin state saved, reload failed or kept previous active instance.'))
            }
            for (const item of result.results) {
                console.log(`${item.id}: ${item.action} (${item.status})${item.message ? ` - ${item.message}` : ''}`)
            }
        }
    } catch (error) {
        console.log(chalk.yellow(`${stateSavedMessage} Hub reload was not applied: ${error instanceof Error ? error.message : String(error)}`))
        console.log(chalk.gray('Run hapi plugins reload or restart hapi hub to apply.'))
    }
}

async function reloadRemoteOptional(pluginId: string | undefined, requested: boolean): Promise<PluginReloadResult | undefined> {
    if (!requested) {
        return undefined
    }
    await initializeApiUrl()
    await initializeToken()
    return await reloadRemotePlugins(configuration.cliApiToken, pluginId)
}

async function writeExamplePlugin(overwrite: boolean): Promise<{
    action: PluginInstallAction
    pluginId: string
    targetPath: string
    record: DiscoveredPluginRecord
    defaultConfig: Record<string, unknown>
}> {
    const example = createExampleNotificationLoggerFiles({
        logFile: join(configuration.happyHomeDir, 'logs', 'example-plugin-notifications.jsonl')
    })
    const targetPath = getUserPluginInstallDir(configuration.happyHomeDir, example.id)
    const targetExists = existsSync(targetPath)
    let action: PluginInstallAction = 'unchanged'

    if (!targetExists || overwrite) {
        if (targetExists) {
            await rm(targetPath, { recursive: true, force: true })
            action = 'overwritten'
        } else {
            action = 'installed'
        }
        for (const file of example.files) {
            const path = join(targetPath, file.relativePath)
            await mkdir(dirname(path), { recursive: true, mode: 0o700 })
            await writeFile(path, file.contents, { mode: 0o600 })
        }
    }

    const record = await validatePluginRoot(targetPath, 'user-home')
    if (!record.manifest || record.status !== 'validated') {
        const details = record.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join('; ')
        throw new Error(`Example plugin could not be installed: ${details || targetPath}`)
    }

    return {
        action,
        pluginId: example.id,
        targetPath,
        record,
        defaultConfig: example.defaultConfig
    }
}

async function enableInstalledPlugin(record: DiscoveredPluginRecord, config?: Record<string, unknown>): Promise<void> {
    if (!record.manifest) {
        throw new Error('Cannot enable plugin without a valid manifest.')
    }
    ensureConfigHasNoDeclaredSecrets(config, record.manifest.permissions?.secrets ?? [], record.manifest.id)
    const state = await readWritableState()
    const previous = state.enabled[record.manifest.id]
    state.enabled[record.manifest.id] = {
        enabled: true,
        ...(config ?? previous?.config ? { config: config ?? previous?.config } : {})
    }
    await writePluginState(getPluginStateFile(configuration.happyHomeDir), state)
}

async function buildLocalInstallResult(args: {
    action: PluginInstallAction
    pluginId: string
    sourcePath?: string
    targetPath: string
    record: DiscoveredPluginRecord
    reload?: PluginReloadResult
}): Promise<PluginInstallResult> {
    const plugins = (await loadLocalRecords()).records.map(toLocalListItem)
    const plugin = plugins.find((entry) => entry.id === args.pluginId)
    return {
        ok: args.reload?.ok ?? true,
        action: args.action,
        ...(plugin ? { plugin } : {}),
        pluginId: args.pluginId,
        ...(args.sourcePath ? { sourcePath: args.sourcePath } : {}),
        targetPath: args.targetPath,
        diagnostics: args.record.diagnostics.map((diagnostic) => ({ ...diagnostic, pluginId: args.pluginId })),
        ...(args.reload ? { reload: args.reload } : {}),
        plugins
    }
}

async function runList(args: string[]): Promise<void> {
    const json = hasFlag(args, '--json')
    const remote = await tryRemoteList()
    const payload = remote ?? { plugins: (await loadLocalRecords()).records.map(toLocalListItem) }
    if (json) {
        console.log(JSON.stringify(payload, null, 2))
    } else {
        printTable(payload.plugins)
        if (!remote) {
            console.log(chalk.gray('\nActive state is shown as no when Hub plugin API is offline or unavailable.'))
        }
    }
}

async function runInspect(args: string[]): Promise<void> {
    const id = args[0]
    if (!id) throw new Error('Usage: hapi plugins inspect <id> [--json]')
    const json = hasFlag(args, '--json')
    const { records } = await loadLocalRecords()
    const record = findRecord(records, id)
    if (!record) throw new Error(`Plugin not found: ${id}`)
    const item = toLocalListItem(record)
    const detail = {
        ...item,
        manifest: record.manifest,
        config: sanitizeConfigForView(record.config, record.manifest?.permissions?.secrets ?? []),
        runtimeEntryPaths: record.runtimeEntryPaths,
        permissions: {
            network: record.manifest?.permissions?.network ?? [],
            secrets: (record.manifest?.permissions?.secrets ?? []).map((name) => ({ name, present: Boolean(process.env[name]) }))
        }
    }
    if (json) {
        console.log(JSON.stringify({ plugin: detail }, null, 2))
        return
    }
    console.log(chalk.bold(`${record.manifest?.name ?? pluginId(record)} (${pluginId(record)})`))
    console.log(`Status: ${item.status}`)
    console.log(`Enabled: ${item.enabled ? 'yes' : 'no'}`)
    console.log(`Source: ${item.source}`)
    console.log(`Root: ${item.rootPath}`)
    console.log(`Manifest: ${item.manifestPath}`)
    console.log(`Hub entry: ${record.manifest?.runtimes?.hub?.entry ?? '(none)'}`)
    console.log(`Network: ${(record.manifest?.permissions?.network ?? []).join(', ') || '(none)'}`)
    console.log(`Secrets: ${(record.manifest?.permissions?.secrets ?? []).join(', ') || '(none)'}`)
    if (record.config) {
        console.log(`Config: ${JSON.stringify(sanitizeConfigForView(record.config, record.manifest?.permissions?.secrets ?? []), null, 2)}`)
    }
    printDiagnostics(record.diagnostics)
}

async function runEnable(args: string[]): Promise<void> {
    const id = args[0]
    if (!id) throw new Error('Usage: hapi plugins enable <id> [--config <json-or-@file>] [--reload] [--yes]')
    const json = hasFlag(args, '--json')
    const { records } = await loadLocalRecords()
    const record = findRecord(records, id)
    if (!record) throw new Error(`Plugin not found or invalid: ${id}`)
    assertLocalRecordCanBeEnabled(record, id)
    await confirmRisk(record, 'enable', hasFlag(args, '--yes') || hasFlag(args, '-y'))
    const config = await parseConfigArg(valueAfter(args, '--config'))
    ensureConfigHasNoDeclaredSecrets(config, record.manifest.permissions?.secrets ?? [], record.manifest.id)
    const writableState = await readWritableState()
    const previous = writableState.enabled[record.manifest.id]
    writableState.enabled[record.manifest.id] = {
        enabled: true,
        ...(config ?? previous?.config ? { config: config ?? previous?.config } : {})
    }
    await writePluginState(getPluginStateFile(configuration.happyHomeDir), writableState)
    await maybeReload(record.manifest.id, hasFlag(args, '--reload'), json, 'Plugin enabled locally.')
}

async function runDisable(args: string[]): Promise<void> {
    const id = args[0]
    if (!id) throw new Error('Usage: hapi plugins disable <id> [--reload] [--yes]')
    const json = hasFlag(args, '--json')
    const { records } = await loadLocalRecords()
    const record = findRecord(records, id)
    if (!record?.manifest) throw new Error(`Plugin not found or invalid: ${id}`)
    await confirmRisk(record, 'disable', hasFlag(args, '--yes') || hasFlag(args, '-y'))
    const state = await readWritableState()
    const previous = state.enabled[record.manifest.id]
    state.enabled[record.manifest.id] = { enabled: false, ...(previous?.config ? { config: previous.config } : {}) }
    await writePluginState(getPluginStateFile(configuration.happyHomeDir), state)
    await maybeReload(record.manifest.id, hasFlag(args, '--reload'), json, 'Plugin disabled locally.')
}

async function runConfig(args: string[]): Promise<void> {
    const sub = args[0]
    const id = args[1]
    if (!sub || !id || !['get', 'set'].includes(sub)) {
        throw new Error('Usage: hapi plugins config get <id> [--json] | hapi plugins config set <id> <key> <value> [--reload]')
    }
    const { records } = await loadLocalRecords()
    const record = findRecord(records, id)
    if (!record) throw new Error(`Plugin not found or invalid: ${id}`)
    assertLocalRecordCanBeEnabled(record, id)
    const state = await readWritableState()
    const entry = state.enabled[record.manifest.id] ?? { enabled: false }
    if (sub === 'get') {
        const payload = { id: record.manifest.id, config: sanitizeConfigForView(entry.config, record.manifest.permissions?.secrets ?? []) ?? {} }
        console.log(hasFlag(args, '--json') ? JSON.stringify(payload, null, 2) : JSON.stringify(payload.config, null, 2))
        return
    }
    const key = args[2]
    const value = args[3]
    if (!key || value === undefined) {
        throw new Error('Usage: hapi plugins config set <id> <key> <value> [--reload]')
    }
    const nextConfig = { ...(entry.config ?? {}), [key]: parseValue(value) }
    ensureConfigHasNoDeclaredSecrets(nextConfig, record.manifest.permissions?.secrets ?? [], record.manifest.id)
    state.enabled[record.manifest.id] = { enabled: entry.enabled, config: nextConfig }
    await writePluginState(getPluginStateFile(configuration.happyHomeDir), state)
    await maybeReload(record.manifest.id, hasFlag(args, '--reload'), hasFlag(args, '--json'), 'Plugin config saved locally.')
}

async function runInstallExample(args: string[]): Promise<void> {
    const json = hasFlag(args, '--json')
    const enable = !hasFlag(args, '--no-enable')
    const reload = hasFlag(args, '--reload')
    const installed = await writeExamplePlugin(hasFlag(args, '--overwrite'))
    if (enable) {
        await enableInstalledPlugin(installed.record, installed.defaultConfig)
    }

    let reloadResult: PluginReloadResult | undefined
    try {
        reloadResult = await reloadRemoteOptional(installed.pluginId, reload)
    } catch (error) {
        if (!json) {
            console.log(chalk.yellow(`Example plugin installed locally, but Hub reload was not applied: ${error instanceof Error ? error.message : String(error)}`))
            console.log(chalk.gray('Run hapi plugins reload or restart hapi hub to apply.'))
        }
    }

    const payload = await buildLocalInstallResult({
        action: installed.action,
        pluginId: installed.pluginId,
        targetPath: installed.targetPath,
        record: installed.record,
        reload: reloadResult
    })
    if (json) {
        console.log(JSON.stringify(payload, null, 2))
        return
    }

    const actionLabel = installed.action === 'unchanged' ? 'already installed' : installed.action
    console.log(chalk.green(`Example Notification Logger ${actionLabel}.`))
    console.log(chalk.gray(`Target: ${installed.targetPath}`))
    if (enable) {
        console.log(chalk.gray(`Log file: ${String(installed.defaultConfig.logFile)}`))
    }
    if (!reload) {
        console.log(chalk.gray('Run hapi plugins reload or restart hapi hub to apply.'))
    } else if (reloadResult) {
        console.log(chalk.green(reloadResult.ok ? 'Hub reload applied.' : 'Hub reload completed with issues.'))
    }
}

async function runInstallLocal(args: string[]): Promise<void> {
    const sourcePath = args.find((arg) => !arg.startsWith('-'))
    if (!sourcePath) throw new Error('Usage: hapi plugins install-local <path> [--enable] [--reload] [--overwrite] [--json] [--yes]')
    const json = hasFlag(args, '--json')
    const install = await installPluginFromDirectory({
        hapiHome: configuration.happyHomeDir,
        sourcePath,
        overwrite: hasFlag(args, '--overwrite')
    })
    const pluginIdValue = install.record.manifest!.id
    if (hasFlag(args, '--enable')) {
        await confirmRisk(install.record, 'enable', hasFlag(args, '--yes') || hasFlag(args, '-y'))
        await enableInstalledPlugin(install.record)
    }

    let reloadResult: PluginReloadResult | undefined
    try {
        reloadResult = await reloadRemoteOptional(pluginIdValue, hasFlag(args, '--reload'))
    } catch (error) {
        if (!json) {
            console.log(chalk.yellow(`Plugin installed locally, but Hub reload was not applied: ${error instanceof Error ? error.message : String(error)}`))
            console.log(chalk.gray('Run hapi plugins reload or restart hapi hub to apply.'))
        }
    }

    const payload = await buildLocalInstallResult({
        action: install.action,
        pluginId: pluginIdValue,
        sourcePath: install.sourcePath,
        targetPath: install.targetPath,
        record: install.record,
        reload: reloadResult
    })
    if (json) {
        console.log(JSON.stringify(payload, null, 2))
        return
    }

    console.log(chalk.green(`Plugin ${install.action}: ${pluginIdValue}`))
    console.log(chalk.gray(`Source: ${install.sourcePath}`))
    console.log(chalk.gray(`Target: ${install.targetPath}`))
    if (!hasFlag(args, '--reload')) {
        console.log(chalk.gray('Run hapi plugins reload or restart hapi hub to apply.'))
    } else if (reloadResult) {
        console.log(chalk.green(reloadResult.ok ? 'Hub reload applied.' : 'Hub reload completed with issues.'))
    }
}

async function runReload(args: string[]): Promise<void> {
    const id = args.find((arg) => !arg.startsWith('-'))
    await initializeApiUrl()
    await initializeToken()
    const result: PluginReloadResult = await reloadRemotePlugins(configuration.cliApiToken, id)
    if (hasFlag(args, '--json')) {
        console.log(JSON.stringify(result, null, 2))
        return
    }
    for (const item of result.results) {
        const color = item.action === 'failed' || item.action === 'kept-previous' ? chalk.yellow : chalk.green
        console.log(color(`${item.id}: ${item.action} (${item.status})${item.message ? ` - ${item.message}` : ''}`))
    }
}

async function runDoctor(args: string[]): Promise<void> {
    const targetId = args.find((arg) => !arg.startsWith('-'))
    const json = hasFlag(args, '--json')
    const { records, parseError } = await loadLocalRecords()
    const diagnostics: Array<PluginDiagnostic & { pluginId?: string }> = []
    if (parseError) {
        diagnostics.push({ severity: 'error', code: 'plugin-state-parse-error', message: parseError })
    }
    for (const record of records) {
        const id = pluginId(record)
        if (targetId && id !== targetId && record.manifest?.id !== targetId) continue
        diagnostics.push(...record.diagnostics.map((diagnostic) => ({ ...diagnostic, pluginId: id })))
        for (const secret of record.manifest?.permissions?.secrets ?? []) {
            if (!process.env[secret]) {
                diagnostics.push({ pluginId: id, severity: 'warning', code: 'missing-secret', message: `Declared secret ${secret} is not set.` })
            }
        }
        const schemaPath = record.manifest?.config?.schema
        if (schemaPath) {
            const resolved = resolve(record.rootPath, schemaPath)
            if (!existsSync(resolved)) {
                diagnostics.push({ pluginId: id, severity: 'error', code: 'missing-config-schema', message: `Config schema ${schemaPath} is missing.`, path: resolved })
            }
        }
    }
    if (json) {
        console.log(JSON.stringify({ diagnostics }, null, 2))
        return
    }
    printDiagnostics(diagnostics)
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi plugins')} - Local plugin management

${chalk.bold('Usage:')}
  hapi plugins list [--json]
  hapi plugins inspect <id> [--json]
  hapi plugins enable <id> [--config <json-or-@file>] [--reload] [--yes]
  hapi plugins disable <id> [--reload] [--yes]
  hapi plugins config get <id> [--json]
  hapi plugins config set <id> <key> <value> [--reload]
  hapi plugins install-example [--reload] [--overwrite] [--no-enable] [--json]
  hapi plugins install-local <path> [--enable] [--reload] [--overwrite] [--json] [--yes]
  hapi plugins reload [id] [--json]
  hapi plugins doctor [id] [--json]
`)
}

export async function handlePluginsCommand(args: string[]): Promise<void> {
    const subcommand = args[0]
    const rest = args.slice(1)
    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        showHelp()
        return
    }
    if (subcommand === 'list') return await runList(rest)
    if (subcommand === 'inspect') return await runInspect(rest)
    if (subcommand === 'enable') return await runEnable(rest)
    if (subcommand === 'disable') return await runDisable(rest)
    if (subcommand === 'config') return await runConfig(rest)
    if (subcommand === 'install-example') return await runInstallExample(rest)
    if (subcommand === 'install-local' || subcommand === 'install') return await runInstallLocal(rest)
    if (subcommand === 'reload') return await runReload(rest)
    if (subcommand === 'doctor') return await runDoctor(rest)
    throw new Error(`Unknown plugins subcommand: ${subcommand}`)
}

export const pluginsCommand: CommandDefinition = {
    name: 'plugins',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handlePluginsCommand(commandArgs)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}
