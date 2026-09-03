package dev.cursorremote.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import dev.cursorremote.android.R
import dev.cursorremote.android.data.remote.RemoteConnectionState
import dev.cursorremote.android.state.CursorRemoteUiState
import dev.cursorremote.android.state.CursorRemoteViewModel
import kotlinx.coroutines.launch

enum class AppDestination(val route: String) {
    Machines("machines"),
    Workspaces("workspaces"),
    Sessions("sessions"),
    Chat("chat"),
    ;

    val previous: AppDestination?
        get() = entries.getOrNull(ordinal - 1)

    val next: AppDestination?
        get() = entries.getOrNull(ordinal + 1)
}

@Composable
fun CursorRemoteApp(viewModel: CursorRemoteViewModel) {
    val uiState by viewModel.uiState.collectAsState()
    val navController = rememberNavController()
    val scope = rememberCoroutineScope()
    fun go(entry: NavBackStackEntry, destination: AppDestination, action: suspend () -> Boolean) {
        entry.lifecycleScope.launch {
            if (action()) navigateForward(navController, destination)
        }
    }
    val canReconnect =
        uiState.selectedMachineId != null &&
            !uiState.isLoading &&
            (uiState.remoteConnection == RemoteConnectionState.Failed ||
                uiState.remoteConnection == RemoteConnectionState.Disconnected)

    MaterialTheme {
        Surface(modifier = Modifier.fillMaxSize()) {
            Column(modifier = Modifier.fillMaxSize()) {
                if (canReconnect) {
                    Button(onClick = { scope.launch { viewModel.reconnectSelectedMachine() } }) {
                        Text(stringResource(R.string.reconnect))
                    }
                }
                NavHost(
                    navController = navController,
                    startDestination = AppDestination.Machines.route,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                ) {
                composable(AppDestination.Machines.route) { entry ->
                    MachinesScreen(
                        uiState = uiState,
                        onRegister = { pairingJson, displayName ->
                            go(entry, AppDestination.Workspaces) { viewModel.registerFromPairingJson(pairingJson, displayName) }
                        },
                        onSelectMachine = { machineId ->
                            go(entry, AppDestination.Workspaces) { viewModel.connectExistingMachine(machineId) }
                        },
                    )
                }
                composable(AppDestination.Workspaces.route) { entry ->
                    WorkspacesScreen(
                        uiState = uiState,
                        onBack = { navController.popBackStack() },
                        onSelectWorkspace = { workspaceId ->
                            go(entry, AppDestination.Sessions) { viewModel.openWorkspace(workspaceId) }
                        },
                    )
                }
                composable(AppDestination.Sessions.route) { entry ->
                    SessionsScreen(
                        uiState = uiState,
                        onBack = { navController.popBackStack() },
                        onCreateSession = { go(entry, AppDestination.Chat) { viewModel.createSession() } },
                        onResumeSession = { sessionId -> go(entry, AppDestination.Chat) { viewModel.resumeSession(sessionId) } },
                    )
                }
                composable(AppDestination.Chat.route) {
                    val viewer = uiState.fileViewer
                    if (viewer != null) {
                        FileViewerScreen(
                            state = viewer,
                            onReload = viewModel::reloadFile,
                            onClose = viewModel::closeFile,
                        )
                    } else {
                        ChatScreen(
                            uiState = uiState,
                            onBack = { navController.popBackStack() },
                            onSend = viewModel::sendPrompt,
                            onStop = viewModel::stopSession,
                            onApprove = viewModel::approvePermission,
                            onReject = viewModel::rejectPermission,
                            onRefreshDiff = viewModel::refreshDiff,
                            onToggleDiffFile = viewModel::toggleDiffFile,
                            onOpenFile = { path, startLine, endLine -> viewModel.openFile(path, startLine, endLine) },
                            onRefreshModels = viewModel::refreshModels,
                            onSelectModel = viewModel::selectModel,
                            onToggleModelPicker = viewModel::toggleModelPicker,
                            onToggleManageModels = viewModel::toggleManageModels,
                            onSetModelHidden = viewModel::setModelHidden,
                            onStartVoice = viewModel::startVoicePrompt,
                            onFinishVoice = viewModel::finishVoicePrompt,
                            onCancelVoice = viewModel::cancelVoicePrompt,
                        )
                    }
                }
                }
            }
        }
    }
}

@Composable
internal fun StatusBlock(uiState: CursorRemoteUiState) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (uiState.isLoading) Text("Loading")
        uiState.errorMessage?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (uiState.syncGapWarning) {
            Text(stringResource(R.string.sync_gap_warning), color = MaterialTheme.colorScheme.error)
        }
        Text("connection: ${uiState.remoteConnection.name}")
        Text("machine: ${uiState.selectedMachineId ?: "-"}")
        Text("workspace: ${uiState.selectedWorkspaceId ?: "-"}")
        Text("session: ${uiState.selectedSessionId ?: "-"}")
    }
}

private fun navigateForward(
    navController: NavHostController,
    destination: AppDestination,
) {
    if (navController.currentDestination?.route == destination.route) return
    navController.navigate(destination.route) { launchSingleTop = true }
}
