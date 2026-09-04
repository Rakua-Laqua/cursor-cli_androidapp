package dev.cursorremote.android.notify

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.cursorremote.android.CursorRemoteApplication
import dev.cursorremote.android.data.local.ReliabilityStore
import dev.cursorremote.android.data.protocol.ProtocolParseError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking

const val PUSH_TYPE_PERMISSION_REQUESTED = "permission.requested"
const val PUSH_TYPE_AGENT_COMPLETED = "agent.completed"
const val PUSH_TYPE_AGENT_FAILED = "agent.failed"
const val PUSH_TYPE_AGENT_WAITING = "agent.waiting"

val PUSH_EVENT_TYPES: Set<String> =
    setOf(
        PUSH_TYPE_PERMISSION_REQUESTED,
        PUSH_TYPE_AGENT_COMPLETED,
        PUSH_TYPE_AGENT_FAILED,
        PUSH_TYPE_AGENT_WAITING,
    )

private val PAYLOAD_KEYS = setOf("eventId", "type", "machineId", "sessionId")

const val FCM_TOKEN_MAX_CODE_UNITS = 4096

private val FCM_TOKEN_CHARS = Regex("^[A-Za-z0-9_.:-]+$")

fun acceptedFcmToken(value: String?): String? {
    if (value.isNullOrEmpty()) {
        return null
    }
    if (value.length > FCM_TOKEN_MAX_CODE_UNITS) {
        return null
    }
    if (!FCM_TOKEN_CHARS.matches(value)) {
        return null
    }
    return value
}

@Suppress("DEPRECATION")
fun bootstrapFcmToken(context: Context, onValidToken: (String) -> Unit) {
    val app =
        try {
            FirebaseApp.getInstance()
        } catch (_: Exception) {
            try {
                FirebaseApp.initializeApp(context.applicationContext)
            } catch (_: Exception) {
                null
            }
        }
    if (app == null) {
        return
    }
    try {
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener { task ->
            if (!task.isSuccessful) {
                return@addOnCompleteListener
            }
            val raw =
                try {
                    task.result
                } catch (_: Exception) {
                    null
                }
            val valid = acceptedFcmToken(raw) ?: return@addOnCompleteListener
            try {
                onValidToken(valid)
            } catch (_: Exception) {
            }
        }
    } catch (_: Exception) {
    }
}

data class FcmDataPayload(
    val eventId: String,
    val type: String,
    val machineId: String,
    val sessionId: String,
)

fun parseFcmDataPayload(data: Map<String, String>): FcmDataPayload {
    if (data.size != 4 || data.keys.any { it !in PAYLOAD_KEYS }) {
        throw ProtocolParseError("unexpected or missing fields.")
    }
    val type = data["type"] ?: ""
    if (type !in PUSH_EVENT_TYPES) {
        throw ProtocolParseError("type must be a push event type.")
    }
    return FcmDataPayload(
        eventId = boundId(data["eventId"], "eventId", false),
        type = type,
        machineId = boundId(data["machineId"], "machineId", false),
        sessionId = boundId(data["sessionId"], "sessionId", true),
    )
}

private fun boundId(value: String?, field: String, allowEmpty: Boolean): String {
    if (value == null) {
        throw ProtocolParseError(
            if (allowEmpty) "$field must be a string." else "$field must be a non-empty string.",
        )
    }
    if (!allowEmpty && value.isEmpty()) {
        throw ProtocolParseError("$field must be a non-empty string.")
    }
    if (value.length > NotificationTarget.MAX_ID_CODE_UNITS) {
        throw ProtocolParseError("$field must be at most 512 characters.")
    }
    return value
}

class FcmMessageHandler(
    private val coordinator: PushNotificationCoordinator,
    private val reliabilityStore: ReliabilityStore,
    private val tokenSink: (String) -> Unit = {},
) {
    fun onNewToken(token: String) {
        val valid = acceptedFcmToken(token) ?: return
        try {
            tokenSink(valid)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
        }
    }

    fun onDataMessage(data: Map<String, String>, hasNotificationPayload: Boolean) {
        if (hasNotificationPayload) {
            return
        }
        val payload =
            try {
                parseFcmDataPayload(data)
            } catch (_: Exception) {
                return
            }
        try {
            coordinator.onPush(payload)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
        }
    }

    suspend fun onDeletedMessages() {
        try {
            reliabilityStore.setNeedsCatchUp(true)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
        }
    }
}

class CursorRemoteFirebaseMessagingService : FirebaseMessagingService() {
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onNewToken(token: String) {
        try {
            handler()?.onNewToken(token)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        dispatch {
            handler()?.onDataMessage(message.data, message.notification != null)
        }
    }

    override fun onDeletedMessages() {
        dispatch {
            handler()?.onDeletedMessages()
        }
    }

    private fun handler(): FcmMessageHandler? =
        try {
            (application as? CursorRemoteApplication)?.container?.fcmMessageHandler
        } catch (_: Exception) {
            null
        }

    private fun dispatch(action: suspend () -> Unit) {
        try {
            runBlocking(Dispatchers.IO) {
                action()
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
        }
    }
}
