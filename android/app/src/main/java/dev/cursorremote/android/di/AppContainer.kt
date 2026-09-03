package dev.cursorremote.android.di

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.room.Room
import dev.cursorremote.android.data.local.CursorRemoteDatabase
import dev.cursorremote.android.data.local.MIGRATION_1_2
import dev.cursorremote.android.data.local.MIGRATION_2_3
import dev.cursorremote.android.data.remote.RemoteRepository
import dev.cursorremote.android.data.security.AndroidKeystoreDeviceCredentialStore
import dev.cursorremote.android.data.security.DeviceCredentialStore
import dev.cursorremote.android.data.transport.OkHttpWebSocketTransport
import dev.cursorremote.android.data.transport.WebSocketTransport
import dev.cursorremote.android.notify.PushNotificationCoordinator
import dev.cursorremote.android.notify.ScheduleAfter
import dev.cursorremote.android.notify.ScheduledNotification
import dev.cursorremote.android.notify.SystemNotificationPoster
import dev.cursorremote.android.state.CursorRemoteViewModel
import dev.cursorremote.android.voice.AndroidPushToTalkRecorder
import dev.cursorremote.android.voice.AndroidSpeechToTextEngine
import dev.cursorremote.android.voice.VoicePromptController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class AppContainer(context: Context) {
    private val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    val database: CursorRemoteDatabase =
        Room.databaseBuilder(
            context.applicationContext,
            CursorRemoteDatabase::class.java,
            DATABASE_NAME,
        ).addMigrations(MIGRATION_1_2, MIGRATION_2_3).build()

    val credentialStore: DeviceCredentialStore = AndroidKeystoreDeviceCredentialStore()

    val transport: WebSocketTransport = OkHttpWebSocketTransport()

    val remoteRepository: RemoteRepository =
        RemoteRepository(
            transport = transport,
            credentialStore = credentialStore,
            scope = applicationScope,
        )

    val pushNotificationCoordinator: PushNotificationCoordinator =
        PushNotificationCoordinator(
            poster = SystemNotificationPoster(context.applicationContext),
            scheduleAfter =
                ScheduleAfter { delayMs, action ->
                    val job =
                        applicationScope.launch {
                            delay(delayMs)
                            action()
                        }
                    ScheduledNotification { job.cancel() }
                },
        )

    private val appContext = context.applicationContext

    val viewModelFactory: CursorRemoteViewModelFactory =
        CursorRemoteViewModelFactory(
            database = database,
            remoteRepository = remoteRepository,
            voicePromptControllerFactory = {
                VoicePromptController(
                    recorder = AndroidPushToTalkRecorder(appContext),
                    engine = AndroidSpeechToTextEngine(appContext),
                )
            },
        )

    init {
        applicationScope.launch {
            remoteRepository.events.collect { event ->
                pushNotificationCoordinator.onEvent(event)
            }
        }
        applicationScope.launch {
            remoteRepository.connectionState.collect { state ->
                pushNotificationCoordinator.onConnectionState(state)
            }
        }
    }

    private companion object {
        const val DATABASE_NAME = "cursor_remote.db"
    }
}

class CursorRemoteViewModelFactory(
    private val database: CursorRemoteDatabase,
    private val remoteRepository: RemoteRepository,
    private val voicePromptControllerFactory: () -> VoicePromptController,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        if (!modelClass.isAssignableFrom(CursorRemoteViewModel::class.java)) {
            throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
        }
        return CursorRemoteViewModel(
            machineDao = database.machineDao(),
            hiddenModelDao = database.hiddenModelDao(),
            remoteRepository = remoteRepository,
            voicePromptController = voicePromptControllerFactory(),
        ) as T
    }
}
