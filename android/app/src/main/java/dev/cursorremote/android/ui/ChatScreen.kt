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
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import dev.cursorremote.android.R
import dev.cursorremote.android.data.protocol.DiffFileInfo
import dev.cursorremote.android.data.protocol.ModelCatalogEntry
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
    onOpenFile: (path: String, startLine: Int?, endLine: Int?) -> Unit,
    onRefreshModels: () -> Unit,
    onSelectModel: (modelId: String) -> Unit,
    onToggleModelPicker: () -> Unit,
    onToggleManageModels: () -> Unit,
    onSetModelHidden: (modelId: String, hidden: Boolean) -> Unit,
) {
    var draft by rememberSaveable { mutableStateOf("") }
    var contextExpanded by rememberSaveable { mutableStateOf(false) }
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
        uiState.sessionContextUsage?.let { usage ->
            val breakdown = uiState.sessionContextBreakdown
            if (breakdown.isNullOrEmpty()) {
                Text("${stringResource(R.string.context_usage_label)} ${formatSessionContextUsage(usage)}")
            } else {
                Column {
                    Text(
                        text = "${stringResource(R.string.context_usage_label)} ${formatSessionContextUsage(usage)} ${if (contextExpanded) "v" else ">"}",
                        modifier = Modifier.clickable { contextExpanded = !contextExpanded },
                    )
                    if (contextExpanded) {
                        for (category in breakdown) {
                            Row(Modifier.fillMaxWidth()) {
                                Text(category.displayName, modifier = Modifier.weight(1f))
                                Text(formatCompactCount(category.tokens))
                            }
                        }
                    }
                }
            }
        }
        StatusBlock(uiState)
        ModelPanel(
            uiState = uiState,
            onRefreshModels = onRefreshModels,
            onSelectModel = onSelectModel,
            onToggleModelPicker = onToggleModelPicker,
            onToggleManageModels = onToggleManageModels,
            onSetModelHidden = onSetModelHidden,
        )
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
                ChatMessageRow(message, onOpenFile)
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
private fun ModelPanel(
    uiState: CursorRemoteUiState,
    onRefreshModels: () -> Unit,
    onSelectModel: (modelId: String) -> Unit,
    onToggleModelPicker: () -> Unit,
    onToggleManageModels: () -> Unit,
    onSetModelHidden: (modelId: String, hidden: Boolean) -> Unit,
) {
    val confirmedName =
        uiState.modelCatalog.firstOrNull { it.id == uiState.currentModelId }?.displayName
            ?: uiState.currentModelId
    val headerLabel = confirmedName ?: stringResource(R.string.model_unavailable)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = headerLabel,
            style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.fillMaxWidth().clickable(onClick = onToggleModelPicker),
        )
        uiState.pendingModelId?.let { pendingId ->
            val pendingName = uiState.modelCatalog.firstOrNull { it.id == pendingId }?.displayName ?: pendingId
            Text("${stringResource(R.string.model_pending)}: $pendingName")
        }
        uiState.modelError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(
            onClick = onRefreshModels,
            enabled = !uiState.modelsLoading && uiState.selectedSessionId != null,
        ) { Text(stringResource(R.string.model_refresh)) }
        Button(
            onClick = onToggleManageModels,
            enabled = uiState.selectedSessionId != null,
        ) { Text(stringResource(R.string.manage_models)) }
        if (uiState.modelPickerVisible) {
            ModelPickerList(uiState = uiState, onSelectModel = onSelectModel)
        }
        if (uiState.manageModelsVisible) {
            ManageModelsDialog(
                uiState = uiState,
                onDismiss = onToggleManageModels,
                onSetModelHidden = onSetModelHidden,
            )
        }
    }
}

@Composable
private fun ModelPickerList(
    uiState: CursorRemoteUiState,
    onSelectModel: (modelId: String) -> Unit,
) {
    Text(stringResource(R.string.model_select), style = MaterialTheme.typography.titleSmall)
    Column(
        Modifier.fillMaxWidth().heightIn(max = 280.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        uiState.pickerModels.forEach { model ->
            val pending = uiState.pendingModelId != null || uiState.modelsLoading
            TextButton(
                onClick = { onSelectModel(model.id) },
                enabled = !pending && model.id != uiState.currentModelId,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(model.displayName, modifier = Modifier.fillMaxWidth())
            }
        }
    }
}

@Composable
private fun ManageModelsDialog(
    uiState: CursorRemoteUiState,
    onDismiss: () -> Unit,
    onSetModelHidden: (modelId: String, hidden: Boolean) -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.manage_models)) },
        text = {
            Column(
                Modifier.fillMaxWidth().heightIn(max = 360.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                uiState.modelCatalog.forEach { model ->
                    ManageModelRow(
                        model = model,
                        hidden = model.id in uiState.hiddenModelIds,
                        onSetModelHidden = onSetModelHidden,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.manage_models_close)) }
        },
    )
}

@Composable
private fun ManageModelRow(
    model: ModelCatalogEntry,
    hidden: Boolean,
    onSetModelHidden: (modelId: String, hidden: Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(model.displayName)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!model.available) {
                    Text(stringResource(R.string.model_unavailable))
                }
                Text(if (hidden) stringResource(R.string.model_hidden) else stringResource(R.string.model_visible))
            }
        }
        TextButton(onClick = { onSetModelHidden(model.id, !hidden) }) {
            Text(if (hidden) stringResource(R.string.model_show) else stringResource(R.string.model_hide))
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
private fun ChatMessageRow(
    message: ChatMessage,
    onOpenFile: (path: String, startLine: Int?, endLine: Int?) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(chatRoleLabel(message.role), style = MaterialTheme.typography.titleSmall)
        if (message.role == ChatRole.User) {
            Text(message.text)
        } else {
            AssistantMessageText(message.text, onOpenFile)
        }
    }
}

@Composable
private fun AssistantMessageText(
    text: String,
    onOpenFile: (path: String, startLine: Int?, endLine: Int?) -> Unit,
) {
    val refs = parseFileReferences(text)
    if (refs.isEmpty()) {
        Text(text)
        return
    }
    val linkStyles =
        TextLinkStyles(
            style =
                SpanStyle(
                    color = MaterialTheme.colorScheme.primary,
                    textDecoration = TextDecoration.Underline,
                ),
        )
    val annotated =
        buildAnnotatedString {
            var last = 0
            for (ref in refs) {
                if (ref.startIndex > last) {
                    append(text.substring(last, ref.startIndex))
                }
                withLink(
                    LinkAnnotation.Clickable(
                        tag = "file:${ref.startIndex}",
                        styles = linkStyles,
                        linkInteractionListener = { onOpenFile(ref.path, ref.startLine, ref.endLine) },
                    ),
                ) {
                    append(text.substring(ref.startIndex, ref.endIndex))
                }
                last = ref.endIndex
            }
            if (last < text.length) {
                append(text.substring(last))
            }
        }
    Text(text = annotated)
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
