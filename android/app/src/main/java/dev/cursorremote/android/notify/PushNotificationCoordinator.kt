package dev.cursorremote.android.notify

import dev.cursorremote.android.data.protocol.ChatEvent
import dev.cursorremote.android.data.protocol.ProtocolParseError
import dev.cursorremote.android.data.protocol.RemoteEvent
import dev.cursorremote.android.data.protocol.RemoteProtocol
import dev.cursorremote.android.data.remote.RemoteConnectionState

fun interface ScheduledNotification {
    fun cancel()
}

fun interface ScheduleAfter {
    fun schedule(delayMs: Long, action: () -> Unit): ScheduledNotification
}

class PushNotificationCoordinator(
    private val poster: NotificationPoster,
    private val scheduleAfter: ScheduleAfter,
) {
    private val lock = Any()
    private var foreground = false
    private val seenEventIds = mutableSetOf<String>()
    private val waitingTimers = mutableMapOf<String, PendingWaiting>()

    fun setForeground(isForeground: Boolean) {
        synchronized(lock) {
            foreground = isForeground
        }
    }

    fun onConnectionState(state: RemoteConnectionState) {
        if (state == RemoteConnectionState.Ready) {
            return
        }
        synchronized(lock) {
            cancelAllWaitingLocked()
        }
    }

    fun onEvent(event: RemoteEvent) {
        val chat =
            try {
                RemoteProtocol.parseChatEvent(event)
            } catch (_: ProtocolParseError) {
                return
            } ?: return
        synchronized(lock) {
            when (chat) {
                is ChatEvent.AgentCompleted -> {
                    cancelSessionWaitingLocked(chat.sessionId)
                    postImmediateOnceLocked(
                        chat.eventId,
                        NotificationContent(
                            title = TITLE_COMPLETED,
                            body = BODY_COMPLETED,
                        ),
                    )
                }
                is ChatEvent.AgentFailed -> {
                    cancelSessionWaitingLocked(chat.sessionId)
                    postImmediateOnceLocked(
                        chat.eventId,
                        NotificationContent(
                            title = TITLE_FAILED,
                            body = boundedReason(chat.reason, BODY_FAILED_FALLBACK),
                        ),
                    )
                }
                is ChatEvent.AgentInterrupted -> {
                    cancelSessionWaitingLocked(chat.sessionId)
                }
                is ChatEvent.PermissionRequested -> {
                    cancelSessionWaitingLocked(chat.sessionId)
                    postImmediateOnceLocked(
                        chat.eventId,
                        NotificationContent(
                            title = TITLE_PERMISSION,
                            body = boundedFirstLine(chat.command),
                        ),
                    )
                }
                is ChatEvent.PermissionResolved -> {
                    cancelSessionWaitingLocked(chat.sessionId)
                }
                is ChatEvent.AgentWaiting -> {
                    handleWaitingLocked(chat)
                }
                is ChatEvent.SessionStatusChanged,
                is ChatEvent.UserMessage,
                is ChatEvent.AssistantMessage,
                is ChatEvent.AssistantStatus,
                -> Unit
            }
        }
    }

    private fun handleWaitingLocked(chat: ChatEvent.AgentWaiting) {
        if (!seenEventIds.add(chat.eventId)) {
            return
        }
        cancelSessionWaitingLocked(chat.sessionId)
        val content =
            NotificationContent(
                title = TITLE_WAITING,
                body = boundedReason(chat.reason, BODY_WAITING_FALLBACK),
            )
        val sessionId = chat.sessionId
        val eventId = chat.eventId
        val scheduled =
            scheduleAfter.schedule(LONG_WAITING_MS) {
                onWaitingFired(sessionId, eventId, content)
            }
        waitingTimers[sessionId] = PendingWaiting(eventId, scheduled)
    }

    private fun onWaitingFired(
        sessionId: String,
        eventId: String,
        content: NotificationContent,
    ) {
        synchronized(lock) {
            val pending = waitingTimers[sessionId] ?: return
            if (pending.eventId != eventId) {
                return
            }
            waitingTimers.remove(sessionId)
            if (foreground) {
                return
            }
            if (!poster.notificationsEnabled()) {
                return
            }
            poster.post(eventId, content)
        }
    }

    private fun postImmediateOnceLocked(eventId: String, content: NotificationContent) {
        if (!seenEventIds.add(eventId)) {
            return
        }
        if (foreground) {
            return
        }
        if (!poster.notificationsEnabled()) {
            return
        }
        poster.post(eventId, content)
    }

    private fun cancelSessionWaitingLocked(sessionId: String) {
        waitingTimers.remove(sessionId)?.scheduled?.cancel()
    }

    private fun cancelAllWaitingLocked() {
        waitingTimers.values.forEach { it.scheduled.cancel() }
        waitingTimers.clear()
    }

    private class PendingWaiting(
        val eventId: String,
        val scheduled: ScheduledNotification,
    )

    companion object {
        const val LONG_WAITING_MS = 60_000L
        private const val BODY_MAX_CHARS = 240
        private const val TITLE_PERMISSION = "Cursor is waiting for approval"
        private const val TITLE_COMPLETED = "Session completed"
        private const val TITLE_FAILED = "Session failed"
        private const val TITLE_WAITING = "Cursor is waiting"
        private const val BODY_COMPLETED = "Cursor finished the task."
        private const val BODY_FAILED_FALLBACK = "Cursor could not finish the task."
        private const val BODY_WAITING_FALLBACK = "Open the app to continue."

        private fun boundedReason(reason: String?, fallback: String): String {
            if (reason == null) {
                return fallback
            }
            val bounded = boundedFirstLine(reason)
            return bounded.ifEmpty { fallback }
        }

        private fun boundedFirstLine(text: String): String {
            var end = text.length
            for (index in text.indices) {
                val char = text[index]
                if (char == '\n' || char == '\r') {
                    end = index
                    break
                }
            }
            val first = text.substring(0, end).trim()
            return if (first.length <= BODY_MAX_CHARS) first else first.substring(0, BODY_MAX_CHARS)
        }
    }
}
