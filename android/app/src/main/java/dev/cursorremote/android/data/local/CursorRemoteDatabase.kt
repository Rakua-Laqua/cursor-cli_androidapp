package dev.cursorremote.android.data.local

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.Upsert
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "machines")
data class MachineEntity(
    @PrimaryKey val id: String,
    val displayName: String,
    val relayUrl: String,
    val deviceId: String?,
    val lastConnectedAt: Long?,
)

@Dao
interface MachineDao {
    @Query("SELECT * FROM machines ORDER BY displayName ASC")
    fun observeMachines(): Flow<List<MachineEntity>>

    @Query("SELECT * FROM machines WHERE id = :id LIMIT 1")
    suspend fun getMachine(id: String): MachineEntity?

    @Upsert
    suspend fun upsert(machine: MachineEntity)

    @Query(
        "UPDATE machines SET relayUrl = :relayUrl, deviceId = :deviceId, lastConnectedAt = :lastConnectedAt WHERE id = :id",
    )
    suspend fun updateConnectionInfo(
        id: String,
        relayUrl: String,
        deviceId: String,
        lastConnectedAt: Long,
    )
}

@Entity(tableName = "hidden_models")
data class HiddenModelEntity(
    @PrimaryKey val modelId: String,
)

@Dao
interface HiddenModelDao {
    @Query("SELECT modelId FROM hidden_models")
    fun observeHiddenModelIds(): Flow<List<String>>

    @Upsert
    suspend fun hide(entity: HiddenModelEntity)

    @Query("DELETE FROM hidden_models WHERE modelId = :modelId")
    suspend fun show(modelId: String)
}

val MIGRATION_1_2 =
    object : Migration(1, 2) {
        override fun migrate(database: SupportSQLiteDatabase) {
            database.execSQL("ALTER TABLE machines ADD COLUMN relayUrl TEXT NOT NULL DEFAULT ''")
            database.execSQL("ALTER TABLE machines ADD COLUMN deviceId TEXT")
            database.execSQL("ALTER TABLE machines ADD COLUMN lastConnectedAt INTEGER")
        }
    }

val MIGRATION_2_3 =
    object : Migration(2, 3) {
        override fun migrate(database: SupportSQLiteDatabase) {
            database.execSQL("CREATE TABLE IF NOT EXISTS hidden_models (modelId TEXT NOT NULL PRIMARY KEY)")
        }
    }

@Entity(tableName = "reliability_state")
data class ReliabilityStateEntity(
    @PrimaryKey val id: Int,
    val machineId: String?,
    val workspaceId: String?,
    val sessionId: String?,
    val needsCatchUp: Boolean,
)

@Entity(tableName = "sync_cursors")
data class SyncCursorEntity(
    @PrimaryKey val machineId: String,
    val lastEventId: String,
)

@Entity(tableName = "notification_events")
data class NotificationEventEntity(
    @PrimaryKey val eventId: String,
    val seenAt: Long,
)

@Dao
interface ReliabilityDao {
    @Query("SELECT * FROM reliability_state WHERE id = 1 LIMIT 1")
    suspend fun getState(): ReliabilityStateEntity?

    @Upsert
    suspend fun upsertState(entity: ReliabilityStateEntity)

    @Query("SELECT lastEventId FROM sync_cursors WHERE machineId = :machineId LIMIT 1")
    suspend fun getCursor(machineId: String): String?

    @Upsert
    suspend fun upsertCursor(entity: SyncCursorEntity)

    @Query("DELETE FROM sync_cursors WHERE machineId = :machineId")
    suspend fun deleteCursor(machineId: String)

    @Query("SELECT seenAt FROM notification_events WHERE eventId = :eventId LIMIT 1")
    suspend fun notificationSeenAt(eventId: String): Long?

    @Upsert
    suspend fun upsertNotification(entity: NotificationEventEntity)

    @Query("SELECT COUNT(*) FROM notification_events")
    suspend fun notificationCount(): Int

    @Query(
        "DELETE FROM notification_events WHERE eventId IN (SELECT eventId FROM notification_events ORDER BY seenAt ASC, eventId ASC LIMIT :limit)",
    )
    suspend fun deleteOldestNotifications(limit: Int)
}

val MIGRATION_3_4 =
    object : Migration(3, 4) {
        override fun migrate(database: SupportSQLiteDatabase) {
            database.execSQL(
                "CREATE TABLE IF NOT EXISTS reliability_state (id INTEGER NOT NULL PRIMARY KEY, machineId TEXT, workspaceId TEXT, sessionId TEXT, needsCatchUp INTEGER NOT NULL)",
            )
            database.execSQL(
                "CREATE TABLE IF NOT EXISTS sync_cursors (machineId TEXT NOT NULL PRIMARY KEY, lastEventId TEXT NOT NULL)",
            )
            database.execSQL(
                "CREATE TABLE IF NOT EXISTS notification_events (eventId TEXT NOT NULL PRIMARY KEY, seenAt INTEGER NOT NULL)",
            )
        }
    }

@Database(
    entities = [
        MachineEntity::class,
        HiddenModelEntity::class,
        ReliabilityStateEntity::class,
        SyncCursorEntity::class,
        NotificationEventEntity::class,
    ],
    version = 4,
    exportSchema = false,
)
abstract class CursorRemoteDatabase : RoomDatabase() {
    abstract fun machineDao(): MachineDao

    abstract fun hiddenModelDao(): HiddenModelDao

    abstract fun reliabilityDao(): ReliabilityDao
}
