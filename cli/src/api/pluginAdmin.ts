import { configuration } from '@/configuration'
import { buildHubRequestHeaders } from './hubExtraHeaders'
import type {
    PluginConfigUpdateRequest,
    PluginDetailResponse,
    PluginInstallLocalRequest,
    PluginInstallPackageRequest,
    PluginInstallResult,
    PluginListResponse,
    PluginReloadResult,
    PluginTargetScope
} from '@hapi/protocol/plugins/admin'

async function readError(response: Response): Promise<string> {
    const body = await response.text().catch(() => '')
    return body || `${response.status} ${response.statusText}`
}

function withTargetQuery(path: string, target?: PluginTargetScope): string {
    if (!target) return path
    const separator = path.includes('?') ? '&' : '?'
    return `${path}${separator}target=${encodeURIComponent(target)}`
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

export async function getRemotePlugins(accessToken: string, timeoutMs = 5000, target?: PluginTargetScope): Promise<PluginListResponse> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    return await fetchJson<PluginListResponse>(withTargetQuery('/api/plugins', target), {
        method: 'GET',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}` })
    }, timeoutMs)
}

export async function getRemotePlugin(accessToken: string, pluginId: string, timeoutMs = 5000, target?: PluginTargetScope): Promise<PluginDetailResponse> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    return await fetchJson<PluginDetailResponse>(withTargetQuery(`/api/plugins/${encodeURIComponent(pluginId)}`, target), {
        method: 'GET',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}` })
    }, timeoutMs)
}

export async function updateRemotePluginConfig(accessToken: string, pluginId: string, body: PluginConfigUpdateRequest, timeoutMs = 5000, target?: PluginTargetScope): Promise<PluginReloadResult> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    return await fetchJson<PluginReloadResult>(withTargetQuery(`/api/plugins/${encodeURIComponent(pluginId)}/config`, target), {
        method: 'PATCH',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }),
        body: JSON.stringify(body)
    }, timeoutMs)
}

export async function installRemoteLocalPlugin(accessToken: string, body: PluginInstallLocalRequest, timeoutMs = 5000, target?: PluginTargetScope): Promise<PluginInstallResult> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    return await fetchJson<PluginInstallResult>(withTargetQuery('/api/plugins/install-local', target), {
        method: 'POST',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }),
        body: JSON.stringify(body)
    }, timeoutMs)
}

export async function installRemotePackagePlugin(accessToken: string, body: PluginInstallPackageRequest, timeoutMs = 120000, target?: PluginTargetScope): Promise<PluginInstallResult> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    return await fetchJson<PluginInstallResult>(withTargetQuery('/api/plugins/install-package', target), {
        method: 'POST',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }),
        body: JSON.stringify(body)
    }, timeoutMs)
}

export async function reloadRemotePlugins(accessToken: string, pluginId?: string, timeoutMs = 5000, target?: PluginTargetScope): Promise<PluginReloadResult> {
    const jwt = await getPluginAdminJwt(accessToken, timeoutMs)
    const path = pluginId ? `/api/plugins/${encodeURIComponent(pluginId)}/reload` : '/api/plugins/reload'
    return await fetchJson<PluginReloadResult>(withTargetQuery(path, target), {
        method: 'POST',
        headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}` })
    }, timeoutMs)
}
