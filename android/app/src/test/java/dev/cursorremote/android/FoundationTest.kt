package dev.cursorremote.android

import dev.cursorremote.android.data.local.MachineDao
import dev.cursorremote.android.data.local.MachineEntity
import dev.cursorremote.android.data.protocol.RemoteProtocol
import dev.cursorremote.android.data.remote.RemoteConnectionState
import dev.cursorremote.android.data.remote.RemoteRepository
import dev.cursorremote.android.data.security.DeviceCredentialStore
import dev.cursorremote.android.data.transport.ConnectionState
import dev.cursorremote.android.data.transport.TransportMessage
import dev.cursorremote.android.data.transport.WebSocketTransport
import dev.cursorremote.android.state.CursorRemoteViewModel
import dev.cursorremote.android.ui.AppDestination
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
        assertEquals("TASK-204", AppDestination.Chat.unimplementedTaskId)
    }

    @Test
    fun initialUiStateHasNoSelectionAndDisconnectedTransport() {
        withViewModel { viewModel, _, _ ->
            val state = viewModel.uiState.value
            assertNull(state.selectedMachineId)
            assertNull(state.selectedWorkspaceId)
            assertNull(state.selectedSessionId)
            assertTrue(state.machines.isEmpty())
            assertTrue(state.workspaces.isEmpty())
            assertTrue(state.sessions.isEmpty())
            assertEquals(ConnectionState.Disconnected, viewModel.connectionState.value)
            assertEquals(RemoteConnectionState.Disconnected, state.remoteConnection)
        }
    }

    @Test
    fun selectingMachineClearsWorkspaceAndSession() {
        withViewModel { viewModel, _, _ ->
            viewModel.selectMachine("machine-1")
            viewModel.selectWorkspace("workspace-1")
            viewModel.selectSession("session-1")
            viewModel.selectMachine("machine-2")
            val state = viewModel.uiState.value
            assertEquals("machine-2", state.selectedMachineId)
            assertNull(state.selectedWorkspaceId)
            assertNull(state.selectedSessionId)
            assertTrue(state.workspaces.isEmpty())
            assertTrue(state.sessions.isEmpty())
        }
    }

    @Test
    fun selectingWorkspaceClearsSession() {
        withViewModel { viewModel, _, _ ->
            viewModel.selectMachine("machine-1")
            viewModel.selectWorkspace("workspace-1")
            viewModel.selectSession("session-1")
            viewModel.selectWorkspace("workspace-2")
            val state = viewModel.uiState.value
            assertEquals("machine-1", state.selectedMachineId)
            assertEquals("workspace-2", state.selectedWorkspaceId)
            assertNull(state.selectedSessionId)
            assertTrue(state.sessions.isEmpty())
        }
    }

    @Test
    fun pairingJsonSuccessLoadsWorkspacesAndInvalidQrStaysOnMachineScreen() {
        withViewModel { viewModel, dao, _ ->
            runBlocking { assertTrue(viewModel.registerFromPairingJson(validQrJson(), "PC")) }
            val success = viewModel.uiState.value
            assertEquals("pc-1", success.selectedMachineId)
            assertEquals("PC", dao.machines.value.single().displayName)
            assertEquals("device-1", dao.machines.value.single().deviceId)
            assertEquals("ws-1", success.workspaces.single().workspaceId)
            assertNull(success.errorMessage)
            runBlocking { assertFalse(viewModel.registerFromPairingJson("{", "PC")) }
            assertEquals("pc-1", viewModel.uiState.value.selectedMachineId)
            assertTrue(viewModel.uiState.value.errorMessage != null)
        }
    }

    @Test
    fun existingMachineReauthWorkspaceListNewAndResumeSession() {
        withViewModel { viewModel, dao, _ ->
            runBlocking {
                dao.upsert(pairedMachine())
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertEquals("ws-1", viewModel.uiState.value.workspaces.single().workspaceId)
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertEquals("sess-1", viewModel.uiState.value.sessions.single().remoteSessionId)
                assertTrue(viewModel.createSession())
                assertEquals("sess-new", viewModel.uiState.value.selectedSessionId)
                assertTrue(viewModel.resumeSession("sess-1"))
                assertEquals("sess-1", viewModel.uiState.value.selectedSessionId)
            }
        }
    }

    @Test
    fun listAndResumeFailuresStayOnCurrentSelection() {
        withViewModel(autoRespond = false) { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                transport.onSend = { text ->
                    val requestId = requestIdOf(text)
                    val failing = commandType(text) == "session.load"
                    transport.emit(
                        if (failing) {
                            resultJson(requestId, ok = false, value = "null", error = "missing")
                        } else {
                            successBody(requestId, text)
                        },
                    )
                }
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertFalse(viewModel.resumeSession("sess-1"))
                assertNull(viewModel.uiState.value.selectedSessionId)
                assertEquals("missing", viewModel.uiState.value.errorMessage)
                assertEquals("ws-1", viewModel.uiState.value.selectedWorkspaceId)
                assertEquals(RemoteConnectionState.Ready, viewModel.uiState.value.remoteConnection)
            }
        }
    }

    private fun withViewModel(
        autoRespond: Boolean = true,
        block: (CursorRemoteViewModel, FakeMachineDao, FakeTransport) -> Unit,
    ) {
        val job = SupervisorJob()
        val scope = CoroutineScope(job + Dispatchers.Unconfined)
        val dao = FakeMachineDao()
        val transport = FakeTransport(autoRespond)
        val repository =
            RemoteRepository(
                transport = transport,
                credentialStore = JavaEcdsaCredentialStore(),
                scope = scope,
                requestTimeoutMs = 1_000,
            )
        val viewModel =
            CursorRemoteViewModel(
                machineDao = dao,
                remoteRepository = repository,
                coroutineScope = scope,
                nowMillis = { 1_699_000_000_000L },
            )
        try {
            block(viewModel, dao, transport)
        } finally {
            repository.disconnect()
            job.cancel()
        }
    }

    private fun validQrJson(): String {
        val token = RemoteProtocol.encodeBase64Url(ByteArray(32) { 3 })
        return """{"v":1,"relayUrl":"ws://127.0.0.1:8787","machineId":"pc-1","token":"$token","expiresAt":1700000000000}"""
    }

    private fun pairedMachine(): MachineEntity {
        return MachineEntity("pc-1", "PC", "ws://127.0.0.1:8787", "device-1", 1L)
    }
}

