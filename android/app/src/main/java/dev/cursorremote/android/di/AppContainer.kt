package dev.cursorremote.android.di

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.room.Room
import dev.cursorremote.android.data.local.CursorRemoteDatabase
import dev.cursorremote.android.data.security.AndroidKeystoreDeviceCredentialStore
import dev.cursorremote.android.data.security.DeviceCredentialStore
import dev.cursorremote.android.data.transport.OkHttpWebSocketTransport
import dev.cursorremote.android.data.transport.WebSocketTransport
import dev.cursorremote.android.state.CursorRemoteViewModel

class AppContainer(context: Context) {
    val database: CursorRemoteDatabase =
        Room.databaseBuilder(
            context.applicationContext,
            CursorRemoteDatabase::class.java,
            DATABASE_NAME,
        ).build()

    val credentialStore: DeviceCredentialStore = AndroidKeystoreDeviceCredentialStore()

    val transport: WebSocketTransport = OkHttpWebSocketTransport()

    val viewModelFactory: CursorRemoteViewModelFactory =
        CursorRemoteViewModelFactory(
            database = database,
            credentialStore = credentialStore,
            transport = transport,
        )

    private companion object {
        const val DATABASE_NAME = "cursor_remote.db"
    }
}

class CursorRemoteViewModelFactory(
    private val database: CursorRemoteDatabase,
    private val credentialStore: DeviceCredentialStore,
    private val transport: WebSocketTransport,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        if (!modelClass.isAssignableFrom(CursorRemoteViewModel::class.java)) {
            throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
        }
        return CursorRemoteViewModel(
            machineDao = database.machineDao(),
            credentialStore = credentialStore,
            transport = transport,
        ) as T
    }
}
