package dev.cursorremote.android.voice

enum class MicrophonePreference {
    BuiltIn,
    Auto,
    Bluetooth,
}

enum class AudioDeviceKind {
    BuiltInMic,
    Bluetooth,
    Wired,
    Other,
}

data class AudioDeviceSnapshot(
    val id: Int,
    val productName: String,
    val kind: AudioDeviceKind,
    val isSource: Boolean,
    val isSink: Boolean,
)

data class AudioRouteDecision(
    val accepted: Boolean,
    val preference: MicrophonePreference,
    val selectedSource: AudioDeviceSnapshot?,
    val reason: String,
    val communicationModeRequested: Boolean,
    val bluetoothScoRequested: Boolean,
)

object AudioRoutePolicy {
    const val NO_COMMUNICATION_OR_SCO =
        "Communication mode is not requested. Bluetooth SCO is not requested."

    val defaultPreference: MicrophonePreference = MicrophonePreference.BuiltIn

    fun decide(
        devices: List<AudioDeviceSnapshot>,
        preference: MicrophonePreference = defaultPreference,
    ): AudioRouteDecision {
        return when (preference) {
            MicrophonePreference.BuiltIn -> decideBuiltIn(devices)
            MicrophonePreference.Auto ->
                rejectUnsupported(MicrophonePreference.Auto, "Auto microphone preference is unsupported and pending.")
            MicrophonePreference.Bluetooth ->
                rejectUnsupported(
                    MicrophonePreference.Bluetooth,
                    "Bluetooth microphone preference is unsupported and pending.",
                )
        }
    }

    private fun decideBuiltIn(devices: List<AudioDeviceSnapshot>): AudioRouteDecision {
        val builtInSources =
            devices.filter { device ->
                device.kind == AudioDeviceKind.BuiltInMic && device.isSource
            }
        val selected = builtInSources.minByOrNull { it.id }
        if (selected == null) {
            return AudioRouteDecision(
                accepted = false,
                preference = MicrophonePreference.BuiltIn,
                selectedSource = null,
                reason = "Built-in microphone source is absent; fail closed without Bluetooth fallback. $NO_COMMUNICATION_OR_SCO",
                communicationModeRequested = false,
                bluetoothScoRequested = false,
            )
        }
        return AudioRouteDecision(
            accepted = true,
            preference = MicrophonePreference.BuiltIn,
            selectedSource = selected,
            reason = "Selected built-in microphone source id=${selected.id}. $NO_COMMUNICATION_OR_SCO",
            communicationModeRequested = false,
            bluetoothScoRequested = false,
        )
    }

    private fun rejectUnsupported(
        preference: MicrophonePreference,
        detail: String,
    ): AudioRouteDecision {
        return AudioRouteDecision(
            accepted = false,
            preference = preference,
            selectedSource = null,
            reason = "$detail $NO_COMMUNICATION_OR_SCO",
            communicationModeRequested = false,
            bluetoothScoRequested = false,
        )
    }
}
