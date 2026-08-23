package dev.cursorremote.android.data.protocol

import java.math.BigInteger
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.PublicKey
import java.security.interfaces.ECPublicKey
import java.util.Base64
import java.util.Locale
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class ProtocolParseError(message: String) : Exception(message)

data class P256PublicJwk(val kty: String, val crv: String, val x: String, val y: String)

data class PairingQrPayload(
    val v: Int,
    val relayUrl: String,
    val machineId: String,
    val token: String,
    val expiresAt: Long,
)

data class WorkspaceInfo(
    val workspaceId: String,
    val name: String,
    val path: String,
    val gitBranch: String?,
    val modified: Boolean,
    val activeSessionCount: Int,
    val lastUsedAt: String?,
)

data class SessionInfo(
    val remoteSessionId: String,
    val cursorSessionId: String?,
    val workspaceId: String,
    val title: String,
    val status: String,
    val createdAt: String,
    val updatedAt: String,
)

data class DiffFileInfo(
    val path: String,
    val previousPath: String?,
    val change: String,
    val binary: Boolean,
    val sensitive: Boolean,
    val additions: Int,
    val deletions: Int,
    val unifiedDiff: String?,
    val truncated: Boolean,
)

data class DiffSnapshot(
    val workspaceId: String,
    val available: Boolean,
    val source: String,
    val files: List<DiffFileInfo>,
    val truncated: Boolean,
    val omittedCount: Int,
    val totalAdditions: Int,
    val totalDeletions: Int,
)

data class FileContent(
    val path: String,
    val content: String,
    val truncated: Boolean,
)

data class ModelCatalogEntry(
    val id: String,
    val displayName: String,
    val description: String?,
    val parameters: List<JsonElement>,
    val variants: List<JsonElement>,
    val available: Boolean,
)

data class ModelCatalog(
    val models: List<ModelCatalogEntry>,
    val currentModelId: String?,
)

data class ModelSelectionChanged(
    val modelId: String,
    val confirmed: Boolean,
)

data class SessionContextUsage(
    val used: Long,
    val size: Long,
)

data class RemoteCommandResult(val requestId: String, val ok: Boolean, val value: JsonElement?, val error: String?)

data class RemoteEvent(
    val eventId: String,
    val sessionId: String?,
    val timestamp: String,
    val type: String,
    val payload: JsonElement,
)

sealed class ChatEvent {
    abstract val eventId: String
    abstract val sessionId: String
    abstract val timestamp: String

    data class SessionStatusChanged(
        override val eventId: String,
        override val sessionId: String,
        override val timestamp: String,
        val status: String,
    ) : ChatEvent()

    data class UserMessage(
        override val eventId: String,
        override val sessionId: String,
        override val timestamp: String,
        val text: String,
    ) : ChatEvent()

    data class AssistantMessage(
        override val eventId: String,
        override val sessionId: String,
        override val timestamp: String,
        val text: String,
        val delta: Boolean,
    ) : ChatEvent()

    data class AssistantStatus(
        override val eventId: String,
        override val sessionId: String,
        override val timestamp: String,
        val status: String,
    ) : ChatEvent()

    data class AgentWaiting(
        override val eventId: String,
        override val sessionId: String,
        override val timestamp: String,
        val reason: String?,
    ) : ChatEvent()

    data class AgentCompleted(
        override val eventId: String,
        override val sessionId: String,
        override val timestamp: String,
        val reason: String?,
    ) : ChatEvent()

    data class AgentFailed(
        override val eventId: String,
        override val sessionId: String,
        override val timestamp: String,
        val reason: String?,
    ) : ChatEvent()

    data class AgentInterrupted(
        override val eventId: String,
        override val sessionId: String,
        override val timestamp: String,
        val reason: String?,
    ) : ChatEvent()

    data class PermissionRequested(
        override val eventId: String,
        override val sessionId: String,
        override val timestamp: String,
        val permissionId: String,
        val kind: String,
        val command: String,
        val risk: String,
    ) : ChatEvent()

    data class PermissionResolved(
        override val eventId: String,
        override val sessionId: String,
        override val timestamp: String,
        val permissionId: String,
        val decision: String,
    ) : ChatEvent()
}

sealed class IncomingRemoteFrame {
    data class AuthChallenge(val nonce: String) : IncomingRemoteFrame()

    data class Result(val result: RemoteCommandResult) : IncomingRemoteFrame()

    data class Event(val event: RemoteEvent) : IncomingRemoteFrame()
}

