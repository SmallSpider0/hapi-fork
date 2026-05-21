import { Hono, type Context } from 'hono'
import {
    PluginConfigUpdateRequestSchema,
    PluginDisableRequestSchema,
    PluginEnableRequestSchema,
    PluginDetailResponseSchema,
    PluginDiagnosticsResponseSchema,
    PluginInstallExampleRequestSchema,
    PluginInstallLocalRequestSchema,
    PluginInstallResultSchema,
    PluginListResponseSchema,
    PluginReloadResultSchema
} from '@hapi/protocol/plugins/admin'
import { PluginInstallError, PluginStateLockError } from '@hapi/protocol/plugins/foundation'
import type { HubPluginManager } from '../../plugins/pluginManager'
import type { WebAppEnv } from '../middleware/auth'

function errorStatus(error: unknown): 400 | 404 | 409 | 500 {
    if (error instanceof PluginStateLockError) {
        return 409
    }
    if (error instanceof PluginInstallError) {
        return error.code === 'plugin-install-target-exists' ? 409 : 400
    }
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('was not found')) {
        return 404
    }
    if (message.includes('plugins.json') || message.includes('must not store declared secret')) {
        return 409
    }
    return 500
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function requirePluginManager(c: Context<WebAppEnv>, getPluginManager: () => HubPluginManager | null): HubPluginManager | Response {
    const manager = getPluginManager()
    if (!manager) {
        return c.json({ error: 'Plugin manager is not ready' }, 503)
    }
    return manager
}

export function createPluginsRoutes(getPluginManager: () => HubPluginManager | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/plugins', (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        const payload = PluginListResponseSchema.parse({ plugins: manager.listPlugins() })
        return c.json(payload)
    })

    app.get('/plugins/diagnostics', (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        const payload = PluginDiagnosticsResponseSchema.parse({ diagnostics: manager.getDiagnostics() })
        return c.json(payload)
    })

    app.post('/plugins/reload', async (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        const result = await manager.reload()
        return c.json(PluginReloadResultSchema.parse(result))
    })

    app.post('/plugins/install-example', async (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        const json = await c.req.json().catch(() => ({}))
        const parsed = PluginInstallExampleRequestSchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        try {
            const result = await manager.installExamplePlugin(parsed.data)
            return c.json(PluginInstallResultSchema.parse(result))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.post('/plugins/install-local', async (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        const json = await c.req.json().catch(() => null)
        const parsed = PluginInstallLocalRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        try {
            const result = await manager.installLocalPlugin(parsed.data.sourcePath, parsed.data)
            return c.json(PluginInstallResultSchema.parse(result))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.get('/plugins/:id', (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        const plugin = manager.getPlugin(c.req.param('id'))
        if (!plugin) {
            return c.json({ error: 'Plugin not found' }, 404)
        }
        return c.json(PluginDetailResponseSchema.parse({ plugin }))
    })

    app.post('/plugins/:id/reload', async (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        const result = await manager.reload(c.req.param('id'))
        return c.json(PluginReloadResultSchema.parse(result))
    })

    app.post('/plugins/:id/enable', async (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        const json = await c.req.json().catch(() => ({}))
        const parsed = PluginEnableRequestSchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        try {
            const result = await manager.enablePlugin(c.req.param('id'), parsed.data.config, parsed.data.reload !== false)
            return c.json(PluginReloadResultSchema.parse(result))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.post('/plugins/:id/disable', async (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        const json = await c.req.json().catch(() => ({}))
        const parsed = PluginDisableRequestSchema.safeParse(json ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        try {
            const result = await manager.disablePlugin(c.req.param('id'), parsed.data.reload !== false)
            return c.json(PluginReloadResultSchema.parse(result))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    app.patch('/plugins/:id/config', async (c) => {
        const manager = requirePluginManager(c, getPluginManager)
        if (manager instanceof Response) {
            return manager
        }
        const json = await c.req.json().catch(() => null)
        const parsed = PluginConfigUpdateRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }
        try {
            const result = await manager.updatePluginConfig(c.req.param('id'), parsed.data.config)
            return c.json(PluginReloadResultSchema.parse(result))
        } catch (error) {
            return c.json({ error: errorMessage(error) }, errorStatus(error))
        }
    })

    return app
}
