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

function relativeLink(page: string): string {
    return `./${page}`
}

export function renderTutorialIndex(tutorials: TutorialFixture[]): string {
    return GENERATED_HEADER + [
        '# Plugin tutorials',
        '',
        'Step-by-step guides for building HAPI plugins. The examples on these pages are generated from checked tutorial fixtures under `scripts/plugin-api-docs/tutorial-fixtures/` and their manifests are validated during `bun run docs:plugin-api`.',
        '',
        '## Start here',
        '',
        ...tutorials.map((tutorial) => `- [${tutorial.title}](${relativeLink(tutorial.page)}) — ${tutorial.summary}`),
        '',
        '## Development loop',
        '',
        'Use this loop for all plugin types:',
        bash(`mkdir -p my-plugin/dist
# write hapi.plugin.json and runtime files
hapi plugins install-local ./my-plugin --target hub --enable --reload
hapi plugins list --target hub
hapi plugins inspect <plugin-id> --target hub
hapi plugins doctor <plugin-id>`),
        'For Runner plugins, replace `--target hub` with `--target runner:<machineId>`.',
        '',
        '## Safety model',
        '',
        '- Hub and Runner runtime plugins are trusted local in-process JavaScript.',
        '- Disabled or invalid runtime plugins are not imported.',
        '- Secrets are read from environment variables through `ctx.secrets.get(name)` and must not be saved in `plugins.json`.',
        '- Web contributions are descriptors only; Web does not execute plugin JavaScript.'
    ].join('\n')
}

export function renderTutorialPage(tutorial: TutorialFixture): string {
    if (tutorial.id === 'hub-notification') return renderHubNotificationTutorial(tutorial)
    if (tutorial.id === 'runner-env') return renderRunnerEnvTutorial(tutorial)
    return renderWebDescriptorTutorial(tutorial)
}

function renderHubNotificationTutorial(tutorial: TutorialFixture): string {
    const runtime = requireRuntime(tutorial, 'dist/hub.js')
    return GENERATED_HEADER + [
        `# ${tutorial.title}`,
        '',
        tutorial.summary,
        '',
        '## What you will build',
        '',
        'A Hub runtime plugin that registers a notification channel. When HAPI emits ready, permission, task, or session completion events, your plugin receives a narrow `PluginNotificationEvent` DTO and logs it.',
        '',
        '## 1. Create files',
        bash(`mkdir -p tutorial-notification-logger/dist
cd tutorial-notification-logger`),
        'Create `hapi.plugin.json`:',
        json(tutorial.manifestSource),
        'Create `dist/hub.js`:',
        js(runtime.source),
        '## 2. Install and enable on the Hub target',
        bash(`cd ..
hapi plugins install-local ./tutorial-notification-logger --target hub --enable --reload`),
        'If Hub is not running, omit `--reload`; the plugin will load next time Hub starts.',
        '',
        '## 3. Set optional config',
        bash(`hapi plugins config set ${tutorial.manifest.id} prefix "[notify]" --target hub --reload`),
        'Config is saved to `$HAPI_HOME/plugins.json`. Do not put secrets there.',
        '',
        '## 4. Provide declared secrets',
        'The manifest declares `TUTORIAL_WEBHOOK_TOKEN`. Export it in the environment that starts Hub:',
        bash(`export TUTORIAL_WEBHOOK_TOKEN=dev-token
hapi hub`),
        'A missing declared secret creates diagnostics but does not expose the secret value.',
        '',
        '## 5. Inspect and debug',
        bash(`hapi plugins list --target hub
hapi plugins inspect ${tutorial.manifest.id} --target hub
hapi plugins doctor ${tutorial.manifest.id}`),
        'Useful failure codes include invalid manifest, missing entry path, disabled plugin, missing secret, and activation failure.',
        '',
        '## 6. Iterate',
        bash(`# edit dist/hub.js or hapi.plugin.json
hapi plugins reload ${tutorial.manifest.id}`),
        'Reload disposes HAPI-mediated resources such as registered notification channels. Your plugin must clean up its own timers, sockets, and handles in `dispose()`.'
    ].join('\n')
}