object RemoteProtocol {
    const val PAIRING_QR_VERSION = 1
    const val PAIR_PROOF_DOMAIN = "cursor-remote.pair.v1"
    const val AUTH_PROOF_DOMAIN = "cursor-remote.auth.v1"
    const val PAIRING_TOKEN_BYTES = 32
    const val PAIRING_NONCE_BYTES = 32
    const val P256_COORDINATE_BYTES = 32
    const val JS_MAX_SAFE_INTEGER = 9007199254740991L
    val SESSION_STATUSES = setOf("idle", "running", "waiting_approval", "waiting_user", "completed", "failed", "interrupted", "disconnected")
    val DIFF_SOURCES = setOf("git", "none")
    val DIFF_CHANGES = setOf("modified", "added", "deleted", "renamed", "untracked")
    val CHAT_EVENT_TYPES =
        setOf(
            "session.status_changed",
            "user.message",
            "assistant.message",
            "assistant.status",
            "agent.waiting",
            "agent.completed",
            "agent.failed",
            "agent.interrupted",
            "permission.requested",
            "permission.resolved",
        )

    fun parsePairingQrPayload(
        text: String,
        nowMillis: Long,
    ): PairingQrPayload {
        val root = parseObject(parseJson(text), "Pairing QR payload")
        assertExactKeys(root, listOf("v", "relayUrl", "machineId", "token", "expiresAt"))
        if (requireSafeInteger(root, "v") != PAIRING_QR_VERSION.toLong()) {
            throw ProtocolParseError("v must be 1.")
        }
        val expiresAt = requireSafeInteger(root, "expiresAt")
        if (expiresAt <= 0) {
            throw ProtocolParseError("expiresAt must be a positive safe integer.")
        }
        if (nowMillis >= expiresAt) {
            throw ProtocolParseError("pairing QR payload has expired.")
        }
        return PairingQrPayload(
            v = PAIRING_QR_VERSION,
            relayUrl = parseRelayOrigin(requireNonEmptyString(root, "relayUrl")),
            machineId = requireNonEmptyString(root, "machineId"),
            token = parseBase64UrlBytes(root.getValue("token"), PAIRING_TOKEN_BYTES, "token"),
            expiresAt = expiresAt,
        )
    }

    fun parseRelayOrigin(value: String): String {
        val uri =
            try {
                URI(value)
            } catch (_: Exception) {
                throw ProtocolParseError("relayUrl must be a ws or wss origin.")
            }
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
            ?: throw ProtocolParseError("relayUrl must be a ws or wss origin.")
        if (scheme != "ws" && scheme != "wss") {
            throw ProtocolParseError("relayUrl must be a ws or wss origin.")
        }
        if (!uri.userInfo.isNullOrEmpty()) throw ProtocolParseError("relayUrl must not include credentials.")
        if (!uri.rawQuery.isNullOrEmpty() || !uri.rawFragment.isNullOrEmpty()) {
            throw ProtocolParseError("relayUrl must not include query or fragment.")
        }
        val path = uri.path.orEmpty()
        val host = uri.host
        if ((path.isNotEmpty() && path != "/") || host.isNullOrEmpty()) {
            throw ProtocolParseError("relayUrl must be a ws or wss origin.")
        }
        return "$scheme://${formatOriginHost(host, uri.port, scheme)}"
    }

    fun parseIncomingFrame(text: String): IncomingRemoteFrame {
        val root = parseObject(parseJson(text), "Frame")
        return when (requireNonEmptyString(root, "kind")) {
            "auth_challenge" -> {
                assertExactKeys(root, listOf("kind", "nonce"))
                IncomingRemoteFrame.AuthChallenge(
                    parseBase64UrlBytes(root.getValue("nonce"), PAIRING_NONCE_BYTES, "nonce"),
                )
            }
            "result" -> IncomingRemoteFrame.Result(parseResultRecord(requireObject(root, "result")))
            "event" -> IncomingRemoteFrame.Event(parseEventRecord(requireJsonValue(root, "event")))
            else -> throw ProtocolParseError("kind must be auth_challenge, result, or event.")
        }
    }

    fun parseP256PublicJwk(value: JsonElement): P256PublicJwk {
        val root = parseObject(value, "publicKey")
        assertExactKeys(root, listOf("kty", "crv", "x", "y"))
        if (requireNonEmptyString(root, "kty") != "EC") {
            throw ProtocolParseError("publicKey.kty must be EC.")
        }
        if (requireNonEmptyString(root, "crv") != "P-256") {
            throw ProtocolParseError("publicKey.crv must be P-256.")
        }
        return P256PublicJwk(
            kty = "EC",
            crv = "P-256",
            x = parseBase64UrlBytes(root.getValue("x"), P256_COORDINATE_BYTES, "publicKey.x"),
            y = parseBase64UrlBytes(root.getValue("y"), P256_COORDINATE_BYTES, "publicKey.y"),
        )
    }

