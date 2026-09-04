package dev.cursorremote.android.data.remote

import dev.cursorremote.android.FakeTransport
import dev.cursorremote.android.JavaEcdsaCredentialStore
import dev.cursorremote.android.commandType
import dev.cursorremote.android.eventJson
import dev.cursorremote.android.hangSessionSend
import dev.cursorremote.android.lastCommand
import dev.cursorremote.android.requestIdOf
import dev.cursorremote.android.resultJson
import dev.cursorremote.android.successBody
import dev.cursorremote.android.data.local.NavigationSelection
import dev.cursorremote.android.data.local.ReliabilityStore
import dev.cursorremote.android.data.local.VolatileReliabilityStore
import dev.cursorremote.android.data.protocol.PairingQrPayload
import dev.cursorremote.android.data.protocol.RemoteEvent
import dev.cursorremote.android.data.protocol.RemoteProtocol
import dev.cursorremote.android.data.transport.ConnectionState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class RemoteRepositoryTest {
    @Test
    fun pairCorrelatesRequestIdAndReachesReady() =
        withRepository { repo, transport ->
            assertEquals("device-1", repo.pair(qrPayload()))
            assertEquals(RemoteConnectionState.Ready, repo.connectionState.value)
            assertEquals("ws://127.0.0.1:8787/client?machineId=pc-1", transport.connectUrl)
            assertEquals(true, transport.sent.first().contains("\"kind\":\"pair\""))
            assertEquals("sync.catch_up", commandType(lastCommand(transport, "sync.catch_up")))
            assertEquals(true, lastCommand(transport, "sync.catch_up").contains("\"lastEventId\":null"))
        }

    @Test
    fun authProofAndCommandsUseRequestIdAndRejectWhenDisconnected() =
        withRepository { repo, transport ->
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            assertEquals(true, transport.sent.any { it.contains("\"kind\":\"auth_proof\"") })
            assertEquals("sync.catch_up", commandType(lastCommand(transport, "sync.catch_up")))
            assertEquals("ws-1", repo.listWorkspaces().single().workspaceId)
            assertEquals("sess-1", repo.listSessions("ws-1").single().remoteSessionId)
            assertEquals("sess-new", repo.createSession("ws-1").remoteSessionId)
            assertEquals("sess-1", repo.loadSession("sess-1").remoteSessionId)
            repo.disconnect()
            try {
                repo.listWorkspaces()
                fail("expected not authenticated")
            } catch (error: RemoteRepositoryException) {
                assertEquals("Not authenticated", error.message)
            }
        }

    @Test
    fun authFailuresSetFailedAndDisconnect() {
        withRepository(timeoutMs = 50, autoRespond = false, autoChallenge = false) { repo, transport ->
            assertAuthFailure(repo, transport, "Authentication timed out") { it.pair(qrPayload()) }
        }
        withRepository(timeoutMs = 50, autoRespond = false) { repo, transport ->
            transport.onSend = { text ->
                transport.emit(resultJson(requestIdOf(text), ok = false, value = "null", error = "nope"))
            }
            assertAuthFailure(repo, transport, "nope") { it.pair(qrPayload()) }
        }
        withRepository(timeoutMs = 50, autoRespond = false) { repo, transport ->
            transport.onSend = { text ->
                transport.emit(
                    resultJson(requestIdOf(text), ok = true, value = """{"deviceId":"device-1"}"""),
                    generationOverride = 0,
                )
            }
            assertAuthFailure(repo, transport, "Authentication timed out") {
                it.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            }
        }
        withRepository(autoRespond = false) { repo, transport ->
            transport.onSend = { text ->
                transport.emit(resultJson(requestIdOf(text), ok = true, value = """{"deviceId":"other"}"""))
            }
            assertAuthFailure(repo, transport, "deviceId does not match the paired device.") {
                it.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            }
        }
    }

    @Test
    fun failedSocketFailsPendingRequests() =
        withRepository(autoRespond = false, autoChallenge = false) { repo, transport ->
            transport.onConnect = { transport.fail() }
            assertAuthFailure(repo, transport, "Connection failed", expectSocketDisconnected = false) {
                it.pair(qrPayload())
            }
        }

    @Test
    fun unexpectedChallengeWhileReadyFailsConnection() =
        withRepository { repo, transport ->
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            val nonce = RemoteProtocol.encodeBase64Url(ByteArray(32) { 9 })
            transport.emit("""{"kind":"auth_challenge","nonce":"$nonce"}""")
            assertEquals(RemoteConnectionState.Failed, repo.connectionState.value)
            assertEquals(ConnectionState.Disconnected, transport.connectionState.value)
        }

    @Test
    fun eventsAreDispatchedSendWaitsBeyondTimeoutAndCancelRunsConcurrently() =
        withRepository(timeoutMs = 80) { repo, transport ->
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            hangSessionSend(transport)
            val received = mutableListOf<RemoteEvent>()
            val collectJob = launch(Dispatchers.Unconfined) { repo.events.collect { received += it } }
            transport.emit(eventJson("session.status_changed", "sess-1", """{"status":"running"}"""))
            assertEquals("session.status_changed", received.single().type)
            val sendJob =
                async {
                    repo.sendSessionPrompt("sess-1", "hello")
                }
            delay(160)
            assertTrue(sendJob.isActive)
            val sendFrame = lastCommand(transport, "session.send")
            assertTrue(sendFrame.contains("\"sessionId\":\"sess-1\""))
            assertTrue(sendFrame.contains("\"type\":\"session.send\""))
            repo.cancelSession("sess-1")
            assertTrue(lastCommand(transport, "session.cancel").contains("\"sessionId\":\"sess-1\""))
            assertTrue(sendJob.isActive)
            transport.emit(resultJson(requestIdOf(sendFrame), ok = true, value = "null"))
            sendJob.await()
            collectJob.cancel()
        }

    @Test
    fun moreThanBufferEventsAreDeliveredInOrderWithoutDrop() =
        withRepository { repo, transport ->
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            val received = mutableListOf<RemoteEvent>()
            val collectJob = launch(Dispatchers.Unconfined) { repo.events.collect { received += it } }
            repeat(120) { index ->
                transport.emit(
                    eventJson(
                        "assistant.message",
                        "sess-1",
                        """{"text":"$index","delta":true}""",
                        eventId = "evt-$index",
                    ),
                )
            }
            assertEquals(120, received.size)
            assertEquals((0 until 120).map { "evt-$it" }, received.map { it.eventId })
            collectJob.cancel()
        }

    @Test
    fun permissionCommandsUsePermissionIdOnlyAndStayOnTheSession() =
        withRepository { repo, transport ->
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            hangSessionSend(transport)
            repo.approvePermission("sess-1", "perm-1")
            val approve = lastCommand(transport, "permission.approve")
            assertTrue(approve.contains("\"sessionId\":\"sess-1\""))
            assertTrue(approve.contains("\"permissionId\":\"perm-1\""))
            assertTrue(approve.contains("\"type\":\"permission.approve\""))
            assertEquals(false, approve.contains("optionId"))
            assertEquals(false, approve.contains("allow-always"))
            repo.rejectPermission("sess-1", "perm-1")
            val reject = lastCommand(transport, "permission.reject")
            assertTrue(reject.contains("\"sessionId\":\"sess-1\""))
            assertTrue(reject.contains("\"permissionId\":\"perm-1\""))
            assertEquals(false, reject.contains("risk"))
            assertEquals(false, reject.contains("policy"))
        }

    @Test
    fun diffReadSendsOnlyWorkspaceIdAndNullSessionId() =
        withRepository { repo, transport ->
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            val snapshot = repo.readDiff("ws-1")
            assertEquals("ws-1", snapshot.workspaceId)
            val frame = lastCommand(transport, "diff.read")
            assertTrue(frame.contains("\"type\":\"diff.read\""))
            assertTrue(frame.contains("\"sessionId\":null"))
            assertTrue(frame.contains("\"workspaceId\":\"ws-1\""))
            assertEquals("""{"workspaceId":"ws-1"}""", RemoteProtocol.diffReadPayload("ws-1").toString())
            assertEquals(false, frame.contains("gitArgs"))
            assertEquals(false, frame.contains("\"path\""))
        }

    @Test
    fun fileReadSendsSessionIdAndPathOnly() =
        withRepository { repo, transport ->
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            val content = repo.readFile("sess-1", "src/foo.ts")
            assertEquals("src/foo.ts", content.path)
            assertEquals("file-body", content.content)
            assertEquals(false, content.truncated)
            val frame = lastCommand(transport, "file.read")
            assertTrue(frame.contains("\"type\":\"file.read\""))
            assertTrue(frame.contains("\"sessionId\":\"sess-1\""))
            assertTrue(frame.contains("\"path\":\"src/foo.ts\""))
            assertEquals("""{"path":"src/foo.ts"}""", RemoteProtocol.fileReadPayload("src/foo.ts").toString())
            assertEquals(false, frame.contains("workspaceId"))
            assertEquals(false, frame.contains("startLine"))
            assertEquals(false, frame.contains("endLine"))
        }

    @Test
    fun modelListAndSelectSendSessionIdAndParseFixtureCatalog() =
        withRepository { repo, transport ->
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            val listed = repo.listModels("sess-1")
            assertEquals(listOf("mock-model", "mock-fast", "fixture-added-model", "unavailable-mock"), listed.models.map { it.id })
            assertEquals("mock-model", listed.currentModelId)
            assertEquals("fixture-added-model", listed.models.first { it.id == "fixture-added-model" }.displayName)
            val listFrame = lastCommand(transport, "model.list")
            assertTrue(listFrame.contains("\"type\":\"model.list\""))
            assertTrue(listFrame.contains("\"sessionId\":\"sess-1\""))
            assertEquals("{}", RemoteProtocol.modelListPayload().toString())
            val selected = repo.selectModel("sess-1", "fixture-added-model")
            assertEquals("fixture-added-model", selected.currentModelId)
            val selectFrame = lastCommand(transport, "model.select")
            assertTrue(selectFrame.contains("\"type\":\"model.select\""))
            assertTrue(selectFrame.contains("\"sessionId\":\"sess-1\""))
            assertTrue(selectFrame.contains("\"modelId\":\"fixture-added-model\""))
            assertEquals("""{"modelId":"fixture-added-model"}""", RemoteProtocol.modelSelectPayload("fixture-added-model").toString())
        }

    @Test
    fun disconnectFailsInFlightSessionSend() =
        withRepository { repo, transport ->
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            hangSessionSend(transport)
            val sendJob =
                async(start = CoroutineStart.UNDISPATCHED) {
                    try {
                        repo.sendSessionPrompt("sess-1", "hello")
                        fail("expected disconnect")
                    } catch (error: RemoteRepositoryException) {
                        assertEquals("Disconnected", error.message)
                    }
                }
            assertTrue(sendJob.isActive)
            repo.disconnect()
            sendJob.await()
        }

    @Test
    fun catchUpBaselinesNullCursorThenReplaysHeldCursorAndDedupsLiveOverlap() =
        withRepository(autoRespond = false) { repo, transport ->
            val received = mutableListOf<RemoteEvent>()
            val collectJob = launch(Dispatchers.Unconfined) { repo.events.collect { received += it } }
            transport.onSend = { text ->
                when (commandType(text)) {
                    "sync.catch_up" -> {
                        val lastEventId =
                            Json.parseToJsonElement(text)
                                .jsonObject
                                .getValue("command")
                                .jsonObject
                                .getValue("payload")
                                .jsonObject
                                .getValue("lastEventId")
                        if (lastEventId.toString() == "null") {
                            transport.emit(
                                resultJson(
                                    requestIdOf(text),
                                    ok = true,
                                    value =
                                        """{"status":"replayed","events":[],"headEventId":"evt-head","pendingPermission":null}""",
                                ),
                            )
                        } else {
                            transport.emit(
                                eventJson("assistant.message", "sess-1", """{"text":"live","delta":true}""", eventId = "evt-live"),
                            )
                            transport.emit(
                                eventJson("assistant.message", "sess-1", """{"text":"dup","delta":true}""", eventId = "evt-2"),
                            )
                            transport.emit(
                                resultJson(
                                    requestIdOf(text),
                                    ok = true,
                                    value =
                                        """{"status":"replayed","events":[{"eventId":"evt-1","sessionId":"sess-1","timestamp":"t","type":"assistant.message","payload":{"text":"one","delta":true}},{"eventId":"evt-2","sessionId":"sess-1","timestamp":"t","type":"assistant.message","payload":{"text":"two","delta":true}}],"headEventId":"evt-2","pendingPermission":null}""",
                                ),
                            )
                        }
                    }
                    else -> transport.emit(successBody(requestIdOf(text), text))
                }
            }
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            assertTrue(received.isEmpty())
            assertEquals(true, lastCommand(transport, "sync.catch_up").contains("\"lastEventId\":null"))
            assertEquals(RemoteConnectionState.Ready, repo.connectionState.value)
            repo.disconnect()
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            assertEquals(true, lastCommand(transport, "sync.catch_up").contains("\"lastEventId\":\"evt-head\""))
            assertEquals(listOf("evt-1", "evt-2", "evt-live"), received.map { it.eventId })
            assertEquals(RemoteConnectionState.Ready, repo.connectionState.value)
            transport.emit(eventJson("assistant.message", "sess-1", """{"text":"again","delta":true}""", eventId = "evt-2"))
            assertEquals(listOf("evt-1", "evt-2", "evt-live"), received.map { it.eventId })
            collectJob.cancel()
        }

    @Test
    fun catchUpNullDoesNotRestoreBodiesAndReconnectSendsHeldCursorPerMachine() =
        withRepository { repo, transport ->
            val received = mutableListOf<RemoteEvent>()
            val collectJob = launch(Dispatchers.Unconfined) { repo.events.collect { received += it } }
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            assertEquals(true, lastCommand(transport, "sync.catch_up").contains("\"lastEventId\":null"))
            assertTrue(received.isEmpty())
            transport.emit(eventJson("assistant.message", "sess-1", """{"text":"a","delta":true}""", eventId = "evt-a"))
            assertEquals(listOf("evt-a"), received.map { it.eventId })
            repo.disconnect()
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            assertEquals(true, lastCommand(transport, "sync.catch_up").contains("\"lastEventId\":\"evt-a\""))
            repo.authenticate("ws://127.0.0.1:8787", "pc-2", "device-1")
            assertEquals(true, lastCommand(transport, "sync.catch_up").contains("\"lastEventId\":null"))
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            assertEquals(true, lastCommand(transport, "sync.catch_up").contains("\"lastEventId\":\"evt-a\""))
            collectJob.cancel()
        }

    @Test
    fun catchUpGapAndSyncFailureFailOrExposeGapWithoutReadyOnParseError() =
        withRepository(autoRespond = false) { repo, transport ->
            transport.onSend = { text ->
                if (commandType(text) == "sync.catch_up") {
                    transport.emit(
                        resultJson(
                            requestIdOf(text),
                            ok = true,
                            value = """{"status":"gap","events":[],"headEventId":"evt-head","pendingPermission":null}""",
                        ),
                    )
                } else {
                    transport.emit(successBody(requestIdOf(text), text))
                }
            }
            val result = repo.reconnect("ws://127.0.0.1:8787", "pc-1", "device-1", null)
            assertEquals(RemoteConnectionState.Ready, repo.connectionState.value)
            assertEquals("gap", result.catchUp.status)
            assertEquals("evt-head", result.catchUp.headEventId)
        }

    @Test
    fun catchUpFailureFailsConnection() {
        withRepository(autoRespond = false) { repo, transport ->
            transport.onSend = { text ->
                if (commandType(text) == "sync.catch_up") {
                    transport.emit(resultJson(requestIdOf(text), ok = false, value = "null", error = "sync failed"))
                } else {
                    transport.emit(successBody(requestIdOf(text), text))
                }
            }
            assertAuthFailure(repo, transport, "sync failed") {
                it.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            }
        }
    }

    @Test
    fun reconnectApiReauthsSelectedSession() =
        withRepository { repo, transport ->
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1", "sess-1")
            assertEquals(true, lastCommand(transport, "sync.catch_up").contains("\"sessionId\":\"sess-1\""))
            repo.disconnect()
            repo.reconnect("ws://127.0.0.1:8787", "pc-1", "device-1", "sess-1")
            assertEquals(RemoteConnectionState.Ready, repo.connectionState.value)
            assertEquals(true, lastCommand(transport, "sync.catch_up").contains("\"sessionId\":\"sess-1\""))
        }

    @Test
    fun liveQueueOverflowFailsCatchUpInsteadOfReady() =
        withRepository(autoRespond = false, liveQueueLimit = 2) { repo, transport ->
            transport.onSend = { text ->
                if (commandType(text) != "sync.catch_up") {
                    transport.emit(successBody(requestIdOf(text), text))
                }
            }
            val authJob =
                async(start = CoroutineStart.UNDISPATCHED) {
                    try {
                        repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
                        fail("expected overflow")
                    } catch (error: RemoteRepositoryException) {
                        assertEquals("Event buffer overflow", error.message)
                    }
                }
            assertEquals("sync.catch_up", commandType(lastCommand(transport, "sync.catch_up")))
            repeat(3) { index ->
                transport.emit(
                    eventJson(
                        "assistant.message",
                        "sess-1",
                        """{"text":"$index","delta":true}""",
                        eventId = "evt-overflow-$index",
                    ),
                )
            }
            authJob.await()
            assertEquals(RemoteConnectionState.Failed, repo.connectionState.value)
            assertEquals(ConnectionState.Disconnected, transport.connectionState.value)
        }

    @Test
    fun transportRegisterSendsOnlyWhenReadyAndCorrelatesResult() {
        withRepository { repo, transport ->
            try {
                repo.updateTransportRegistration("d1.tok-APA91b:x", true)
                fail("expected not authenticated")
            } catch (error: RemoteRepositoryException) {
                assertEquals("Not authenticated", error.message)
            }
            assertEquals(0, transport.sent.count { frameKind(it) == "transport_register" })
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            repo.updateTransportRegistration("d1.tok-APA91b:x", false)
            val frame = transport.sent.last { frameKind(it) == "transport_register" }
            assertEquals("transport_register", frameKind(frame))
            assertEquals(null, commandType(frame))
            assertTrue(frame.contains("\"fcmToken\":\"d1.tok-APA91b:x\""))
            assertTrue(frame.contains("\"appForeground\":false"))
            repo.updateTransportRegistration(null, true)
            assertTrue(transport.sent.last { frameKind(it) == "transport_register" }.contains("\"fcmToken\":null"))
            repo.disconnect()
            try {
                repo.updateTransportRegistration("d1.tok-APA91b:x", true)
                fail("expected not authenticated")
            } catch (error: RemoteRepositoryException) {
                assertEquals("Not authenticated", error.message)
            }
        }
    }

    @Test
    fun sharedReliabilityStoreHydratesCursorAndIgnoresDuplicates() {
        val store = VolatileReliabilityStore()
        withRepository(autoRespond = false, reliabilityStore = store) { repo, transport ->
            val received = mutableListOf<RemoteEvent>()
            val collectJob = launch(Dispatchers.Unconfined) { repo.events.collect { received += it } }
            transport.onSend = { text ->
                if (commandType(text) == "sync.catch_up") {
                    transport.emit(
                        resultJson(
                            requestIdOf(text),
                            ok = true,
                            value =
                                """{"status":"replayed","events":[],"headEventId":"evt-head","pendingPermission":null}""",
                        ),
                    )
                } else {
                    transport.emit(successBody(requestIdOf(text), text))
                }
            }
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            assertTrue(lastCommand(transport, "sync.catch_up").contains("\"lastEventId\":null"))
            assertEquals("evt-head", store.loadCursor("pc-1"))
            transport.emit(eventJson("assistant.message", "sess-1", """{"text":"live","delta":true}""", eventId = "evt-live"))
            transport.emit(eventJson("assistant.message", "sess-1", """{"text":"dup","delta":true}""", eventId = "evt-live"))
            assertEquals(listOf("evt-live"), received.map { it.eventId })
            assertEquals("evt-live", store.loadCursor("pc-1"))
            collectJob.cancel()
        }
        withRepository(autoRespond = false, reliabilityStore = store) { repo, transport ->
            transport.onSend = { text ->
                if (commandType(text) == "sync.catch_up") {
                    transport.emit(
                        resultJson(
                            requestIdOf(text),
                            ok = true,
                            value =
                                """{"status":"replayed","events":[],"headEventId":"evt-live","pendingPermission":null}""",
                        ),
                    )
                } else {
                    transport.emit(successBody(requestIdOf(text), text))
                }
            }
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            assertTrue(lastCommand(transport, "sync.catch_up").contains("\"lastEventId\":\"evt-live\""))
            assertEquals("evt-live", store.loadCursor("pc-1"))
        }
    }

    @Test
    fun storageExceptionsDoNotKillEventProcessing() {
        val store = FaultyReliabilityStore()
        store.failReads = true
        store.failWrites = true
        withRepository(reliabilityStore = store) { repo, transport ->
            val received = mutableListOf<RemoteEvent>()
            val collectJob = launch(Dispatchers.Unconfined) { repo.events.collect { received += it } }
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            assertEquals(RemoteConnectionState.Ready, repo.connectionState.value)
            transport.emit(eventJson("assistant.message", "sess-1", """{"text":"one","delta":true}""", eventId = "evt-1"))
            transport.emit(eventJson("assistant.message", "sess-1", """{"text":"two","delta":true}""", eventId = "evt-2"))
            assertEquals(listOf("evt-1", "evt-2"), received.map { it.eventId })
            assertEquals(RemoteConnectionState.Ready, repo.connectionState.value)
            collectJob.cancel()
        }
    }

    private suspend fun assertAuthFailure(
        repo: RemoteRepository,
        transport: FakeTransport,
        message: String,
        expectSocketDisconnected: Boolean = true,
        block: suspend (RemoteRepository) -> Unit,
    ) {
        try {
            block(repo)
            fail("expected $message")
        } catch (error: RemoteRepositoryException) {
            assertEquals(message, error.message)
        }
        assertEquals(RemoteConnectionState.Failed, repo.connectionState.value)
        if (expectSocketDisconnected) {
            assertEquals(ConnectionState.Disconnected, transport.connectionState.value)
        } else {
            assertEquals(ConnectionState.Failed, transport.connectionState.value)
        }
    }

    private fun withRepository(
        timeoutMs: Long = 1_000,
        autoRespond: Boolean = true,
        autoChallenge: Boolean = true,
        liveQueueLimit: Int = 2048,
        reliabilityStore: ReliabilityStore = VolatileReliabilityStore(),
        block: suspend CoroutineScope.(RemoteRepository, FakeTransport) -> Unit,
    ) {
        val job = SupervisorJob()
        val scope = CoroutineScope(job + Dispatchers.Unconfined)
        val transport = FakeTransport(autoRespond, autoChallenge)
        val repo =
            RemoteRepository(
                transport = transport,
                credentialStore = JavaEcdsaCredentialStore(),
                scope = scope,
                requestTimeoutMs = timeoutMs,
                liveQueueLimit = liveQueueLimit,
                reliabilityStore = reliabilityStore,
            )
        try {
            runBlocking { block(repo, transport) }
        } finally {
            repo.disconnect()
            job.cancel()
        }
    }

    private fun qrPayload(): PairingQrPayload {
        return PairingQrPayload(
            v = 1,
            relayUrl = "ws://127.0.0.1:8787",
            machineId = "pc-1",
            token = RemoteProtocol.encodeBase64Url(ByteArray(32) { 3 }),
            expiresAt = 1_700_000_000_000L,
        )
    }
}

private fun frameKind(text: String): String? =
    Json.parseToJsonElement(text).jsonObject["kind"]?.jsonPrimitive?.content

private class FaultyReliabilityStore(
    private val inner: ReliabilityStore = VolatileReliabilityStore(),
) : ReliabilityStore {
    var failReads = false
    var failWrites = false

    override suspend fun loadSelection(): NavigationSelection = inner.loadSelection()

    override suspend fun saveSelection(selection: NavigationSelection) = inner.saveSelection(selection)

    override suspend fun loadCursor(machineId: String): String? {
        if (failReads) error("read")
        return inner.loadCursor(machineId)
    }

    override suspend fun saveCursor(machineId: String, lastEventId: String?) {
        if (failWrites) error("write")
        inner.saveCursor(machineId, lastEventId)
    }

    override suspend fun needsCatchUp(): Boolean = inner.needsCatchUp()

    override suspend fun setNeedsCatchUp(value: Boolean) = inner.setNeedsCatchUp(value)

    override suspend fun claimNotificationEventId(eventId: String): Boolean = inner.claimNotificationEventId(eventId)
}
