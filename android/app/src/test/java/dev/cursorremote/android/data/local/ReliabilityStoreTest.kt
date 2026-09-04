package dev.cursorremote.android.data.local

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReliabilityStoreTest {
    @Test
    fun selectionDoesNotClobberCatchUpCursorSaveDeleteAndNotificationClaimIsOnceOnlyBounded() =
        runBlocking {
            val store = VolatileReliabilityStore()
            store.setNeedsCatchUp(true)
            store.saveSelection(NavigationSelection("pc-1", "ws-1", "sess-1"))
            assertTrue(store.needsCatchUp())
            assertEquals(NavigationSelection("pc-1", "ws-1", "sess-1"), store.loadSelection())
            store.setNeedsCatchUp(false)
            assertEquals("pc-1", store.loadSelection().machineId)
            assertFalse(store.needsCatchUp())
            assertNull(store.loadCursor("pc-1"))
            store.saveCursor("pc-1", "evt-1")
            assertEquals("evt-1", store.loadCursor("pc-1"))
            store.saveCursor("pc-2", "evt-other")
            store.saveCursor("pc-1", null)
            assertNull(store.loadCursor("pc-1"))
            assertEquals("evt-other", store.loadCursor("pc-2"))
            assertTrue(store.claimNotificationEventId("a"))
            assertFalse(store.claimNotificationEventId("a"))
            repeat(NOTIFICATION_EVENT_LIMIT - 1) { index ->
                assertTrue(store.claimNotificationEventId("n-$index"))
            }
            assertFalse(store.claimNotificationEventId("a"))
            assertTrue(store.claimNotificationEventId("overflow"))
            assertTrue(store.claimNotificationEventId("a"))
            assertFalse(store.claimNotificationEventId("overflow"))
        }
}