    fun p256PublicJwkFromKey(publicKey: PublicKey): P256PublicJwk {
        val ec =
            publicKey as? ECPublicKey
                ?: throw ProtocolParseError("publicKey must be an EC P-256 key.")
        if (ec.params.curve.field.fieldSize != 256) {
            throw ProtocolParseError("publicKey.crv must be P-256.")
        }
        return P256PublicJwk(
            kty = "EC",
            crv = "P-256",
            x = encodeBase64Url(toFixedLength(ec.w.affineX, P256_COORDINATE_BYTES, "publicKey.x")),
            y = encodeBase64Url(toFixedLength(ec.w.affineY, P256_COORDINATE_BYTES, "publicKey.y")),
        )
    }

    fun deviceIdFromPublicKey(publicKey: P256PublicJwk): String {
        val canonical = parseP256PublicJwk(publicJwkElement(publicKey))
        val digest =
            MessageDigest.getInstance("SHA-256")
                .digest(encodePublicJwk(canonical).toByteArray(StandardCharsets.UTF_8))
        return encodeBase64Url(digest)
    }

    fun canonicalPairProofBytes(
        machineId: String,
        nonce: String,
        token: String,
        publicKey: P256PublicJwk,
    ): ByteArray {
        requireNonEmpty(machineId, "machineId")
        parseBase64UrlBytes(JsonPrimitive(nonce), PAIRING_NONCE_BYTES, "nonce")
        parseBase64UrlBytes(JsonPrimitive(token), PAIRING_TOKEN_BYTES, "token")
        val canonicalKey = parseP256PublicJwk(publicJwkElement(publicKey))
        return buildJsonArray {
            add(JsonPrimitive(PAIR_PROOF_DOMAIN))
            add(JsonPrimitive(machineId))
            add(JsonPrimitive(nonce))
            add(JsonPrimitive(token))
            add(publicJwkElement(canonicalKey))
        }.toString().toByteArray(StandardCharsets.UTF_8)
    }

    fun canonicalAuthProofBytes(
        machineId: String,
        nonce: String,
        deviceId: String,
    ): ByteArray {
        requireNonEmpty(machineId, "machineId")
        requireNonEmpty(deviceId, "deviceId")
        parseBase64UrlBytes(JsonPrimitive(nonce), PAIRING_NONCE_BYTES, "nonce")
        return buildJsonArray {
            add(JsonPrimitive(AUTH_PROOF_DOMAIN))
            add(JsonPrimitive(machineId))
            add(JsonPrimitive(nonce))
            add(JsonPrimitive(deviceId))
        }.toString().toByteArray(StandardCharsets.UTF_8)
    }

    fun encodePairFrame(
        requestId: String,
        token: String,
        publicKey: P256PublicJwk,
        signature: ByteArray,
    ): String {
        requireNonEmpty(requestId, "requestId")
        val canonicalToken = parseBase64UrlBytes(JsonPrimitive(token), PAIRING_TOKEN_BYTES, "token")
        val canonicalKey = parseP256PublicJwk(publicJwkElement(publicKey))
        return buildJsonObject {
            put("kind", "pair")
            put("requestId", requestId)
            put("token", canonicalToken)
            put("publicKey", publicJwkElement(canonicalKey))
            put("signature", encodeBase64Url(signature))
        }.toString()
    }

    fun encodeAuthProofFrame(
        requestId: String,
        deviceId: String,
        signature: ByteArray,
    ): String {
        requireNonEmpty(requestId, "requestId")
        requireNonEmpty(deviceId, "deviceId")
        if (signature.isEmpty()) {
            throw ProtocolParseError("signature must be base64url.")
        }
        return buildJsonObject {
            put("kind", "auth_proof")
            put("requestId", requestId)
            put("deviceId", deviceId)
            put("signature", encodeBase64Url(signature))
        }.toString()
    }

    fun encodeCommandFrame(
        requestId: String,
        type: String,
        payload: JsonObject,
        timestamp: String,
        sessionId: String? = null,
    ): String {
        requireNonEmpty(requestId, "requestId")
        requireNonEmpty(type, "type")
        requireNonEmpty(timestamp, "timestamp")
        if (sessionId != null) requireNonEmpty(sessionId, "sessionId")
        return buildJsonObject {
            put("kind", "command")
            put(
                "command",
                buildJsonObject {
                    put("requestId", requestId)
                    if (sessionId == null) put("sessionId", JsonNull) else put("sessionId", sessionId)
                    put("timestamp", timestamp)
                    put("type", type)
                    put("payload", payload)
                },
            )
        }.toString()
    }

