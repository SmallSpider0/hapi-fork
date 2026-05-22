export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export type EndpointDoc = {
    id: string
    method: HttpMethod
    path: string
    description: string
    targetQuery?: boolean
    bodySchema?: string
    responseSchema: string
}

export const endpointCatalog: EndpointDoc[] = [
    {
        id: 'plugins.list',
        method: 'GET',
        path: '/api/plugins',
        description: 'List Hub and/or Runner plugin inventory for the current namespace.',
        targetQuery: true,
        responseSchema: 'PluginListResponse'
    },
    {
        id: 'plugins.diagnostics',
        method: 'GET',
        path: '/api/plugins/diagnostics',
        description: 'List plugin diagnostics for Hub or Runner targets.',
        targetQuery: true,
        responseSchema: 'PluginDiagnosticsResponse'
    },
    {
        id: 'plugins.reloadAll',
        method: 'POST',
        path: '/api/plugins/reload',
        description: 'Reload all plugins on the selected target.',
        targetQuery: true,
        responseSchema: 'PluginReloadResult'
    },
    {
        id: 'plugins.installLocal',
        method: 'POST',
        path: '/api/plugins/install-local',
        description: 'Install a plugin from a target-local directory.',
        targetQuery: true,
        bodySchema: 'PluginInstallLocalRequest',
        responseSchema: 'PluginInstallResult'
    },
    {
        id: 'plugins.installPackage',
        method: 'POST',
        path: '/api/plugins/install-package',
        description: 'Install a plugin from a tgz/zip package upload payload.',
        targetQuery: true,
        bodySchema: 'PluginInstallPackageRequest',
        responseSchema: 'PluginInstallResult'
    },
    {
        id: 'plugins.localDirectory',
        method: 'POST',
        path: '/api/plugins/local-directory',
        description: 'Browse a target-local directory for plugin install UI.',
        targetQuery: true,
        bodySchema: 'PluginLocalDirectoryListRequest',
        responseSchema: 'PluginLocalDirectoryListResponse'
    },
    {
        id: 'plugins.detail',
        method: 'GET',
        path: '/api/plugins/{id}',
        description: 'Inspect one plugin on Hub or one Runner target.',
        targetQuery: true,
        responseSchema: 'PluginDetailResponse'
    },
    {
        id: 'plugins.reload',
        method: 'POST',
        path: '/api/plugins/{id}/reload',
        description: 'Reload one plugin on the selected target.',
        targetQuery: true,
        responseSchema: 'PluginReloadResult'
    },
    {
        id: 'plugins.enable',
        method: 'POST',
        path: '/api/plugins/{id}/enable',
        description: 'Enable one plugin with optional non-secret config.',
        targetQuery: true,
        bodySchema: 'PluginEnableRequest',
        responseSchema: 'PluginReloadResult'
    },
    {
        id: 'plugins.disable',
        method: 'POST',
        path: '/api/plugins/{id}/disable',
        description: 'Disable one plugin.',
        targetQuery: true,
        bodySchema: 'PluginDisableRequest',
        responseSchema: 'PluginReloadResult'
    },
    {
        id: 'plugins.delete',
        method: 'DELETE',
        path: '/api/plugins/{id}',
        description: 'Delete one plugin from a user-owned plugin install directory.',
        targetQuery: true,
        responseSchema: 'PluginDeleteResult'
    },
    {
        id: 'plugins.updateConfig',
        method: 'PATCH',
        path: '/api/plugins/{id}/config',
        description: 'Replace one plugin scoped config object and reload by default.',
        targetQuery: true,
        bodySchema: 'PluginConfigUpdateRequest',
        responseSchema: 'PluginReloadResult'
    }
]
