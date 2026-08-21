package dev.cursorremote.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.cursorremote.android.state.CursorRemoteUiState

@Composable
fun SessionsScreen(
    uiState: CursorRemoteUiState,
    onBack: () -> Unit,
    onCreateSession: () -> Unit,
    onResumeSession: (sessionId: String) -> Unit,
) {
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        TextButton(onClick = onBack) { Text("Back") }
        Text("Sessions", style = MaterialTheme.typography.headlineSmall)
        StatusBlock(uiState)
        Button(onClick = onCreateSession, enabled = !uiState.isLoading && uiState.selectedWorkspaceId != null) {
            Text("New Session")
        }
        if (!uiState.isLoading && uiState.sessions.isEmpty()) {
            Text("No sessions")
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(uiState.sessions, key = { it.remoteSessionId }) { session ->
                Column(
                    Modifier.fillMaxWidth().clickable(enabled = !uiState.isLoading) { onResumeSession(session.remoteSessionId) }.padding(vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(session.title, style = MaterialTheme.typography.titleMedium)
                    Text("status: ${session.status}")
                    Text("updatedAt: ${session.updatedAt}")
                }
            }
        }
    }
}
