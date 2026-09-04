package dev.cursorremote.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.cursorremote.android.notify.NotificationTarget
import dev.cursorremote.android.notify.notificationTargetFromIntentValues
import dev.cursorremote.android.ui.CursorRemoteApp

class MainActivity : ComponentActivity() {
    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ -> }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handoffNotificationIntent(intent)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        val factory = (application as CursorRemoteApplication).container.viewModelFactory
        setContent {
            CursorRemoteApp(viewModel = viewModel(factory = factory))
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handoffNotificationIntent(intent)
    }

    private fun handoffNotificationIntent(intent: Intent?) {
        if (intent == null || intent.action == Intent.ACTION_MAIN) {
            return
        }
        val target =
            notificationTargetFromIntentValues(
                intent.action,
                intent.getStringExtra(NotificationTarget.EXTRA_MACHINE_ID),
                intent.getStringExtra(NotificationTarget.EXTRA_SESSION_ID),
                intent.getStringExtra(NotificationTarget.EXTRA_EVENT_ID),
            ) ?: return
        (application as CursorRemoteApplication).container.publishNotificationTarget(target)
    }
}
