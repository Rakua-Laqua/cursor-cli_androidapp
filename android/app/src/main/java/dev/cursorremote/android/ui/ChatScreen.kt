package dev.cursorremote.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.cursorremote.android.data.protocol.DiffFileInfo
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
    onRefreshDiff: () -> Unit,
    onToggleDiffFile: (path: String) -> Unit,
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
        if (uiState.selectedWorkspaceId != null) {
            DiffPanel(uiState = uiState, onRefreshDiff = onRefreshDiff, onToggleDiffFile = onToggleDiffFile)
        }
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
private fun DiffPanel(
    uiState: CursorRemoteUiState,
    onRefreshDiff: () -> Unit,
    onToggleDiffFile: (path: String) -> Unit,
) {
    val snapshot = uiState.diffSnapshot
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(
            onClick = onRefreshDiff,
            enabled = !uiState.diffLoading,
        ) { Text("Refresh Diff") }
        if (uiState.diffLoading) {
            Text("Loading diff")
        }
        uiState.diffError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        when {
            snapshot == null && !uiState.diffLoading && uiState.diffError == null -> Text("Diff not loaded")
            snapshot != null && !snapshot.available -> Text("Not a Git workspace")
            snapshot != null && snapshot.files.isEmpty() -> Text("No changed files")
            snapshot != null ->
                Text("${snapshot.files.size} files  +${snapshot.totalAdditions} -${snapshot.totalDeletions}")
        }
        if (snapshot?.truncated == true) {
            Text("truncated")
        }
        if (snapshot != null && snapshot.omittedCount > 0) {
            Text("omitted: ${snapshot.omittedCount}")
        }
        if (snapshot != null && snapshot.files.isNotEmpty()) {
            Column(
                Modifier.fillMaxWidth().heightIn(max = 280.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                snapshot.files.forEach { file ->
                    DiffFileRow(
                        file = file,
                        expanded = file.path in uiState.expandedDiffPaths,
                        onToggle = { onToggleDiffFile(file.path) },
                    )
                }
            }
        }
    }
}

@Composable
private fun DiffFileRow(
    file: DiffFileInfo,
    expanded: Boolean,
    onToggle: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Column(
            Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(file.path, style = MaterialTheme.typography.titleSmall)
            Text(diffFileSummary(file))
        }
        if (expanded) {
            val diff = file.unifiedDiff
            if (diff.isNullOrEmpty()) {
                Text("No unified diff")
            } else {
                Text(
                    text = diff,
                    fontFamily = FontFamily.Monospace,
                    softWrap = false,
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                )
            }
        }
    }
}

private fun diffFileSummary(file: DiffFileInfo): String {
    val flags = buildList {
        add(file.change)
        add("+${file.additions}")
        add("-${file.deletions}")
        if (file.sensitive) add("sensitive")
        if (file.binary) add("binary")
        if (file.truncated) add("truncated")
        file.previousPath?.let { add("from $it") }
    }
    return flags.joinToString("  ")
}

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
