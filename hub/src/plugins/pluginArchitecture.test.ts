import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    HUB_IMPLEMENTED_EXTENSION_POINTS,
    RUNNER_IMPLEMENTED_EXTENSION_POINTS,
    SCHEMA_ONLY_EXTENSION_POINTS
} from '@hapi/protocol/plugins/extensionPoints'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const scannedRoots = ['hub/src', 'web/src', 'cli/src']
const excludedSuffixes = [
    '.test.ts',
    '.test.tsx',
    '.spec.ts',
    '.spec.tsx'
]

function sourceFiles(root: string): string[] {
    const result: string[] = []
    const visit = (dir: string) => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry)
            const stat = statSync(path)
            if (stat.isDirectory()) {
                if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue
                visit(path)
                continue
            }
            if (!/\.(ts|tsx)$/.test(entry)) continue
            if (excludedSuffixes.some((suffix) => entry.endsWith(suffix))) continue
            result.push(path)
        }
    }
    visit(join(repoRoot, root))
    return result
}

describe('plugin architecture boundaries', () => {
    it('does not hard-code first-party plugin identities in core runtime or Web code', () => {
        const forbidden = /HAPI_(SERVERCHAN_NOTIFIER|RUNNER_LAUNCH_PRESETS)_PLUGIN_ID|com\.hapi\.(serverchan-notifier|runner-launch-presets)/
        const offenders = scannedRoots
            .flatMap(sourceFiles)
            .filter((file) => forbidden.test(readFileSync(file, 'utf8')))
            .map((file) => relative(repoRoot, file))

        expect(offenders).toEqual([])
    })

    it('does not expose plugin-specific core APIs for runner launch presets', () => {
        const forbidden = /launch-presets\/resolve|resolveRunnerLaunchPresets|RunnerLaunchPresetsEditor/
        const offenders = scannedRoots
            .flatMap(sourceFiles)
            .filter((file) => forbidden.test(readFileSync(file, 'utf8')))
            .map((file) => relative(repoRoot, file))

        expect(offenders).toEqual([])
    })

    it('keeps implemented extension points scoped to actual runtimes', () => {
        expect(HUB_IMPLEMENTED_EXTENSION_POINTS).not.toContain('hub.action')
        expect(RUNNER_IMPLEMENTED_EXTENSION_POINTS).not.toContain('hub.action')
        for (const extensionPoint of SCHEMA_ONLY_EXTENSION_POINTS) {
            expect(HUB_IMPLEMENTED_EXTENSION_POINTS).not.toContain(extensionPoint)
            expect(RUNNER_IMPLEMENTED_EXTENSION_POINTS).not.toContain(extensionPoint)
        }
    })
})
