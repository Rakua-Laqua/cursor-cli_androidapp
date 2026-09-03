package dev.cursorremote.android.voice

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import java.io.IOException
import java.io.OutputStream

interface SpeechToTextListener {
    fun onFinalResult(transcript: String)

    fun onError(message: String)
}

interface SpeechToTextEngine {
    fun start(listener: SpeechToTextListener)

    fun writeAudio(pcmChunk: ByteArray)

    fun finish()

    fun cancel()
}

class AndroidSpeechToTextEngine(
    context: Context,
    private val mainHandler: Handler = Handler(Looper.getMainLooper()),
) : SpeechToTextEngine {
    private val appContext = context.applicationContext
    private val lock = Any()
    private var session = 0
    private var listener: SpeechToTextListener? = null
    private var recognizer: SpeechRecognizer? = null
    private var writeStream: OutputStream? = null
    private var readFd: ParcelFileDescriptor? = null
    private var finishRequested = false
    private var pendingFinal: String? = null
    private val segmentTranscripts = ArrayList<String>()
    private val timeoutRunnable = Runnable { onTimeout() }

    override fun start(listener: SpeechToTextListener) {
        runOnMain {
            val previous: RecognizerResources
            val id: Int
            synchronized(lock) {
                previous = releaseLocked()
                session += 1
                this.listener = listener
                id = session
                finishRequested = false
                pendingFinal = null
                segmentTranscripts.clear()
            }
            previous.dispose()
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                failLocked(id, "External PCM injection requires Android 13 or higher.")
                return@runOnMain
            }
            val created =
                try {
                    createRecognizer()
                } catch (error: RuntimeException) {
                    failLocked(id, error.message?.ifBlank { null } ?: "Speech recognition failed to start.")
                    return@runOnMain
                }
            if (created == null) {
                failLocked(id, "Speech recognition is not available.")
                return@runOnMain
            }
            val pipe =
                try {
                    ParcelFileDescriptor.createPipe()
                } catch (error: IOException) {
                    created.destroy()
                    failLocked(id, error.message ?: "Audio pipe failure.")
                    return@runOnMain
                }
            val readEnd = pipe[0]
            val writeEnd = pipe[1]
            val intent =
                Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, readEnd)
                    putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, VoicePcmFormat.CHANNEL_COUNT)
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, VoicePcmFormat.SAMPLE_RATE_HZ)
                }
            synchronized(lock) {
                if (session != id) {
                    readEnd.closeQuietly()
                    writeEnd.closeQuietly()
                    created.destroy()
                    return@runOnMain
                }
                recognizer = created
                readFd = readEnd
                writeStream = ParcelFileDescriptor.AutoCloseOutputStream(writeEnd)
            }
            try {
                created.setRecognitionListener(EngineRecognitionListener(id))
                created.startListening(intent)
            } catch (error: RuntimeException) {
                failLocked(id, error.message?.ifBlank { null } ?: "Speech recognition failed to start.")
                return@runOnMain
            }
            readEnd.closeQuietly()
            synchronized(lock) {
                if (session == id && readFd === readEnd) {
                    readFd = null
                }
            }
        }
    }

    override fun writeAudio(pcmChunk: ByteArray) {
        val stream = synchronized(lock) { writeStream } ?: return
        try {
            stream.write(pcmChunk)
        } catch (error: IOException) {
            val id =
                synchronized(lock) {
                    if (listener == null || writeStream == null) {
                        return
                    }
                    session
                }
            runOnMain {
                failLocked(id, error.message ?: "Audio pipe failure.")
            }
        }
    }

    override fun finish() {
        runOnMain {
            val stream: OutputStream?
            val pending: String?
            val id: Int
            synchronized(lock) {
                if (listener == null) {
                    return@runOnMain
                }
                finishRequested = true
                id = session
                pending = pendingFinal
                pendingFinal = null
                stream = writeStream
                writeStream = null
            }
            stream.closeQuietly()
            mainHandler.removeCallbacks(timeoutRunnable)
            mainHandler.postDelayed(timeoutRunnable, RESULT_TIMEOUT_MS)
            if (pending != null) {
                completeLocked(id, pending)
            }
        }
    }

    override fun cancel() {
        runOnMain {
            val resources: RecognizerResources
            synchronized(lock) {
                resources = releaseLocked()
            }
            resources.dispose()
        }
    }

    private fun createRecognizer(): SpeechRecognizer? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            SpeechRecognizer.isOnDeviceRecognitionAvailable(appContext)
        ) {
            return SpeechRecognizer.createOnDeviceSpeechRecognizer(appContext)
        }
        if (SpeechRecognizer.isRecognitionAvailable(appContext)) {
            return SpeechRecognizer.createSpeechRecognizer(appContext)
        }
        return null
    }

    private fun onTimeout() {
        failLocked(session, "Speech recognition timed out.")
    }

    private fun failLocked(id: Int, message: String) {
        val callback: SpeechToTextListener?
        val resources: RecognizerResources
        synchronized(lock) {
            if (session != id) {
                return
            }
            callback = listener
            resources = releaseLocked()
        }
        resources.dispose()
        callback?.onError(message)
    }

    private fun completeLocked(id: Int, transcript: String) {
        val callback: SpeechToTextListener?
        val resources: RecognizerResources
        synchronized(lock) {
            if (session != id) {
                return
            }
            callback = listener
            resources = releaseLocked()
        }
        resources.dispose()
        callback?.onFinalResult(transcript)
    }

    private fun deliverIfFinished(id: Int, transcript: String) {
        synchronized(lock) {
            if (session != id) {
                return
            }
            if (!finishRequested) {
                pendingFinal = transcript
                return
            }
        }
        completeLocked(id, transcript)
    }

    private fun releaseLocked(): RecognizerResources {
        session += 1
        listener = null
        finishRequested = false
        pendingFinal = null
        segmentTranscripts.clear()
        mainHandler.removeCallbacks(timeoutRunnable)
        val rec = recognizer
        recognizer = null
        val stream = writeStream
        writeStream = null
        val leftoverRead = readFd
        readFd = null
        return RecognizerResources(rec, stream, leftoverRead)
    }

    private fun runOnMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            block()
        } else {
            mainHandler.post(block)
        }
    }

    private inner class EngineRecognitionListener(
        private val id: Int,
    ) : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) = Unit

        override fun onBeginningOfSpeech() = Unit

        override fun onRmsChanged(rmsdB: Float) = Unit

        override fun onBufferReceived(buffer: ByteArray?) = Unit

        override fun onEndOfSpeech() = Unit

        override fun onError(error: Int) {
            failLocked(id, speechRecognizerErrorMessage(error))
        }

        override fun onResults(results: Bundle?) {
            deliverIfFinished(id, transcriptFromResults(results))
        }

        override fun onPartialResults(partialResults: Bundle?) = Unit

        @SuppressLint("NewApi")
        override fun onSegmentResults(segmentResults: Bundle) {
            val text = transcriptFromResults(segmentResults)
            if (text.isEmpty()) {
                return
            }
            synchronized(lock) {
                if (session != id) {
                    return
                }
                segmentTranscripts += text
            }
        }

        @SuppressLint("NewApi")
        override fun onEndOfSegmentedSession() {
            val combined =
                synchronized(lock) {
                    if (session != id) {
                        return
                    }
                    segmentTranscripts.joinToString(" ").ifBlank { pendingFinal.orEmpty() }
                }
            deliverIfFinished(id, combined)
        }

        override fun onEvent(eventType: Int, params: Bundle?) = Unit
    }

    private companion object {
        const val RESULT_TIMEOUT_MS = 15_000L
    }
}

