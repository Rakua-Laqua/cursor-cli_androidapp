package dev.cursorremote.android.voice

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.sqrt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class AudioRoutingProbeActivity : ComponentActivity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val recordLock = Any()
    private val stopFlag = AtomicBoolean(false)
    private var audioRecord: AudioRecord? = null
    private var probeJob: Job? = null
    private var stopLabel = "completed"
    private val report = mutableStateOf(INITIAL_REPORT)
    private val probing = mutableStateOf(false)

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                startProbe()
            } else {
                report.value = "ERROR: RECORD_AUDIO denied.\nCommunication mode is not requested. Bluetooth SCO is not requested."
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val text by report
            val busy by probing
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    AudioRoutingProbeScreen(
                        report = text,
                        probing = busy,
                        onRefresh = { refreshInventory() },
                        onStart = { startProbe() },
                        onStop = { requestStop("stopped") },
                        onCancel = { requestStop("cancelled") },
                    )
                }
            }
        }
    }

    override fun onDestroy() {
        stopFlag.set(true)
        releaseRecord()
        probeJob?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    private fun refreshInventory() {
        if (probing.value) {
            return
        }
        report.value = buildReport(runProbe = false)
    }

    private fun startProbe() {
        if (probing.value) {
            return
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        stopFlag.set(false)
        stopLabel = "completed"
        probing.value = true
        probeJob =
            scope.launch {
                val text =
                    try {
                        withContext(Dispatchers.IO) { buildReport(runProbe = true) }
                    } catch (e: CancellationException) {
                        releaseRecord()
                        throw e
                    } catch (e: Exception) {
                        "ERROR: ${e.javaClass.simpleName}: ${e.message}"
                    } finally {
                        releaseRecord()
                        if (!isDestroyed) {
                            probing.value = false
                        }
                    }
                if (!isDestroyed) {
                    report.value = text
                }
            }
    }

    private fun requestStop(label: String) {
        stopLabel = label
        stopFlag.set(true)
        val recording = synchronized(recordLock) { audioRecord }
        if (recording != null && recording.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
            try {
                recording.stop()
            } catch (_: IllegalStateException) {
            }
        }
    }

    private fun buildReport(runProbe: Boolean): String {
        val out = StringBuilder()
        appendIdentity(out)
        val audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        val modeBefore = audioManager.mode
        out.appendLine("AudioManager.mode before: ${modeLabel(modeBefore)}")
        val inputs = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
        val outputs = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        appendInventory(out, "INPUT", inputs)
        appendInventory(out, "OUTPUT", outputs)
        val snapshots = (inputs.toList() + outputs.toList()).distinctBy { it.id }.map { it.toSnapshot() }
        val decision = AudioRoutePolicy.decide(snapshots)
        out.appendLine("preference: ${decision.preference}")
        out.appendLine("decision accepted: ${decision.accepted}")
        out.appendLine("decision reason: ${decision.reason}")
        out.appendLine("communicationModeRequested: ${decision.communicationModeRequested}")
        out.appendLine("bluetoothScoRequested: ${decision.bluetoothScoRequested}")
        out.appendLine("selected source: ${decision.selectedSource?.let { formatSnapshot(it) } ?: "none"}")
        if (!runProbe) {
            out.appendLine("probe: not started (refresh only)")
            out.appendLine("AudioManager.mode current: ${modeLabel(audioManager.mode)}")
            return out.toString()
        }
        if (!decision.accepted || decision.selectedSource == null) {
            out.appendLine("ERROR: built-in microphone route failed closed; AudioRecord not started.")
            out.appendLine("AudioManager.mode after: ${modeLabel(audioManager.mode)}")
            return out.toString()
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            out.appendLine("ERROR: RECORD_AUDIO missing; AudioRecord not started.")
            out.appendLine("AudioManager.mode after: ${modeLabel(audioManager.mode)}")
            return out.toString()
        }
        val preferred = inputs.firstOrNull { it.id == decision.selectedSource.id }
        if (preferred == null) {
            out.appendLine("ERROR: selected built-in AudioDeviceInfo is missing from inputs.")
            out.appendLine("AudioManager.mode after: ${modeLabel(audioManager.mode)}")
            return out.toString()
        }
        val minBuffer =
            AudioRecord.getMinBufferSize(
                SAMPLE_RATE_HZ,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
        if (minBuffer <= 0) {
            out.appendLine("ERROR: AudioRecord.getMinBufferSize returned $minBuffer")
            return out.toString()
        }
        val record =
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE_HZ,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuffer * 2,
            )
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            out.appendLine("ERROR: AudioRecord failed to initialize.")
            return out.toString()
        }
        synchronized(recordLock) { audioRecord = record }
        val preferredAccepted = record.setPreferredDevice(preferred)
        out.appendLine("setPreferredDevice accepted: $preferredAccepted")
        out.appendLine("preferred device: ${formatDevice(preferred)}")
        try {
            record.startRecording()
            out.appendLine("AudioManager.mode during: ${modeLabel(audioManager.mode)}")
            val buffer = ShortArray(minBuffer)
            var frames = 0L
            var peak = 0
            var sumSquares = 0.0
            val routed = linkedSetOf<String>()
            val deadline = SystemClock.elapsedRealtime() + PROBE_LIMIT_MS
            while (!stopFlag.get() && SystemClock.elapsedRealtime() < deadline) {
                if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                    break
                }
                routed += formatDevice(record.routedDevice)
                val n = record.read(buffer, 0, buffer.size)
                if (n < 0) {
                    out.appendLine("ERROR: AudioRecord.read returned $n")
                    break
                }
                var i = 0
                while (i < n) {
                    val sample = buffer[i].toInt()
                    val magnitude = abs(sample)
                    if (magnitude > peak) {
                        peak = magnitude
                    }
                    sumSquares += sample.toDouble() * sample.toDouble()
                    i += 1
                }
                frames += n
            }
            if (record.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                record.stop()
            }
            out.appendLine("AudioManager.mode after: ${modeLabel(audioManager.mode)}")
            out.appendLine("probe outcome: $stopLabel")
            out.appendLine("routed-device observations (recording only):")
            if (routed.isEmpty()) {
                out.appendLine("  (none)")
            } else {
                routed.forEach { line -> out.appendLine("  $line") }
            }
            val bytes = frames * 2L
            val rms = if (frames > 0L) sqrt(sumSquares / frames.toDouble()) else 0.0
            out.appendLine("PCM source: VOICE_RECOGNITION")
            out.appendLine("PCM format: 16-bit mono $SAMPLE_RATE_HZ Hz")
            out.appendLine("PCM frames: $frames")
            out.appendLine("PCM bytes: $bytes")
            out.appendLine("signal peak: $peak")
            out.appendLine("signal RMS: ${"%.3f".format(Locale.US, rms)}")
            out.appendLine("samples arrived: ${frames > 0L}")
        } finally {
            releaseRecord()
            out.appendLine("AudioRecord released")
        }
        return out.toString()
    }

    private fun appendIdentity(out: StringBuilder) {
        val packageInfo =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                packageManager.getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                packageManager.getPackageInfo(packageName, 0)
            }
        val versionCode =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                packageInfo.longVersionCode
            } else {
                @Suppress("DEPRECATION")
                packageInfo.versionCode.toLong()
            }
        out.appendLine("Audio routing probe (debug-only, not Gate D evidence)")
        out.appendLine("package: $packageName")
        out.appendLine("versionName: ${packageInfo.versionName}")
        out.appendLine("versionCode: $versionCode")
        out.appendLine("manufacturer: ${Build.MANUFACTURER}")
        out.appendLine("brand: ${Build.BRAND}")
        out.appendLine("model: ${Build.MODEL}")
        out.appendLine("device: ${Build.DEVICE}")
        out.appendLine("product: ${Build.PRODUCT}")
        out.appendLine("android.release: ${Build.VERSION.RELEASE}")
        out.appendLine("android.sdk: ${Build.VERSION.SDK_INT}")
        out.appendLine("display: ${Build.DISPLAY}")
        out.appendLine("fingerprint: ${Build.FINGERPRINT}")
    }

    private fun appendInventory(out: StringBuilder, label: String, devices: Array<AudioDeviceInfo>) {
        out.appendLine("$label devices (${devices.size}):")
        if (devices.isEmpty()) {
            out.appendLine("  (none)")
            return
        }
        devices.forEach { device -> out.appendLine("  ${formatDevice(device)}") }
    }

    private fun releaseRecord() {
        synchronized(recordLock) {
            val record = audioRecord
            audioRecord = null
            if (record == null) {
                return
            }
            try {
                if (record.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                    record.stop()
                }
            } catch (_: IllegalStateException) {
            }
            record.release()
        }
    }

    companion object {
        private const val SAMPLE_RATE_HZ = 16_000
        private const val PROBE_LIMIT_MS = 3_000L
        private const val INITIAL_REPORT = "Debug audio routing probe. Use Refresh, Start, Stop, or Cancel."
    }
}

