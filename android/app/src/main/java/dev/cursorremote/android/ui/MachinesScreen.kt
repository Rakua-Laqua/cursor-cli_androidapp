package dev.cursorremote.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.weight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.cursorremote.android.data.remote.RemoteConnectionState
import dev.cursorremote.android.state.CursorRemoteUiState
import java.time.Instant

@Composable
fun MachinesScreen(
    uiState: CursorRemoteUiState,
    onRegister: (pairingJson: String, displayName: String) -> Unit,
    onSelectMachine: (machineId: String) -> Unit,
) {
    var displayName by rememberSaveable { mutableStateOf("") }
    var pairingJson by rememberSaveable { mutableStateOf("") }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Machines", style = MaterialTheme.typography.headlineSmall)
        StatusBlock(uiState)
        OutlinedTextField(
            value = displayName,
            onValueChange = { displayName = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Display name (optional)") },
            enabled = !uiState.isLoading,
            singleLine = true,
        )
        OutlinedTextField(
            value = pairingJson,
            onValueChange = { pairingJson = it },
            modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp),
            label = { Text("Pairing QR JSON") },
            enabled = !uiState.isLoading,
        )
        Button(
            onClick = { onRegister(pairingJson, displayName) },
            enabled = !uiState.isLoading && pairingJson.isNotBlank(),
        ) { Text("Register from Pairing JSON") }
        if (!uiState.isLoading && uiState.machines.isEmpty()) {
            Text("No machines")
        }
        LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(uiState.machines, key = { it.id }) { machine ->
                val online = uiState.selectedMachineId == machine.id && uiState.remoteConnection == RemoteConnectionState.Ready
                Column(
                    Modifier.fillMaxWidth().clickable(enabled = !uiState.isLoading) { onSelectMachine(machine.id) }.padding(vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(machine.displayName.ifBlank { machine.id }, style = MaterialTheme.typography.titleMedium)
                    Text(if (online) "Online" else "Offline")
                    Text("Last connected: ${machine.lastConnectedAt?.let { Instant.ofEpochMilli(it).toString() } ?: "—"}")
                }
            }
        }
    }
}
