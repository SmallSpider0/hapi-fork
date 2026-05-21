import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { usePlatform } from '@/hooks/usePlatform'
import { useMachinePathsExists } from '@/hooks/useMachinePathsExists'
import { useSpawnSession } from '@/hooks/mutations/useSpawnSession'
import { useCodexModels } from '@/hooks/queries/useCodexModels'
import { useOpencodeModelsForCwd } from '@/hooks/queries/useOpencodeModelsForCwd'
import { useSessions } from '@/hooks/queries/useSessions'
import { useActiveSuggestions, type Suggestion } from '@/hooks/useActiveSuggestions'
import { useDirectorySuggestions } from '@/hooks/useDirectorySuggestions'
import { useRecentPaths } from '@/hooks/useRecentPaths'
import { useTranslation } from '@/lib/use-translation'
import { agentSupportsYolo, type AgentType, type ClaudeEffort, type CodexReasoningEffort, type SessionType } from './types'
import { ActionButtons } from './ActionButtons'
import { AgentSelector } from './AgentSelector'
import { DirectorySection } from './DirectorySection'
import { MachineSelector } from './MachineSelector'
import { ModelSelector } from './ModelSelector'
import { OpencodeModelSelector } from './OpencodeModelSelector'
import { ClaudeEffortSelector } from './ClaudeEffortSelector'
import { shouldEnableOpencodeModelDiscovery } from './opencodeModelsGate'
import { ReasoningEffortSelector } from './ReasoningEffortSelector'
import {
    loadPreferredAgent,
    loadPreferredYoloMode,
    savePreferredAgent,
    savePreferredYoloMode,
} from './preferences'
import { SessionTypeSelector } from './SessionTypeSelector'
import { YoloToggle } from './YoloToggle'
import { formatRunnerSpawnError } from '../../utils/formatRunnerSpawnError'
import { builtinAgentDescriptors } from '@hapi/protocol/plugins'
import type { AgentCapabilityProviderSnapshot } from '@hapi/protocol/plugins'