function renderRunnerEnvTutorial(tutorial: TutorialFixture): string {
    const runtime = requireRuntime(tutorial, 'dist/runner.js')
    return GENERATED_HEADER + [
        `# ${tutorial.title}`,
        '',
        tutorial.summary,
        '',
        '## What you will build',
        '',
        'A Runner runtime plugin that adds `TUTORIAL_RUNNER_ENV` to spawned agent processes and records spawn diagnostics. The plugin runs on the Runner machine, not on the Hub machine.',
        '',
        '## 1. Create files',
        bash(`mkdir -p tutorial-runner-env/dist
cd tutorial-runner-env`),
        'Create `hapi.plugin.json`:',
        json(tutorial.manifestSource),
        'Create `dist/runner.js`:',
        js(runtime.source),
        '## 2. Find the Runner target',
        bash(`hapi plugins list --target all-runners`),
        'Pick the `runner:<machineId>` shown in the target column.',
        '',
        '## 3. Install and enable on that Runner',
        bash(`cd ..
hapi plugins install-local ./tutorial-runner-env --target runner:<machineId> --enable --reload`),
        'The `sourcePath` is resolved on the selected Runner machine. If your Hub and Runner are different machines, either run this command from the Runner machine or package/upload the plugin with `hapi plugins install-package`.',
        '',
        'For every connected Runner in the namespace, use:',
        bash(`hapi plugins install-local ./tutorial-runner-env --target all-runners --enable --reload`),
        '## 4. Configure the environment value',
        bash(`hapi plugins config set ${tutorial.manifest.id} envValue "from-plugin" --target runner:<machineId> --reload`),
        'Runner config is scoped to `runner:<machineId>:<pluginId>`, so Hub and Runner values do not overwrite each other.',
        '',
        '## 5. Verify through diagnostics',
        bash(`hapi plugins inspect ${tutorial.manifest.id} --target runner:<machineId>
hapi plugins list --target runner:<machineId>`),
        `Run \`hapi plugins doctor ${tutorial.manifest.id}\` on the Runner machine for local manifest, entry, and secret checks.`,
        '',
        'Start a new remote session on that Runner. The resolved spawn plan should include diagnostics from `tutorial-env-applied` and `tutorial-spawn-audit`.',
        '',
        '## 6. Iterate safely',
        bash(`# edit dist/runner.js or hapi.plugin.json
hapi plugins reload ${tutorial.manifest.id} --target runner:<machineId>`),
        'Runner plugin proposals are schema-validated. Invalid proposal fields are rejected and reported as diagnostics; final command construction remains core-owned.'
    ].join('\n')
}

function renderWebDescriptorTutorial(tutorial: TutorialFixture): string {
    return GENERATED_HEADER + [
        `# ${tutorial.title}`,
        '',
        tutorial.summary,
        '',
        '## What you will build',
        '',
        'A plugin with no runtime entry. It contributes validated JSON descriptors that the Web app can render as settings panels, badges, actions, and New Session fields.',
        '',
        '## 1. Create files',
        bash(`mkdir -p tutorial-web-descriptor
cd tutorial-web-descriptor`),
        'Create `hapi.plugin.json`:',
        json(tutorial.manifestSource),
        'There is no `dist/*.js` file because Web descriptors do not execute plugin code.',
        '',
        '## 2. Install and enable',
        bash(`cd ..
hapi plugins install-local ./tutorial-web-descriptor --target hub --enable --reload`),
        'Descriptor-only plugins can be installed on Hub. Runner inventories can also publish Web descriptors when they come from Runner plugins.',
        '',
        '## 3. View in Web settings',
        '',
        'Open the Web app, go to Settings → Plugins, then open the plugin detail page. The settings panel, badge, action, and form fields come from the manifest descriptor.',
        '',
        '## 4. Update descriptor config',
        bash(`hapi plugins config set ${tutorial.manifest.id} note "hello" --target hub --reload`),
        'Fields marked `secret: true` are redacted by the UI and must not display existing secret values.',
        '',
        '## 5. Validate descriptor constraints',
        '',
        'Only built-in component kinds are allowed: `text`, `badge`, `table`, `actionButton`, and `schemaForm`. `actionButton.actionId` is allowlisted to core plugin actions such as `plugin.reload`; arbitrary URLs or JavaScript handlers are rejected by schema validation.',
        '',
        '## 6. Iterate',
        bash(`# edit hapi.plugin.json
hapi plugins reload ${tutorial.manifest.id}`),
        'Because no runtime code is imported, descriptor-only iteration is low risk. Invalid descriptors fail locally without executing browser-side plugin JavaScript.'
    ].join('\n')
}

function requireRuntime(tutorial: TutorialFixture, path: string): TutorialFixture['runtimeFiles'][number] {
    const runtime = tutorial.runtimeFiles.find((entry) => entry.path === path)
    if (!runtime) {
        throw new Error(`Tutorial fixture ${tutorial.id} is missing runtime ${path}`)
    }
    return runtime
}
