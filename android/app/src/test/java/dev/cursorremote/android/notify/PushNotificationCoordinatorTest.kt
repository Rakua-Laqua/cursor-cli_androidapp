package dev.cursorremote.android.notify

import dev.cursorremote.android.data.protocol.IncomingRemoteFrame
import dev.cursorremote.android.data.protocol.RemoteEvent
import dev.cursorremote.android.data.protocol.RemoteProtocol
import dev.cursorremote.android.data.remote.RemoteConnectionState
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PushNotificationCoordinatorTest {
    @Test
    fun eventFilterPostsImmediateTargetsAndIgnoresStreamingInterruptedAndResolved() {
        val harness = Harness()
        harness.coordinator.onEvent(
            chatEvent(
                "permission.requested",
                """{"permissionId":"perm-1","kind":"execute","command":"Get-ChildItem -Force","risk":"high"}""",
                eventId = "evt-perm",
            ),
        )
        harness.coordinator.onEvent(chatEvent("agent.completed", """{"reason":"done"}""", eventId = "evt-done"))
        harness.coordinator.onEvent(chatEvent("agent.failed", """{"reason":"boom"}""", eventId = "evt-fail"))
        harness.coordinator.onEvent(chatEvent("agent.interrupted", """{"reason":null}""", eventId = "evt-int"))
        harness.coordinator.onEvent(
            chatEvent("permission.resolved", """{"permissionId":"perm-1","decision":"approved"}""", eventId = "evt-res"),
        )
        harness.coordinator.onEvent(chatEvent("user.message", """{"text":"hi"}""", eventId = "evt-user"))
        harness.coordinator.onEvent(
            chatEvent("assistant.message", """{"text":"Hel","delta":true}""", eventId = "evt-asst"),
        )
        harness.coordinator.onEvent(chatEvent("assistant.status", """{"status":"thinking"}""", eventId = "evt-status"))
        harness.coordinator.onEvent(
            chatEvent("session.status_changed", """{"status":"running"}""", eventId = "evt-sess"),
        )
        harness.coordinator.onEvent(chatEvent("agent.waiting", """{"reason":null}""", eventId = "evt-wait"))
        assertEquals(
            listOf(
                "evt-perm" to NotificationContent("Cursor is waiting for approval", "Get-ChildItem -Force"),
                "evt-done" to NotificationContent("Session completed", "Cursor finished the task."),
                "evt-fail" to NotificationContent("Session failed", "boom"),
            ),
            harness.poster.posted,
        )
        assertEquals(1, harness.scheduler.tasks.size)
        assertEquals(PushNotificationCoordinator.LONG_WAITING_MS, harness.scheduler.tasks.single().delayMs)
    }

    @Test
    fun foregroundSuppressesImmediateAndWaitingFireWithoutDroppingTimer() {
        val harness = Harness()
        harness.coordinator.setForeground(true)
        harness.coordinator.onEvent(chatEvent("agent.completed", """{"reason":null}""", eventId = "evt-done"))
        harness.coordinator.onEvent(chatEvent("agent.waiting", """{"reason":null}""", eventId = "evt-wait"))
        assertTrue(harness.poster.posted.isEmpty())
        assertEquals(1, harness.scheduler.tasks.size)
        harness.scheduler.tasks.single().fire()
        assertTrue(harness.poster.posted.isEmpty())
        harness.coordinator.setForeground(false)
        harness.coordinator.onEvent(chatEvent("agent.completed", """{"reason":null}""", eventId = "evt-done"))
        harness.scheduler.tasks.single().fire()
        assertTrue(harness.poster.posted.isEmpty())
    }

    @Test
    fun backgroundWaitingFiresAfterLeavingForeground() {
        val harness = Harness()
        harness.coordinator.setForeground(true)
        harness.coordinator.onEvent(chatEvent("agent.waiting", """{"reason":null}""", eventId = "evt-wait"))
        harness.coordinator.setForeground(false)
        harness.scheduler.tasks.single().fire()
        assertEquals(
            listOf("evt-wait" to NotificationContent("Cursor is waiting", "Open the app to continue.")),
            harness.poster.posted,
        )
    }

    @Test
    fun duplicateEventIdIsNotNotifiedAfterBackgroundOrPermissionEnable() {
        val harness = Harness()
        harness.coordinator.setForeground(true)
        harness.coordinator.onEvent(
            chatEvent(
                "permission.requested",
                """{"permissionId":"perm-1","kind":"execute","command":"ls","risk":"high"}""",
                eventId = "evt-perm",
            ),
        )
        harness.coordinator.setForeground(false)
        harness.poster.enabled = false
        harness.coordinator.onEvent(chatEvent("agent.failed", """{"reason":"boom"}""", eventId = "evt-fail"))
        harness.poster.enabled = true
        harness.coordinator.onEvent(
            chatEvent(
                "permission.requested",
                """{"permissionId":"perm-1","kind":"execute","command":"ls","risk":"high"}""",
                eventId = "evt-perm",
            ),
        )
        harness.coordinator.onEvent(chatEvent("agent.failed", """{"reason":"boom"}""", eventId = "evt-fail"))
        assertTrue(harness.poster.posted.isEmpty())
    }

    @Test
    fun permissionDisabledDoesNotPostImmediateOrWaitingFire() {
        val harness = Harness()
        harness.poster.enabled = false
        harness.coordinator.onEvent(chatEvent("agent.completed", """{"reason":null}""", eventId = "evt-done"))
        harness.coordinator.onEvent(chatEvent("agent.waiting", """{"reason":"hold"}""", eventId = "evt-wait"))
        harness.scheduler.tasks.single().fire()
        assertTrue(harness.poster.posted.isEmpty())
        harness.poster.enabled = true
        harness.coordinator.onEvent(chatEvent("agent.completed", """{"reason":null}""", eventId = "evt-done"))
        harness.scheduler.tasks.single().fire()
        assertTrue(harness.poster.posted.isEmpty())
    }

    @Test
    fun otherSessionStillNotifies() {
        val harness = Harness()
        harness.coordinator.onEvent(
            chatEvent("agent.completed", """{"reason":null}""", sessionId = "sess-1", eventId = "evt-1"),
        )
        harness.coordinator.onEvent(
            chatEvent("agent.failed", """{"reason":"x"}""", sessionId = "sess-2", eventId = "evt-2"),
        )
        assertEquals(listOf("evt-1", "evt-2"), harness.poster.posted.map { it.first })
    }

    @Test
    fun waitingSameIdDoesNotExtendTimerAndNewIdReplaces() {
        val harness = Harness()
        harness.coordinator.onEvent(chatEvent("agent.waiting", """{"reason":"one"}""", eventId = "wait-1"))
        harness.coordinator.onEvent(chatEvent("agent.waiting", """{"reason":"one"}""", eventId = "wait-1"))
        assertEquals(1, harness.scheduler.tasks.size)
        harness.coordinator.onEvent(chatEvent("agent.waiting", """{"reason":"two"}""", eventId = "wait-2"))
        assertEquals(2, harness.scheduler.tasks.size)
        assertTrue(harness.scheduler.tasks[0].cancelled)
        harness.scheduler.tasks[0].fire()
        assertTrue(harness.poster.posted.isEmpty())
        harness.scheduler.tasks[1].fire()
        assertEquals(
            listOf("wait-2" to NotificationContent("Cursor is waiting", "two")),
            harness.poster.posted,
        )
    }

    @Test
    fun waitingCancelledByTerminalPermissionAndNonReadyConnectionBeforeDedupe() {
        val harness = Harness()
        harness.coordinator.onEvent(chatEvent("agent.waiting", """{"reason":null}""", eventId = "wait-a"))
        harness.coordinator.onEvent(chatEvent("agent.completed", """{"reason":null}""", eventId = "done-a"))
        harness.scheduler.tasks.last().fire()
        assertEquals(listOf("done-a"), harness.poster.posted.map { it.first })

        harness.poster.posted.clear()
        harness.coordinator.onEvent(chatEvent("agent.waiting", """{"reason":null}""", eventId = "wait-b"))
        harness.coordinator.onEvent(chatEvent("agent.failed", """{"reason":null}""", eventId = "fail-b"))
        harness.scheduler.tasks.last().fire()
        assertEquals(listOf("fail-b"), harness.poster.posted.map { it.first })

        harness.poster.posted.clear()
        harness.coordinator.onEvent(chatEvent("agent.waiting", """{"reason":null}""", eventId = "wait-c"))
        harness.coordinator.onEvent(chatEvent("agent.interrupted", """{"reason":null}""", eventId = "int-c"))
        harness.scheduler.tasks.last().fire()
        assertTrue(harness.poster.posted.isEmpty())

        harness.coordinator.onEvent(chatEvent("agent.waiting", """{"reason":null}""", eventId = "wait-d"))
        harness.coordinator.onEvent(
            chatEvent(
                "permission.requested",
                """{"permissionId":"perm-1","kind":"execute","command":"ls","risk":"high"}""",
                eventId = "perm-d",
            ),
        )
        harness.scheduler.tasks.last().fire()
        assertEquals(listOf("perm-d"), harness.poster.posted.map { it.first })

        harness.poster.posted.clear()
        harness.coordinator.onEvent(chatEvent("agent.waiting", """{"reason":null}""", eventId = "wait-e"))
        harness.coordinator.onEvent(
            chatEvent("permission.resolved", """{"permissionId":"perm-1","decision":"rejected"}""", eventId = "res-e"),
        )
        harness.scheduler.tasks.last().fire()
        assertTrue(harness.poster.posted.isEmpty())

        harness.coordinator.onEvent(chatEvent("agent.waiting", """{"reason":null}""", eventId = "wait-f"))
        harness.coordinator.onConnectionState(RemoteConnectionState.Ready)
        assertEquals(false, harness.scheduler.tasks.last().cancelled)
        harness.coordinator.onConnectionState(RemoteConnectionState.Disconnected)
        assertTrue(harness.scheduler.tasks.last().cancelled)
        harness.scheduler.tasks.last().fire()
        assertTrue(harness.poster.posted.isEmpty())

        harness.coordinator.onEvent(chatEvent("agent.waiting", """{"reason":null}""", eventId = "wait-g"))
        harness.coordinator.onEvent(chatEvent("agent.completed", """{"reason":null}""", eventId = "done-a"))
        harness.scheduler.tasks.last().fire()
        assertTrue(harness.poster.posted.isEmpty())
    }

    @Test
    fun waitingNotCancelledByStreaming() {
        val harness = Harness()
        harness.coordinator.onEvent(chatEvent("agent.waiting", """{"reason":"hold"}""", eventId = "wait-1"))
        harness.coordinator.onEvent(chatEvent("user.message", """{"text":"hi"}""", eventId = "user-1"))
        harness.coordinator.onEvent(
            chatEvent("assistant.message", """{"text":"Hel","delta":true}""", eventId = "asst-1"),
        )
        harness.coordinator.onEvent(chatEvent("assistant.status", """{"status":"thinking"}""", eventId = "st-1"))
        harness.coordinator.onEvent(
            chatEvent("session.status_changed", """{"status":"waiting_user"}""", eventId = "sess-st"),
        )
        harness.scheduler.tasks.single().fire()
        assertEquals(
            listOf("wait-1" to NotificationContent("Cursor is waiting", "hold")),
            harness.poster.posted,
        )
    }

    @Test
    fun malformedAndUnknownEventsDoNotCrashOrNotify() {
        val harness = Harness()
        harness.coordinator.onEvent(
            RemoteEvent(
                eventId = "bad",
                sessionId = "sess-1",
                timestamp = "t",
                type = "agent.completed",
                payload = Json.parseToJsonElement("{}"),
            ),
        )
        harness.coordinator.onEvent(
            RemoteEvent(
                eventId = "bad-wait",
                sessionId = "sess-1",
                timestamp = "t",
                type = "agent.waiting",
                payload = Json.parseToJsonElement("{}"),
            ),
        )
        val workspaceJson =
            """{"workspaceId":"ws-1","name":"app","path":"/app","gitBranch":"main","modified":false,"activeSessionCount":1,"lastUsedAt":null}"""
        val unrelated =
            RemoteProtocol.parseIncomingFrame(
                """{"kind":"event","event":{"eventId":"ws-evt","sessionId":null,"timestamp":"t","type":"workspace.updated","payload":$workspaceJson}}""",
            ) as IncomingRemoteFrame.Event
        harness.coordinator.onEvent(unrelated.event)
        val unknown =
            RemoteProtocol.parseIncomingFrame(
                """{"kind":"event","event":{"eventId":"tool-evt","sessionId":"sess-1","timestamp":"t","type":"tool.started","payload":{}}}""",
            ) as IncomingRemoteFrame.Event
        harness.coordinator.onEvent(unknown.event)
        assertTrue(harness.poster.posted.isEmpty())
        assertTrue(harness.scheduler.tasks.isEmpty())
    }

    @Test
    fun notificationBodyUsesBoundedFirstLine() {
        val harness = Harness()
        val longReason = "x".repeat(300)
        harness.coordinator.onEvent(
            chatEvent(
                "permission.requested",
                """{"permissionId":"perm-1","kind":"execute","command":"  first \nsecond","risk":"high"}""",
                eventId = "evt-perm",
            ),
        )
        harness.coordinator.onEvent(
            chatEvent("agent.failed", """{"reason":"line1\r\nline2"}""", eventId = "evt-fail"),
        )
        harness.coordinator.onEvent(chatEvent("agent.waiting", """{"reason":"$longReason"}""", eventId = "evt-wait"))
        harness.scheduler.tasks.single().fire()
        harness.coordinator.onEvent(chatEvent("agent.failed", """{"reason":null}""", eventId = "evt-fail-null"))
        assertEquals("first", harness.poster.posted[0].second.body)
        assertEquals("line1", harness.poster.posted[1].second.body)
        assertEquals("x".repeat(240), harness.poster.posted[2].second.body)
        assertEquals("Cursor could not finish the task.", harness.poster.posted[3].second.body)
    }

    @Test
    fun connectionStatesOtherThanReadyCancelAllSessionTimers() {
        val harness = Harness()
        harness.coordinator.onEvent(
            chatEvent("agent.waiting", """{"reason":null}""", sessionId = "sess-1", eventId = "w1"),
        )
        harness.coordinator.onEvent(
            chatEvent("agent.waiting", """{"reason":null}""", sessionId = "sess-2", eventId = "w2"),
        )
        harness.coordinator.onConnectionState(RemoteConnectionState.Connecting)
        harness.scheduler.tasks.forEach { task ->
            assertTrue(task.cancelled)
            task.fire()
        }
        assertTrue(harness.poster.posted.isEmpty())
        harness.coordinator.onEvent(
            chatEvent("agent.waiting", """{"reason":null}""", sessionId = "sess-1", eventId = "w3"),
        )
        harness.coordinator.onConnectionState(RemoteConnectionState.Authenticating)
        harness.coordinator.onEvent(
            chatEvent("agent.waiting", """{"reason":null}""", sessionId = "sess-1", eventId = "w4"),
        )
        harness.coordinator.onConnectionState(RemoteConnectionState.Failed)
        harness.scheduler.tasks.filter { it.delayMs == PushNotificationCoordinator.LONG_WAITING_MS }.forEach { it.fire() }
        assertTrue(harness.poster.posted.isEmpty())
    }

    private class Harness {
        val poster = RecordingPoster()
        val scheduler = ManualScheduleAfter()
        val coordinator = PushNotificationCoordinator(poster, scheduler)
    }

    private class RecordingPoster : NotificationPoster {
        var enabled: Boolean = true
        val posted = mutableListOf<Pair<String, NotificationContent>>()

        override fun notificationsEnabled(): Boolean = enabled

        override fun post(eventId: String, content: NotificationContent) {
            posted += eventId to content
        }
    }

    private class ManualScheduleAfter : ScheduleAfter {
        val tasks = mutableListOf<Task>()

        override fun schedule(delayMs: Long, action: () -> Unit): ScheduledNotification {
            val task = Task(delayMs, action)
            tasks += task
            return task
        }

        class Task(
            val delayMs: Long,
            private val action: () -> Unit,
        ) : ScheduledNotification {
            var cancelled: Boolean = false
                private set
            private var executed: Boolean = false

            override fun cancel() {
                cancelled = true
            }

            fun fire() {
                if (cancelled || executed) {
                    return
                }
                executed = true
                action()
            }
        }
    }

    private fun chatEvent(
        type: String,
        payload: String,
        sessionId: String = "sess-1",
        eventId: String,
    ): RemoteEvent {
        val frame =
            RemoteProtocol.parseIncomingFrame(
                """{"kind":"event","event":{"eventId":"$eventId","sessionId":"$sessionId","timestamp":"t","type":"$type","payload":$payload}}""",
            ) as IncomingRemoteFrame.Event
        return frame.event
    }
}
