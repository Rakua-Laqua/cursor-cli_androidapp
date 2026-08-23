package dev.cursorremote.android.state

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.cursorremote.android.data.local.HiddenModelDao
import dev.cursorremote.android.data.local.HiddenModelEntity
import dev.cursorremote.android.data.local.MachineDao
import dev.cursorremote.android.data.local.MachineEntity
import dev.cursorremote.android.data.protocol.ChatEvent
import dev.cursorremote.android.data.protocol.DiffSnapshot
import dev.cursorremote.android.data.protocol.FileContent
import dev.cursorremote.android.data.protocol.ModelCatalog
import dev.cursorremote.android.data.protocol.ModelCatalogEntry
import dev.cursorremote.android.data.protocol.ProtocolParseError
import dev.cursorremote.android.data.protocol.RemoteEvent
import dev.cursorremote.android.data.protocol.RemoteProtocol
import dev.cursorremote.android.data.protocol.SessionContextUsage
import dev.cursorremote.android.data.protocol.SessionInfo
import dev.cursorremote.android.data.protocol.WorkspaceInfo
import dev.cursorremote.android.data.remote.RemoteConnectionState
import dev.cursorremote.android.data.remote.RemoteRepository
import dev.cursorremote.android.data.transport.ConnectionState
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class ChatRole {
    User,
    Assistant,
}

data class ChatMessage(
    val id: String,
    val role: ChatRole,
    val text: String,
    val isStreaming: Boolean = false,
)

data class PendingPermission(
    val permissionId: String,
    val kind: String,
    val command: String,
    val risk: String,
    val deciding: Boolean = false,
)

data class FileViewerState(
    val path: String,
    val startLine: Int? = null,
    val endLine: Int? = null,
    val content: String? = null,
    val truncated: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
)

data class CursorRemoteUiState(
    val selectedMachineId: String? = null,
    val selectedWorkspaceId: String? = null,
    val selectedSessionId: String? = null,
    val machines: List<MachineEntity> = emptyList(),
    val workspaces: List<WorkspaceInfo> = emptyList(),
    val sessions: List<SessionInfo> = emptyList(),
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
    val remoteConnection: RemoteConnectionState = RemoteConnectionState.Disconnected,
    val chatMessages: List<ChatMessage> = emptyList(),
    val chatStatus: String? = null,
    val chatError: String? = null,
    val chatTerminal: String? = null,
    val isSending: Boolean = false,
    val isStopping: Boolean = false,
    val pendingPermission: PendingPermission? = null,
    val diffSnapshot: DiffSnapshot? = null,
    val diffLoading: Boolean = false,
    val diffError: String? = null,
    val expandedDiffPaths: Set<String> = emptySet(),
    val fileViewer: FileViewerState? = null,
    val modelCatalog: List<ModelCatalogEntry> = emptyList(),
    val currentModelId: String? = null,
    val pendingModelId: String? = null,
    val modelError: String? = null,
    val modelsLoading: Boolean = false,
    val modelPickerVisible: Boolean = false,
    val hiddenModelIds: Set<String> = emptySet(),
    val manageModelsVisible: Boolean = false,
    val sessionContextUsage: SessionContextUsage? = null,
) {
    val pickerModels: List<ModelCatalogEntry>
        get() = modelCatalog.filter { it.available && it.id !in hiddenModelIds }
}

