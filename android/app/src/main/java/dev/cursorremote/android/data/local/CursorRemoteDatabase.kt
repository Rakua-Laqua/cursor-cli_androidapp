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

@Database(
    entities = [MachineEntity::class, HiddenModelEntity::class],
    version = 3,
    exportSchema = false,
)
abstract class CursorRemoteDatabase : RoomDatabase() {
    abstract fun machineDao(): MachineDao

    abstract fun hiddenModelDao(): HiddenModelDao
}