export function NewSession(props: {
    api: ApiClient
    machines: Machine[]
    isLoading?: boolean
    onSuccess: (sessionId: string) => void
    onCancel: () => void
    onChooseFolder?: (args: { machineId: string | null; directory: string }) => void
    initialDirectory?: string
    initialMachineId?: string
}) {
    const { haptic } = usePlatform()
    const { t } = useTranslation()
    const { spawnSession, isPending, error: spawnError } = useSpawnSession(props.api)
    const { sessions } = useSessions(props.api)
    const isFormDisabled = Boolean(isPending || props.isLoading)
    const { getRecentPaths, addRecentPath, getLastUsedMachineId, setLastUsedMachineId } = useRecentPaths()

    const [machineId, setMachineId] = useState<string | null>(props.initialMachineId ?? null)
    const [directory, setDirectory] = useState(props.initialDirectory ?? '')
    const [suppressSuggestions, setSuppressSuggestions] = useState(false)
    const [isDirectoryFocused, setIsDirectoryFocused] = useState(false)
    const [agent, setAgent] = useState<AgentType>(loadPreferredAgent)
    const [model, setModel] = useState('auto')
    const [effort, setEffort] = useState<ClaudeEffort>('auto')
    const [modelReasoningEffort, setModelReasoningEffort] = useState<CodexReasoningEffort>('default')
    const [yoloMode, setYoloMode] = useState(loadPreferredYoloMode)
    const [sessionType, setSessionType] = useState<SessionType>('simple')
    const [worktreeName, setWorktreeName] = useState('')
    const [directoryCreationConfirmed, setDirectoryCreationConfirmed] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const worktreeInputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (sessionType === 'worktree') {
            worktreeInputRef.current?.focus()
        }
    }, [sessionType])

    useEffect(() => {
        setModel('auto')
        setEffort('auto')
    }, [agent])

    useEffect(() => {
        savePreferredAgent(agent)
    }, [agent])

    useEffect(() => {
        savePreferredYoloMode(yoloMode)
    }, [yoloMode])

    useEffect(() => {
        if (props.machines.length === 0) return
        if (machineId && props.machines.find((m) => m.id === machineId)) return

        const lastUsed = getLastUsedMachineId()
        const foundLast = lastUsed ? props.machines.find((m) => m.id === lastUsed) : null

        if (foundLast) {
            setMachineId(foundLast.id)
            if (!props.initialDirectory) {
                const paths = getRecentPaths(foundLast.id)
                if (paths[0]) setDirectory(paths[0])
            }
        } else if (props.machines[0]) {
            setMachineId(props.machines[0].id)
        }
    }, [props.machines, machineId, getLastUsedMachineId, getRecentPaths, props.initialDirectory])

    const selectedMachine = useMemo(
        () => (machineId ? props.machines.find((machine) => machine.id === machineId) ?? null : null),
        [machineId, props.machines]
    )
    const agentDescriptors = useMemo(() => {
        const descriptors = selectedMachine?.runnerState?.agentDescriptors
        return descriptors && descriptors.length > 0 ? descriptors : builtinAgentDescriptors()
    }, [selectedMachine])
    const selectedAgentDescriptor = useMemo(
        () => agentDescriptors.find((descriptor) => descriptor.id === agent) ?? null,
        [agentDescriptors, agent]
    )
    const selectedAgentCapabilities = useMemo(
        () => (selectedMachine?.runnerState?.agentCapabilities ?? []).filter((snapshot) => snapshot.agentId === agent),
        [agent, selectedMachine]
    )
    const selectedAgentSupportsYolo = agentSupportsYolo(selectedAgentDescriptor)
    useEffect(() => {
        if (agentDescriptors.some((descriptor) => descriptor.id === agent && descriptor.available !== false)) {
            return
        }
        const fallback = agentDescriptors.find((descriptor) => descriptor.available !== false)?.id ?? 'claude'
        setAgent(fallback)
    }, [agent, agentDescriptors])
    const codexModelsState = useCodexModels({
        api: props.api,
        machineId,
        enabled: agent === 'codex' && Boolean(machineId)
    })
    const [opencodeSelectedModel, setOpencodeSelectedModel] = useState<string | null>(null)
    const runnerSpawnError = useMemo(
        () => formatRunnerSpawnError(selectedMachine),
        [selectedMachine]
    )
    const codexModelOptions = useMemo(() => {
        const options = [{ value: 'auto', label: 'Default' }]
        for (const codexModel of codexModelsState.models) {
            options.push({
                value: codexModel.id,
                label: codexModel.displayName
            })
        }
        if (model !== 'auto' && !options.some((option) => option.value === model)) {
            options.splice(1, 0, { value: model, label: model })
        }
        return options
    }, [codexModelsState.models, model])
    const descriptorModelOptions = useMemo(() => {
        const descriptorModels = selectedAgentDescriptor?.capabilities.models ?? []
        if (descriptorModels.length === 0) {
            return undefined
        }
        const options = [
            { value: 'auto', label: 'Default' },
            ...descriptorModels.map((modelId) => ({ value: modelId, label: modelId }))
        ]
        if (model !== 'auto' && !options.some((option) => option.value === model)) {
            options.splice(1, 0, { value: model, label: model })
        }
        return options
    }, [model, selectedAgentDescriptor])
    const providerModelOptions = useMemo(() => {
        const models = selectedAgentCapabilities.flatMap((snapshot) => snapshot.capabilities.models ?? [])
        if (models.length === 0) {
            return undefined
        }
        const options = [{ value: 'auto', label: 'Default' }]
        const seen = new Set(['auto'])
        for (const providerModel of models) {
            if (seen.has(providerModel.id)) continue
            seen.add(providerModel.id)
            options.push({
                value: providerModel.id,
                label: providerModel.displayName ?? providerModel.id
            })
        }
        if (model !== 'auto' && !seen.has(model)) {
            options.splice(1, 0, { value: model, label: model })
        }
        return options
    }, [model, selectedAgentCapabilities])

    const recentPaths = useMemo(
        () => getRecentPaths(machineId),
        [getRecentPaths, machineId]
    )

    const trimmedDirectory = directory.trim()
    const deferredDirectory = useDeferredValue(trimmedDirectory)
    const allPaths = useDirectorySuggestions(machineId, sessions, recentPaths)

    const pathsToCheck = useMemo(
        () => Array.from(new Set([
            ...(deferredDirectory ? [deferredDirectory] : []),
            ...allPaths
        ])).slice(0, 1000),
        [allPaths, deferredDirectory]
    )

    const { pathExistence, checkPathsExists } = useMachinePathsExists(props.api, machineId, pathsToCheck)

    const verifiedPaths = useMemo(
        () => allPaths.filter((path) => pathExistence[path]),
        [allPaths, pathExistence]
    )

    const deferredDirectoryExists = deferredDirectory
        ? pathExistence[deferredDirectory]
        : undefined
    const opencodeModelsState = useOpencodeModelsForCwd({
        api: props.api,
        machineId,
        cwd: deferredDirectory,
        // Gate on positive existence: typing partial paths must not spawn an
        // expensive `opencode acp` probe for a non-existent cwd while the
        // existence check is in flight.
        enabled: shouldEnableOpencodeModelDiscovery({
            agent,
            machineId,
            cwd: deferredDirectory,
            cwdExists: deferredDirectoryExists,
        })
    })
    useEffect(() => {
        // Auto-pick the OpenCode default model when discovery finishes, so the
        // form has a sensible value if the user hits Enter without scrolling.
        if (agent !== 'opencode') return
        if (opencodeSelectedModel !== null) return
        const fallback = opencodeModelsState.currentModelId
            ?? opencodeModelsState.availableModels[0]?.modelId
            ?? null
        if (fallback) {
            setOpencodeSelectedModel(fallback)
        }
    }, [agent, opencodeSelectedModel, opencodeModelsState.currentModelId, opencodeModelsState.availableModels])
    useEffect(() => {
        // Reset selection when agent / machine / directory changes; new probe = new defaults.
        setOpencodeSelectedModel(null)
    }, [agent, machineId, deferredDirectory])

    const currentDirectoryExists = trimmedDirectory ? pathExistence[trimmedDirectory] : undefined
    const needsDirectoryCreationWarning = sessionType === 'simple' && trimmedDirectory !== '' && currentDirectoryExists === false
    const missingWorktreeDirectory = sessionType === 'worktree' && trimmedDirectory !== '' && currentDirectoryExists === false
    const directoryStatusMessage = missingWorktreeDirectory
        ? t('session.directoryMissingWorktree')
        : needsDirectoryCreationWarning
            ? (
                directoryCreationConfirmed
                    ? t('session.directoryMissingSimpleConfirm')
                    : t('session.directoryMissingSimple')
            )
            : null
    const directoryStatusTone = missingWorktreeDirectory ? 'error' : needsDirectoryCreationWarning ? 'warning' : null
    const createLabel = needsDirectoryCreationWarning && directoryCreationConfirmed
        ? t('session.createAndCreateDirectory')
        : undefined

    useEffect(() => {
        setDirectoryCreationConfirmed(false)
    }, [machineId, sessionType, trimmedDirectory])

    const getSuggestions = useCallback(async (query: string): Promise<Suggestion[]> => {
        const lowered = query.toLowerCase()
        return verifiedPaths
            .filter((path) => path.toLowerCase().includes(lowered))
            .slice(0, 8)
            .map((path) => ({
                key: path,
                text: path,
                label: path
            }))
    }, [verifiedPaths])

    const activeQuery = (!isDirectoryFocused || suppressSuggestions) ? null : directory

    const [suggestions, selectedIndex, moveUp, moveDown, clearSuggestions] = useActiveSuggestions(
        activeQuery,
        getSuggestions,
        { allowEmptyQuery: true, autoSelectFirst: false }
    )

    const handleMachineChange = useCallback((newMachineId: string) => {
        setMachineId(newMachineId)
        const paths = getRecentPaths(newMachineId)
        if (paths[0]) {
            setDirectory(paths[0])
        } else {
            setDirectory('')
        }
    }, [getRecentPaths])

    const handlePathClick = useCallback((path: string) => {
        setDirectory(path)
    }, [])

    const handleSuggestionSelect = useCallback((index: number) => {
        const suggestion = suggestions[index]
        if (suggestion) {
            setDirectory(suggestion.text)
            clearSuggestions()
            setSuppressSuggestions(true)
        }
    }, [suggestions, clearSuggestions])

    const handleDirectoryChange = useCallback((value: string) => {
        setSuppressSuggestions(false)
        setDirectory(value)
    }, [])

    const handleDirectoryFocus = useCallback(() => {
        setSuppressSuggestions(false)
        setIsDirectoryFocused(true)
    }, [])

    const handleDirectoryBlur = useCallback(() => {
        setIsDirectoryFocused(false)
    }, [])

    const handleDirectoryKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (suggestions.length === 0) return

        if (event.key === 'ArrowUp') {
            event.preventDefault()
            moveUp()
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault()
            moveDown()
        }

        if (event.key === 'Enter' || event.key === 'Tab') {
            if (selectedIndex >= 0) {
                event.preventDefault()
                handleSuggestionSelect(selectedIndex)
            }
        }

        if (event.key === 'Escape') {
            clearSuggestions()
        }
    }, [suggestions, selectedIndex, moveUp, moveDown, clearSuggestions, handleSuggestionSelect])

    const chooseFolderCallback = props.onChooseFolder
    const workspaceRootsAvailable = Boolean(selectedMachine?.metadata?.workspaceRoots?.length)
    const handleChooseFolder = useMemo(() => {
        if (!chooseFolderCallback || !workspaceRootsAvailable) return undefined
        return () => chooseFolderCallback({ machineId, directory: trimmedDirectory })
    }, [chooseFolderCallback, workspaceRootsAvailable, machineId, trimmedDirectory])

    async function handleCreate() {
        if (!machineId || !trimmedDirectory) return

        setError(null)
        try {
            const existsResult = await checkPathsExists([trimmedDirectory])
            const directoryExists = existsResult[trimmedDirectory]

            if (sessionType === 'worktree' && directoryExists === false) {
                haptic.notification('error')
                setError(t('session.directoryMissingWorktree'))
                return
            }

            if (sessionType === 'simple' && directoryExists === false && !directoryCreationConfirmed) {
                setDirectoryCreationConfirmed(true)
                return
            }

            const resolvedModel = agent === 'opencode'
                ? (opencodeSelectedModel ?? undefined)
                : (model !== 'auto' ? model : undefined)
            const resolvedEffort = agent === 'claude' && effort !== 'auto' ? effort : undefined
            const resolvedModelReasoningEffort = agent === 'codex' && modelReasoningEffort !== 'default'
                ? modelReasoningEffort
                : undefined
            const result = await spawnSession({
                machineId,
                directory: trimmedDirectory,
                agent,
                model: resolvedModel,
                effort: resolvedEffort,
                modelReasoningEffort: resolvedModelReasoningEffort,
                yolo: selectedAgentSupportsYolo ? yoloMode : false,
                sessionType,
                worktreeName: sessionType === 'worktree' ? (worktreeName.trim() || undefined) : undefined
            })

            if (result.type === 'success') {
                haptic.notification('success')
                setLastUsedMachineId(machineId)
                addRecentPath(machineId, trimmedDirectory)
                props.onSuccess(result.sessionId)
                return
            }

            haptic.notification('error')
            setError(result.message)
        } catch (e) {
            haptic.notification('error')
            setError(e instanceof Error ? e.message : 'Failed to create session')
        }
    }

    const canCreate = Boolean(machineId && trimmedDirectory && !isFormDisabled && !missingWorktreeDirectory)

    return (
        <div className="flex flex-col divide-y divide-[var(--app-divider)]">
            <MachineSelector
                machines={props.machines}
                machineId={machineId}
                isLoading={props.isLoading}
                isDisabled={isFormDisabled}
                onChange={handleMachineChange}
            />
            {runnerSpawnError ? (
                <div className="px-3 py-2 text-xs text-red-600">
                    Runner last spawn error: {runnerSpawnError}
                </div>
            ) : null}
            <DirectorySection
                directory={directory}
                suggestions={suggestions}
                selectedIndex={selectedIndex}
                isDisabled={isFormDisabled}
                recentPaths={recentPaths}
                statusMessage={directoryStatusMessage}
                statusTone={directoryStatusTone}
                onDirectoryChange={handleDirectoryChange}
                onDirectoryFocus={handleDirectoryFocus}
                onDirectoryBlur={handleDirectoryBlur}
                onDirectoryKeyDown={handleDirectoryKeyDown}
                onSuggestionSelect={handleSuggestionSelect}
                onPathClick={handlePathClick}
                onChooseFolder={handleChooseFolder}
            />
            <SessionTypeSelector
                sessionType={sessionType}
                worktreeName={worktreeName}
                worktreeInputRef={worktreeInputRef}
                isDisabled={isFormDisabled}
                onSessionTypeChange={setSessionType}
                onWorktreeNameChange={setWorktreeName}
            />
            <AgentSelector
                agent={agent}
                agents={agentDescriptors}
                isDisabled={isFormDisabled}
                onAgentChange={setAgent}
            />
            <AgentCapabilitiesSummary
                api={props.api}
                machineId={machineId}
                agentId={agent}
                snapshots={selectedAgentCapabilities}
            />
            {agent === 'opencode' ? (
                <OpencodeModelSelector
                    cwd={deferredDirectory}
                    machineId={machineId}
                    isLoading={opencodeModelsState.isLoading}
                    error={opencodeModelsState.error}
                    availableModels={opencodeModelsState.availableModels}
                    currentModelId={opencodeModelsState.currentModelId}
                    selectedModel={opencodeSelectedModel}
                    onModelChange={setOpencodeSelectedModel}
                    onRetry={opencodeModelsState.refetch}
                />
            ) : (
                <ModelSelector
                    agent={agent}
                    model={model}
                    options={agent === 'codex' ? codexModelOptions : providerModelOptions ?? descriptorModelOptions}
                    isDisabled={isFormDisabled || (agent === 'codex' && Boolean(codexModelsState.error))}
                    isLoading={agent === 'codex' && codexModelsState.isLoading}
                    error={agent === 'codex' && codexModelsState.error
                        ? `${t('newSession.model.loadFailed')}: ${codexModelsState.error}`
                        : null}
                    onModelChange={setModel}
                />
            )}
            <ClaudeEffortSelector
                agent={agent}
                effort={effort}
                isDisabled={isFormDisabled}
                onEffortChange={setEffort}
            />
            <ReasoningEffortSelector
                agent={agent}
                value={modelReasoningEffort}
                isDisabled={isFormDisabled}
                onChange={setModelReasoningEffort}
            />
            <YoloToggle
                yoloMode={yoloMode}
                isDisabled={isFormDisabled || !selectedAgentSupportsYolo}
                onToggle={setYoloMode}
            />

            {(error ?? spawnError) ? (
                <div className="px-3 py-2 text-sm text-red-600">
                    {error ?? spawnError}
                </div>
            ) : null}

            <ActionButtons
                isPending={isPending}
                canCreate={canCreate}
                isDisabled={isFormDisabled}
                createLabel={createLabel}
                onCancel={props.onCancel}
                onCreate={handleCreate}
            />
        </div>
    )
}

