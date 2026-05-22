import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type React from 'react'
import { PluginDescriptorPanels } from './DescriptorRenderer'
import { PluginWebContributionsSchema } from '@hapi/protocol/plugins'
import { I18nProvider } from '@/lib/i18n-context'

function renderPanels(props: React.ComponentProps<typeof PluginDescriptorPanels>) {
    return render(
        <I18nProvider>
            <PluginDescriptorPanels {...props} />
        </I18nProvider>
    )
}

describe('PluginDescriptorPanels', () => {
    it('renders supported descriptor components and dispatches allowlisted actions', async () => {
        const onAction = vi.fn()
        renderPanels({
            contributions: {
                settingsPanels: [{
                    id: 'status',
                    title: 'Status',
                    components: [
                        { kind: 'text', text: 'Ready' },
                        { kind: 'badge', label: 'Active', variant: 'success' },
                        { kind: 'actionButton', id: 'reload', label: 'Reload', actionId: 'plugin.reload' }
                    ]
                }]
            },
            onAction
        })

        expect(screen.getByText('Ready')).toBeInTheDocument()
        expect(screen.getByText('Active')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
        await waitFor(() => expect(onAction).toHaveBeenCalledWith('plugin.reload'))
    })

    it('rejects unknown component kinds locally without hiding valid sibling components', () => {
        renderPanels({
            contributions: {
                settingsPanels: [{
                    id: 'bad',
                    title: 'Bad',
                    components: [
                        { kind: 'text', text: 'Still visible' },
                        { kind: 'iframe', src: 'javascript:alert(1)' }
                    ]
                }]
            }
        })

        expect(screen.getByText('Still visible')).toBeInTheDocument()
        expect(screen.getByText('Plugin descriptor component failed validation.')).toBeInTheDocument()
    })

    it('rejects arbitrary action URLs or JavaScript handlers in protocol schema', () => {
        const parsed = PluginWebContributionsSchema.safeParse({
            settingsPanels: [{
                id: 'bad-action',
                title: 'Bad action',
                components: [{
                    kind: 'actionButton',
                    label: 'Open',
                    actionId: 'https://evil.example/run',
                    url: 'javascript:alert(1)'
                }]
            }]
        })

        expect(parsed.success).toBe(false)
    })

    it('does not render secret values from config in schema forms', () => {
        renderPanels({
            contributions: {
                settingsPanels: [{
                    id: 'config',
                    title: 'Config',
                    components: [{
                        kind: 'schemaForm',
                        id: 'form',
                        fields: [
                            { key: 'apiToken', label: 'API token', type: 'text', secret: true },
                            { key: 'label', label: 'Label', type: 'text' }
                        ]
                    }]
                }]
            },
            config: { apiToken: 'secret-value', label: 'Visible value' }
        })

        expect(screen.queryByDisplayValue('secret-value')).not.toBeInTheDocument()
        expect(screen.getByDisplayValue('Visible value')).toBeInTheDocument()
    })
})
