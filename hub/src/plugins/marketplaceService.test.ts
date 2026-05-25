import { describe, expect, it } from 'bun:test'
import { PluginMarketplaceService, type MarketplaceFetch } from './marketplaceService'

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
})
