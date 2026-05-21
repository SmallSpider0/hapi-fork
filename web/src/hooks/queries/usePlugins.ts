import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { PluginListItem } from '@hapi/protocol/plugins/admin'
import { queryKeys } from '@/lib/query-keys'

export function usePlugins(api: ApiClient | null): {
    plugins: PluginListItem[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.plugins,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getPlugins()
        },
        enabled: Boolean(api),
    })

    return {
        plugins: query.data?.plugins ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load plugins' : null,
        refetch: query.refetch,
    }
}