    fun workspaceListPayload(): JsonObject = buildJsonObject {}

    fun sessionListPayload(workspaceId: String): JsonObject {
        requireNonEmpty(workspaceId, "workspaceId")
        return buildJsonObject { put("workspaceId", workspaceId) }
    }

    fun sessionCreatePayload(workspaceId: String): JsonObject {
        requireNonEmpty(workspaceId, "workspaceId")
        return buildJsonObject {
            put("workspaceId", workspaceId)
            put("initialPrompt", "")
            put("title", JsonNull)
        }
    }

    fun sessionLoadPayload(remoteSessionId: String): JsonObject {
        requireNonEmpty(remoteSessionId, "remoteSessionId")
        return buildJsonObject { put("remoteSessionId", remoteSessionId) }
    }

    fun sessionSendPayload(text: String): JsonObject = buildJsonObject { put("text", text) }

    fun sessionCancelPayload(): JsonObject = buildJsonObject {}

    fun permissionApprovePayload(permissionId: String): JsonObject = permissionDecisionPayload(permissionId)

    fun permissionRejectPayload(permissionId: String): JsonObject = permissionDecisionPayload(permissionId)

    fun diffReadPayload(workspaceId: String): JsonObject {
        requireNonEmpty(workspaceId, "workspaceId")
        return buildJsonObject { put("workspaceId", workspaceId) }
    }

    fun fileReadPayload(path: String): JsonObject {
        requireNonEmpty(path, "path")
        return buildJsonObject { put("path", path) }
    }

    fun modelListPayload(): JsonObject = buildJsonObject {}

    fun modelSelectPayload(modelId: String): JsonObject {
        requireNonEmpty(modelId, "modelId")
        return buildJsonObject { put("modelId", modelId) }
    }

    fun parseFileContent(value: JsonElement?): FileContent {
        val root = parseObject(value ?: throw ProtocolParseError("file content must be a JSON object."), "file content")
        return FileContent(
            path = requireNonEmptyString(root, "path"),
            content = requireStringField(root, "content"),
            truncated = requireBoolean(root, "truncated"),
        )
    }

    fun parseModelCatalog(value: JsonElement?): ModelCatalog {
        val root = parseObject(value ?: throw ProtocolParseError("model catalog must be a JSON object."), "model catalog")
        return ModelCatalog(
            models = parseList(root["models"], "models", ::parseModelCatalogEntry),
            currentModelId = requireNullableString(root, "currentModelId"),
        )
    }

    fun parseModelSelectionChanged(value: JsonElement): ModelSelectionChanged {
        val root = parseObject(value, "model.selection_changed")
        return ModelSelectionChanged(
            modelId = requireNonEmptyString(root, "modelId"),
            confirmed = requireBoolean(root, "confirmed"),
        )
    }

    fun parseSessionContextUsage(value: JsonElement): SessionContextUsage {
        val root = parseObject(value, "session.context_updated")
        val used = requireSafeInteger(root, "used")
        val size = requireSafeInteger(root, "size")
        if (used < 0) {
            throw ProtocolParseError("used must be a non-negative integer.")
        }
        if (size < 0) {
            throw ProtocolParseError("size must be a non-negative integer.")
        }
        return SessionContextUsage(used = used, size = size)
    }

