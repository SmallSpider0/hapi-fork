import { describe, expect, it } from 'vitest'
import { reduceChatBlocks } from './reducer'
import type { NormalizedMessage } from './types'

describe('reduceChatBlocks', () => {
    it('ignores child agent usage when calculating parent latest usage', () => {
        const messages: NormalizedMessage[] = [
            {
                id: 'parent-usage',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'event',
                content: { type: 'token-count', info: {} },
                isSidechain: false,
                usage: {
                    input_tokens: 100,
                    output_tokens: 10,
                    context_tokens: 100,
                    scope_role: 'parent'
                }
            },
            {
                id: 'child-usage',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'event',
                content: { type: 'token-count', info: {} },
                isSidechain: false,
                usage: {
                    input_tokens: 999,
                    output_tokens: 1,
                    context_tokens: 999,
                    scope_role: 'child'
                }
            }
        ] as NormalizedMessage[]

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.latestUsage).toMatchObject({
            inputTokens: 100,
            outputTokens: 10,
            contextSize: 100
        })
    })

    it('uses goal events for latest goal state without rendering timeline prompts', () => {
        const messages: NormalizedMessage[] = [
            {
                id: 'goal-update',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'event',
                content: {
                    type: 'thread-goal-updated',
                    threadId: 'thread-1',
                    goal: {
                        threadId: 'thread-1',
                        objective: 'ship goal support',
                        status: 'active',
                        tokenBudget: null,
                        tokensUsed: 0,
                        timeUsedSeconds: 0,
                        createdAt: 1,
                        updatedAt: 2
                    }
                },
                isSidechain: false
            }
        ] as NormalizedMessage[]

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.blocks).toHaveLength(0)
        expect(reduced.latestGoal).toMatchObject({
            threadId: 'thread-1',
            objective: 'ship goal support',
            status: 'active'
        })
    })

    it('uses goal clear events to clear latest goal without rendering timeline prompts', () => {
        const messages: NormalizedMessage[] = [
            {
                id: 'goal-update',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'event',
                content: {
                    type: 'thread-goal-updated',
                    threadId: 'thread-1',
                    goal: {
                        threadId: 'thread-1',
                        objective: 'ship goal support',
                        status: 'active',
                        tokenBudget: null,
                        tokensUsed: 0,
                        timeUsedSeconds: 0,
                        createdAt: 1,
                        updatedAt: 2
                    }
                },
                isSidechain: false
            },
            {
                id: 'goal-clear',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'event',
                content: {
                    type: 'thread-goal-cleared',
                    threadId: 'thread-1'
                },
                isSidechain: false
            }
        ] as NormalizedMessage[]

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.blocks).toHaveLength(0)
        expect(reduced.latestGoal).toBeNull()
    })

    it('hides historical goal success status messages but keeps actionable goal messages', () => {
        const messages: NormalizedMessage[] = [
            {
                id: 'goal-active-message',
                localId: null,
                createdAt: 1_700_000_000_000,
                role: 'event',
                content: { type: 'message', message: 'Goal active' },
                isSidechain: false
            },
            {
                id: 'goal-complete-message',
                localId: null,
                createdAt: 1_700_000_001_000,
                role: 'event',
                content: { type: 'message', message: 'Goal complete' },
                isSidechain: false
            },
            {
                id: 'goal-cleared-message',
                localId: null,
                createdAt: 1_700_000_002_000,
                role: 'event',
                content: { type: 'message', message: 'Goal cleared' },
                isSidechain: false
            },
            {
                id: 'goal-actionable-message',
                localId: null,
                createdAt: 1_700_000_003_000,
                role: 'event',
                content: { type: 'message', message: 'No goal to clear' },
                isSidechain: false
            }
        ] as NormalizedMessage[]

        const reduced = reduceChatBlocks(messages, null)

        expect(reduced.blocks).toHaveLength(1)
        expect(reduced.blocks[0]).toMatchObject({
            kind: 'agent-event',
            event: { type: 'message', message: 'No goal to clear' }
        })
    })
})
