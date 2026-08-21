package dev.cursorremote.android

import dev.cursorremote.android.data.local.MachineDao
import dev.cursorremote.android.data.local.MachineEntity
import dev.cursorremote.android.data.security.DeviceCredentialStore
import dev.cursorremote.android.data.transport.ConnectionState
import dev.cursorremote.android.data.transport.WebSocketTransport
import dev.cursorremote.android.state.CursorRemoteViewModel
import dev.cursorremote.android.ui.AppDestination
import java.security.PublicKey
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FoundationTest {
    @Test
    fun destinationsStartAtMachinesAndFollowOrder() {
        assertEquals(
            listOf(
                AppDestination.Machines,
                AppDestination.Workspaces,
                AppDestination.Sessions,
                AppDestination.Chat,
            ),
            AppDestination.entries,
        )
        assertEquals(AppDestination.Machines, AppDestination.entries.first())
        assertEquals("machines", AppDestination.Machines.route)
        assertNull(AppDestination.Machines.previous)
        assertEquals(AppDestination.Workspaces, AppDestination.Machines.next)
        assertEquals(AppDestination.Sessions, AppDestination.Workspaces.next)
        assertEquals(AppDestination.Chat, AppDestination.Sessions.next)
        assertNull(AppDestination.Chat.next)
    }

    @Test
    fun initialUiStateHasNoSelectionAndDisconnectedTransport() {
        val viewModel = createViewModel()
        val state = viewModel.uiState.value
        assertNull(state.selectedMachineId)
        assertNull(state.selectedWorkspaceId)
        assertNull(state.selectedSessionId)
        assertEquals(ConnectionState.Disconnected, viewModel.connectionState.value)
    }

    @Test
    fun selectingMachineClearsWorkspaceAndSession() {
        val viewModel = createViewModel()
        viewModel.selectMachine("machine-1")
        viewModel.selectWorkspace("workspace-1")
        viewModel.selectSession("session-1")

        viewModel.selectMachine("machine-2")

        val state = viewModel.uiState.value
        assertEquals("machine-2", state.selectedMachineId)
        assertNull(state.selectedWorkspaceId)
        assertNull(state.selectedSessionId)
    }

    @Test
    fun selectingWorkspaceClearsSession() {
        val viewModel = createViewModel()
        viewModel.selectMachine("machine-1")
        viewModel.selectWorkspace("workspace-1")
        viewModel.selectSession("session-1")

        viewModel.selectWorkspace("workspace-2")

        val state = viewModel.uiState.value
        assertEquals("machine-1", state.selectedMachineId)
        assertEquals("workspace-2", state.selectedWorkspaceId)
        assertNull(state.selectedSessionId)
    }

    private fun createViewModel(): CursorRemoteViewModel {
        return CursorRemoteViewModel(
            machineDao = FakeMachineDao(),
            credentialStore = FakeCredentialStore(),
            transport = FakeWebSocketTransport(),
        )
    }
}

private class FakeMachineDao : MachineDao {
    override fun observeMachines(): Flow<List<MachineEntity>> = emptyFlow()
}

private class FakeCredentialStore : DeviceCredentialStore {
    override fun createDeviceKey(): PublicKey {
        throw UnsupportedOperationException("TASK-202 unit tests do not create device keys")
    }

    override fun getDeviceKey(): PublicKey? = null

    override fun deleteDeviceKey() = Unit
}

private class FakeWebSocketTransport : WebSocketTransport {
    private val _connectionState = MutableStateFlow(ConnectionState.Disconnected)
    override val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()
    override val incomingText: Flow<String> = MutableSharedFlow()

    override fun connect(url: String) = Unit

    override fun send(text: String) = Unit

    override fun disconnect() = Unit
}