    fun parseChatEvent(event: RemoteEvent): ChatEvent? {
        if (event.type !in CHAT_EVENT_TYPES) {
            return null
        }
        val sessionId = event.sessionId
        if (sessionId.isNullOrEmpty()) {
            throw ProtocolParseError("sessionId must be a non-empty string.")
        }
        return when (event.type) {
            "session.status_changed" ->
                ChatEvent.SessionStatusChanged(
                    eventId = event.eventId,
                    sessionId = sessionId,
                    timestamp = event.timestamp,
                    status = parseSessionStatusChangedPayload(event.payload),
                )
            "user.message" ->
                ChatEvent.UserMessage(
                    eventId = event.eventId,
                    sessionId = sessionId,
                    timestamp = event.timestamp,
                    text = parseUserMessagePayload(event.payload),
                )
            "assistant.message" -> {
                val parsed = parseAssistantMessagePayload(event.payload)
                ChatEvent.AssistantMessage(
                    eventId = event.eventId,
                    sessionId = sessionId,
                    timestamp = event.timestamp,
                    text = parsed.first,
                    delta = parsed.second,
                )
            }
            "assistant.status" ->
                ChatEvent.AssistantStatus(
                    eventId = event.eventId,
                    sessionId = sessionId,
                    timestamp = event.timestamp,
                    status = parseAssistantStatusPayload(event.payload),
                )
            "agent.waiting" ->
                ChatEvent.AgentWaiting(
                    eventId = event.eventId,
                    sessionId = sessionId,
                    timestamp = event.timestamp,
                    reason = parseAgentTerminalPayload(event.payload),
                )
            "agent.completed" ->
                ChatEvent.AgentCompleted(
                    eventId = event.eventId,
                    sessionId = sessionId,
                    timestamp = event.timestamp,
                    reason = parseAgentTerminalPayload(event.payload),
                )
            "agent.failed" ->
                ChatEvent.AgentFailed(
                    eventId = event.eventId,
                    sessionId = sessionId,
                    timestamp = event.timestamp,
                    reason = parseAgentTerminalPayload(event.payload),
                )
            "agent.interrupted" ->
                ChatEvent.AgentInterrupted(
                    eventId = event.eventId,
                    sessionId = sessionId,
                    timestamp = event.timestamp,
                    reason = parseAgentTerminalPayload(event.payload),
                )
            "permission.requested" -> {
                val parsed = parsePermissionRequestedPayload(event.payload)
                ChatEvent.PermissionRequested(
                    eventId = event.eventId,
                    sessionId = sessionId,
                    timestamp = event.timestamp,
                    permissionId = parsed.permissionId,
                    kind = parsed.kind,
                    command = parsed.command,
                    risk = parsed.risk,
                )
            }
            "permission.resolved" -> {
                val parsed = parsePermissionResolvedPayload(event.payload)
                ChatEvent.PermissionResolved(
                    eventId = event.eventId,
                    sessionId = sessionId,
                    timestamp = event.timestamp,
                    permissionId = parsed.permissionId,
                    decision = parsed.decision,
                )
            }
            else -> null
        }
    }

    fun parseDeviceIdValue(value: JsonElement?): String {
        val root = parseObject(value ?: throw ProtocolParseError("deviceId must be a non-empty string."), "value")
        return requireNonEmptyString(root, "deviceId")
    }

    fun parseWorkspaceList(value: JsonElement?): List<WorkspaceInfo> = parseList(value, "workspace list", ::parseWorkspace)

    fun parseSessionList(value: JsonElement?): List<SessionInfo> = parseList(value, "session list", ::parseSession)

    fun parseWorkspace(value: JsonElement): WorkspaceInfo {
        val root = parseObject(value, "workspace")
        return WorkspaceInfo(
            workspaceId = requireNonEmptyString(root, "workspaceId"),
            name = requireNonEmptyString(root, "name"),
            path = requireNonEmptyString(root, "path"),
            gitBranch = requireNullableString(root, "gitBranch"),
            modified = requireBoolean(root, "modified"),
            activeSessionCount = requireNonNegativeInt(root, "activeSessionCount"),
            lastUsedAt = requireNullableString(root, "lastUsedAt"),
        )
    }

    fun parseSession(value: JsonElement): SessionInfo {
        val root = parseObject(value, "session")
        val status = requireNonEmptyString(root, "status")
        if (status !in SESSION_STATUSES) {
            throw ProtocolParseError("status must be a known session status.")
        }
        return SessionInfo(
            remoteSessionId = requireNonEmptyString(root, "remoteSessionId"),
            cursorSessionId = requireNullableString(root, "cursorSessionId"),
            workspaceId = requireNonEmptyString(root, "workspaceId"),
            title = requireNonEmptyString(root, "title"),
            status = status,
            createdAt = requireNonEmptyString(root, "createdAt"),
            updatedAt = requireNonEmptyString(root, "updatedAt"),
        )
    }

    fun parseDiffSnapshot(value: JsonElement?): DiffSnapshot {
        val root = parseObject(value ?: throw ProtocolParseError("diff snapshot must be a JSON object."), "diff snapshot")
        val source = requireNonEmptyString(root, "source")
        if (source !in DIFF_SOURCES) {
            throw ProtocolParseError("source must be git or none.")
        }
        return DiffSnapshot(
            workspaceId = requireNonEmptyString(root, "workspaceId"),
            available = requireBoolean(root, "available"),
            source = source,
            files = parseList(root["files"], "files", ::parseDiffFile),
            truncated = requireBoolean(root, "truncated"),
            omittedCount = requireNonNegativeInt(root, "omittedCount"),
            totalAdditions = requireNonNegativeInt(root, "totalAdditions"),
            totalDeletions = requireNonNegativeInt(root, "totalDeletions"),
        )
    }

