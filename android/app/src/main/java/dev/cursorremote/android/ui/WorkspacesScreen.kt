package dev.cursorremote.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.cursorremote.android.state.CursorRemoteUiState

@Composable
fun WorkspacesScreen(
    uiState: CursorRemoteUiState,
    onBack: () -> Unit,
    onSelectWorkspace: (workspaceId: String) -> Unit,
) {
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        TextButton(onClick = onBack) { Text("Back") }
        Text("Workspaces", style = MaterialTheme.typography.headlineSmall)
        StatusBlock(uiState)
        if (!uiState.isLoading && uiState.workspaces.isEmpty()) {
            Text("No workspaces")
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(uiState.workspaces, key = { it.workspaceId }) { workspace ->
                Column(
                    Modifier.fillMaxWidth().clickable(enabled = !uiState.isLoading) { onSelectWorkspace(workspace.workspaceId) }.padding(vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(workspace.name, style = MaterialTheme.typography.titleMedium)
                    Text(workspace.path)
                    Text("gitBranch: ${workspace.gitBranch ?: "—"}")
                    Text("modified: ${workspace.modified}")
                    Text("activeSessionCount: ${workspace.activeSessionCount}")
                }
            }
        }
    }
}
