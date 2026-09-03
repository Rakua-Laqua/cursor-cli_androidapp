package dev.cursorremote.android.voice

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import java.util.concurrent.atomic.AtomicBoolean

enum class AudioRecordingState {
    Idle,
    Recording,
}

data class RoutedMicrophone(
    val id: Int,
    val productName: String,
    val kind: AudioDeviceKind,
)

object VoicePcmFormat {
    const val SAMPLE_RATE_HZ = 16_000
    const val CHANNEL_COUNT = 1
    const val BITS_PER_SAMPLE = 16
}

interface PushToTalkRecorder {
    val state: AudioRecordingState

    fun start(
        onPcmChunk: (ByteArray) -> Unit,
        onError: (String) -> Unit,
    ): Result<RoutedMicrophone>

    fun stop()

    fun cancel()
}

class AndroidPushToTalkRecorder(
    context: Context,
) : PushToTalkRecorder {
    private val appContext = context.applicationContext
    private val audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val lock = Any()
    private val stopFlag = AtomicBoolean(false)
    private var audioRecord: AudioRecord? = null
    private var readThread: Thread? = null

    @Volatile
    override var state: AudioRecordingState = AudioRecordingState.Idle
        private set

    @SuppressLint("MissingPermission")
    override fun start(
        onPcmChunk: (ByteArray) -> Unit,
        onError: (String) -> Unit,
    ): Result<RoutedMicrophone> {
        val started =
            synchronized(lock) {
                if (state == AudioRecordingState.Recording) {
                    return Result.failure(IllegalStateException("Recording is already in progress."))
                }
                if (appContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
                    PackageManager.PERMISSION_GRANTED
                ) {
                    return Result.failure(SecurityException("Microphone permission is required."))
                }
                val inputs = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
                val decision = AudioRoutePolicy.decide(inputs.map { it.toAudioDeviceSnapshot() })
                if (!decision.accepted || decision.selectedSource == null) {
                    return Result.failure(
                        IllegalStateException(decision.reason.ifBlank { "Built-in microphone is unavailable." }),
                    )
                }
                val preferred =
                    inputs.firstOrNull { device -> device.id == decision.selectedSource.id }
                        ?: return Result.failure(IllegalStateException("Selected built-in microphone is missing."))
                val minBuffer =
                    AudioRecord.getMinBufferSize(
                        VoicePcmFormat.SAMPLE_RATE_HZ,
                        AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT,
                    )
                if (minBuffer <= 0) {
                    return Result.failure(IllegalStateException("AudioRecord buffer size is invalid."))
                }
                val record =
                    try {
                        AudioRecord(
                            MediaRecorder.AudioSource.VOICE_RECOGNITION,
                            VoicePcmFormat.SAMPLE_RATE_HZ,
                            AudioFormat.CHANNEL_IN_MONO,
                            AudioFormat.ENCODING_PCM_16BIT,
                            minBuffer * 2,
                        )
                    } catch (error: IllegalArgumentException) {
                        return Result.failure(error)
                    }
                if (record.state != AudioRecord.STATE_INITIALIZED) {
                    record.release()
                    return Result.failure(IllegalStateException("AudioRecord failed to initialize."))
                }
                if (!record.setPreferredDevice(preferred)) {
                    record.release()
                    return Result.failure(IllegalStateException("Preferred built-in microphone was rejected."))
                }
                try {
                    record.startRecording()
                } catch (error: IllegalStateException) {
                    record.release()
                    return Result.failure(error)
                }
                val routed = record.routedDevice?.toAudioDeviceSnapshot()
                if (routed == null || routed.kind != AudioDeviceKind.BuiltInMic || !routed.isSource) {
                    stopAndReleaseRecord(record)
                    return Result.failure(
                        IllegalStateException("Actual recording device is not the built-in microphone."),
                    )
                }
                stopFlag.set(false)
                audioRecord = record
                state = AudioRecordingState.Recording
                val thread =
                    Thread(
                        {
                            val active = synchronized(lock) { audioRecord === record && !stopFlag.get() }
                            if (!active) {
                                return@Thread
                            }
                            readLoop(record, minBuffer * 2, onPcmChunk, onError)
                        },
                        "ptt-record",
                    )
                readThread = thread
                val name = routed.productName.ifBlank { "Built-in microphone" }
                Pair(thread, Result.success(RoutedMicrophone(id = routed.id, productName = name, kind = routed.kind)))
            }
        started.first.start()
        return started.second
    }

    override fun stop() {
        releaseRecording(joinThread = true)
    }

    override fun cancel() {
        releaseRecording(joinThread = true)
    }

    private fun releaseRecording(joinThread: Boolean) {
        val record: AudioRecord?
        val thread: Thread?
        synchronized(lock) {
            stopFlag.set(true)
            record = audioRecord
            thread = readThread
            audioRecord = null
            readThread = null
            state = AudioRecordingState.Idle
        }
        if (record != null) {
            try {
                if (record.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                    record.stop()
                }
            } catch (_: IllegalStateException) {
            }
        }
        if (joinThread && thread != null && thread !== Thread.currentThread()) {
            try {
                thread.join(1_000L)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
        if (record != null) {
            try {
                record.release()
            } catch (_: IllegalStateException) {
            }
        }
    }

    private fun readLoop(
        record: AudioRecord,
        bufferBytes: Int,
        onPcmChunk: (ByteArray) -> Unit,
        onError: (String) -> Unit,
    ) {
        val buffer = ByteArray(bufferBytes)
        while (!stopFlag.get()) {
            if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                if (stopFlag.get()) {
                    break
                }
                failFromRead(record, "AudioRecord stopped unexpectedly.", onError)
                return
            }
            val n =
                try {
                    record.read(buffer, 0, buffer.size)
                } catch (error: IllegalStateException) {
                    if (stopFlag.get()) {
                        break
                    }
                    failFromRead(
                        record,
                        error.message ?: "AudioRecord entered an illegal state.",
                        onError,
                    )
                    return
                }
            if (n < 0) {
                if (stopFlag.get()) {
                    break
                }
                failFromRead(record, "AudioRecord.read failed ($n).", onError)
                return
            }
            if (n > 0 && !stopFlag.get()) {
                try {
                    onPcmChunk(buffer.copyOf(n))
                } catch (error: RuntimeException) {
                    failFromRead(record, error.message ?: "PCM callback failed.", onError)
                    return
                }
            }
        }
    }

    private fun failFromRead(
        record: AudioRecord,
        message: String,
        onError: (String) -> Unit,
    ) {
        val claimed: AudioRecord?
        synchronized(lock) {
            if (audioRecord !== record) {
                return
            }
            stopFlag.set(true)
            claimed = audioRecord
            audioRecord = null
            readThread = null
            state = AudioRecordingState.Idle
        }
        stopAndReleaseRecord(claimed)
        if (claimed != null) {
            onError(message)
        }
    }

    private fun stopAndReleaseRecord(record: AudioRecord?) {
        if (record == null) {
            return
        }
        try {
            if (record.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                record.stop()
            }
        } catch (_: IllegalStateException) {
        }
        try {
            record.release()
        } catch (_: IllegalStateException) {
        }
    }
}

internal fun AudioDeviceInfo.toAudioDeviceSnapshot(): AudioDeviceSnapshot {
    return AudioDeviceSnapshot(
        id = id,
        productName = productName?.toString().orEmpty(),
        kind = audioDeviceKindForType(type),
        isSource = isSource,
        isSink = isSink,
    )
}

internal fun audioDeviceKindForType(type: Int): AudioDeviceKind {
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