    fun clientUrl(
        relayOrigin: String,
        machineId: String,
    ): String {
        requireNonEmpty(machineId, "machineId")
        val encoded =
            URLEncoder.encode(machineId, StandardCharsets.UTF_8.name()).replace("+", "%20")
        return "${parseRelayOrigin(relayOrigin)}/client?machineId=$encoded"
    }

    fun encodePublicJwk(publicKey: P256PublicJwk): String = publicJwkElement(publicKey).toString()

    fun encodeBase64Url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    private fun formatOriginHost(
        host: String,
        port: Int,
        scheme: String,
    ): String {
        val hostname = host.removePrefix("[").removeSuffix("]")
        val formatted = if (hostname.contains(':')) "[$hostname]" else hostname
        val defaultPort = if (scheme == "ws") 80 else 443
        return if (port == -1 || port == defaultPort) formatted else "$formatted:$port"
    }

    private fun parseEventRecord(value: JsonElement): RemoteEvent {
        val root = parseObject(value, "Event")
        val type = requireNonEmptyString(root, "type")
        val payload = requireJsonValue(root, "payload")
        when (type) {
            "workspace.updated" -> parseWorkspace(payload)
            "session.created", "session.loaded" -> parseSession(payload)
            "diff.updated" -> parseDiffSnapshot(payload)
            "model.catalog_updated" -> parseModelCatalog(payload)
            "model.selection_changed" -> parseModelSelectionChanged(payload)
            "session.context_updated" -> parseSessionContextUsage(payload)
        }
        val event =
            RemoteEvent(
                eventId = requireNonEmptyString(root, "eventId"),
                sessionId = requireNullableString(root, "sessionId"),
                timestamp = requireNonEmptyString(root, "timestamp"),
                type = type,
                payload = payload,
            )
        parseChatEvent(event)
        return event
    }

    private fun parseSessionStatusChangedPayload(payload: JsonElement): String {
        val root = parseObject(payload, "session.status_changed")
        val status = requireNonEmptyString(root, "status")
        if (status !in SESSION_STATUSES) {
            throw ProtocolParseError("status must be a known session status.")
        }
        return status
    }

    private fun parseUserMessagePayload(payload: JsonElement): String {
        val root = parseObject(payload, "user.message")
        return requireStringField(root, "text")
    }

    private fun parseAssistantMessagePayload(payload: JsonElement): Pair<String, Boolean> {
        val root = parseObject(payload, "assistant.message")
        return requireStringField(root, "text") to requireBoolean(root, "delta")
    }

    private fun parseAssistantStatusPayload(payload: JsonElement): String {
        val root = parseObject(payload, "assistant.status")
        return requireNonEmptyString(root, "status")
    }

    private fun parseAgentTerminalPayload(payload: JsonElement): String? {
        val root = parseObject(payload, "agent terminal")
        return requireNullableString(root, "reason")
    }

    private data class ParsedPermissionRequested(
        val permissionId: String,
        val kind: String,
        val command: String,
        val risk: String,
    )

    private data class ParsedPermissionResolved(
        val permissionId: String,
        val decision: String,
    )

    private fun parsePermissionRequestedPayload(payload: JsonElement): ParsedPermissionRequested {
        val root = parseObject(payload, "permission.requested")
        return ParsedPermissionRequested(
            permissionId = requireNonEmptyString(root, "permissionId"),
            kind = requireStringField(root, "kind"),
            command = requireStringField(root, "command"),
            risk = requireNonEmptyString(root, "risk"),
        )
    }

    private fun parsePermissionResolvedPayload(payload: JsonElement): ParsedPermissionResolved {
        val root = parseObject(payload, "permission.resolved")
        val decision = requireNonEmptyString(root, "decision")
        if (decision != "approved" && decision != "rejected") {
            throw ProtocolParseError("decision must be approved or rejected.")
        }
        return ParsedPermissionResolved(
            permissionId = requireNonEmptyString(root, "permissionId"),
            decision = decision,
        )
    }

    private fun permissionDecisionPayload(permissionId: String): JsonObject {
        requireNonEmpty(permissionId, "permissionId")
        return buildJsonObject { put("permissionId", permissionId) }
    }

    private fun parseModelCatalogEntry(value: JsonElement): ModelCatalogEntry {
        val root = parseObject(value, "model")
        return ModelCatalogEntry(
            id = requireNonEmptyString(root, "id"),
            displayName = requireNonEmptyString(root, "displayName"),
            description = requireNullableString(root, "description"),
            parameters = requireJsonValueArray(root, "parameters"),
            variants = requireJsonValueArray(root, "variants"),
            available = requireBoolean(root, "available"),
        )
    }

