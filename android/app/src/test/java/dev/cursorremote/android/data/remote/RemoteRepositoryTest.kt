package dev.cursorremote.android.data.remote

import dev.cursorremote.android.FakeTransport
import dev.cursorremote.android.JavaEcdsaCredentialStore
import dev.cursorremote.android.requestIdOf
import dev.cursorremote.android.resultJson
import dev.cursorremote.android.data.protocol.PairingQrPayload
import dev.cursorremote.android.data.protocol.RemoteProtocol
import dev.cursorremote.android.data.transport.ConnectionState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
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
        }

    @Test
    fun authProofAndCommandsUseRequestIdAndRejectWhenDisconnected() =
        withRepository { repo, transport ->
            repo.authenticate("ws://127.0.0.1:8787", "pc-1", "device-1")
            assertEquals(true, transport.sent.last().contains("\"kind\":\"auth_proof\""))
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
        block: suspend (RemoteRepository, FakeTransport) -> Unit,
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
