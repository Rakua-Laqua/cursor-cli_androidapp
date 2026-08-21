package dev.cursorremote.android.state

import androidx.lifecycle.ViewModel
import dev.cursorremote.android.data.local.MachineDao
import dev.cursorremote.android.data.security.DeviceCredentialStore
import dev.cursorremote.android.data.transport.ConnectionState
import dev.cursorremote.android.data.transport.WebSocketTransport
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

data class CursorRemoteUiState(
    val selectedMachineId: String? = null,
    val selectedWorkspaceId: String? = null,
    val selectedSessionId: String? = null,
)

@Suppress("UnusedPrivateProperty")
class CursorRemoteViewModel(
    private val machineDao: MachineDao,
    private val credentialStore: DeviceCredentialStore,
    private val transport: WebSocketTransport,
) : ViewModel() {
    private val _uiState = MutableStateFlow(CursorRemoteUiState())
    val uiState: StateFlow<CursorRemoteUiState> = _uiState.asStateFlow()

    val connectionState: StateFlow<ConnectionState> = transport.connectionState

    fun selectMachine(machineId: String?) {
        _uiState.update {
            it.copy(
                selectedMachineId = machineId,
                selectedWorkspaceId = null,
                selectedSessionId = null,
            )
        }
    }

    fun selectWorkspace(workspaceId: String?) {
        _uiState.update {
            it.copy(
                selectedWorkspaceId = workspaceId,
                selectedSessionId = null,
            )
        }
    }

    fun selectSession(sessionId: String?) {
        _uiState.update { it.copy(selectedSessionId = sessionId) }
    }
}