internal fun transcriptFromResults(results: Bundle?): String {
    val values = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
    return values?.firstOrNull().orEmpty()
}

internal fun speechRecognizerErrorMessage(code: Int): String {
    return when (code) {
        SpeechRecognizer.ERROR_AUDIO -> "Audio recording error."
        SpeechRecognizer.ERROR_CLIENT -> "Speech recognition client error."
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission is required."
        SpeechRecognizer.ERROR_NETWORK -> "Speech recognition network error."
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Speech recognition network timed out."
        SpeechRecognizer.ERROR_NO_MATCH -> "No speech recognized."
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Speech recognizer is busy."
        SpeechRecognizer.ERROR_SERVER -> "Speech recognition server error."
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Speech recognition timed out."
        else -> "Speech recognition failed ($code)."
    }
}

private class RecognizerResources(
    private val recognizer: SpeechRecognizer?,
    private val stream: OutputStream?,
    private val readFd: ParcelFileDescriptor?,
) {
    fun dispose() {
        stream.closeQuietly()
        readFd.closeQuietly()
        if (recognizer != null) {
            try {
                recognizer.cancel()
            } catch (_: IllegalStateException) {
            }
            recognizer.destroy()
        }
    }
}

private fun ParcelFileDescriptor?.closeQuietly() {
    if (this == null) {
        return
    }
    try {
        close()
    } catch (_: IOException) {
    }
}

private fun OutputStream?.closeQuietly() {
    if (this == null) {
        return
    }
    try {
        close()
    } catch (_: IOException) {
    }
}
