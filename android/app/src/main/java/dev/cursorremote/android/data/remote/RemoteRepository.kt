package dev.cursorremote.android.data.remote

import dev.cursorremote.android.data.protocol.DiffSnapshot
import dev.cursorremote.android.data.protocol.FileContent
import dev.cursorremote.android.data.protocol.ModelCatalog
import dev.cursorremote.android.data.protocol.IncomingRemoteFrame
import dev.cursorremote.android.data.protocol.PairingQrPayload
import dev.cursorremote.android.data.protocol.ProtocolParseError
import dev.cursorremote.android.data.protocol.RemoteCommandResult
import dev.cursorremote.android.data.protocol.RemoteEvent
import dev.cursorremote.android.data.protocol.RemoteProtocol
import dev.cursorremote.android.data.protocol.SessionInfo
import dev.cursorremote.android.data.protocol.SyncCatchUpResult
import dev.cursorremote.android.data.protocol.WorkspaceInfo
import dev.cursorremote.android.data.security.DeviceCredentialStore
import dev.cursorremote.android.data.transport.ConnectionState
import dev.cursorremote.android.data.transport.WebSocketTransport
import java.time.Instant
import java.util.ArrayDeque
import java.util.LinkedHashSet
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
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

data class RemoteAuthResult(
    val deviceId: String,
    val catchUp: SyncCatchUpResult,
)

