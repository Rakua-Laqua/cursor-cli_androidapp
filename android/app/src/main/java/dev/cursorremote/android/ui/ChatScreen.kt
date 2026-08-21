package dev.cursorremote.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.cursorremote.android.state.ChatMessage
import dev.cursorremote.android.state.ChatRole
import dev.cursorremote.android.state.CursorRemoteUiState
import dev.cursorremote.android.state.PendingPermission

@Composable
fun ChatScreen(
    uiState: CursorRemoteUiState,
    onBack: () -> Unit,
    onSend: (text: String) -> Unit,
    onStop: () -> Unit,
    onApprove: () -> Unit,
    onReject: () -> Unit,
) {
    var draft by rememberSaveable { mutableStateOf("") }
    val listState = rememberLazyListState()
    val lastMessage = uiState.chatMessages.lastOrNull()
    LaunchedEffect(uiState.chatMessages.size, lastMessage?.id, lastMessage?.text) {
        val lastIndex = uiState.chatMessages.lastIndex
        if (lastIndex >= 0) {
            listState.scrollToItem(lastIndex)
        }
    }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        TextButton(onClick = onBack) { Text("Back") }
        Text("Chat", style = MaterialTheme.typography.headlineSmall)
        StatusBlock(uiState)
        ChatStatusLabels(uiState)
        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            state = listState,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(uiState.chatMessages, key = { it.id }) { message ->
                ChatMessageRow(message)
            }
        }
        uiState.pendingPermission?.let { pending ->
            ApprovalCard(pending = pending, onApprove = onApprove, onReject = onReject)
        }
        OutlinedTextField(
            value = draft,
            onValueChange = { draft = it },
            modifier = Modifier.fillMaxWidth().heightIn(min = 72.dp),
            label = { Text("Prompt") },
            enabled = !uiState.isSending,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    val text = draft
                    if (text.isBlank()) return@Button
                    onSend(text)
                    draft = ""
                },
                enabled = !uiState.isSending && uiState.selectedSessionId != null && draft.isNotBlank(),
            ) { Text("Send") }
            Button(
                onClick = onStop,
                enabled = uiState.isSending && !uiState.isStopping,
            ) { Text("Stop") }
        }
    }
}

@Composable
private fun ChatStatusLabels(uiState: CursorRemoteUiState) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        uiState.chatStatus?.let { Text("status: $it") }
        uiState.chatError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        when (uiState.chatTerminal) {
            "completed" -> Text("completed")
            "failed" -> Text("failed")
            "interrupted" -> {
                Text("interrupted")
                Text("stopped")
            }
        }
    }
}

@Composable
private fun ChatMessageRow(message: ChatMessage) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(chatRoleLabel(message.role), style = MaterialTheme.typography.titleSmall)
        Text(message.text)
    }
}

private fun chatRoleLabel(role: ChatRole): String =
    if (role == ChatRole.User) "User" else "Assistant"

@Composable
private fun ApprovalCard(
    pending: PendingPermission,
    onApprove: () -> Unit,
    onReject: () -> Unit,
) {
    val enabled = !pending.deciding
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Approval required", style = MaterialTheme.typography.titleMedium)
        Text(pending.command)
        Text("Risk: High")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onReject, enabled = enabled) { Text("Reject") }
            Button(onClick = onApprove, enabled = enabled) { Text("Approve") }
        }
    }
}
