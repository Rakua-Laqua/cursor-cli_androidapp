package dev.cursorremote.android.notify

import dev.cursorremote.android.data.local.NOTIFICATION_EVENT_LIMIT
import dev.cursorremote.android.data.local.ReliabilityStore
import dev.cursorremote.android.data.protocol.ChatEvent
import dev.cursorremote.android.data.protocol.ProtocolParseError
import dev.cursorremote.android.data.protocol.RemoteEvent
import dev.cursorremote.android.data.protocol.RemoteProtocol
import dev.cursorremote.android.data.remote.RemoteConnectionState
import java.util.LinkedHashSet
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking

fun interface ScheduledNotification {
    fun cancel()
}

fun interface ScheduleAfter {
    fun schedule(delayMs: Long, action: () -> Unit): ScheduledNotification
}

class PushNotificationCoordinator(
    private val poster: NotificationPoster,
    private val scheduleAfter: ScheduleAfter,
    private val reliabilityStore: ReliabilityStore,
    private val currentMachineId: () -> String?,
) {
    private val lock = Any()
    private var foreground = false
    private val seenEventIds = LinkedHashSet<String>()
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
        val immediate =
            synchronized(lock) {
                when (chat) {
                    is ChatEvent.AgentCompleted -> {
                        cancelSessionWaitingLocked(chat.sessionId)
                        prepareImmediateLocked(
                            chat.eventId,
                            NotificationContent(
                                title = TITLE_COMPLETED,
                                body = BODY_COMPLETED,
                            ),
                            chat.sessionId,
                        )
                    }
                    is ChatEvent.AgentFailed -> {
                        cancelSessionWaitingLocked(chat.sessionId)
                        prepareImmediateLocked(
                            chat.eventId,
                            NotificationContent(
                                title = TITLE_FAILED,
                                body = boundedReason(chat.reason, BODY_FAILED_FALLBACK),
                            ),
                            chat.sessionId,
                        )
                    }
                    is ChatEvent.AgentInterrupted -> {
                        cancelSessionWaitingLocked(chat.sessionId)
                        null
                    }
                    is ChatEvent.PermissionRequested -> {
                        cancelSessionWaitingLocked(chat.sessionId)
                        prepareImmediateLocked(
                            chat.eventId,
                            NotificationContent(
                                title = TITLE_PERMISSION,
                                body = boundedFirstLine(chat.command),
                            ),
                            chat.sessionId,
                        )
                    }
                    is ChatEvent.PermissionResolved -> {
                        cancelSessionWaitingLocked(chat.sessionId)
                        null
                    }
                    is ChatEvent.AgentWaiting -> {
                        handleWaitingLocked(chat)
                        null
                    }
                    is ChatEvent.SessionStatusChanged,
                    is ChatEvent.UserMessage,
                    is ChatEvent.AssistantMessage,
                    is ChatEvent.AssistantStatus,
                    -> null
                }
            }
        if (immediate != null) {
            postImmediate(immediate)
        }
    }

    fun onPush(payload: FcmDataPayload) {
        val immediate =
            synchronized(lock) {
                cancelSessionWaitingLocked(payload.sessionId)
                if (foreground || !poster.notificationsEnabled()) {
                    rememberEventIdLocked(payload.eventId)
                    null
                } else {
                    ImmediatePost(
                        eventId = payload.eventId,
                        content = genericContent(payload.type),
                        target =
                            NotificationTarget(
                                machineId = payload.machineId,
                                sessionId = payload.sessionId,
                                eventId = payload.eventId,
                            ),
                    )
                }
            } ?: return
        postImmediate(immediate)
        synchronized(lock) {
            rememberEventIdLocked(payload.eventId)
        }
    }

    private fun handleWaitingLocked(chat: ChatEvent.AgentWaiting) {
        if (!rememberEventIdLocked(chat.eventId)) {
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
        val target = targetFor(eventId, sessionId)
        val scheduled =
            scheduleAfter.schedule(LONG_WAITING_MS) {
                try {
                    runBlocking {
                        onWaitingFired(sessionId, eventId, content, target)
                    }
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                }
            }
        waitingTimers[sessionId] = PendingWaiting(eventId, scheduled)
    }

    private suspend fun onWaitingFired(
        sessionId: String,
        eventId: String,
        content: NotificationContent,
        target: NotificationTarget?,
    ) {
        val shouldClaim =
            synchronized(lock) {
                val pending = waitingTimers[sessionId] ?: return
                if (pending.eventId != eventId) {
                    return
                }
                if (foreground) {
                    waitingTimers.remove(sessionId)
                    return
                }
                if (!poster.notificationsEnabled()) {
                    waitingTimers.remove(sessionId)
                    return
                }
                true
            }
        if (!shouldClaim) {
            return
        }
        val claimed = claimSafely(eventId)
        synchronized(lock) {
            val pending = waitingTimers[sessionId] ?: return
            if (pending.eventId != eventId) {
                return
            }
            waitingTimers.remove(sessionId)
            if (!claimed) {
                return
            }
            if (foreground) {
                return
            }
            if (!poster.notificationsEnabled()) {
                return
            }
            poster.post(eventId, content, target)
        }
    }

    private fun prepareImmediateLocked(
        eventId: String,
        content: NotificationContent,
        sessionId: String,
    ): ImmediatePost? {
        if (!rememberEventIdLocked(eventId)) {
            return null
        }
        if (foreground) {
            return null
        }
        if (!poster.notificationsEnabled()) {
            return null
        }
        return ImmediatePost(eventId, content, targetFor(eventId, sessionId))
    }

    private fun postImmediate(work: ImmediatePost) {
        try {
            runBlocking {
                val claimed = claimSafely(work.eventId)
                synchronized(lock) {
                    if (!claimed) {
                        return@runBlocking
                    }
                    if (foreground) {
                        return@runBlocking
                    }
                    if (!poster.notificationsEnabled()) {
                        return@runBlocking
                    }
                    poster.post(work.eventId, work.content, work.target)
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
        }
    }

    private suspend fun claimSafely(eventId: String): Boolean =
        try {
            reliabilityStore.claimNotificationEventId(eventId)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            false
        }

    private fun targetFor(eventId: String, sessionId: String): NotificationTarget? =
        NotificationTarget.verified(currentMachineId(), sessionId, eventId)

    private fun rememberEventIdLocked(eventId: String): Boolean {
        if (!seenEventIds.add(eventId)) {
            return false
        }
        if (seenEventIds.size > NOTIFICATION_EVENT_LIMIT) {
            val oldest = seenEventIds.iterator()
            oldest.next()
            oldest.remove()
        }
        return true
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

    private class ImmediatePost(
        val eventId: String,
        val content: NotificationContent,
        val target: NotificationTarget?,
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
        private const val BODY_GENERIC = "Open the app to continue."

        internal fun genericContent(type: String): NotificationContent =
            when (type) {
                PUSH_TYPE_PERMISSION_REQUESTED ->
                    NotificationContent(TITLE_PERMISSION, BODY_GENERIC)
                PUSH_TYPE_AGENT_COMPLETED ->
                    NotificationContent(TITLE_COMPLETED, BODY_COMPLETED)
                PUSH_TYPE_AGENT_FAILED ->
                    NotificationContent(TITLE_FAILED, BODY_FAILED_FALLBACK)
                else -> NotificationContent(TITLE_WAITING, BODY_WAITING_FALLBACK)
            }

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
