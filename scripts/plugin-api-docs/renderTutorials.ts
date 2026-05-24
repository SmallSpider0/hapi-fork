import type { TutorialFixture } from './tutorialCatalog'
import { GENERATED_HEADER } from './renderMarkdown'

function codeBlock(language: string, source: string): string {
    return `\n\`\`\`${language}\n${source.trim()}\n\`\`\`\n`
}

function bash(source: string): string {
    return codeBlock('bash', source)
}

function json(source: string): string {
    return codeBlock('json', source)
}

function js(source: string): string {
    return codeBlock('js', source)
}

export function renderQuickstartPage(tutorials: TutorialFixture[]): string {
    return GENERATED_HEADER + [
        '# Plugin quickstart',
        '',
        'Three minimal plugin shapes, generated from checked fixtures under `scripts/plugin-api-docs/tutorial-fixtures/`. Their manifests are validated when `bun run docs:plugin-api` runs.',
        '',
        '## Development loop',
        '',
        bash(`mkdir -p my-plugin/dist
# write hapi.plugin.json and optional runtime files
hapi plugins install-local ./my-plugin --target hub --enable --reload
hapi plugins list --target hub
hapi plugins inspect <plugin-id> --target hub
hapi plugins doctor <plugin-id>`),
        'For Runner plugins, replace `--target hub` with `--target runner:<machineId>` or use manifest-driven package install:',
        bash(`hapi plugins install-package ./my-plugin.hapi-plugin.tgz --runners compatible --enable --reload`),
        '',
        ...tutorials.flatMap((tutorial) => renderTutorialSection(tutorial)),
        '## Safety checklist',
        '',
        '- Hub and Runner runtime plugins are trusted local in-process JavaScript.',
        '- Disabled or invalid runtime plugins are not imported.',
        '- Secrets are read from environment variables through `ctx.secrets.get(name)` and must not be saved in `plugins.json`.',
        '- Web contributions are descriptors only; Web does not execute plugin JavaScript.'
    ].join('\n')
}

function renderTutorialSection(tutorial: TutorialFixture): string[] {
    const installCommand = tutorial.installTarget === 'hub'
        ? `hapi plugins install-local ./${tutorial.pluginDir} --target hub --enable --reload`
        : `hapi plugins install-local ./${tutorial.pluginDir} --target runner:<machineId> --enable --reload`
    return [
        `## ${tutorial.title}`,
        '',
        tutorial.summary,
        '',
        'Create `hapi.plugin.json`:',
        json(tutorial.manifestSource),
        ...tutorial.runtimeFiles.flatMap((runtime) => [
            `Create \`${runtime.path}\`:`,
            js(runtime.source)
        ]),
        'Install:',
        bash(installCommand),
        tutorial.installTarget === 'hub'
            ? 'Hub-local path install reads files on the Hub machine.'
            : 'Runner-local path install reads files on the selected Runner machine; use package install when Hub and Runner are on different machines.',
        ''
    ]
}
