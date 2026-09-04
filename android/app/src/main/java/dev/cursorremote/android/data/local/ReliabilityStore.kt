package dev.cursorremote.android.data.local

import androidx.room.withTransaction
import java.util.LinkedHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class NavigationSelection(
    val machineId: String?,
    val workspaceId: String?,
    val sessionId: String?,
)

interface ReliabilityStore {
    suspend fun loadSelection(): NavigationSelection

    suspend fun saveSelection(selection: NavigationSelection)

    suspend fun loadCursor(machineId: String): String?

    suspend fun saveCursor(machineId: String, lastEventId: String?)

    suspend fun needsCatchUp(): Boolean

    suspend fun setNeedsCatchUp(value: Boolean)

    suspend fun claimNotificationEventId(eventId: String): Boolean
}

class VolatileReliabilityStore : ReliabilityStore {
    private val mutex = Mutex()
    private var selection = NavigationSelection(null, null, null)
    private var catchUpNeeded = false
    private val cursors = HashMap<String, String>()
    private val notificationIds = LinkedHashMap<String, Long>()
    private val seenAtSeq = AtomicLong(0L)

    override suspend fun loadSelection(): NavigationSelection = mutex.withLock { selection }

    override suspend fun saveSelection(selection: NavigationSelection) {
        mutex.withLock { this.selection = selection }
    }

    override suspend fun loadCursor(machineId: String): String? = mutex.withLock { cursors[machineId] }

    override suspend fun saveCursor(machineId: String, lastEventId: String?) {
        mutex.withLock {
            if (lastEventId == null) {
                cursors.remove(machineId)
            } else {
                cursors[machineId] = lastEventId
            }
        }
    }

    override suspend fun needsCatchUp(): Boolean = mutex.withLock { catchUpNeeded }

    override suspend fun setNeedsCatchUp(value: Boolean) {
        mutex.withLock { catchUpNeeded = value }
    }

    override suspend fun claimNotificationEventId(eventId: String): Boolean =
        mutex.withLock {
            if (notificationIds.containsKey(eventId)) {
                return@withLock false
            }
            if (notificationIds.size >= NOTIFICATION_EVENT_LIMIT) {
                val oldest = notificationIds.entries.iterator()
                oldest.next()
                oldest.remove()
            }
            notificationIds[eventId] = seenAtSeq.incrementAndGet()
            true
        }
}

class RoomReliabilityStore(
    private val database: CursorRemoteDatabase,
    private val nowMillis: () -> Long = { System.currentTimeMillis() },
) : ReliabilityStore {
    private val mutex = Mutex()
    private val dao = database.reliabilityDao()

    override suspend fun loadSelection(): NavigationSelection =
        mutex.withLock {
            val state = dao.getState()
            NavigationSelection(state?.machineId, state?.workspaceId, state?.sessionId)
        }

    override suspend fun saveSelection(selection: NavigationSelection) {
        mutex.withLock {
            database.withTransaction {
                val current = dao.getState() ?: EMPTY_STATE
                dao.upsertState(
                    current.copy(
                        machineId = selection.machineId,
                        workspaceId = selection.workspaceId,
                        sessionId = selection.sessionId,
                    ),
                )
            }
        }
    }

    override suspend fun loadCursor(machineId: String): String? = mutex.withLock { dao.getCursor(machineId) }

    override suspend fun saveCursor(machineId: String, lastEventId: String?) {
        mutex.withLock {
            database.withTransaction {
                if (lastEventId == null) {
                    dao.deleteCursor(machineId)
                } else {
                    dao.upsertCursor(SyncCursorEntity(machineId, lastEventId))
                }
            }
        }
    }

    override suspend fun needsCatchUp(): Boolean = mutex.withLock { dao.getState()?.needsCatchUp == true }

    override suspend fun setNeedsCatchUp(value: Boolean) {
        mutex.withLock {
            database.withTransaction {
                val current = dao.getState() ?: EMPTY_STATE
                dao.upsertState(current.copy(needsCatchUp = value))
            }
        }
    }

    override suspend fun claimNotificationEventId(eventId: String): Boolean =
        mutex.withLock {
            database.withTransaction {
                if (dao.notificationSeenAt(eventId) != null) {
                    false
                } else {
                    dao.upsertNotification(NotificationEventEntity(eventId, nowMillis()))
                    val overflow = dao.notificationCount() - NOTIFICATION_EVENT_LIMIT
                    if (overflow > 0) {
                        dao.deleteOldestNotifications(overflow)
                    }
                    true
                }
            }
        }

    private companion object {
        val EMPTY_STATE = ReliabilityStateEntity(1, null, null, null, false)
    }
}

internal const val NOTIFICATION_EVENT_LIMIT = 4096
