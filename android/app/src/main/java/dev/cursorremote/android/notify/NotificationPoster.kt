package dev.cursorremote.android.notify

data class NotificationContent(
    val title: String,
    val body: String,
)

interface NotificationPoster {
    fun notificationsEnabled(): Boolean

    fun post(eventId: String, content: NotificationContent)
}