@Composable
private fun AudioRoutingProbeScreen(
    report: String,
    probing: Boolean,
    onRefresh: () -> Unit,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onCancel: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Audio Routing Probe", style = MaterialTheme.typography.headlineSmall)
        Text("Debug-only diagnostic. Not STT UI. Not Gate D evidence.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onRefresh, enabled = !probing) { Text("Refresh") }
            Button(onClick = onStart, enabled = !probing) { Text("Start") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onStop) { Text("Stop") }
            Button(onClick = onCancel) { Text("Cancel") }
        }
        OutlinedTextField(
            value = report,
            onValueChange = {},
            readOnly = true,
            modifier = Modifier.fillMaxWidth().weight(1f),
            label = { Text("Result (selectable)") },
        )
    }
}

private fun AudioDeviceInfo.toSnapshot(): AudioDeviceSnapshot {
    return AudioDeviceSnapshot(
        id = id,
        productName = productName?.toString().orEmpty(),
        kind = classifyAudioDeviceType(type),
        isSource = isSource,
        isSink = isSink,
    )
}

private fun classifyAudioDeviceType(type: Int): AudioDeviceKind {
    return when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> AudioDeviceKind.BuiltInMic
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_BLE_SPEAKER,
        AudioDeviceInfo.TYPE_BLE_BROADCAST,
        AudioDeviceInfo.TYPE_HEARING_AID,
        -> AudioDeviceKind.Bluetooth
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_USB_DEVICE,
        AudioDeviceInfo.TYPE_LINE_ANALOG,
        AudioDeviceInfo.TYPE_LINE_DIGITAL,
        -> AudioDeviceKind.Wired
        else -> AudioDeviceKind.Other
    }
}

