package dev.cursorremote.android.notify

import android.app.Activity
import android.app.Application
import android.os.Bundle

class AppForegroundTracker(
    private val onForegroundChanged: (Boolean) -> Unit,
) : Application.ActivityLifecycleCallbacks {
    private var startedCount = 0

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

    override fun onActivityStarted(activity: Activity) {
        startedCount += 1
        if (startedCount == 1) {
            onForegroundChanged(true)
        }
    }

    override fun onActivityResumed(activity: Activity) = Unit

    override fun onActivityPaused(activity: Activity) = Unit

    override fun onActivityStopped(activity: Activity) {
        startedCount -= 1
        if (startedCount == 0) {
            onForegroundChanged(false)
        }
    }

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    override fun onActivityDestroyed(activity: Activity) = Unit
}
