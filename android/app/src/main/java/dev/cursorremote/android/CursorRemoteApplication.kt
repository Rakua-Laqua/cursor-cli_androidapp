package dev.cursorremote.android

import android.app.Application
import dev.cursorremote.android.di.AppContainer

class CursorRemoteApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
