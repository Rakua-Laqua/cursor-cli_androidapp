package dev.cursorremote.android.notify

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import dev.cursorremote.android.MainActivity
import dev.cursorremote.android.R

class SystemNotificationPoster(
    context: Context,
) : NotificationPoster {
    private val appContext = context.applicationContext
    private val notificationManager =
        appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    init {
        val channel =
            NotificationChannel(
                CHANNEL_ID,
                appContext.getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT,
            )
        channel.description = appContext.getString(R.string.notification_channel_description)
        notificationManager.createNotificationChannel(channel)
    }

    override fun notificationsEnabled(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            appContext.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return notificationManager.areNotificationsEnabled()
    }

    override fun post(eventId: String, content: NotificationContent, target: NotificationTarget?) {
        val intent =
            Intent(appContext, MainActivity::class.java).apply {
                action = notificationPendingIntentAction(eventId)
                flags =
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP or
                        Intent.FLAG_ACTIVITY_CLEAR_TOP
                if (target != null) {
                    putExtra(NotificationTarget.EXTRA_MACHINE_ID, target.machineId)
                    putExtra(NotificationTarget.EXTRA_SESSION_ID, target.sessionId)
                    putExtra(NotificationTarget.EXTRA_EVENT_ID, target.eventId)
                }
            }
        val pendingIntent =
            PendingIntent.getActivity(
                appContext,
                eventId.hashCode(),
                intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        val notification =
            Notification.Builder(appContext, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(content.title)
                .setContentText(content.body)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(pendingIntent)
                .build()
        notificationManager.notify(eventId, NOTIFICATION_ID, notification)
    }

    private companion object {
        const val CHANNEL_ID = "cursor_remote_session_events"
        const val NOTIFICATION_ID = 303
    }
}

internal fun notificationPendingIntentAction(eventId: String): String =
    "dev.cursorremote.android.notify.OPEN_EVENT:$eventId"
