package dev.cursorremote.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.cursorremote.android.ui.CursorRemoteApp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val factory = (application as CursorRemoteApplication).container.viewModelFactory
        setContent {
            CursorRemoteApp(viewModel = viewModel(factory = factory))
        }
    }
}
