package dev.cursorremote.android.data.local

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "machines")
data class MachineEntity(
    @PrimaryKey val id: String,
    val displayName: String,
)

@Dao
interface MachineDao {
    @Query("SELECT * FROM machines ORDER BY displayName ASC")
    fun observeMachines(): Flow<List<MachineEntity>>
}

@Database(
    entities = [MachineEntity::class],
    version = 1,
    exportSchema = false,
)
abstract class CursorRemoteDatabase : RoomDatabase() {
    abstract fun machineDao(): MachineDao
}
