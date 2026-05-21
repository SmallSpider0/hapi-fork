import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { PluginDeleteResult, PluginInstallLocalRequest, PluginInstallResult, PluginReloadResult } from '@hapi/protocol/plugins/admin'
import { queryKeys } from '@/lib/query-keys'

type PluginActionMutationResult = PluginReloadResult | PluginInstallResult | PluginDeleteResult

export function usePluginActions(api: ApiClient | null): {
    enablePlugin: (id: string, config?: Record<string, unknown>) => Promise<PluginReloadResult>
    disablePlugin: (id: string) => Promise<PluginReloadResult>
    reloadPlugin: (id: string) => Promise<PluginReloadResult>
    reloadPlugins: () => Promise<PluginReloadResult>
    saveConfig: (id: string, config: Record<string, unknown>) => Promise<PluginReloadResult>
    installLocalPlugin: (body: PluginInstallLocalRequest) => Promise<PluginInstallResult>
    deletePlugin: (id: string) => Promise<PluginDeleteResult>
    isPending: boolean
} {
    const queryClient = useQueryClient()
    const invalidate = async (id?: string) => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.plugins })
        await queryClient.invalidateQueries({ queryKey: queryKeys.pluginDiagnostics })
        if (id) {
            await queryClient.invalidateQueries({ queryKey: queryKeys.plugin(id) })
        }
    }
    const mutation = useMutation<PluginActionMutationResult, Error, {
        type: 'enable' | 'disable' | 'reload' | 'reload-all' | 'config' | 'install-local' | 'delete'
        id?: string
        config?: Record<string, unknown>
        installLocal?: PluginInstallLocalRequest
    }>({
        mutationFn: async (action: {
            type: 'enable' | 'disable' | 'reload' | 'reload-all' | 'config' | 'install-local' | 'delete'
            id?: string
            config?: Record<string, unknown>
            installLocal?: PluginInstallLocalRequest
        }) => {
            if (!api) throw new Error('API unavailable')
            if (action.type === 'enable' && action.id) return await api.enablePlugin(action.id, action.config)
            if (action.type === 'disable' && action.id) return await api.disablePlugin(action.id)
            if (action.type === 'reload' && action.id) return await api.reloadPlugin(action.id)
            if (action.type === 'config' && action.id && action.config) return await api.updatePluginConfig(action.id, action.config)
            if (action.type === 'install-local' && action.installLocal) return await api.installLocalPlugin(action.installLocal)
            if (action.type === 'delete' && action.id) return await api.deletePlugin(action.id)
            return await api.reloadPlugins()
        },
        onSuccess: (result, action) => {
            const installedId = 'pluginId' in result ? result.pluginId : undefined
            void invalidate(action.id ?? installedId)
        },
    })

    return {
        enablePlugin: async (id, config) => await mutation.mutateAsync({ type: 'enable', id, config }) as PluginReloadResult,
        disablePlugin: async (id) => await mutation.mutateAsync({ type: 'disable', id }) as PluginReloadResult,
        reloadPlugin: async (id) => await mutation.mutateAsync({ type: 'reload', id }) as PluginReloadResult,
        reloadPlugins: async () => await mutation.mutateAsync({ type: 'reload-all' }) as PluginReloadResult,
        saveConfig: async (id, config) => await mutation.mutateAsync({ type: 'config', id, config }) as PluginReloadResult,
        installLocalPlugin: async (body) => await mutation.mutateAsync({ type: 'install-local', installLocal: body }) as PluginInstallResult,
        deletePlugin: async (id) => await mutation.mutateAsync({ type: 'delete', id }) as PluginDeleteResult,
        isPending: mutation.isPending,
    }
}
