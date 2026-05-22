import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { HAPI_PLUGIN_MANIFEST_FILE, PluginManifestLiteSchema, type PluginManifestLite } from '../../shared/src/plugins'

export type TutorialId = 'hub-notification' | 'runner-env' | 'web-descriptor'

export type TutorialFixture = {
    id: TutorialId
    page: string
    title: string
    summary: string
    installTarget: 'hub' | 'runner:<machineId>'
    pluginDir: string
    manifest: PluginManifestLite
    manifestSource: string
    runtimeFiles: Array<{
        path: string
        language: 'js'
        source: string
    }>
}

const tutorialMetadata: Array<Omit<TutorialFixture, 'manifest' | 'manifestSource' | 'runtimeFiles'> & { runtimePaths: string[] }> = [
    {
        id: 'hub-notification',
        page: 'tutorial-hub-notification.md',
        title: 'Tutorial: Hub notification plugin',
        summary: 'Build a Hub runtime plugin that receives HAPI notification events and logs them.',
        installTarget: 'hub',
        pluginDir: 'hub-notification',
        runtimePaths: ['dist/hub.js']
    },
    {
        id: 'runner-env',
        page: 'tutorial-runner-env.md',
        title: 'Tutorial: Runner environment plugin',
        summary: 'Build a Runner runtime plugin that injects environment variables and spawn diagnostics.',
        installTarget: 'runner:<machineId>',
        pluginDir: 'runner-env',
        runtimePaths: ['dist/runner.js']
    },
    {
        id: 'web-descriptor',
        page: 'tutorial-web-descriptor.md',
        title: 'Tutorial: Web descriptor plugin',
        summary: 'Build a descriptor-only plugin rendered by the Web UI without browser-side plugin JavaScript.',
        installTarget: 'hub',
        pluginDir: 'web-descriptor',
        runtimePaths: []
    }
]

export function loadTutorialFixtures(root: string): TutorialFixture[] {
    const fixtureRoot = join(root, 'scripts/plugin-api-docs/tutorial-fixtures')
    return tutorialMetadata.map((metadata) => {
        const pluginRoot = join(fixtureRoot, metadata.pluginDir)
        const manifestPath = join(pluginRoot, HAPI_PLUGIN_MANIFEST_FILE)
        const manifestSource = readFileSync(manifestPath, 'utf8')
        const parsed = PluginManifestLiteSchema.safeParse(JSON.parse(manifestSource) as unknown)
        if (!parsed.success) {
            throw new Error(`Tutorial fixture manifest is invalid: ${relative(root, manifestPath)} ${parsed.error.message}`)
        }

        const runtimeFiles = metadata.runtimePaths.map((runtimePath) => {
            const filePath = resolve(pluginRoot, runtimePath)
            if (!isPathInside(resolve(pluginRoot), filePath)) {
                throw new Error(`Tutorial fixture runtime path escapes plugin root: ${metadata.id}:${runtimePath}`)
            }
            if (!existsSync(filePath)) {
                throw new Error(`Tutorial fixture runtime file is missing: ${relative(root, filePath)}`)
            }
            return {
                path: runtimePath,
                language: 'js' as const,
                source: readFileSync(filePath, 'utf8')
            }
        })

        return {
            id: metadata.id,
            page: metadata.page,
            title: metadata.title,
            summary: metadata.summary,
            installTarget: metadata.installTarget,
            pluginDir: metadata.pluginDir,
            manifest: parsed.data,
            manifestSource,
            runtimeFiles
        }
    })
}

function isPathInside(parentPath: string, childPath: string): boolean {
    const rel = relative(parentPath, childPath)
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
}