private fun formatSnapshot(snapshot: AudioDeviceSnapshot): String {
    return "id=${snapshot.id} kind=${snapshot.kind} source=${snapshot.isSource} sink=${snapshot.isSink} name=${snapshot.productName}"
}

private fun formatDevice(device: AudioDeviceInfo?): String {
    if (device == null) {
        return "null"
    }
    return "id=${device.id} type=${typeLabel(device.type)} source=${device.isSource} sink=${device.isSink} name=${device.productName}"
}

private fun typeLabel(type: Int): String {
    return when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> "TYPE_BUILTIN_MIC"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "TYPE_BUILTIN_SPEAKER"
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "TYPE_BUILTIN_EARPIECE"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "TYPE_BLUETOOTH_SCO"
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "TYPE_BLUETOOTH_A2DP"
        AudioDeviceInfo.TYPE_BLE_HEADSET -> "TYPE_BLE_HEADSET"
        AudioDeviceInfo.TYPE_BLE_SPEAKER -> "TYPE_BLE_SPEAKER"
        AudioDeviceInfo.TYPE_BLE_BROADCAST -> "TYPE_BLE_BROADCAST"
        AudioDeviceInfo.TYPE_HEARING_AID -> "TYPE_HEARING_AID"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "TYPE_WIRED_HEADSET"
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "TYPE_WIRED_HEADPHONES"
        AudioDeviceInfo.TYPE_USB_HEADSET -> "TYPE_USB_HEADSET"
        AudioDeviceInfo.TYPE_USB_DEVICE -> "TYPE_USB_DEVICE"
        else -> "TYPE_$type"
    }
}

private fun modeLabel(mode: Int): String {
    val name =
        when (mode) {
            AudioManager.MODE_NORMAL -> "MODE_NORMAL"
            AudioManager.MODE_RINGTONE -> "MODE_RINGTONE"
            AudioManager.MODE_IN_CALL -> "MODE_IN_CALL"
            AudioManager.MODE_IN_COMMUNICATION -> "MODE_IN_COMMUNICATION"
            else -> "MODE_UNKNOWN"
        }
    return "$name($mode)"
}
