package dev.cursorremote.android.notify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NotificationDeepLinkTest {
    @Test
    fun parserAcceptsExactActionAndVerifiedIds() {
        val eventId = "evt-1"
        val accepted =
            notificationTargetFromIntentValues(
                notificationPendingIntentAction(eventId),
                "pc-1",
                "sess-1",
                eventId,
            )
        assertEquals(NotificationTarget("pc-1", "sess-1", eventId), accepted)
        val emptySession =
            notificationTargetFromIntentValues(
                notificationPendingIntentAction(eventId),
                "pc-1",
                "",
                eventId,
            )
        assertEquals(NotificationTarget("pc-1", "", eventId), emptySession)
        val maxIds = "x".repeat(NotificationTarget.MAX_ID_CODE_UNITS)
        assertEquals(
            NotificationTarget(maxIds, maxIds, maxIds),
            notificationTargetFromIntentValues(
                notificationPendingIntentAction(maxIds),
                maxIds,
                maxIds,
                maxIds,
            ),
        )
    }

    @Test
    fun parserIgnoresMissingInconsistentEmptyAndOversize() {
        val eventId = "evt-1"
        val action = notificationPendingIntentAction(eventId)
        assertNull(notificationTargetFromIntentValues(action, "pc-1", "sess-1", null))
        assertNull(notificationTargetFromIntentValues(action, "pc-1", null, eventId))
        assertNull(notificationTargetFromIntentValues(null, "pc-1", "sess-1", eventId))
        assertNull(notificationTargetFromIntentValues("android.intent.action.MAIN", "pc-1", "sess-1", eventId))
        assertNull(
            notificationTargetFromIntentValues(
                notificationPendingIntentAction("other"),
                "pc-1",
                "sess-1",
                eventId,
            ),
        )
        assertNull(notificationTargetFromIntentValues(action, null, "sess-1", eventId))
        assertNull(notificationTargetFromIntentValues(action, "", "sess-1", eventId))
        assertNull(notificationTargetFromIntentValues(action, "pc-1", "sess-1", ""))
        val oversize = "x".repeat(NotificationTarget.MAX_ID_CODE_UNITS + 1)
        assertNull(
            notificationTargetFromIntentValues(
                notificationPendingIntentAction(oversize),
                "pc-1",
                "sess-1",
                oversize,
            ),
        )
        assertNull(notificationTargetFromIntentValues(action, oversize, "sess-1", eventId))
        assertNull(notificationTargetFromIntentValues(action, "pc-1", oversize, eventId))
    }
}