internal class FakeMachineDao : MachineDao {
    val machines = MutableStateFlow<List<MachineEntity>>(emptyList())

    override fun observeMachines(): Flow<List<MachineEntity>> = machines

    override suspend fun getMachine(id: String): MachineEntity? = machines.value.find { it.id == id }

    override suspend fun upsert(machine: MachineEntity) {
        machines.value = machines.value.filter { it.id != machine.id } + machine
    }

    override suspend fun updateConnectionInfo(
        id: String,
        relayUrl: String,
        deviceId: String,
        lastConnectedAt: Long,
    ) {
        machines.value =
            machines.value.map { machine ->
                if (machine.id == id) {
                    machine.copy(relayUrl = relayUrl, deviceId = deviceId, lastConnectedAt = lastConnectedAt)
                } else {
                    machine
                }
            }
    }
}

internal class FakeTransport(
    autoRespond: Boolean,
    initialAutoChallenge: Boolean = true,
) : WebSocketTransport {
    private val _connectionState = MutableStateFlow(ConnectionState.Disconnected)
    private val _incoming = MutableSharedFlow<TransportMessage>(extraBufferCapacity = 64)
    override val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()
    override val incomingMessages = _incoming.asSharedFlow()
    override var generation: Long = 0L
        private set
    var connectUrl: String? = null
    val sent = mutableListOf<String>()
    var autoChallenge = initialAutoChallenge
    var onSend: ((String) -> Unit)? = if (autoRespond) ({ text -> emit(successBody(requestIdOf(text), text)) }) else null
    var onConnect: (() -> Unit)? = null

    override fun connect(url: String) {
        connectUrl = url
        generation += 1
        _connectionState.value = ConnectionState.Connected
        onConnect?.invoke()
        if (autoChallenge && _connectionState.value == ConnectionState.Connected) {
            val nonce = RemoteProtocol.encodeBase64Url(ByteArray(32) { 4 })
            emit("""{"kind":"auth_challenge","nonce":"$nonce"}""")
        }
    }

    override fun send(text: String) {
        sent += text
        onSend?.invoke(text)
    }

    override fun disconnect() {
        _connectionState.value = ConnectionState.Disconnected
    }

    fun emit(
        text: String,
        generationOverride: Long? = null,
    ) {
        _incoming.tryEmit(TransportMessage(generationOverride ?: generation, text))
    }

    fun fail() {
        _connectionState.value = ConnectionState.Failed
    }
}