    private fun parseDiffFile(value: JsonElement): DiffFileInfo {
        val root = parseObject(value, "diff file")
        val change = requireNonEmptyString(root, "change")
        if (change !in DIFF_CHANGES) {
            throw ProtocolParseError("change must be a known diff change.")
        }
        val previousPath = requireNullableString(root, "previousPath")
        if (change == "renamed") {
            if (previousPath == null) {
                throw ProtocolParseError("previousPath must be a non-empty string.")
            }
        } else if (previousPath != null) {
            throw ProtocolParseError("previousPath must be null.")
        }
        return DiffFileInfo(
            path = requireNonEmptyString(root, "path"),
            previousPath = previousPath,
            change = change,
            binary = requireBoolean(root, "binary"),
            sensitive = requireBoolean(root, "sensitive"),
            additions = requireNonNegativeInt(root, "additions"),
            deletions = requireNonNegativeInt(root, "deletions"),
            unifiedDiff = requireNullableStringAllowEmpty(root, "unifiedDiff"),
            truncated = requireBoolean(root, "truncated"),
        )
    }

    private fun requireNullableStringAllowEmpty(
        root: JsonObject,
        key: String,
    ): String? {
        val value = root[key] ?: throw ProtocolParseError("$key must be a string or null.")
        if (value is JsonNull) return null
        val primitive = value as? JsonPrimitive
        if (primitive == null || !primitive.isString) {
            throw ProtocolParseError("$key must be a string or null.")
        }
        return primitive.content
    }

    private fun parseResultRecord(value: JsonObject): RemoteCommandResult {
        val requestId = requireNonEmptyString(value, "requestId")
        val ok = requireBoolean(value, "ok")
        if ("value" !in value) {
            throw ProtocolParseError("value must be valid JSON data or null.")
        }
        val rawValue = value.getValue("value")
        if (rawValue !is JsonNull && !isJsonValue(rawValue)) {
            throw ProtocolParseError("value must be valid JSON data or null.")
        }
        val error = requireNullableString(value, "error")
        if (ok) {
            if (error != null) {
                throw ProtocolParseError("successful result must have error null.")
            }
            return RemoteCommandResult(requestId, true, rawValue.takeUnless { it is JsonNull }, null)
        }
        if (rawValue !is JsonNull) {
            throw ProtocolParseError("failed result must have value null.")
        }
        if (error == null) {
            throw ProtocolParseError("failed result must have a non-empty error.")
        }
        return RemoteCommandResult(requestId, false, null, error)
    }

    private fun publicJwkElement(publicKey: P256PublicJwk): JsonObject =
        buildJsonObject {
            put("kty", publicKey.kty)
            put("crv", publicKey.crv)
            put("x", publicKey.x)
            put("y", publicKey.y)
        }

    private fun requireJsonValueArray(
        root: JsonObject,
        key: String,
    ): List<JsonElement> {
        val value = root[key] ?: throw ProtocolParseError("$key must be a JSON array.")
        val array = value as? JsonArray ?: throw ProtocolParseError("$key must be a JSON array.")
        if (!array.all { isJsonValue(it) }) {
            throw ProtocolParseError("$key must be valid JSON data.")
        }
        return array.toList()
    }

    private fun <T> parseList(
        value: JsonElement?,
        label: String,
        parse: (JsonElement) -> T,
    ): List<T> {
        val array = value as? JsonArray ?: throw ProtocolParseError("$label must be a JSON array.")
        return array.map(parse)
    }

    private fun parseJson(text: String): JsonElement =
        try {
            Json.parseToJsonElement(text)
        } catch (_: Exception) {
            throw ProtocolParseError("Frame must be a JSON object.")
        }

    private fun parseObject(
        value: JsonElement,
        label: String,
    ): JsonObject = value as? JsonObject ?: throw ProtocolParseError("$label must be a JSON object.")

    private fun requireObject(
        root: JsonObject,
        key: String,
    ): JsonObject = parseObject(root[key] ?: throw ProtocolParseError("$key must be a JSON object."), key)

    private fun requireJsonValue(
        root: JsonObject,
        key: String,
    ): JsonElement {
        val value = root[key] ?: throw ProtocolParseError("$key must be valid JSON data.")
        if (!isJsonValue(value)) throw ProtocolParseError("$key must be valid JSON data.")
        return value
    }

    private fun requireNonEmptyString(
        root: JsonObject,
        key: String,
    ): String {
        val value = root[key] as? JsonPrimitive
        if (value == null || !value.isString || value.content.isEmpty()) {
            throw ProtocolParseError("$key must be a non-empty string.")
        }
        return value.content
    }

