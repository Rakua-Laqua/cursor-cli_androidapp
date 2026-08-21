package dev.cursorremote.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import dev.cursorremote.android.data.transport.ConnectionState
import dev.cursorremote.android.state.CursorRemoteUiState
import dev.cursorremote.android.state.CursorRemoteViewModel

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

    val unimplementedTaskId: String
        get() = if (this == Chat) "TASK-204" else "TASK-203"
}

@Composable
fun CursorRemoteApp(viewModel: CursorRemoteViewModel) {
    val uiState by viewModel.uiState.collectAsState()
    val connectionState by viewModel.connectionState.collectAsState()
    val navController = rememberNavController()

    MaterialTheme {
        Surface(modifier = Modifier.fillMaxSize()) {
            NavHost(
                navController = navController,
                startDestination = AppDestination.Machines.route,
            ) {
                AppDestination.entries.forEach { destination ->
                    composable(destination.route) {
                        PlaceholderScreen(
                            destination = destination,
                            uiState = uiState,
                            connectionState = connectionState,
                            onNavigate = { target ->
                                navController.navigate(target.route)
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun PlaceholderScreen(
    destination: AppDestination,
    uiState: CursorRemoteUiState,
    connectionState: ConnectionState,
    onNavigate: (AppDestination) -> Unit,
) {
    Column(
        modifier = Modifier.padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(text = destination.name, style = MaterialTheme.typography.headlineSmall)
        Text(text = "${destination.unimplementedTaskId} 未実装")
        Text(text = "connection: ${connectionState.name}")
        Text(text = "machine: ${uiState.selectedMachineId ?: "-"}")
        Text(text = "workspace: ${uiState.selectedWorkspaceId ?: "-"}")
        Text(text = "session: ${uiState.selectedSessionId ?: "-"}")
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(
                onClick = { destination.previous?.let(onNavigate) },
                enabled = destination.previous != null,
            ) {
                Text("Previous")
            }
            Button(
                onClick = { destination.next?.let(onNavigate) },
                enabled = destination.next != null,
            ) {
                Text("Next")
            }
        }
    }
}
