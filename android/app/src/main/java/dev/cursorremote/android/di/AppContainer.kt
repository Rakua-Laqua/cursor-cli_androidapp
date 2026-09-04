package dev.cursorremote.android.di

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.room.Room
import dev.cursorremote.android.data.local.CursorRemoteDatabase
import dev.cursorremote.android.data.local.MIGRATION_1_2
import dev.cursorremote.android.data.local.MIGRATION_2_3
import dev.cursorremote.android.data.local.MIGRATION_3_4
import dev.cursorremote.android.data.local.ReliabilityStore
import dev.cursorremote.android.data.local.RoomReliabilityStore
import dev.cursorremote.android.data.remote.PushRegistrationController
import dev.cursorremote.android.data.remote.RemoteRepository
import dev.cursorremote.android.data.security.AndroidKeystoreDeviceCredentialStore
import dev.cursorremote.android.data.security.DeviceCredentialStore
import dev.cursorremote.android.data.transport.OkHttpWebSocketTransport
import dev.cursorremote.android.data.transport.WebSocketTransport
import dev.cursorremote.android.notify.FcmMessageHandler
import dev.cursorremote.android.notify.NotificationTarget
import dev.cursorremote.android.notify.PushNotificationCoordinator
import dev.cursorremote.android.notify.bootstrapFcmToken
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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class AppContainer(context: Context) {
    private val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    val database: CursorRemoteDatabase =
        Room.databaseBuilder(
            context.applicationContext,
            CursorRemoteDatabase::class.java,
            DATABASE_NAME,
        ).addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4).build()

    val credentialStore: DeviceCredentialStore = AndroidKeystoreDeviceCredentialStore()

    val transport: WebSocketTransport = OkHttpWebSocketTransport()

    val reliabilityStore: ReliabilityStore = RoomReliabilityStore(database)

    val remoteRepository: RemoteRepository =
        RemoteRepository(
            transport = transport,
            credentialStore = credentialStore,
            scope = applicationScope,
            reliabilityStore = reliabilityStore,
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
            reliabilityStore = reliabilityStore,
            currentMachineId = { remoteRepository.currentMachineId() },
        )

    private val fcmToken = MutableStateFlow<String?>(null)

    val fcmMessageHandler: FcmMessageHandler =
        FcmMessageHandler(
            coordinator = pushNotificationCoordinator,
            reliabilityStore = reliabilityStore,
            tokenSink = { token -> fcmToken.value = token },
        )

    val appForeground = MutableStateFlow(false)

    private val notificationMailbox = NotificationTargetMailbox()

    private val pushRegistrationController =
        PushRegistrationController(
            scope = applicationScope,
            connectionState = remoteRepository.connectionState,
            fcmToken = fcmToken,
            appForeground = appForeground,
            register = { token, foreground ->
                remoteRepository.updateTransportRegistration(token, foreground)
            },
        )

    fun setForeground(isForeground: Boolean) {
        appForeground.value = isForeground
        pushNotificationCoordinator.setForeground(isForeground)
    }

    fun publishNotificationTarget(target: NotificationTarget) {
        notificationMailbox.publish(target)
    }

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
            reliabilityStore = reliabilityStore,
            appForeground = appForeground,
            notificationTargets = notificationMailbox.target,
            consumeNotificationTarget = notificationMailbox::consume,
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
        try {
            bootstrapFcmToken(appContext) { token ->
                fcmToken.value = token
            }
        } catch (_: Exception) {
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
    private val reliabilityStore: ReliabilityStore,
    private val appForeground: StateFlow<Boolean>,
    private val notificationTargets: StateFlow<NotificationTarget?>,
    private val consumeNotificationTarget: (String) -> Unit,
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
            reliabilityStore = reliabilityStore,
            appForeground = appForeground,
            notificationTargets = notificationTargets,
            consumeNotificationTarget = consumeNotificationTarget,
        ) as T
    }
}

internal const val NOTIFICATION_TARGET_EVENT_ID_LIMIT = 4096

internal class NotificationTargetMailbox(
    private val maxDispatchedEventIds: Int = NOTIFICATION_TARGET_EVENT_ID_LIMIT,
) {
    private val lock = Any()
    private val dispatchedEventIds = LinkedHashSet<String>()
    private val _target = MutableStateFlow<NotificationTarget?>(null)
    val target: StateFlow<NotificationTarget?> = _target.asStateFlow()

    fun publish(candidate: NotificationTarget) {
        synchronized(lock) {
            if (candidate.eventId in dispatchedEventIds) {
                return
            }
            if (dispatchedEventIds.size >= maxDispatchedEventIds) {
                val oldest = dispatchedEventIds.iterator()
                if (oldest.hasNext()) {
                    oldest.next()
                    oldest.remove()
                }
            }
            dispatchedEventIds.add(candidate.eventId)
            _target.value = candidate
        }
    }

    fun consume(eventId: String) {
        synchronized(lock) {
            if (_target.value?.eventId == eventId) {
                _target.value = null
            }
        }
    }
}