internal class JavaEcdsaCredentialStore : DeviceCredentialStore {
    private val keyPair: KeyPair =
        KeyPairGenerator.getInstance("EC").run {
            initialize(ECGenParameterSpec("secp256r1"))
            generateKeyPair()
        }

    override fun createDeviceKey(): PublicKey = keyPair.public

    override fun getDeviceKey(): PublicKey? = keyPair.public

    override fun deleteDeviceKey() = Unit

    override fun signSha256Ecdsa(payload: ByteArray): ByteArray {
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(keyPair.private)
        signature.update(payload)
        return signature.sign()
    }
}

internal fun requestIdOf(text: String): String {
    val root = Json.parseToJsonElement(text).jsonObject
    return if (root["kind"]?.jsonPrimitive?.content == "command") {
        root.getValue("command").jsonObject.getValue("requestId").jsonPrimitive.content
    } else {
        root.getValue("requestId").jsonPrimitive.content
    }
}

internal fun commandType(text: String): String? {
    val root = Json.parseToJsonElement(text).jsonObject
    if (root["kind"]?.jsonPrimitive?.content != "command") {
        return null
    }
    return root.getValue("command").jsonObject.getValue("type").jsonPrimitive.content
}

internal fun resultJson(
    requestId: String,
    ok: Boolean,
    value: String,
    error: String? = null,
): String {
    val errorJson = if (error == null) "null" else "\"$error\""
    return """{"kind":"result","result":{"requestId":"$requestId","ok":$ok,"value":$value,"error":$errorJson}}"""
}

internal fun successBody(
    requestId: String,
    text: String,
): String {
    val value =
        when (Json.parseToJsonElement(text).jsonObject.getValue("kind").jsonPrimitive.content) {
            "pair", "auth_proof" -> """{"deviceId":"device-1"}"""
            "command" ->
                when (commandType(text)) {
                    "workspace.list" ->
                        """[{"workspaceId":"ws-1","name":"app","path":"/app","gitBranch":"main","modified":false,"activeSessionCount":0,"lastUsedAt":null}]"""
                    "session.list" ->
                        """[{"remoteSessionId":"sess-1","cursorSessionId":null,"workspaceId":"ws-1","title":"Session","status":"idle","createdAt":"c","updatedAt":"u"}]"""
                    "session.create" ->
                        """{"remoteSessionId":"sess-new","cursorSessionId":null,"workspaceId":"ws-1","title":"Session","status":"idle","createdAt":"c","updatedAt":"u"}"""
                    "session.load" ->
                        """{"remoteSessionId":"sess-1","cursorSessionId":null,"workspaceId":"ws-1","title":"Session","status":"idle","createdAt":"c","updatedAt":"u"}"""
                    else -> "null"
                }
            else -> "null"
        }
    return resultJson(requestId, ok = true, value = value)
}
