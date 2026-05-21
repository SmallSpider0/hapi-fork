import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ioMock = vi.hoisted(() => vi.fn())
const listOpencodeModelsForCwdMock = vi.hoisted(() => vi.fn())

vi.mock('socket.io-client', () => ({
    io: ioMock
}))

vi.mock('@/api/auth', () => ({
    getAuthToken: () => 'cli-token'
}))

vi.mock('../modules/common/opencodeModels', () => ({
    listOpencodeModelsForCwd: listOpencodeModelsForCwdMock
}))

import { ApiMachineClient } from './apiMachine'
import type { Machine } from './types'

function makeMachine(id: string): Machine {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        runnerState: null,
        runnerStateVersion: 0
    }
}

async function callListOpencodeModels(client: ApiMachineClient, machineId: string, cwd: string): Promise<unknown> {
    // Reach into the private rpc handler manager to dispatch a request.
    // Mirrors how the on-socket 'rpc-request' listener invokes handleRequest.
    const manager = (client as unknown as { rpcHandlerManager: { handleRequest: (req: { method: string; params: string }) => Promise<string> } }).rpcHandlerManager
    const raw = await manager.handleRequest({
        method: `${machineId}:listOpencodeModelsForCwd`,
        params: JSON.stringify({ cwd })
    })
    return JSON.parse(raw) as unknown
}

describe('ApiMachineClient listOpencodeModelsForCwd handler', () => {
    let workspaceRoot: string

    beforeEach(() => {
        ioMock.mockReset()
        listOpencodeModelsForCwdMock.mockReset()
        workspaceRoot = mkdtempSync(join(tmpdir(), 'hapi-machine-ws-'))
    })

    afterEach(() => {
        rmSync(workspaceRoot, { recursive: true, force: true })
    })

    it('rejects cwd outside the workspace root with the standard error shape', async () => {
        const machine = makeMachine('machine-1')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])

        const outsideCwd = mkdtempSync(join(tmpdir(), 'hapi-outside-'))
        try {
            const result = await callListOpencodeModels(client, machine.id, outsideCwd)
            expect(result).toEqual({ success: false, error: 'Path is outside workspace roots' })
            expect(listOpencodeModelsForCwdMock).not.toHaveBeenCalled()
        } finally {
            rmSync(outsideCwd, { recursive: true, force: true })
            client.shutdown()
        }
    })

    it('rejects empty cwd with cwd-required error', async () => {
        const machine = makeMachine('machine-2')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])

        try {
            const result = await callListOpencodeModels(client, machine.id, '')
            expect(result).toEqual({ success: false, error: 'cwd is required' })
            expect(listOpencodeModelsForCwdMock).not.toHaveBeenCalled()
        } finally {
            client.shutdown()
        }
    })

    it('forwards a workspace-internal cwd to listOpencodeModelsForCwd', async () => {
        const machine = makeMachine('machine-3')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])

        const innerDir = join(workspaceRoot, 'inner-project')
        mkdirSync(innerDir)

        listOpencodeModelsForCwdMock.mockResolvedValueOnce({
            success: true,
            availableModels: [{ modelId: 'a/b' }],
            currentModelId: 'a/b'
        })

        try {
            const result = await callListOpencodeModels(client, machine.id, innerDir)
            expect(result).toEqual({
                success: true,
                availableModels: [{ modelId: 'a/b' }],
                currentModelId: 'a/b'
            })
            expect(listOpencodeModelsForCwdMock).toHaveBeenCalledTimes(1)
            // The handler should pass the resolved (realpath'd) cwd to the lower layer.
            expect(listOpencodeModelsForCwdMock).toHaveBeenCalledWith(expect.stringContaining('inner-project'))
        } finally {
            client.shutdown()
        }
    })

    it('accepts cwd inside any configured workspace root', async () => {
        const machine = makeMachine('machine-4')
        const secondWorkspaceRoot = mkdtempSync(join(tmpdir(), 'hapi-machine-ws-2-'))
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot, secondWorkspaceRoot])

        listOpencodeModelsForCwdMock.mockResolvedValueOnce({
            success: true,
            availableModels: [{ modelId: 'x/y' }],
            currentModelId: 'x/y'
        })

        try {
            const result = await callListOpencodeModels(client, machine.id, secondWorkspaceRoot)
            expect(result).toEqual({
                success: true,
                availableModels: [{ modelId: 'x/y' }],
                currentModelId: 'x/y'
            })
            expect(listOpencodeModelsForCwdMock).toHaveBeenCalledWith(secondWorkspaceRoot)
        } finally {
            rmSync(secondWorkspaceRoot, { recursive: true, force: true })
            client.shutdown()
        }
    })
})

async function callMachineRpc(client: ApiMachineClient, machineId: string, method: string, params: unknown): Promise<unknown> {
    const manager = (client as unknown as { rpcHandlerManager: { handleRequest: (req: { method: string; params: string }) => Promise<string> } }).rpcHandlerManager
    const raw = await manager.handleRequest({
        method: `${machineId}:${method}`,
        params: JSON.stringify(params)
    })
    return JSON.parse(raw) as unknown
}

describe('ApiMachineClient runner plugin RPC handlers', () => {
    it('registers machine-scoped runner plugin handlers and validates request schema', async () => {
        const machine = makeMachine('machine-plugins')
        const client = new ApiMachineClient('cli-token', machine)
        vi.spyOn(client, 'updateRunnerState').mockResolvedValue(undefined)
        const calls: string[] = []
        client.registerRunnerPluginHandlers({
            getInventory: () => ({ machineId: machine.id, updatedAt: 1, plugins: [], diagnostics: [] }),
            getPlugin: () => null,
            enablePlugin: async () => { calls.push('enable'); return { ok: true, results: [], plugins: [] } },
            disablePlugin: async () => { calls.push('disable'); return { ok: true, results: [], plugins: [] } },
            updatePluginConfig: async () => { calls.push('config'); return { ok: true, results: [], plugins: [] } },
            reload: async () => { calls.push('reload'); return { ok: true, results: [], plugins: [] } },
            deletePlugin: async () => { calls.push('delete'); return { ok: true, pluginId: 'x', rootPath: '/tmp/x', deleted: true, plugins: [] } },
            installPrepareUnsupported: () => ({ ok: false, code: 'unsupported-runtime', message: 'unsupported' }),
            installCommitUnsupported: () => ({ ok: false, code: 'unsupported-runtime', message: 'unsupported' })
        } as never)

        try {
            expect(await callMachineRpc(client, machine.id, 'runner.plugins.list', {})).toEqual({ machineId: machine.id, updatedAt: 1, plugins: [], diagnostics: [] })
            expect(await callMachineRpc(client, machine.id, 'runner.plugins.enable', { pluginId: 'com.example.runner' })).toMatchObject({ ok: true })
            expect(await callMachineRpc(client, machine.id, 'runner.plugins.enable', { pluginId: '' })).toEqual({ error: expect.stringContaining('Too small') })
            expect(calls).toEqual(['enable'])
        } finally {
            client.shutdown()
        }
    })
})
