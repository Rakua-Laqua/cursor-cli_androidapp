package dev.cursorremote.android.voice

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class VoicePromptPhase {
    Idle,
    Preparing,
    Listening,
    Transcribing,
    Ready,
    Error,
}

data class VoicePromptState(
    val phase: VoicePromptPhase = VoicePromptPhase.Idle,
    val transcript: String = "",
    val errorMessage: String? = null,
    val routedMicrophoneName: String? = null,
)

class VoicePromptController(
    private val recorder: PushToTalkRecorder,
    private val engine: SpeechToTextEngine,
) {
    private val lock = Any()
    private val _state = MutableStateFlow(VoicePromptState())
    private var session = 0
    private var closed = false
    val state: StateFlow<VoicePromptState> = _state.asStateFlow()

    fun start() {
        val id: Int
        synchronized(lock) {
            if (closed) {
                return
            }
            when (_state.value.phase) {
                VoicePromptPhase.Idle, VoicePromptPhase.Ready, VoicePromptPhase.Error -> Unit
                VoicePromptPhase.Preparing,
                VoicePromptPhase.Listening,
                VoicePromptPhase.Transcribing,
                -> return
            }
            session += 1
            id = session
            emitLocked(
                VoicePromptState(phase = VoicePromptPhase.Preparing),
            )
        }
        try {
            engine.start(
                object : SpeechToTextListener {
                    override fun onFinalResult(transcript: String) {
                        onEngineResult(id, transcript)
                    }

                    override fun onError(message: String) {
                        onEngineError(id, message)
                    }
                },
            )
        } catch (error: RuntimeException) {
            fail(id, error.message?.ifBlank { null } ?: "Failed to start speech recognition.")
            return
        }
        synchronized(lock) {
            if (closed || session != id || _state.value.phase != VoicePromptPhase.Preparing) {
                return
            }
        }
        val started =
            try {
                recorder.start(
                    onPcmChunk = { chunk ->
                        val live =
                            synchronized(lock) {
                                !closed &&
                                    session == id &&
                                    (
                                        _state.value.phase == VoicePromptPhase.Preparing ||
                                            _state.value.phase == VoicePromptPhase.Listening
                                    )
                            }
                        if (live) {
                            engine.writeAudio(chunk)
                        }
                    },
                    onError = { message -> fail(id, message) },
                )
            } catch (error: RuntimeException) {
                fail(id, error.message ?: "Failed to start recording.")
                return
            }
        val microphone = started.getOrNull()
        if (microphone == null) {
            fail(id, started.exceptionOrNull()?.message ?: "Failed to start recording.")
            return
        }
        val shouldCancel: Boolean
        synchronized(lock) {
            if (closed || session != id || _state.value.phase != VoicePromptPhase.Preparing) {
                shouldCancel = true
            } else {
                shouldCancel = false
                emitLocked(
                    VoicePromptState(
                        phase = VoicePromptPhase.Listening,
                        routedMicrophoneName = microphone.productName,
                    ),
                )
            }
        }
        if (shouldCancel) {
            cleanupQuietly()
        }
    }

    fun finish() {
        val id: Int
        val microphoneName: String?
        synchronized(lock) {
            if (closed || _state.value.phase != VoicePromptPhase.Listening) {
                return
            }
            id = session
            microphoneName = _state.value.routedMicrophoneName
            emitLocked(
                VoicePromptState(
                    phase = VoicePromptPhase.Transcribing,
                    routedMicrophoneName = microphoneName,
                ),
            )
        }
        try {
            recorder.stop()
        } catch (error: RuntimeException) {
            fail(id, error.message ?: "Failed to stop recording.")
            return
        }
        synchronized(lock) {
            if (closed || session != id || _state.value.phase != VoicePromptPhase.Transcribing) {
                return
            }
        }
        try {
            engine.finish()
        } catch (error: RuntimeException) {
            fail(id, error.message ?: "Failed to finish speech recognition.")
        }
    }

    fun cancel() {
        synchronized(lock) {
            if (!closed) {
                session += 1
                if (_state.value.phase != VoicePromptPhase.Idle) {
                    emitLocked(VoicePromptState())
                }
            }
        }
        cleanupQuietly()
    }

    fun close() {
        synchronized(lock) {
            closed = true
            session += 1
            if (_state.value.phase != VoicePromptPhase.Idle) {
                emitLocked(VoicePromptState())
            }
        }
        cleanupQuietly()
    }

    private fun onEngineResult(id: Int, transcript: String) {
        val trimmed = transcript.trim()
        val shouldRelease: Boolean
        synchronized(lock) {
            if (closed || session != id) {
                return
            }
            session += 1
            shouldRelease = true
            val microphoneName = _state.value.routedMicrophoneName
            if (trimmed.isEmpty()) {
                emitLocked(
                    VoicePromptState(
                        phase = VoicePromptPhase.Error,
                        errorMessage = "No speech recognized.",
                        routedMicrophoneName = microphoneName,
                    ),
                )
            } else {
                emitLocked(
                    VoicePromptState(
                        phase = VoicePromptPhase.Ready,
                        transcript = trimmed,
                        routedMicrophoneName = microphoneName,
                    ),
                )
            }
        }
        if (shouldRelease) {
            cleanupQuietly()
        }
    }

    private fun onEngineError(id: Int, message: String) {
        fail(id, message)
    }

    private fun fail(id: Int, message: String) {
        val shouldRelease: Boolean
        synchronized(lock) {
            if (closed || session != id) {
                return
            }
            session += 1
            shouldRelease = true
            emitLocked(
                VoicePromptState(
                    phase = VoicePromptPhase.Error,
                    errorMessage = message,
                    routedMicrophoneName = _state.value.routedMicrophoneName,
                ),
            )
        }
        if (shouldRelease) {
            cleanupQuietly()
        }
    }

    private fun cleanupQuietly() {
        try {
            engine.cancel()
        } catch (_: RuntimeException) {
        }
        try {
            recorder.cancel()
        } catch (_: RuntimeException) {
        }
    }

    private fun emitLocked(next: VoicePromptState) {
        _state.value = next
    }
}
