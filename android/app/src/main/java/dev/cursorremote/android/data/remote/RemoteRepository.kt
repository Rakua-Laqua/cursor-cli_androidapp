package dev.cursorremote.android.data.remote

import dev.cursorremote.android.data.protocol.IncomingRemoteFrame
import dev.cursorremote.android.data.protocol.PairingQrPayload
import dev.cursorremote.android.data.protocol.ProtocolParseError
import dev.cursorremote.android.data.protocol.RemoteCommandResult
import dev.cursorremote.android.data.protocol.RemoteProtocol
import dev.cursorremote.android.data.protocol.SessionInfo
import dev.cursorremote.android.data.protocol.WorkspaceInfo
import dev.cursorremote.android.data.security.DeviceCredentialStore
import dev.cursorremote.android.data.transport.ConnectionState
import dev.cursorremote.android.data.transport.WebSocketTransport
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

enum class RemoteConnectionState {
    Disconnected,
    Connecting,
    Authenticating,
    Ready,
    Failed,
}

class RemoteRepositoryException(message: String) : Exception(message)

class RemoteRepository(
    private val transport: WebSocketTransport,
    private val credentialStore: DeviceCredentialStore,
    private val scope: CoroutineScope,
    private val requestTimeoutMs: Long = 15_000,
    private val nowMillis: () -> Long = { System.currentTimeMillis() },
    private val nowTimestamp: () -> String = { Instant.ofEpochMilli(nowMillis()).toString() },
    private val newRequestId: () -> String = { UUID.randomUUID().toString() },
) {
    private val authMutex = Mutex()
    private val activeGeneration = AtomicLong(-1L)
    private val pending = ConcurrentHashMap<String, CompletableDeferred<RemoteCommandResult>>()
    private val challengeDeferred = AtomicReference<CompletableDeferred<String>?>(null)
    private val _connectionState = MutableStateFlow(RemoteConnectionState.Disconnected)
    val connectionState: StateFlow<RemoteConnectionState> = _connectionState.asStateFlow()
    val socketConnectionState: StateFlow<ConnectionState> = transport.connectionState

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            transport.incomingMessages.collect { message ->
                if (message.generation == activeGeneration.get()) dispatch(message.text)
            }
        }
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            transport.connectionState.collect { onSocketState(it) }
        }
    }

    suspend fun pair(payload: PairingQrPayload): String =
        authenticateInternal(payload.relayUrl, payload.machineId, payload.token, null)

    suspend fun authenticate(
        relayUrl: String,
        machineId: String,
        deviceId: String,
    ): String = authenticateInternal(relayUrl, machineId, null, deviceId)

    suspend fun listWorkspaces(): List<WorkspaceInfo> =
        RemoteProtocol.parseWorkspaceList(sendCommand("workspace.list", RemoteProtocol.workspaceListPayload()))

    suspend fun listSessions(workspaceId: String): List<SessionInfo> =
        RemoteProtocol.parseSessionList(sendCommand("session.list", RemoteProtocol.sessionListPayload(workspaceId)))

    suspend fun createSession(workspaceId: String): SessionInfo {
        val value = sendCommand("session.create", RemoteProtocol.sessionCreatePayload(workspaceId))
            ?: throw RemoteRepositoryException("session.create value must be a session.")
        return RemoteProtocol.parseSession(value)
    }

    suspend fun loadSession(remoteSessionId: String): SessionInfo {
        val value = sendCommand("session.load", RemoteProtocol.sessionLoadPayload(remoteSessionId))
            ?: throw RemoteRepositoryException("session.load value must be a session.")
        return RemoteProtocol.parseSession(value)
    }

    fun disconnect() {
        reset(RemoteConnectionState.Disconnected, RemoteRepositoryException("Disconnected"), disconnectSocket = true)
    }

    private suspend fun authenticateInternal(
        relayUrl: String,
        machineId: String,
        token: String?,
        deviceId: String?,
    ): String =
        authMutex.withLock {
            reset(RemoteConnectionState.Connecting, RemoteRepositoryException("Connection replaced"), disconnectSocket = false)
            val challenge = CompletableDeferred<String>()
            challengeDeferred.set(challenge)
            val expected = transport.generation + 1
            activeGeneration.set(expected)
            try {
                transport.connect(RemoteProtocol.clientUrl(relayUrl, machineId))
                if (_connectionState.value == RemoteConnectionState.Failed) {
                    throw RemoteRepositoryException("Connection failed")
                }
                if (_connectionState.value == RemoteConnectionState.Disconnected) {
                    throw RemoteRepositoryException("Disconnected")
                }
                _connectionState.value = RemoteConnectionState.Authenticating
                val nonce = awaitChallenge(challenge)
                val publicKey = RemoteProtocol.p256PublicJwkFromKey(
                    credentialStore.getDeviceKey() ?: credentialStore.createDeviceKey(),
                )
                val requestId = newRequestId()
                val deferred = CompletableDeferred<RemoteCommandResult>()
                pending[requestId] = deferred
                val frame =
                    if (token != null) {
                        RemoteProtocol.encodePairFrame(
                            requestId, token, publicKey,
                            credentialStore.signSha256Ecdsa(RemoteProtocol.canonicalPairProofBytes(machineId, nonce, token, publicKey)),
                        )
                    } else {
                        val expectedDeviceId = deviceId ?: throw RemoteRepositoryException("deviceId must be a non-empty string.")
                        RemoteProtocol.encodeAuthProofFrame(
                            requestId, expectedDeviceId,
                            credentialStore.signSha256Ecdsa(RemoteProtocol.canonicalAuthProofBytes(machineId, nonce, expectedDeviceId)),
                        )
                    }
                sendOrThrow(requestId, frame)
                val pairedDeviceId = RemoteProtocol.parseDeviceIdValue(awaitRegistered(requestId, deferred, failAuthentication = true))
                if (deviceId != null && pairedDeviceId != deviceId) {
                    throw RemoteRepositoryException("deviceId does not match the paired device.")
                }
                if (activeGeneration.get() != expected ||
                    transport.connectionState.value != ConnectionState.Connected ||
                    !_connectionState.compareAndSet(RemoteConnectionState.Authenticating, RemoteConnectionState.Ready)
                ) {
                    val failed =
                        _connectionState.value == RemoteConnectionState.Failed ||
                            transport.connectionState.value == ConnectionState.Failed
                    throw RemoteRepositoryException(if (failed) "Connection failed" else "Disconnected")
                }
                pairedDeviceId
            } catch (error: CancellationException) {
                reset(RemoteConnectionState.Disconnected, RemoteRepositoryException("Disconnected"), disconnectSocket = true)
                throw error
            } catch (error: Exception) {
                val message = error.message ?: "Authentication failed"
                if (_connectionState.value != RemoteConnectionState.Failed) {
                    failConnection(message)
                }
                throw if (error is RemoteRepositoryException) error else RemoteRepositoryException(message)
            }
        }

    private suspend fun sendCommand(
        type: String,
        payload: JsonObject,
    ): JsonElement? {
        if (_connectionState.value != RemoteConnectionState.Ready) {
            throw RemoteRepositoryException("Not authenticated")
        }
        val requestId = newRequestId()
        val deferred = CompletableDeferred<RemoteCommandResult>()
        pending[requestId] = deferred
        sendOrThrow(
            requestId,
            RemoteProtocol.encodeCommandFrame(requestId, type, payload, nowTimestamp(), sessionId = null),
        )
        return awaitRegistered(requestId, deferred, failAuthentication = false)
    }

    private suspend fun sendOrThrow(
        requestId: String,
        frame: String,
    ) {
        try {
            transport.send(frame)
        } catch (error: Exception) {
            pending.remove(requestId)
            if (error is CancellationException) throw error
            throw RemoteRepositoryException(error.message ?: "WebSocket send failed")
        }
    }

    private suspend fun awaitChallenge(deferred: CompletableDeferred<String>): String {
        return try {
            withTimeout(requestTimeoutMs) { deferred.await() }
        } catch (_: TimeoutCancellationException) {
            failConnection("Authentication timed out")
            throw RemoteRepositoryException("Authentication timed out")
        }
    }

    private suspend fun awaitRegistered(
        requestId: String,
        deferred: CompletableDeferred<RemoteCommandResult>,
        failAuthentication: Boolean,
    ): JsonElement? {
        val result =
            try {
                withTimeout(requestTimeoutMs) { deferred.await() }
            } catch (_: TimeoutCancellationException) {
                pending.remove(requestId)
                val message = if (failAuthentication) "Authentication timed out" else "Request timed out"
                if (failAuthentication) failConnection(message)
                throw RemoteRepositoryException(message)
            } catch (error: CancellationException) {
                pending.remove(requestId)
                throw error
            } catch (error: Exception) {
                pending.remove(requestId)
                throw if (error is RemoteRepositoryException) error else RemoteRepositoryException(error.message ?: "Request failed")
            }
        if (!result.ok) {
            val message = result.error ?: "Request failed"
            if (failAuthentication) failConnection(message)
            throw RemoteRepositoryException(message)
        }
        return result.value
    }

    private fun dispatch(text: String) {
        val frame =
            try {
                RemoteProtocol.parseIncomingFrame(text)
            } catch (_: ProtocolParseError) {
                return
            }
        when (frame) {
            is IncomingRemoteFrame.AuthChallenge -> {
                if (_connectionState.value == RemoteConnectionState.Ready) {
                    failConnection("Reauthentication required")
                    return
                }
                challengeDeferred.getAndSet(null)?.complete(frame.nonce)
            }
            is IncomingRemoteFrame.Result -> pending.remove(frame.result.requestId)?.complete(frame.result)
            is IncomingRemoteFrame.Event -> Unit
        }
    }

    private fun onSocketState(state: ConnectionState) {
        val (next, message) =
            when (state) {
                ConnectionState.Failed -> RemoteConnectionState.Failed to "Connection failed"
                ConnectionState.Disconnected -> RemoteConnectionState.Disconnected to "Disconnected"
                else -> return
            }
        val current = _connectionState.value
        if (current == RemoteConnectionState.Failed || current == next) {
            return
        }
        failPending(RemoteRepositoryException(message))
        activeGeneration.set(-1L)
        _connectionState.value = next
    }

    private fun failConnection(message: String) {
        reset(RemoteConnectionState.Failed, RemoteRepositoryException(message), disconnectSocket = true)
    }

    private fun reset(
        next: RemoteConnectionState,
        error: RemoteRepositoryException,
        disconnectSocket: Boolean,
    ) {
        failPending(error)
        _connectionState.value = next
        activeGeneration.set(-1L)
        if (disconnectSocket) {
            transport.disconnect()
        }
    }

    private fun failPending(error: RemoteRepositoryException) {
        challengeDeferred.getAndSet(null)?.completeExceptionally(error)
        val waiters = pending.values.toList()
        pending.clear()
        waiters.forEach { it.completeExceptionally(error) }
    }
}
