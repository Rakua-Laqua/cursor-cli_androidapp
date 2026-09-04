package dev.cursorremote.android.notify

import dev.cursorremote.android.data.local.VolatileReliabilityStore
import dev.cursorremote.android.data.protocol.ProtocolParseError
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class FcmPushTest {
    @Test
    fun parseAcceptsFourTypesEmptySessionAndMaxIds() {
        for (type in PUSH_EVENT_TYPES) {
            val parsed =
                parseFcmDataPayload(
                    mapOf(
                        "eventId" to "e".repeat(512),
                        "type" to type,
                        "machineId" to "m".repeat(512),
                        "sessionId" to "",
                    ),
                )
            assertEquals(type, parsed.type)
            assertEquals("", parsed.sessionId)
            assertEquals(512, parsed.eventId.length)
            assertEquals(512, parsed.machineId.length)
        }
        val withSession =
            parseFcmDataPayload(
                mapOf(
                    "eventId" to "evt-1",
                    "type" to PUSH_TYPE_AGENT_WAITING,
                    "machineId" to "pc-1",
                    "sessionId" to "s".repeat(512),
                ),
            )
        assertEquals(512, withSession.sessionId.length)
    }

    @Test
    fun parseRejectsUnknownExtraMissingEmptyAndOversize() {
        val valid =
            mapOf(
                "eventId" to "evt-1",
                "type" to PUSH_TYPE_PERMISSION_REQUESTED,
                "machineId" to "pc-1",
                "sessionId" to "sess-1",
            )
        assertRejects(valid + ("command" to "ls"))
        assertRejects(valid - "type")
        assertRejects(valid - "sessionId")
        assertRejects(emptyMap())
        assertRejects(valid + ("eventId" to ""))
        assertRejects(valid + ("machineId" to ""))
        assertRejects(valid + ("type" to "assistant.message"))
        assertRejects(valid + ("type" to "agent.interrupted"))
        assertRejects(valid + ("eventId" to "x".repeat(513)))
        assertRejects(valid + ("machineId" to "x".repeat(513)))
        assertRejects(valid + ("sessionId" to "x".repeat(513)))
        assertRejects(
            mapOf(
                "eventId" to "evt-1",
                "type" to PUSH_TYPE_AGENT_COMPLETED,
                "machineId" to "pc-1",
                "unknown" to "1",
            ),
        )
    }

    @Test
    fun handlerIgnoresInvalidPayloadAndIsolatesPosterFailure() {
        val store = VolatileReliabilityStore()
        val throwing = ThrowingPoster()
        val coordinator =
            PushNotificationCoordinator(
                throwing,
                ScheduleAfter { _, _ -> ScheduledNotification {} },
                store,
                { "pc-1" },
            )
        val handler = FcmMessageHandler(coordinator, store)
        handler.onDataMessage(mapOf("eventId" to "evt-1", "type" to PUSH_TYPE_AGENT_COMPLETED), false)
        handler.onDataMessage(
            mapOf(
                "eventId" to "evt-1",
                "type" to PUSH_TYPE_AGENT_COMPLETED,
                "machineId" to "pc-1",
                "sessionId" to "sess-1",
                "token" to "x",
            ),
            false,
        )
        handler.onDataMessage(
            mapOf(
                "eventId" to "evt-boom",
                "type" to PUSH_TYPE_AGENT_COMPLETED,
                "machineId" to "pc-1",
                "sessionId" to "sess-1",
            ),
            false,
        )
        assertTrue(throwing.posted.get())
    }

    @Test
    fun handlerPostsGenericOnlyAndDeletedMessagesSetCatchUp() =
        runBlocking {
            val store = VolatileReliabilityStore()
            val poster = RecordingPoster()
            val coordinator =
                PushNotificationCoordinator(
                    poster,
                    ScheduleAfter { _, _ -> ScheduledNotification {} },
                    store,
                    { "pc-1" },
                )
            val handler = FcmMessageHandler(coordinator, store)
            handler.onDataMessage(
                mapOf(
                    "eventId" to "evt-perm",
                    "type" to PUSH_TYPE_PERMISSION_REQUESTED,
                    "machineId" to "pc-1",
                    "sessionId" to "sess-1",
                ),
                false,
            )
            assertEquals("Open the app to continue.", poster.posted.single().second.body)
            assertEquals(
                NotificationTarget("pc-1", "sess-1", "evt-perm"),
                poster.targets.single(),
            )
            assertFalse(store.needsCatchUp())
            handler.onDeletedMessages()
            assertTrue(store.needsCatchUp())
        }

    @Test
    fun handlerDedupsRepeatedDataMessage() {
        val store = VolatileReliabilityStore()
        val poster = RecordingPoster()
        val coordinator =
            PushNotificationCoordinator(
                poster,
                ScheduleAfter { _, _ -> ScheduledNotification {} },
                store,
                { "pc-1" },
            )
        val handler = FcmMessageHandler(coordinator, store)
        val data =
            mapOf(
                "eventId" to "evt-1",
                "type" to PUSH_TYPE_AGENT_FAILED,
                "machineId" to "pc-1",
                "sessionId" to "",
            )
        handler.onDataMessage(data, false)
        handler.onDataMessage(data, false)
        assertEquals(1, poster.posted.size)
        assertEquals("Cursor could not finish the task.", poster.posted.single().second.body)
    }

    @Test
    fun handlerIgnoresNotificationPayloadEvenWhenDataMapIsValid() =
        runBlocking {
            val store = VolatileReliabilityStore()
            val poster = RecordingPoster()
            val coordinator =
                PushNotificationCoordinator(
                    poster,
                    ScheduleAfter { _, _ -> ScheduledNotification {} },
                    store,
                    { "pc-1" },
                )
            val handler = FcmMessageHandler(coordinator, store)
            val data =
                mapOf(
                    "eventId" to "evt-1",
                    "type" to PUSH_TYPE_AGENT_COMPLETED,
                    "machineId" to "pc-1",
                    "sessionId" to "sess-1",
                )
            handler.onDataMessage(data, true)
            assertTrue(poster.posted.isEmpty())
            assertTrue(store.claimNotificationEventId("evt-1"))
        }

    @Test
    fun collidingEventIdsProduceDistinctNotificationIdentities() {
        assertEquals("Aa".hashCode(), "BB".hashCode())
        val first = notificationPendingIntentAction("Aa")
        val second = notificationPendingIntentAction("BB")
        assertTrue(first != second)
        assertTrue(first.endsWith("Aa"))
        assertTrue(second.endsWith("BB"))
    }

    @Test
    fun acceptedFcmTokenEnforcesBoundsAndCharset() {
        assertEquals(null, acceptedFcmToken(null))
        assertEquals(null, acceptedFcmToken(""))
        val valid = "Az09_.:-"
        assertTrue(acceptedFcmToken(valid) != null)
        assertEquals(valid.length, acceptedFcmToken(valid)?.length)
        assertTrue(acceptedFcmToken("A".repeat(FCM_TOKEN_MAX_CODE_UNITS)) != null)
        assertEquals(null, acceptedFcmToken("A".repeat(FCM_TOKEN_MAX_CODE_UNITS + 1)))
        assertEquals(null, acceptedFcmToken(" "))
        assertEquals(null, acceptedFcmToken("tok/1"))
        assertEquals(null, acceptedFcmToken("tok+1"))
        assertEquals(null, acceptedFcmToken("tok@1"))
        assertEquals(null, acceptedFcmToken("tok 1"))
        assertEquals(null, acceptedFcmToken("tok\n1"))
    }

    @Test
    fun onNewTokenIgnoresInvalidWithoutClearingExisting() {
        val store = VolatileReliabilityStore()
        val coordinator =
            PushNotificationCoordinator(
                RecordingPoster(),
                ScheduleAfter { _, _ -> ScheduledNotification {} },
                store,
                { "pc-1" },
            )
        val held = MutableStateFlow<String?>(null)
        val handler = FcmMessageHandler(coordinator, store, { token -> held.value = token })
        handler.onNewToken("tok.1")
        val first = held.value
        assertTrue(first != null)
        handler.onNewToken("")
        handler.onNewToken("bad token")
        handler.onNewToken("tok/slash")
        handler.onNewToken("A".repeat(FCM_TOKEN_MAX_CODE_UNITS + 1))
        assertTrue(held.value == first)
        handler.onNewToken("tok.2")
        assertTrue(held.value != null && held.value != first)
    }

    private fun assertRejects(data: Map<String, String>) {
        try {
            parseFcmDataPayload(data)
            fail("expected ProtocolParseError")
        } catch (_: ProtocolParseError) {
        }
    }

    private class RecordingPoster : NotificationPoster {
        val posted = mutableListOf<Pair<String, NotificationContent>>()
        val targets = mutableListOf<NotificationTarget?>()

        override fun notificationsEnabled(): Boolean = true

        override fun post(eventId: String, content: NotificationContent, target: NotificationTarget?) {
            posted += eventId to content
            targets += target
        }
    }

    private class ThrowingPoster : NotificationPoster {
        val posted = AtomicBoolean(false)

        override fun notificationsEnabled(): Boolean = true

        override fun post(eventId: String, content: NotificationContent, target: NotificationTarget?) {
            posted.set(true)
            error("isolated")
        }
    }
}