function AgentCapabilitiesSummary(props: {
    api: ApiClient
    machineId: string | null
    agentId: string
    snapshots: AgentCapabilityProviderSnapshot[]
}) {
    const [importResult, setImportResult] = useState<{
        nativeSessionId: string
        message: string
        error?: boolean
    } | null>(null)
    const models = props.snapshots.flatMap((snapshot) => snapshot.capabilities.models ?? [])
    const permissionModes = props.snapshots.flatMap((snapshot) => snapshot.capabilities.permissionModes ?? [])
    const profiles = props.snapshots.flatMap((snapshot) => snapshot.capabilities.profiles ?? [])
    const sessions = props.snapshots.flatMap((snapshot) => snapshot.capabilities.sessions ?? [])
    const usage = props.snapshots.flatMap((snapshot) => snapshot.capabilities.usage ?? [])
    const skills = props.snapshots.flatMap((snapshot) => snapshot.capabilities.skills ?? [])
    const slashCommands = props.snapshots.flatMap((snapshot) => snapshot.capabilities.slashCommands ?? [])
    const diagnostics = props.snapshots.flatMap((snapshot) => snapshot.diagnostics)
    const [pendingImportId, setPendingImportId] = useState<string | null>(null)

    const handleImportHistory = async (snapshot: AgentCapabilityProviderSnapshot, nativeSessionId: string) => {
        if (!props.machineId) {
            return
        }
        setPendingImportId(nativeSessionId)
        setImportResult(null)
        try {
            const result = await props.api.importAgentHistory(
                props.machineId,
                props.agentId,
                nativeSessionId,
                snapshot.contributionId
            )
            setImportResult({
                nativeSessionId,
                message: `Imported ${result.messages.length} messages for preview.`
            })
        } catch (error) {
            setImportResult({
                nativeSessionId,
                message: error instanceof Error ? error.message : 'Failed to import native history',
                error: true
            })
        } finally {
            setPendingImportId(null)
        }
    }

    const hasContent = models.length > 0
        || permissionModes.length > 0
        || profiles.length > 0
        || sessions.length > 0
        || usage.length > 0
        || skills.length > 0
        || slashCommands.length > 0
        || diagnostics.length > 0
    if (!hasContent) {
        return null
    }

    const uniqueLabels = (values: string[]) => Array.from(new Set(values)).slice(0, 6)
    const usageLabels = usage.slice(0, 3).map((entry) => {
        const parts = [
            entry.totalTokens !== undefined ? `${entry.totalTokens} tokens` : null,
            entry.costUsd !== undefined ? `$${entry.costUsd.toFixed(4)}` : null,
            entry.limitLabel ?? null
        ].filter(Boolean)
        return parts.join(' · ') || entry.scope
    })

    return (
        <div className="flex flex-col gap-2 px-3 py-3 text-xs text-[var(--app-hint)]">
            <div className="font-medium text-[var(--app-text)]">Agent capabilities</div>
            <div className="flex flex-wrap gap-1.5">
                {uniqueLabels(models.map((entry) => entry.displayName ?? entry.id)).map((label) => (
                    <span key={`model-${label}`} className="rounded-full bg-[var(--app-secondary-bg)] px-2 py-1">Model: {label}</span>
                ))}
                {uniqueLabels(permissionModes.map((entry) => entry.label ?? entry.mode)).map((label) => (
                    <span key={`permission-${label}`} className="rounded-full bg-[var(--app-secondary-bg)] px-2 py-1">Permission: {label}</span>
                ))}
                {uniqueLabels(profiles.map((entry) => entry.displayName)).map((label) => (
                    <span key={`profile-${label}`} className="rounded-full bg-[var(--app-secondary-bg)] px-2 py-1">Profile: {label}</span>
                ))}
                {uniqueLabels(skills.map((entry) => entry.name)).map((label) => (
                    <span key={`skill-${label}`} className="rounded-full bg-[var(--app-secondary-bg)] px-2 py-1">Skill: {label}</span>
                ))}
                {uniqueLabels(slashCommands.map((entry) => entry.name)).map((label) => (
                    <span key={`slash-${label}`} className="rounded-full bg-[var(--app-secondary-bg)] px-2 py-1">/{label}</span>
                ))}
            </div>
            {sessions.length > 0 ? (
                <div className="space-y-1">
                    <div className="font-medium text-[var(--app-text)]">Native history</div>
                    {props.snapshots.flatMap((snapshot) =>
                        (snapshot.capabilities.sessions ?? []).slice(0, 3).map((session) => (
                            <div key={`${snapshot.contributionId}-${session.id}`} className="flex items-center justify-between gap-2 rounded-lg bg-[var(--app-secondary-bg)] px-2 py-1">
                                <span className="min-w-0 truncate">
                                    {session.title ?? session.id}{session.cwd ? ` · ${session.cwd}` : ''}
                                </span>
                                {session.importable !== false ? (
                                    <button
                                        type="button"
                                        className="shrink-0 text-[var(--app-link)] disabled:opacity-50"
                                        disabled={!props.machineId || pendingImportId === session.id}
                                        onClick={() => { void handleImportHistory(snapshot, session.id) }}
                                    >
                                        {pendingImportId === session.id ? 'Importing…' : 'Import'}
                                    </button>
                                ) : null}
                            </div>
                        ))
                    )}
                    {importResult ? (
                        <div className={`rounded-lg px-2 py-1 ${importResult.error ? 'bg-red-50 text-red-600' : 'bg-[var(--app-secondary-bg)] text-[var(--app-text)]'}`}>
                            {importResult.message}
                        </div>
                    ) : null}
                </div>
            ) : null}
            {usageLabels.length > 0 ? (
                <div className="space-y-1">
                    <div className="font-medium text-[var(--app-text)]">Usage</div>
                    {usageLabels.map((label, index) => (
                        <div key={`${label}-${index}`} className="truncate rounded-lg bg-[var(--app-secondary-bg)] px-2 py-1">{label}</div>
                    ))}
                </div>
            ) : null}
            {diagnostics.length > 0 ? (
                <div className="space-y-1">
                    {diagnostics.slice(0, 3).map((diagnostic, index) => (
                        <div key={`${diagnostic.code}-${index}`} className="rounded-lg bg-[var(--app-secondary-bg)] px-2 py-1 text-amber-600">
                            {diagnostic.code}: {diagnostic.message}
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    )
}
