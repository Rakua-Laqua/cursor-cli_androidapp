package dev.cursorremote.android.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioRoutePolicyTest {
    @Test
    fun defaultPreferenceIsBuiltInAndSelectsBuiltInSource() {
        assertEquals(MicrophonePreference.BuiltIn, AudioRoutePolicy.defaultPreference)
        val builtIn = snapshot(id = 4, kind = AudioDeviceKind.BuiltInMic, isSource = true)
        val decision = AudioRoutePolicy.decide(listOf(builtIn))
        assertEquals(MicrophonePreference.BuiltIn, decision.preference)
        assertTrue(decision.accepted)
        assertEquals(builtIn, decision.selectedSource)
        assertNoCommunicationOrSco(decision)
    }

    @Test
    fun selectsBuiltInSourceWhenBluetoothDevicesPresent() {
        val bluetoothSource =
            snapshot(id = 1, kind = AudioDeviceKind.Bluetooth, isSource = true, productName = "bt-mic")
        val bluetoothSink =
            snapshot(id = 2, kind = AudioDeviceKind.Bluetooth, isSource = false, isSink = true, productName = "bt-out")
        val builtIn = snapshot(id = 9, kind = AudioDeviceKind.BuiltInMic, isSource = true, productName = "phone-mic")
        val decision = AudioRoutePolicy.decide(listOf(bluetoothSource, bluetoothSink, builtIn))
        assertTrue(decision.accepted)
        assertEquals(MicrophonePreference.BuiltIn, decision.preference)
        assertEquals(builtIn, decision.selectedSource)
        assertEquals(AudioDeviceKind.BuiltInMic, decision.selectedSource?.kind)
        assertNoCommunicationOrSco(decision)
    }

    @Test
    fun failClosedWhenBuiltInSourceAbsentDoesNotFallBackToBluetooth() {
        val bluetoothSource = snapshot(id = 7, kind = AudioDeviceKind.Bluetooth, isSource = true)
        val wiredSource = snapshot(id = 8, kind = AudioDeviceKind.Wired, isSource = true)
        val decision = AudioRoutePolicy.decide(listOf(bluetoothSource, wiredSource))
        assertFalse(decision.accepted)
        assertEquals(MicrophonePreference.BuiltIn, decision.preference)
        assertNull(decision.selectedSource)
        assertTrue(decision.reason.contains("fail closed"))
        assertTrue(decision.reason.contains("absent"))
        assertNoCommunicationOrSco(decision)
    }

    @Test
    fun rejectsNonSourceBuiltInDevices() {
        val builtinSink =
            snapshot(id = 3, kind = AudioDeviceKind.BuiltInMic, isSource = false, isSink = true, productName = "speaker")
        val bluetoothSource = snapshot(id = 5, kind = AudioDeviceKind.Bluetooth, isSource = true)
        val rejected = AudioRoutePolicy.decide(listOf(builtinSink, bluetoothSource))
        assertFalse(rejected.accepted)
        assertNull(rejected.selectedSource)
        assertNoCommunicationOrSco(rejected)

        val builtinSource = snapshot(id = 11, kind = AudioDeviceKind.BuiltInMic, isSource = true)
        val accepted = AudioRoutePolicy.decide(listOf(builtinSink, builtinSource, bluetoothSource))
        assertTrue(accepted.accepted)
        assertEquals(builtinSource, accepted.selectedSource)
        assertNoCommunicationOrSco(accepted)
    }

    @Test
    fun autoAndBluetoothPreferencesAreUnsupportedWithoutCommunicationOrSco() {
        val devices =
            listOf(
                snapshot(id = 1, kind = AudioDeviceKind.BuiltInMic, isSource = true),
                snapshot(id = 2, kind = AudioDeviceKind.Bluetooth, isSource = true, isSink = true),
            )
        val auto = AudioRoutePolicy.decide(devices, MicrophonePreference.Auto)
        assertFalse(auto.accepted)
        assertEquals(MicrophonePreference.Auto, auto.preference)
        assertNull(auto.selectedSource)
        assertTrue(auto.reason.contains("unsupported and pending"))
        assertNoCommunicationOrSco(auto)

        val bluetooth = AudioRoutePolicy.decide(devices, MicrophonePreference.Bluetooth)
        assertFalse(bluetooth.accepted)
        assertEquals(MicrophonePreference.Bluetooth, bluetooth.preference)
        assertNull(bluetooth.selectedSource)
        assertTrue(bluetooth.reason.contains("unsupported and pending"))
        assertNoCommunicationOrSco(bluetooth)
    }

    private fun snapshot(
        id: Int,
        kind: AudioDeviceKind,
        isSource: Boolean,
        isSink: Boolean = false,
        productName: String = "device-$id",
    ): AudioDeviceSnapshot {
        return AudioDeviceSnapshot(
            id = id,
            productName = productName,
            kind = kind,
            isSource = isSource,
            isSink = isSink,
        )
    }

    private fun assertNoCommunicationOrSco(decision: AudioRouteDecision) {
        assertFalse(decision.communicationModeRequested)
        assertFalse(decision.bluetoothScoRequested)
        assertTrue(decision.reason.contains(AudioRoutePolicy.NO_COMMUNICATION_OR_SCO))
    }
}
