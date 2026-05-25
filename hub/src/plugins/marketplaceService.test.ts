import { describe, expect, it } from 'bun:test'
import { PluginMarketplaceService, type MarketplaceFetch } from './marketplaceService'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { embeddedPluginMarketplaceCatalog } from '@hapi/protocol/plugins/marketplaceSources.generated'

function catalogResponse(): Awaited<ReturnType<MarketplaceFetch>> {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() {
            return JSON.stringify({
                schemaVersion: 'hapi-plugin-marketplace/v1',
                updatedAt: '2026-05-24T00:00:00.000Z',
                plugins: []
            })
        },
        async arrayBuffer() {
            return new ArrayBuffer(0)
        }
    }
}

describe('PluginMarketplaceService', () => {
    it('cache-busts forced catalog refreshes without changing the public source URL', async () => {
        const calls: string[] = []
        let now = 1000
        const service = new PluginMarketplaceService({
            sourceUrl: 'https://example.com/catalog.v1.json?branch=main',
            now: () => now,
            fetch: async (url) => {
                calls.push(url)
                return catalogResponse()
            }
        })

        const first = await service.getCatalog()
        const cached = await service.getCatalog()
        now = 2000
        const refreshed = await service.getCatalog({ force: true })

        expect(cached).toBe(first)
        expect(refreshed.sourceUrl).toBe('https://example.com/catalog.v1.json?branch=main')
        expect(calls).toEqual([
            'https://example.com/catalog.v1.json?branch=main',
            'https://example.com/catalog.v1.json?branch=main&_hapiCacheBust=2000'
        ])
    })

    it('builds install-plan package requests from embedded HAPI source plugins', async () => {
        const service = new PluginMarketplaceService({ now: () => 3000 })

        const snapshot = await service.getCatalog()
        const entry = snapshot.catalog.plugins.find((plugin) => plugin.id === 'com.hapi.schedule-send')
        expect(snapshot.sourceUrl).toBe('embedded://hapi-marketplace/catalog.v1.json')
        expect(entry?.releases[0]?.source?.path).toBe('plugins/com.hapi.schedule-send')

        const result = await service.buildInstallPlanRequest('com.hapi.schedule-send', { enable: true })

        expect(result.marketplace).toMatchObject({
            distribution: 'hapi-source',
            sourcePath: 'plugins/com.hapi.schedule-send',
            pluginId: 'com.hapi.schedule-send',
            version: '0.1.1'
        })
        expect(result.request).toMatchObject({
            filename: 'com.hapi.schedule-send-0.1.1.hapi-source.tgz',
            format: 'tgz',
            enable: true,
            installSource: {
                type: 'marketplace',
                distribution: 'hapi-source',
                sourcePath: 'plugins/com.hapi.schedule-send'
            }
        })
        expect(result.request.contentBase64.length).toBeGreaterThan(0)
        expect(result.request.checksum).toMatch(/^sha256:[a-f0-9]{64}$/)
    })

    it('rejects source catalog entries whose embedded source checksum does not match', async () => {
        const testDir = mkdtempSync(join(tmpdir(), 'hapi-marketplace-source-test-'))
        const catalog = structuredClone(embeddedPluginMarketplaceCatalog)
        const entry = catalog.plugins.find((plugin) => plugin.id === 'com.hapi.schedule-send')!
        entry.releases[0]!.source!.treeChecksum = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
        const catalogPath = join(testDir, 'catalog.v1.json')
        writeFileSync(catalogPath, JSON.stringify(catalog, null, 2))

        const service = new PluginMarketplaceService({
            sourceUrl: catalogPath,
            sourceRoot: join(testDir, 'missing-checkout')
        })

        await expect(service.buildInstallPlanRequest('com.hapi.schedule-send')).rejects.toThrow('source checksum mismatch')
    })
})
