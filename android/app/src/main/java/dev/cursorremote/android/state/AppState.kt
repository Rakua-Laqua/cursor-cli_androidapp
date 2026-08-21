package dev.cursorremote.android.state

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.cursorremote.android.data.local.MachineDao
import dev.cursorremote.android.data.local.MachineEntity
import dev.cursorremote.android.data.protocol.RemoteProtocol
import dev.cursorremote.android.data.protocol.SessionInfo
import dev.cursorremote.android.data.protocol.WorkspaceInfo
import dev.cursorremote.android.data.remote.RemoteConnectionState
import dev.cursorremote.android.data.remote.RemoteRepository
import dev.cursorremote.android.data.transport.ConnectionState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

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
)

class CursorRemoteViewModel(
    private val machineDao: MachineDao,
    private val remoteRepository: RemoteRepository,
    coroutineScope: CoroutineScope? = null,
    private val nowMillis: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {
    private val scope = coroutineScope ?: viewModelScope
    private val _uiState = MutableStateFlow(CursorRemoteUiState())
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
    }

    fun selectMachine(machineId: String?) {
        _uiState.update {
            it.copy(
                selectedMachineId = machineId,
                selectedWorkspaceId = null,
                selectedSessionId = null,
                workspaces = emptyList(),
                sessions = emptyList(),
            )
        }
    }

    fun selectWorkspace(workspaceId: String?) {
        _uiState.update {
            it.copy(selectedWorkspaceId = workspaceId, selectedSessionId = null, sessions = emptyList())
        }
    }

    fun selectSession(sessionId: String?) {
        _uiState.update { it.copy(selectedSessionId = sessionId) }
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
