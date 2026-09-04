package dev.cursorremote.android.notify

data class NotificationContent(
    val title: String,
    val body: String,
)

data class NotificationTarget(
    val machineId: String,
    val sessionId: String,
    val eventId: String,
) {
    companion object {
        const val EXTRA_MACHINE_ID = "dev.cursorremote.android.notify.MACHINE_ID"
        const val EXTRA_SESSION_ID = "dev.cursorremote.android.notify.SESSION_ID"
        const val EXTRA_EVENT_ID = "dev.cursorremote.android.notify.EVENT_ID"
        const val MAX_ID_CODE_UNITS = 512

        fun verified(machineId: String?, sessionId: String?, eventId: String): NotificationTarget? {
            val machine = machineId ?: return null
            val session = sessionId ?: ""
            if (!isBoundPushId(eventId, allowEmpty = false)) {
                return null
            }
            if (!isBoundPushId(machine, allowEmpty = false)) {
                return null
            }
            if (!isBoundPushId(session, allowEmpty = true)) {
                return null
            }
            return NotificationTarget(machine, session, eventId)
        }
    }
}

internal fun isBoundPushId(value: String, allowEmpty: Boolean): Boolean {
    if (!allowEmpty && value.isEmpty()) {
        return false
    }
    return value.length <= NotificationTarget.MAX_ID_CODE_UNITS
}

internal fun notificationTargetFromIntentValues(
    action: String?,
    machineId: String?,
    sessionId: String?,
    eventId: String?,
): NotificationTarget? {
    if (eventId == null || machineId == null || sessionId == null) {
        return null
    }
    if (action != notificationPendingIntentAction(eventId)) {
        return null
    }
    return NotificationTarget.verified(machineId, sessionId, eventId)
}

interface NotificationPoster {
    fun notificationsEnabled(): Boolean

    fun post(eventId: String, content: NotificationContent, target: NotificationTarget? = null)
}
