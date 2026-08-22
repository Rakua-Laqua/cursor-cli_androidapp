package dev.cursorremote.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.cursorremote.android.state.FileViewerState

@Composable
fun FileViewerScreen(
    state: FileViewerState,
    onReload: () -> Unit,
    onClose: () -> Unit,
) {
    val clipboard = LocalClipboardManager.current
    val lines =
        remember(state.content) {
            state.content?.replace("\r\n", "\n")?.split('\n') ?: emptyList()
        }
    val listState = rememberLazyListState()
    val rangeStart = state.startLine
    val rangeEnd = state.endLine
    val rangeLabel =
        when {
            rangeStart != null && rangeEnd != null -> "${state.path}:$rangeStart-$rangeEnd"
            rangeStart != null -> "${state.path}:$rangeStart"
            else -> state.path
        }
    BackHandler(onBack = onClose)
    LaunchedEffect(state.content, state.startLine, lines.size) {
        if (lines.isEmpty()) {
            return@LaunchedEffect
        }
        val target = ((rangeStart ?: 1) - 1).coerceIn(0, lines.lastIndex)
        listState.scrollToItem(target)
    }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        TextButton(onClick = onClose) { Text("Close") }
        Text("File", style = MaterialTheme.typography.headlineSmall)
        Text(rangeLabel)
        if (state.truncated) {
            Text("truncated")
        }
        if (state.loading) {
            Text("Loading")
        }
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onReload, enabled = !state.loading) { Text("Reload") }
            Button(
                onClick = { state.content?.let { clipboard.setText(AnnotatedString(it)) } },
                enabled = state.content != null,
            ) { Text("Copy") }
        }
        if (lines.isNotEmpty()) {
            val lineNumberWidth = lines.size.toString().length
            LazyColumn(
                modifier = Modifier.fillMaxWidth().weight(1f),
                state = listState,
                verticalArrangement = Arrangement.spacedBy(0.dp),
            ) {
                items(lines.size) { index ->
                    val line = lines[index]
                    val lineNumber = index + 1
                    val inRange =
                        rangeStart != null &&
                            lineNumber >= rangeStart &&
                            lineNumber <= (rangeEnd ?: rangeStart)
                    Row(
                        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(
                            text = lineNumber.toString().padStart(lineNumberWidth),
                            fontFamily = FontFamily.Monospace,
                            color =
                                if (inRange) {
                                    MaterialTheme.colorScheme.primary
                                } else {
                                    MaterialTheme.colorScheme.onSurfaceVariant
                                },
                            modifier = Modifier.widthIn(min = 32.dp),
                        )
                        Text(
                            text = line,
                            fontFamily = FontFamily.Monospace,
                            softWrap = false,
                            color =
                                if (inRange) {
                                    MaterialTheme.colorScheme.primary
                                } else {
                                    MaterialTheme.colorScheme.onSurface
                                },
                        )
                    }
                }
            }
        }
    }
}