class RemoteRepository(
    private val transport: WebSocketTransport,
    private val credentialStore: DeviceCredentialStore,
    private val scope: CoroutineScope,
    private val requestTimeoutMs: Long = 15_000,
    private val liveQueueLimit: Int = LIVE_EVENT_QUEUE_LIMIT,
    private val nowMillis: () -> Long = { System.currentTimeMillis() },
    private val nowTimestamp: () -> String = { Instant.ofEpochMilli(nowMillis()).toString() },
    private val newRequestId: () -> String = { UUID.randomUUID().toString() },
) {
    private val authMutex = Mutex()
    private val eventLock = Any()
    private val activeGeneration = AtomicLong(-1L)
    private val pending = ConcurrentHashMap<String, CompletableDeferred<RemoteCommandResult>>()
    private val challengeDeferred = AtomicReference<CompletableDeferred<String>?>(null)
    private val _connectionState = MutableStateFlow(RemoteConnectionState.Disconnected)
    private val _events = MutableSharedFlow<RemoteEvent>(extraBufferCapacity = 64)
    private val lastEventIdByMachine = HashMap<String, String>()
    private val seenEventIdsByMachine = HashMap<String, LinkedHashSet<String>>()
    private val liveQueue = ArrayDeque<RemoteEvent>()
    private val currentMachineId = AtomicReference<String?>(null)
    private var bufferingEvents = false
    private var catchUpOverflowed = false
    val connectionState: StateFlow<RemoteConnectionState> = _connectionState.asStateFlow()
    val socketConnectionState: StateFlow<ConnectionState> = transport.connectionState
    val events: SharedFlow<RemoteEvent> = _events.asSharedFlow()

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

    suspend fun pair(payload: PairingQrPayload, sessionId: String? = null): String =
        authenticateInternal(payload.relayUrl, payload.machineId, payload.token, null, sessionId).deviceId

    suspend fun authenticate(
        relayUrl: String,
        machineId: String,
        deviceId: String,
        sessionId: String? = null,
    ): String = authenticateInternal(relayUrl, machineId, null, deviceId, sessionId).deviceId

    suspend fun reconnect(
        relayUrl: String,
        machineId: String,
        deviceId: String,
        sessionId: String?,
    ): RemoteAuthResult = authenticateInternal(relayUrl, machineId, null, deviceId, sessionId)

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

    suspend fun sendSessionPrompt(sessionId: String, text: String) {
        sendCommand("session.send", RemoteProtocol.sessionSendPayload(text), sessionId, timeoutMs = null)
    }

    suspend fun cancelSession(sessionId: String) {
        sendCommand("session.cancel", RemoteProtocol.sessionCancelPayload(), sessionId, timeoutMs = requestTimeoutMs)
    }

    suspend fun approvePermission(sessionId: String, permissionId: String) {
        sendCommand("permission.approve", RemoteProtocol.permissionApprovePayload(permissionId), sessionId)
    }

    suspend fun rejectPermission(sessionId: String, permissionId: String) {
        sendCommand("permission.reject", RemoteProtocol.permissionRejectPayload(permissionId), sessionId)
    }

    suspend fun readDiff(workspaceId: String): DiffSnapshot {
        val value =
            sendCommand("diff.read", RemoteProtocol.diffReadPayload(workspaceId), sessionId = null)
                ?: throw RemoteRepositoryException("diff.read value must be a snapshot.")
        return RemoteProtocol.parseDiffSnapshot(value)
    }

    suspend fun readFile(sessionId: String, path: String): FileContent {
        val value =
            sendCommand("file.read", RemoteProtocol.fileReadPayload(path), sessionId)
                ?: throw RemoteRepositoryException("file.read value must be file content.")
        return RemoteProtocol.parseFileContent(value)
    }

    suspend fun listModels(sessionId: String): ModelCatalog {
        val value =
            sendCommand("model.list", RemoteProtocol.modelListPayload(), sessionId)
                ?: throw RemoteRepositoryException("model.list value must be a catalog.")
        return RemoteProtocol.parseModelCatalog(value)
    }

    suspend fun selectModel(sessionId: String, modelId: String): ModelCatalog {
        val value =
            sendCommand("model.select", RemoteProtocol.modelSelectPayload(modelId), sessionId)
                ?: throw RemoteRepositoryException("model.select value must be a catalog.")
        return RemoteProtocol.parseModelCatalog(value)
    }

    fun disconnect() {
        reset(RemoteConnectionState.Disconnected, RemoteRepositoryException("Disconnected"), disconnectSocket = true)
    }

    private suspend fun authenticateInternal(
        relayUrl: String,
        machineId: String,
        token: String?,
        deviceId: String?,
        sessionId: String?,
    ): RemoteAuthResult =
        authMutex.withLock {
            reset(RemoteConnectionState.Connecting, RemoteRepositoryException("Connection replaced"), disconnectSocket = false)
            currentMachineId.set(machineId)
            synchronized(eventLock) {
                bufferingEvents = true
                catchUpOverflowed = false
                liveQueue.clear()
            }
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
                    _connectionState.value != RemoteConnectionState.Authenticating
                ) {
                    val failed =
                        _connectionState.value == RemoteConnectionState.Failed ||
                            transport.connectionState.value == ConnectionState.Failed
                    throw RemoteRepositoryException(if (failed) "Connection failed" else "Disconnected")
                }
                val catchUp = applyCatchUp(machineId, sessionId)
                if (activeGeneration.get() != expected ||
                    transport.connectionState.value != ConnectionState.Connected ||
                    !_connectionState.compareAndSet(RemoteConnectionState.Authenticating, RemoteConnectionState.Ready)
                ) {
                    val failed =
                        _connectionState.value == RemoteConnectionState.Failed ||
                            transport.connectionState.value == ConnectionState.Failed
                    throw RemoteRepositoryException(if (failed) "Connection failed" else "Disconnected")
                }
                RemoteAuthResult(pairedDeviceId, catchUp)
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

    private suspend fun applyCatchUp(machineId: String, sessionId: String?): SyncCatchUpResult {
        val requestedCursor = synchronized(eventLock) { lastEventIdByMachine[machineId] }
        val catchUp =
            try {
                val value =
                    sendCatchUpCommand(requestedCursor, sessionId)
                        ?: throw RemoteRepositoryException("sync.catch_up value must be an object.")
                RemoteProtocol.parseSyncCatchUpResult(value)
            } catch (error: ProtocolParseError) {
                throw RemoteRepositoryException(error.message ?: "sync.catch_up failed")
            }
        var appliedReplay = false
        while (true) {
            val batch =
                synchronized(eventLock) {
                    if (catchUpOverflowed) {
                        throw RemoteRepositoryException(OVERFLOW_MESSAGE)
                    }
                    val next = ArrayList<RemoteEvent>()
                    if (!appliedReplay) {
                        if (requestedCursor == null) {
                            setCursorLocked(machineId, catchUp.headEventId)
                        } else {
                            for (event in catchUp.events) {
                                acceptLocked(machineId, event, next)
                            }
                            setCursorLocked(machineId, catchUp.headEventId)
                        }
                        appliedReplay = true
                    }
                    drainQueueLocked(machineId, next)
                    next
                }
            for (event in batch) {
                _events.emit(event)
            }
            val more =
                synchronized(eventLock) {
                    if (catchUpOverflowed) {
                        throw RemoteRepositoryException(OVERFLOW_MESSAGE)
                    }
                    if (liveQueue.isEmpty()) {
                        bufferingEvents = false
                        false
                    } else {
                        true
                    }
                }
            if (!more) {
                break
            }
        }
        return catchUp
    }

    private suspend fun sendCatchUpCommand(lastEventId: String?, sessionId: String?): JsonElement? {
        if (_connectionState.value != RemoteConnectionState.Authenticating) {
            throw RemoteRepositoryException("Not authenticated")
        }
        val requestId = newRequestId()
        val deferred = CompletableDeferred<RemoteCommandResult>()
        pending[requestId] = deferred
        sendOrThrow(
            requestId,
            RemoteProtocol.encodeCommandFrame(
                requestId,
                "sync.catch_up",
                RemoteProtocol.syncCatchUpPayload(lastEventId),
                nowTimestamp(),
                sessionId,
            ),
        )
        return awaitRegistered(requestId, deferred, failAuthentication = true)
    }

    private suspend fun sendCommand(
        type: String,
        payload: JsonObject,
        sessionId: String? = null,
        timeoutMs: Long? = requestTimeoutMs,
    ): JsonElement? {
        if (_connectionState.value != RemoteConnectionState.Ready) {
            throw RemoteRepositoryException("Not authenticated")
        }
        val requestId = newRequestId()
        val deferred = CompletableDeferred<RemoteCommandResult>()
        pending[requestId] = deferred
        sendOrThrow(
            requestId,
            RemoteProtocol.encodeCommandFrame(requestId, type, payload, nowTimestamp(), sessionId),
        )
        return awaitRegistered(requestId, deferred, failAuthentication = false, timeoutMs = timeoutMs)
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
        timeoutMs: Long? = requestTimeoutMs,
    ): JsonElement? {
        val result =
            try {
                if (timeoutMs == null) {
                    deferred.await()
                } else {
                    withTimeout(timeoutMs) { deferred.await() }
                }
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

    private suspend fun dispatch(text: String) {
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
            is IncomingRemoteFrame.Event -> {
                val machineId = currentMachineId.get() ?: return
                val overflow: Boolean
                val toEmit: RemoteEvent?
                synchronized(eventLock) {
                    if (bufferingEvents) {
                        if (liveQueue.size >= liveQueueLimit) {
                            catchUpOverflowed = true
                            overflow = true
                            toEmit = null
                        } else {
                            liveQueue.addLast(frame.event)
                            overflow = false
                            toEmit = null
                        }
                    } else {
                        overflow = false
                        toEmit = acceptLiveLocked(machineId, frame.event)
                    }
                }
                if (overflow) {
                    failConnection(OVERFLOW_MESSAGE)
                    return
                }
                if (toEmit != null) {
                    _events.emit(toEmit)
                }
            }
        }
    }

    private fun acceptLocked(
        machineId: String,
        event: RemoteEvent,
        into: MutableList<RemoteEvent>,
    ) {
        if (!noteSeenLocked(machineId, event.eventId)) {
            return
        }
        setCursorLocked(machineId, event.eventId)
        into.add(event)
    }

    private fun acceptLiveLocked(machineId: String, event: RemoteEvent): RemoteEvent? {
        if (!noteSeenLocked(machineId, event.eventId)) {
            return null
        }
        setCursorLocked(machineId, event.eventId)
        return event
    }

    private fun drainQueueLocked(machineId: String, into: MutableList<RemoteEvent>) {
        while (liveQueue.isNotEmpty()) {
            acceptLocked(machineId, liveQueue.removeFirst(), into)
        }
    }

    private fun setCursorLocked(machineId: String, eventId: String?) {
        if (eventId == null) {
            lastEventIdByMachine.remove(machineId)
        } else {
            lastEventIdByMachine[machineId] = eventId
        }
    }

    private fun noteSeenLocked(machineId: String, eventId: String): Boolean {
        val seen = seenEventIdsByMachine.getOrPut(machineId) { LinkedHashSet() }
        if (seen.contains(eventId)) {
            return false
        }
        if (seen.size >= SEEN_EVENT_LIMIT) {
            val oldest = seen.iterator()
            oldest.next()
            oldest.remove()
        }
        seen.add(eventId)
        return true
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
        clearCatchUpBufferLocked()
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
        clearCatchUpBufferLocked()
        _connectionState.value = next
        activeGeneration.set(-1L)
        if (disconnectSocket) {
            transport.disconnect()
        }
    }

    private fun clearCatchUpBufferLocked() {
        synchronized(eventLock) {
            bufferingEvents = false
            catchUpOverflowed = false
            liveQueue.clear()
        }
    }

    private fun failPending(error: RemoteRepositoryException) {
        challengeDeferred.getAndSet(null)?.completeExceptionally(error)
        val waiters = pending.values.toList()
        pending.clear()
        waiters.forEach { it.completeExceptionally(error) }
    }

    companion object {
        private const val LIVE_EVENT_QUEUE_LIMIT = 2048
        private const val SEEN_EVENT_LIMIT = 4096
        private const val OVERFLOW_MESSAGE = "Event buffer overflow"
    }
}