    private fun requireStringField(
        root: JsonObject,
        key: String,
    ): String {
        val value = root[key] as? JsonPrimitive
        if (value == null || !value.isString) {
            throw ProtocolParseError("$key must be a string.")
        }
        return value.content
    }

    private fun requireNullableString(
        root: JsonObject,
        key: String,
    ): String? {
        val value = root[key] ?: throw ProtocolParseError("$key must be a non-empty string or null.")
        if (value is JsonNull) return null
        val primitive = value as? JsonPrimitive
        if (primitive == null || !primitive.isString || primitive.content.isEmpty()) {
            throw ProtocolParseError("$key must be a non-empty string or null.")
        }
        return primitive.content
    }

    private fun requireBoolean(
        root: JsonObject,
        key: String,
    ): Boolean {
        val value = root[key] as? JsonPrimitive
        if (value == null || value.isString) throw ProtocolParseError("$key must be a boolean.")
        return when (value.content) {
            "true" -> true
            "false" -> false
            else -> throw ProtocolParseError("$key must be a boolean.")
        }
    }

    private fun requireSafeInteger(
        root: JsonObject,
        key: String,
    ): Long {
        val value = root[key] as? JsonPrimitive
        if (value == null || value.isString || !value.content.matches(Regex("0|-?[1-9][0-9]*"))) {
            throw ProtocolParseError("$key must be a positive safe integer.")
        }
        val parsed = value.content.toLongOrNull() ?: throw ProtocolParseError("$key must be a positive safe integer.")
        if (parsed > JS_MAX_SAFE_INTEGER || parsed < -JS_MAX_SAFE_INTEGER) {
            throw ProtocolParseError("$key must be a positive safe integer.")
        }
        return parsed
    }

    private fun requireNonNegativeInt(
        root: JsonObject,
        key: String,
    ): Int {
        val parsed = requireSafeInteger(root, key)
        if (parsed < 0 || parsed > Int.MAX_VALUE) throw ProtocolParseError("$key must be a non-negative integer.")
        return parsed.toInt()
    }

    private fun requireNonEmpty(
        value: String,
        fieldName: String,
    ) {
        if (value.isEmpty()) throw ProtocolParseError("$fieldName must be a non-empty string.")
    }

    private fun assertExactKeys(
        value: JsonObject,
        keys: List<String>,
    ) {
        if (value.keys != keys.toSet()) throw ProtocolParseError("unexpected or missing fields.")
    }

    private fun parseBase64UrlBytes(
        value: JsonElement,
        size: Int,
        fieldName: String,
    ): String {
        val raw = parseBase64Url(value, fieldName)
        if (raw.size != size) throw ProtocolParseError("$fieldName must be $size bytes encoded as base64url.")
        return encodeBase64Url(raw)
    }

    private fun parseBase64Url(
        value: JsonElement,
        fieldName: String,
    ): ByteArray {
        val primitive = value as? JsonPrimitive
        if (primitive == null || !primitive.isString || primitive.content.isEmpty() ||
            !primitive.content.matches(Regex("^[A-Za-z0-9_-]+$"))
        ) {
            throw ProtocolParseError("$fieldName must be base64url.")
        }
        val raw =
            try {
                Base64.getUrlDecoder().decode(primitive.content)
            } catch (_: Exception) {
                throw ProtocolParseError("$fieldName must be base64url.")
            }
        if (raw.isEmpty() || encodeBase64Url(raw) != primitive.content) {
            throw ProtocolParseError("$fieldName must be base64url.")
        }
        return raw
    }

    private fun toFixedLength(
        value: BigInteger,
        size: Int,
        fieldName: String,
    ): ByteArray {
        val raw = value.toByteArray()
        val unsigned = if (raw.isNotEmpty() && raw[0] == 0.toByte()) raw.copyOfRange(1, raw.size) else raw
        if (unsigned.isEmpty() || unsigned.size > size) {
            throw ProtocolParseError("$fieldName must be $size bytes encoded as base64url.")
        }
        return if (unsigned.size == size) unsigned else ByteArray(size).also { unsigned.copyInto(it, size - unsigned.size) }
    }

    private fun isJsonValue(value: JsonElement): Boolean {
        return when (value) {
            is JsonNull -> true
            is JsonPrimitive ->
                value.isString || value.content == "true" || value.content == "false" ||
                    value.content.toDoubleOrNull()?.isFinite() == true
            is JsonArray -> value.all { isJsonValue(it) }
            is JsonObject -> value.values.all { isJsonValue(it) }
            else -> false
        }
    }
}
