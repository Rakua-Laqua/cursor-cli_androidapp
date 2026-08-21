package dev.cursorremote.android.state

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.cursorremote.android.data.local.MachineDao
import dev.cursorremote.android.data.local.MachineEntity
import dev.cursorremote.android.data.protocol.ChatEvent
import dev.cursorremote.android.data.protocol.ProtocolParseError
import dev.cursorremote.android.data.protocol.RemoteEvent
import dev.cursorremote.android.data.protocol.RemoteProtocol
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
)

class CursorRemoteViewModel(
    private val machineDao: MachineDao,
    private val remoteRepository: RemoteRepository,
    coroutineScope: CoroutineScope? = null,
    private val nowMillis: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {
    private val scope = coroutineScope ?: viewModelScope
    private val _uiState = MutableStateFlow(CursorRemoteUiState())
    private var pendingUserEcho: String? = null
    private val messageSeq = AtomicLong(0)
    private val chatEpoch = AtomicLong(0)
    val uiState: StateFlow<CursorRemoteUiState> = _uiState.asStateFlow()
    val connectionState: StateFlow<ConnectionState> = remoteRepository.socketConnectionState

    init {
        scope.launch {
            machineDao.observeMachines().collect { machines ->
                _uiState.update { it.copy(machines = machines) }
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
            }
        }
    }

    fun selectMachine(machineId: String?) {
        invalidateChat()
        _uiState.update {
            it.withClearedChat().copy(
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
        _uiState.update {
            it.withClearedChat().copy(selectedWorkspaceId = workspaceId, selectedSessionId = null, sessions = emptyList())
        }
    }

    fun selectSession(sessionId: String?) {
        invalidateChat()
        _uiState.update { it.withClearedChat().copy(selectedSessionId = sessionId) }
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
        }
    }

    suspend fun resumeSession(sessionId: String): Boolean =
        runAction("Failed to resume session") {
            selectSession(remoteRepository.loadSession(sessionId).remoteSessionId)
            _uiState.update { it.copy(isLoading = false, errorMessage = null) }
        }

    override fun onCleared() {
        remoteRepository.disconnect()
        super.onCleared()
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
            is ChatEvent.AgentCompleted -> applyTerminal(chat.sessionId, "completed", error = null)
            is ChatEvent.AgentFailed -> applyTerminal(chat.sessionId, "failed", error = chat.reason)
            is ChatEvent.AgentInterrupted -> applyTerminal(chat.sessionId, "interrupted", error = null)
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
    )
