package dev.cursorremote.android.di

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.room.Room
import dev.cursorremote.android.data.local.CursorRemoteDatabase
import dev.cursorremote.android.data.local.MIGRATION_1_2
import dev.cursorremote.android.data.remote.RemoteRepository
import dev.cursorremote.android.data.security.AndroidKeystoreDeviceCredentialStore
import dev.cursorremote.android.data.security.DeviceCredentialStore
import dev.cursorremote.android.data.transport.OkHttpWebSocketTransport
import dev.cursorremote.android.data.transport.WebSocketTransport
import dev.cursorremote.android.state.CursorRemoteViewModel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class AppContainer(context: Context) {
    private val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    val database: CursorRemoteDatabase =
        Room.databaseBuilder(
            context.applicationContext,
            CursorRemoteDatabase::class.java,
            DATABASE_NAME,
        ).addMigrations(MIGRATION_1_2).build()

    val credentialStore: DeviceCredentialStore = AndroidKeystoreDeviceCredentialStore()

    val transport: WebSocketTransport = OkHttpWebSocketTransport()

    val remoteRepository: RemoteRepository =
        RemoteRepository(
            transport = transport,
            credentialStore = credentialStore,
            scope = applicationScope,
        )

    val viewModelFactory: CursorRemoteViewModelFactory =
        CursorRemoteViewModelFactory(
            database = database,
            remoteRepository = remoteRepository,
        )

    private companion object {
        const val DATABASE_NAME = "cursor_remote.db"
    }
}

class CursorRemoteViewModelFactory(
    private val database: CursorRemoteDatabase,
    private val remoteRepository: RemoteRepository,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        if (!modelClass.isAssignableFrom(CursorRemoteViewModel::class.java)) {
            throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
        }
        return CursorRemoteViewModel(
            machineDao = database.machineDao(),
            remoteRepository = remoteRepository,
        ) as T
    }
}
