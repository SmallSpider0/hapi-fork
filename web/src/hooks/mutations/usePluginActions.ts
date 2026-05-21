import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { PluginDeleteResult, PluginInstallLocalRequest, PluginInstallResult, PluginReloadResult, PluginTargetScope } from '@hapi/protocol/plugins/admin'
import { queryKeys } from '@/lib/query-keys'

type PluginActionMutationResult = PluginReloadResult | PluginInstallResult | PluginDeleteResult

type PluginAction = {
    type: 'enable' | 'disable' | 'reload' | 'reload-all' | 'config' | 'install-local' | 'delete'
    id?: string
    target?: PluginTargetScope
    config?: Record<string, unknown>
    installLocal?: PluginInstallLocalRequest
}

export function usePluginActions(api: ApiClient | null): {
    enablePlugin: (id: string, config?: Record<string, unknown>, target?: PluginTargetScope) => Promise<PluginReloadResult>
    disablePlugin: (id: string, target?: PluginTargetScope) => Promise<PluginReloadResult>
    reloadPlugin: (id: string, target?: PluginTargetScope) => Promise<PluginReloadResult>
    reloadPlugins: (target?: PluginTargetScope) => Promise<PluginReloadResult>
    saveConfig: (id: string, config: Record<string, unknown>, target?: PluginTargetScope) => Promise<PluginReloadResult>
    installLocalPlugin: (body: PluginInstallLocalRequest) => Promise<PluginInstallResult>
    deletePlugin: (id: string, target?: PluginTargetScope) => Promise<PluginDeleteResult>
    isPending: boolean
} {
    const queryClient = useQueryClient()
    const invalidate = async (id?: string, target?: PluginTargetScope) => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.plugins() })
        if (target) {
            await queryClient.invalidateQueries({ queryKey: queryKeys.plugins(target) })
        }
        await queryClient.invalidateQueries({ queryKey: queryKeys.pluginDiagnostics })
        if (id) {
            await queryClient.invalidateQueries({ queryKey: queryKeys.plugin(id, target) })
        }
    }
    const mutation = useMutation<PluginActionMutationResult, Error, PluginAction>({
        mutationFn: async (action) => {
            if (!api) throw new Error('API unavailable')
            if (action.type === 'enable' && action.id) return await api.enablePlugin(action.id, action.config, action.target)
            if (action.type === 'disable' && action.id) return await api.disablePlugin(action.id, action.target)
            if (action.type === 'reload' && action.id) return await api.reloadPlugin(action.id, action.target)
            if (action.type === 'config' && action.id && action.config) return await api.updatePluginConfig(action.id, action.config, action.target)
            if (action.type === 'install-local' && action.installLocal) return await api.installLocalPlugin(action.installLocal)
            if (action.type === 'delete' && action.id) return await api.deletePlugin(action.id, action.target)
            return await api.reloadPlugins(action.target)
        },
        onSuccess: (result, action) => {
            const installedId = 'pluginId' in result ? result.pluginId : undefined
            void invalidate(action.id ?? installedId, action.target)
        },
    })

    return {
        enablePlugin: async (id, config, target) => await mutation.mutateAsync({ type: 'enable', id, config, target }) as PluginReloadResult,
        disablePlugin: async (id, target) => await mutation.mutateAsync({ type: 'disable', id, target }) as PluginReloadResult,
        reloadPlugin: async (id, target) => await mutation.mutateAsync({ type: 'reload', id, target }) as PluginReloadResult,
        reloadPlugins: async (target) => await mutation.mutateAsync({ type: 'reload-all', target }) as PluginReloadResult,
        saveConfig: async (id, config, target) => await mutation.mutateAsync({ type: 'config', id, config, target }) as PluginReloadResult,
        installLocalPlugin: async (body) => await mutation.mutateAsync({ type: 'install-local', installLocal: body }) as PluginInstallResult,
        deletePlugin: async (id, target) => await mutation.mutateAsync({ type: 'delete', id, target }) as PluginDeleteResult,
        isPending: mutation.isPending,
    }
}
