import { configuration } from '@/configuration'
import { buildHubRequestHeaders } from './hubExtraHeaders'
import type { PluginListResponse, PluginReloadResult } from '@hapi/protocol/plugins/admin'

async function readError(response: Response): Promise<string> {
    const body = await response.text().catch(() => '')
    return body || `${response.status} ${response.statusText}`
}

function buildUrl(path: string): string {
    return new URL(path, configuration.apiUrl).toString()
}

async function fetchJson<T>(path: string, init: RequestInit, timeoutMs = 5000): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const response = await fetch(buildUrl(path), {
            ...init,
            signal: controller.signal
        })
        if (!response.ok) {
            throw new Error(await readError(response))
        }
        return await response.json() as T
    } finally {
        clearTimeout(timer)
    }
}

export async function getPluginAdminJwt(accessToken: string, timeoutMs = 5000): Promise<string> {
    const response = await fetchJson<{ token: string }>('/api/auth', {
        method: 'POST',
        headers: buildHubRequestHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ accessToken })
    }, timeoutMs)
    return response.token
}

export async function getRemotePlugins(accessToken: string, timeoutMs = 5000): Promise<PluginListResponse> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    return await fetchJson<PluginListResponse>('/api/plugins', {
        method: 'GET',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}` })
    }, timeoutMs)
}

export async function reloadRemotePlugins(accessToken: string, pluginId?: string, timeoutMs = 5000): Promise<PluginReloadResult> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    const path = pluginId ? `/api/plugins/${encodeURIComponent(pluginId)}/reload` : '/api/plugins/reload'
    return await fetchJson<PluginReloadResult>(path, {
        method: 'POST',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}` })
    }, timeoutMs)
}
