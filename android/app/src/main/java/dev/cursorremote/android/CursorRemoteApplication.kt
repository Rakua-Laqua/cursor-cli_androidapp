package dev.cursorremote.android

import android.app.Application
import dev.cursorremote.android.di.AppContainer
import dev.cursorremote.android.notify.AppForegroundTracker

class CursorRemoteApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        registerActivityLifecycleCallbacks(
            AppForegroundTracker { isForeground ->
                container.pushNotificationCoordinator.setForeground(isForeground)
            },
        )
    }
}