class CursorRemoteViewModel(
    private val machineDao: MachineDao,
    private val hiddenModelDao: HiddenModelDao,
    private val remoteRepository: RemoteRepository,
    coroutineScope: CoroutineScope? = null,
    private val nowMillis: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {
    private val scope = coroutineScope ?: viewModelScope
    private val _uiState = MutableStateFlow(CursorRemoteUiState())
    private var pendingUserEcho: String? = null
    private val messageSeq = AtomicLong(0)
    private val chatEpoch = AtomicLong(0)
    private val diffEpoch = AtomicLong(0)
    private val fileEpoch = AtomicLong(0)
    private val modelEpoch = AtomicLong(0)
    val uiState: StateFlow<CursorRemoteUiState> = _uiState.asStateFlow()
    val connectionState: StateFlow<ConnectionState> = remoteRepository.socketConnectionState

    init {
        scope.launch {
            machineDao.observeMachines().collect { machines ->
                _uiState.update { it.copy(machines = machines) }
            }
        }
        scope.launch {
            hiddenModelDao.observeHiddenModelIds().collect { hiddenIds ->
                _uiState.update { it.copy(hiddenModelIds = hiddenIds.toSet()) }
            }
        }
        scope.launch {
            remoteRepository.connectionState.collect { remoteConnection ->
                _uiState.update { it.copy(remoteConnection = remoteConnection) }
            }
        }
        scope.launch {
            remoteRepository.events.collect { event ->
                applyChatEvent(event)
                applyDiffEvent(event)
                applyModelEvent(event)
                applySessionContextEvent(event)
            }
        }
    }

    fun selectMachine(machineId: String?) {
        invalidateChat()
        invalidateDiff()
        invalidateFileViewer()
        invalidateModels()
        _uiState.update {
            it.withClearedChat().withClearedDiff().withClearedFileViewer().withClearedModels().withClearedSessionContext().copy(
                selectedMachineId = machineId,
                selectedWorkspaceId = null,
                selectedSessionId = null,
                workspaces = emptyList(),
                sessions = emptyList(),
            )
        }
    }

    fun selectWorkspace(workspaceId: String?) {
        invalidateChat()
        invalidateDiff()
        invalidateFileViewer()
        invalidateModels()
        _uiState.update {
            it.withClearedChat().withClearedDiff().withClearedFileViewer().withClearedModels().withClearedSessionContext().copy(
                selectedWorkspaceId = workspaceId,
                selectedSessionId = null,
                sessions = emptyList(),
            )
        }
    }

    fun selectSession(sessionId: String?) {
        invalidateChat()
        invalidateFileViewer()
        invalidateModels()
        _uiState.update {
            it.withClearedChat().withClearedFileViewer().withClearedModels().withClearedSessionContext().copy(selectedSessionId = sessionId)
        }
    }

    fun sendPrompt(text: String) {
        if (text.isBlank()) return
        val sessionId = _uiState.value.selectedSessionId ?: return
        if (_uiState.value.isSending) return
        val userMessage =
            ChatMessage(
                id = nextMessageId(),
                role = ChatRole.User,
                text = text,
            )
        val epoch = chatEpoch.incrementAndGet()
        pendingUserEcho = text
        _uiState.update {
            it.copy(
                chatMessages = it.chatMessages + userMessage,
                isSending = true,
                isStopping = false,
                chatError = null,
                chatTerminal = null,
                chatStatus = null,
            )
        }
        scope.launch {
            try {
                remoteRepository.sendSessionPrompt(sessionId, text)
            } catch (error: CancellationException) {
                finishSend(sessionId, epoch, errorMessage = null)
                throw error
            } catch (error: Exception) {
                finishSend(sessionId, epoch, errorMessage = error.message ?: "Request failed")
            }
        }
    }

    fun stopSession() {
        val sessionId = _uiState.value.selectedSessionId ?: return
        if (!_uiState.value.isSending || _uiState.value.isStopping) return
        val epoch = chatEpoch.get()
        _uiState.update { it.copy(isStopping = true) }
        scope.launch {
            try {
                remoteRepository.cancelSession(sessionId)
            } catch (error: CancellationException) {
                finishStop(sessionId, epoch, errorMessage = null)
                throw error
            } catch (error: Exception) {
                finishStop(sessionId, epoch, errorMessage = error.message ?: "Request failed")
            }
        }
    }

    fun approvePermission() {
        decidePermission(approve = true)
    }

    fun rejectPermission() {
        decidePermission(approve = false)
    }

    fun refreshDiff() {
        val workspaceId = _uiState.value.selectedWorkspaceId ?: return
        if (_uiState.value.diffLoading) return
        val epoch = diffEpoch.get()
        _uiState.update { it.copy(diffLoading = true, diffError = null) }
        scope.launch {
            try {
                applyDiffSnapshot(remoteRepository.readDiff(workspaceId), epoch)
            } catch (error: CancellationException) {
                finishDiff(workspaceId, epoch, errorMessage = null)
                throw error
            } catch (error: Exception) {
                finishDiff(workspaceId, epoch, error.message ?: "Failed to read diff")
            }
        }
    }

    fun refreshModels() {
        val sessionId = _uiState.value.selectedSessionId ?: return
        if (_uiState.value.modelsLoading) return
        val epoch = modelEpoch.get()
        _uiState.update { it.copy(modelsLoading = true, modelError = null) }
        scope.launch {
            try {
                applyModelCatalog(remoteRepository.listModels(sessionId), sessionId, epoch)
            } catch (error: CancellationException) {
                finishModels(sessionId, epoch, errorMessage = null)
                throw error
            } catch (error: Exception) {
                finishModels(sessionId, epoch, error.message ?: "Failed to list models")
            }
        }
    }

    fun selectModel(modelId: String) {
        val sessionId = _uiState.value.selectedSessionId ?: return
        val available = _uiState.value.modelCatalog.any { it.id == modelId && it.available }
        if (!available || _uiState.value.pendingModelId != null || _uiState.value.modelsLoading) {
            return
        }
        val epoch = modelEpoch.get()
        _uiState.update { it.copy(pendingModelId = modelId, modelError = null) }
        scope.launch {
            try {
                applyModelCatalog(remoteRepository.selectModel(sessionId, modelId), sessionId, epoch, closePicker = true)
            } catch (error: CancellationException) {
                finishModels(sessionId, epoch, errorMessage = null, clearPending = true)
                throw error
            } catch (error: Exception) {
                finishModels(sessionId, epoch, error.message ?: "Failed to select model", clearPending = true)
            }
        }
    }

    fun toggleModelPicker() {
        _uiState.update { it.copy(modelPickerVisible = !it.modelPickerVisible) }
    }

    fun toggleManageModels() {
        _uiState.update { it.copy(manageModelsVisible = !it.manageModelsVisible) }
    }

    fun setModelHidden(modelId: String, hidden: Boolean) {
        if (modelId.isEmpty()) return
        scope.launch {
            if (hidden) {
                hiddenModelDao.hide(HiddenModelEntity(modelId))
            } else {
                hiddenModelDao.show(modelId)
            }
        }
    }

    fun toggleDiffFile(path: String) {
        _uiState.update { state ->
            val next = state.expandedDiffPaths.toMutableSet()
            if (!next.add(path)) {
                next.remove(path)
            }
            state.copy(expandedDiffPaths = next)
        }
    }

    fun openFile(path: String, startLine: Int? = null, endLine: Int? = null) {
        val sessionId = _uiState.value.selectedSessionId ?: return
        val epoch = fileEpoch.incrementAndGet()
        _uiState.update {
            it.copy(
                fileViewer =
                    FileViewerState(
                        path = path,
                        startLine = startLine,
                        endLine = endLine,
                        loading = true,
                        error = null,
                        content = null,
                        truncated = false,
                    ),
            )
        }
        requestFile(sessionId, path, startLine, endLine, epoch)
    }

    fun reloadFile() {
        val viewer = _uiState.value.fileViewer ?: return
        if (viewer.loading) return
        val sessionId = _uiState.value.selectedSessionId ?: return
        val epoch = fileEpoch.incrementAndGet()
        _uiState.update { it.copy(fileViewer = viewer.copy(loading = true, error = null)) }
        requestFile(sessionId, viewer.path, viewer.startLine, viewer.endLine, epoch)
    }

    fun closeFile() {
        fileEpoch.incrementAndGet()
        _uiState.update { it.copy(fileViewer = null) }
    }

    suspend fun registerFromPairingJson(
        pairingJson: String,
        displayName: String,
    ): Boolean =
        runAction("Pairing failed") {
            val payload = RemoteProtocol.parsePairingQrPayload(pairingJson, nowMillis())
            val deviceId = remoteRepository.pair(payload)
            val name = displayName.trim().ifEmpty { payload.machineId }
            machineDao.upsert(
                MachineEntity(
                    id = payload.machineId,
                    displayName = name,
                    relayUrl = payload.relayUrl,
                    deviceId = deviceId,
                    lastConnectedAt = nowMillis(),
                ),
            )
            selectMachine(payload.machineId)
            showWorkspaces(remoteRepository.listWorkspaces())
        }

    suspend fun connectExistingMachine(machineId: String): Boolean =
        runAction("Authentication failed") {
            val machine = machineDao.getMachine(machineId) ?: error("Machine is not registered")
            val deviceId = machine.deviceId
            if (deviceId.isNullOrEmpty() || machine.relayUrl.isEmpty()) {
                error("Machine is not paired")
            }
            remoteRepository.authenticate(machine.relayUrl, machine.id, deviceId)
            machineDao.updateConnectionInfo(machine.id, machine.relayUrl, deviceId, nowMillis())
            selectMachine(machine.id)
            showWorkspaces(remoteRepository.listWorkspaces())
        }

    suspend fun openWorkspace(workspaceId: String): Boolean =
        runAction("Failed to list sessions") {
            selectWorkspace(workspaceId)
            val sessions = remoteRepository.listSessions(workspaceId)
            _uiState.update { it.copy(isLoading = false, sessions = sessions, errorMessage = null) }
        }

    suspend fun createSession(): Boolean {
        val workspaceId = _uiState.value.selectedWorkspaceId
        if (workspaceId.isNullOrEmpty()) {
            _uiState.update { it.copy(errorMessage = "Workspace is not selected") }
            return false
        }
        return runAction("Failed to create session") {
            selectSession(remoteRepository.createSession(workspaceId).remoteSessionId)
            _uiState.update { it.copy(isLoading = false, errorMessage = null) }
            refreshModels()
        }
    }

    suspend fun resumeSession(sessionId: String): Boolean =
        runAction("Failed to resume session") {
            selectSession(remoteRepository.loadSession(sessionId).remoteSessionId)
            _uiState.update { it.copy(isLoading = false, errorMessage = null) }
            refreshModels()
        }

    override fun onCleared() {
        remoteRepository.disconnect()
        super.onCleared()
    }

    private fun applySessionContextEvent(event: RemoteEvent) {
        if (event.type != "session.context_updated") {
            return
        }
        val selectedSessionId = _uiState.value.selectedSessionId
        if (selectedSessionId.isNullOrEmpty()) {
            return
        }
        if (event.sessionId != selectedSessionId) {
            return
        }
        val usage =
            try {
                RemoteProtocol.parseSessionContextUsage(event.payload)
            } catch (_: ProtocolParseError) {
                return
            }
        _uiState.update { state ->
            if (state.selectedSessionId != selectedSessionId) {
                state
            } else {
                state.copy(sessionContextUsage = usage)
            }
        }
    }

    private fun applyModelEvent(event: RemoteEvent) {
        val selectedSessionId = _uiState.value.selectedSessionId ?: return
        if (event.sessionId != selectedSessionId) {
            return
        }
        when (event.type) {
            "model.catalog_updated" -> {
                val catalog =
                    try {
                        RemoteProtocol.parseModelCatalog(event.payload)
                    } catch (_: ProtocolParseError) {
                        return
                    }
                applyModelCatalog(catalog, selectedSessionId, modelEpoch.get())
            }
            "model.selection_changed" -> {
                val selection =
                    try {
                        RemoteProtocol.parseModelSelectionChanged(event.payload)
                    } catch (_: ProtocolParseError) {
                        return
                    }
                _uiState.update { state ->
                    if (state.selectedSessionId != selectedSessionId) {
                        state
                    } else if (selection.confirmed) {
                        state.copy(
                            currentModelId = selection.modelId,
                            pendingModelId =
                                if (state.pendingModelId == selection.modelId) null else state.pendingModelId,
                            modelError = null,
                        )
                    } else {
                        state
                    }
                }
            }
        }
    }

    private fun applyModelCatalog(
        catalog: ModelCatalog,
        sessionId: String,
        epoch: Long,
        closePicker: Boolean = false,
    ) {
        _uiState.update { state ->
            if (modelEpoch.get() != epoch || state.selectedSessionId != sessionId) {
                state
            } else {
                state.copy(
                    modelsLoading = false,
                    modelError = null,
                    modelCatalog = catalog.models,
                    currentModelId = catalog.currentModelId,
                    pendingModelId =
                        if (catalog.currentModelId != null && catalog.currentModelId == state.pendingModelId) {
                            null
                        } else {
                            state.pendingModelId
                        },
                    modelPickerVisible = if (closePicker) false else state.modelPickerVisible,
                )
            }
        }
    }

    private fun finishModels(
        sessionId: String,
        epoch: Long,
        errorMessage: String?,
        clearPending: Boolean = false,
    ) {
        _uiState.update { state ->
            if (modelEpoch.get() != epoch || state.selectedSessionId != sessionId) {
                state
            } else {
                state.copy(
                    modelsLoading = false,
                    modelError = errorMessage ?: state.modelError,
                    pendingModelId = if (clearPending) null else state.pendingModelId,
                )
            }
        }
    }

    private fun applyDiffEvent(event: RemoteEvent) {
        if (event.type != "diff.updated") {
            return
        }
        val snapshot =
            try {
                RemoteProtocol.parseDiffSnapshot(event.payload)
            } catch (_: ProtocolParseError) {
                return
            }
        applyDiffSnapshot(snapshot, diffEpoch.get())
    }

    private fun applyDiffSnapshot(snapshot: DiffSnapshot, epoch: Long) {
        _uiState.update { state ->
            if (diffEpoch.get() != epoch || state.selectedWorkspaceId != snapshot.workspaceId) {
                state
            } else {
                state.copy(
                    diffLoading = false,
                    diffError = null,
                    diffSnapshot = snapshot,
                    expandedDiffPaths = emptySet(),
                )
            }
        }
    }

    private fun finishDiff(
        workspaceId: String,
        epoch: Long,
        errorMessage: String?,
    ) {
        _uiState.update { state ->
            if (diffEpoch.get() != epoch || state.selectedWorkspaceId != workspaceId) {
                state
            } else {
                state.copy(diffLoading = false, diffError = errorMessage ?: state.diffError)
            }
        }
    }

    private fun applyChatEvent(event: RemoteEvent) {
        val chat =
            try {
                RemoteProtocol.parseChatEvent(event)
            } catch (_: ProtocolParseError) {
                return
            } ?: return
        if (chat.sessionId != _uiState.value.selectedSessionId) {
            return
        }
        when (chat) {
            is ChatEvent.UserMessage -> {
                if (consumeUserEcho(chat.text)) {
                    return
                }
                _uiState.update { state ->
                    if (state.selectedSessionId != chat.sessionId) {
                        state
                    } else {
                        state.copy(
                            chatMessages =
                                state.chatMessages +
                                    ChatMessage(
                                        id = nextMessageId(),
                                        role = ChatRole.User,
                                        text = chat.text,
                                    ),
                        )
                    }
                }
            }
            is ChatEvent.AssistantMessage -> {
                _uiState.update { state ->
                    if (state.selectedSessionId != chat.sessionId) {
                        state
                    } else {
                        state.copy(chatMessages = applyAssistantDelta(state.chatMessages, chat.text, chat.delta))
                    }
                }
            }
            is ChatEvent.SessionStatusChanged -> {
                _uiState.update { state ->
                    if (state.selectedSessionId != chat.sessionId) state else state.copy(chatStatus = chat.status)
                }
            }
            is ChatEvent.AssistantStatus -> {
                _uiState.update { state ->
                    if (state.selectedSessionId != chat.sessionId) state else state.copy(chatStatus = chat.status)
                }
            }
            is ChatEvent.AgentWaiting -> Unit
            is ChatEvent.AgentCompleted -> applyTerminal(chat.sessionId, "completed", error = null)
            is ChatEvent.AgentFailed -> applyTerminal(chat.sessionId, "failed", error = chat.reason)
            is ChatEvent.AgentInterrupted -> applyTerminal(chat.sessionId, "interrupted", error = null)
            is ChatEvent.PermissionRequested -> {
                _uiState.update { state ->
                    if (state.selectedSessionId != chat.sessionId) {
                        state
                    } else {
                        state.copy(
                            pendingPermission =
                                PendingPermission(
                                    permissionId = chat.permissionId,
                                    kind = chat.kind,
                                    command = chat.command,
                                    risk = chat.risk,
                                ),
                        )
                    }
                }
            }
            is ChatEvent.PermissionResolved -> {
                _uiState.update { state ->
                    if (state.selectedSessionId != chat.sessionId ||
                        state.pendingPermission?.permissionId != chat.permissionId
                    ) {
                        state
                    } else {
                        state.copy(pendingPermission = null)
                    }
                }
            }
        }
    }

    private fun applyAssistantDelta(
        messages: List<ChatMessage>,
        text: String,
        delta: Boolean,
    ): List<ChatMessage> {
        val index = messages.indexOfLast { it.role == ChatRole.Assistant && it.isStreaming }
        return if (index >= 0) {
            messages.toMutableList().also { list ->
                val current = list[index]
                list[index] = current.copy(text = if (delta) current.text + text else text)
            }
        } else {
            messages +
                ChatMessage(
                    id = nextMessageId(),
                    role = ChatRole.Assistant,
                    text = text,
                    isStreaming = true,
                )
        }
    }

    private fun applyTerminal(
        sessionId: String,
        terminal: String,
        error: String?,
    ) {
        if (_uiState.value.selectedSessionId != sessionId) {
            return
        }
        clearPendingUserEcho()
        _uiState.update { state ->
            if (state.selectedSessionId != sessionId) {
                state
            } else {
                state.copy(
                    chatMessages = state.chatMessages.map { message ->
                        if (message.isStreaming) message.copy(isStreaming = false) else message
                    },
                    chatTerminal = terminal,
                    chatError = error ?: state.chatError,
                    isSending = false,
                    isStopping = false,
                    pendingPermission = null,
                )
            }
        }
    }

    private fun decidePermission(approve: Boolean) {
        var claimedSessionId: String? = null
        var claimedPermissionId: String? = null
        _uiState.update { current ->
            val sessionId = current.selectedSessionId
            val pending = current.pendingPermission
            if (sessionId == null || pending == null || pending.deciding) {
                claimedSessionId = null
                claimedPermissionId = null
                current
            } else {
                claimedSessionId = sessionId
                claimedPermissionId = pending.permissionId
                current.copy(pendingPermission = pending.copy(deciding = true), chatError = null)
            }
        }
        val sessionId = claimedSessionId ?: return
        val permissionId = claimedPermissionId ?: return
        scope.launch {
            try {
                if (approve) {
                    remoteRepository.approvePermission(sessionId, permissionId)
                } else {
                    remoteRepository.rejectPermission(sessionId, permissionId)
                }
            } catch (error: CancellationException) {
                clearPermissionDeciding(sessionId, permissionId, errorMessage = null)
                throw error
            } catch (error: Exception) {
                clearPermissionDeciding(sessionId, permissionId, error.message ?: "Request failed")
            }
        }
    }

    private fun clearPermissionDeciding(
        sessionId: String,
        permissionId: String,
        errorMessage: String?,
    ) {
        _uiState.update { state ->
            val pending = state.pendingPermission
            if (state.selectedSessionId != sessionId || pending?.permissionId != permissionId) {
                state
            } else {
                state.copy(
                    pendingPermission = pending.copy(deciding = false),
                    chatError = errorMessage ?: state.chatError,
                )
            }
        }
    }

    private fun consumeUserEcho(text: String): Boolean {
        val pending = pendingUserEcho ?: return false
        if (text.isNotEmpty() && pending.startsWith(text)) {
            pendingUserEcho = pending.removePrefix(text).ifEmpty { null }
            return true
        }
        clearPendingUserEcho()
        return false
    }

    private fun clearPendingUserEcho() {
        pendingUserEcho = null
    }

    private fun finishSend(
        sessionId: String,
        epoch: Long,
        errorMessage: String?,
    ) {
        if (chatEpoch.get() != epoch) return
        clearPendingUserEcho()
        _uiState.update { state ->
            if (state.selectedSessionId != sessionId) {
                state
            } else if (errorMessage != null && state.chatTerminal == null) {
                state.copy(isSending = false, isStopping = false, chatError = errorMessage)
            } else {
                state.copy(isSending = false, isStopping = false)
            }
        }
    }

    private fun finishStop(
        sessionId: String,
        epoch: Long,
        errorMessage: String?,
    ) {
        if (chatEpoch.get() != epoch) return
        _uiState.update { state ->
            if (state.selectedSessionId != sessionId) {
                state
            } else if (errorMessage != null && state.chatTerminal == null) {
                state.copy(isStopping = false, chatError = errorMessage)
            } else {
                state.copy(isStopping = false)
            }
        }
    }

    private fun invalidateChat() {
        chatEpoch.incrementAndGet()
        clearPendingUserEcho()
    }

    private fun invalidateDiff() {
        diffEpoch.incrementAndGet()
    }

    private fun invalidateFileViewer() {
        fileEpoch.incrementAndGet()
    }

    private fun invalidateModels() {
        modelEpoch.incrementAndGet()
    }

    private fun requestFile(
        sessionId: String,
        path: String,
        startLine: Int?,
        endLine: Int?,
        epoch: Long,
    ) {
        scope.launch {
            try {
                applyFileContent(remoteRepository.readFile(sessionId, path), sessionId, epoch, startLine, endLine)
            } catch (error: CancellationException) {
                finishFile(sessionId, epoch, errorMessage = null)
                throw error
            } catch (error: Exception) {
                finishFile(sessionId, epoch, error.message ?: "Failed to read file")
            }
        }
    }

    private fun applyFileContent(
        content: FileContent,
        sessionId: String,
        epoch: Long,
        startLine: Int?,
        endLine: Int?,
    ) {
        _uiState.update { state ->
            if (fileEpoch.get() != epoch || state.selectedSessionId != sessionId) {
                state
            } else {
                state.copy(
                    fileViewer =
                        FileViewerState(
                            path = content.path,
                            startLine = startLine,
                            endLine = endLine,
                            content = content.content,
                            truncated = content.truncated,
                            loading = false,
                            error = null,
                        ),
                )
            }
        }
    }

    private fun finishFile(
        sessionId: String,
        epoch: Long,
        errorMessage: String?,
    ) {
        _uiState.update { state ->
            val viewer = state.fileViewer
            if (fileEpoch.get() != epoch || state.selectedSessionId != sessionId || viewer == null) {
                state
            } else {
                state.copy(fileViewer = viewer.copy(loading = false, error = errorMessage ?: viewer.error))
            }
        }
    }

    private fun nextMessageId(): String = "msg-${messageSeq.incrementAndGet()}"

    private fun showWorkspaces(workspaces: List<WorkspaceInfo>) {
        _uiState.update {
            it.copy(isLoading = false, workspaces = workspaces, sessions = emptyList(), errorMessage = null)
        }
    }

    private suspend fun runAction(
        failure: String,
        block: suspend () -> Unit,
    ): Boolean {
        if (_uiState.value.isLoading) return false
        _uiState.update { it.copy(isLoading = true, errorMessage = null) }
        return try {
            block()
            true
        } catch (error: CancellationException) {
            _uiState.update { it.copy(isLoading = false) }
            throw error
        } catch (error: Exception) {
            _uiState.update { it.copy(isLoading = false, errorMessage = error.message ?: failure) }
            false
        }
    }
}

private fun CursorRemoteUiState.withClearedChat(): CursorRemoteUiState =
    copy(
        chatMessages = emptyList(),
        chatStatus = null,
        chatError = null,
        chatTerminal = null,
        isSending = false,
        isStopping = false,
        pendingPermission = null,
    )

private fun CursorRemoteUiState.withClearedDiff(): CursorRemoteUiState =
    copy(
        diffSnapshot = null,
        diffLoading = false,
        diffError = null,
        expandedDiffPaths = emptySet(),
    )

private fun CursorRemoteUiState.withClearedFileViewer(): CursorRemoteUiState = copy(fileViewer = null)

private fun CursorRemoteUiState.withClearedModels(): CursorRemoteUiState =
    copy(
        modelCatalog = emptyList(),
        currentModelId = null,
        pendingModelId = null,
        modelError = null,
        modelsLoading = false,
        modelPickerVisible = false,
        manageModelsVisible = false,
    )

private fun CursorRemoteUiState.withClearedSessionContext(): CursorRemoteUiState = copy(sessionContextUsage = null)
