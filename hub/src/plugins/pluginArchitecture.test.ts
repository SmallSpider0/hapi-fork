import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

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
        const forbidden = /HAPI_CORE_(SERVERCHAN_NOTIFIER|RUNNER_LAUNCH_PRESETS)_PLUGIN_ID|com\.hapi\.core\.(serverchan-notifier|runner-launch-presets)/
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
})
