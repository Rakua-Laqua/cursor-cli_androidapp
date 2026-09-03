package dev.cursorremote.android.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoicePromptControllerTest {
    @Test
    fun startForwardsPcmThenFinishReachesReadyWithTrimmedTranscript() {
        val recorder = FakePushToTalkRecorder()
        val engine = FakeSpeechToTextEngine()
        val controller = VoicePromptController(recorder, engine)
        controller.start()
        assertEquals(VoicePromptPhase.Listening, controller.state.value.phase)
        assertEquals("phone-mic", controller.state.value.routedMicrophoneName)
        assertEquals(1, engine.startCount)
        assertEquals(1, recorder.startCount)
        val chunk = byteArrayOf(1, 2, 3, 4)
        recorder.emit(chunk)
        assertEquals(listOf(chunk.toList()), engine.written.map { it.toList() })
        controller.finish()
        assertEquals(VoicePromptPhase.Transcribing, controller.state.value.phase)
        assertEquals(1, recorder.stopCount)
        assertEquals(1, engine.finishCount)
        engine.deliver("  hello world  ")
        assertEquals(VoicePromptPhase.Ready, controller.state.value.phase)
        assertEquals("hello world", controller.state.value.transcript)
        assertTrue(recorder.released)
        assertTrue(engine.released)
    }

    @Test
    fun cancelReleasesRecorderAndEngineAndReturnsToIdle() {
        val recorder = FakePushToTalkRecorder()
        val engine = FakeSpeechToTextEngine()
        val controller = VoicePromptController(recorder, engine)
        controller.start()
        recorder.emit(byteArrayOf(9))
        controller.cancel()
        assertEquals(VoicePromptPhase.Idle, controller.state.value.phase)
        assertEquals(1, recorder.cancelCount)
        assertEquals(1, engine.cancelCount)
        assertTrue(recorder.released)
        assertTrue(engine.released)
        engine.deliver("late")
        assertEquals(VoicePromptPhase.Idle, controller.state.value.phase)
        assertEquals("", controller.state.value.transcript)
    }

    @Test
    fun blankResultAndEngineErrorBecomeErrorAndRelease() {
        val recorder = FakePushToTalkRecorder()
        val engine = FakeSpeechToTextEngine()
        val controller = VoicePromptController(recorder, engine)
        controller.start()
        controller.finish()
        engine.deliver("   ")
        assertEquals(VoicePromptPhase.Error, controller.state.value.phase)
        assertEquals("No speech recognized.", controller.state.value.errorMessage)
        assertTrue(recorder.released)
        assertTrue(engine.released)

        controller.start()
        engine.fail("pipe broken")
        assertEquals(VoicePromptPhase.Error, controller.state.value.phase)
        assertEquals("pipe broken", controller.state.value.errorMessage)
        assertTrue(recorder.released)
        assertTrue(engine.released)
    }

    @Test
    fun duplicateStartAndFinishAreRejectedOrHarmless() {
        val recorder = FakePushToTalkRecorder()
        val engine = FakeSpeechToTextEngine()
        val controller = VoicePromptController(recorder, engine)
        controller.start()
        controller.start()
        assertEquals(1, recorder.startCount)
        assertEquals(1, engine.startCount)
        assertEquals(VoicePromptPhase.Listening, controller.state.value.phase)
        controller.finish()
        controller.finish()
        assertEquals(1, recorder.stopCount)
        assertEquals(1, engine.finishCount)
        assertEquals(VoicePromptPhase.Transcribing, controller.state.value.phase)
    }

    @Test
    fun closeReleasesActiveResources() {
        val recorder = FakePushToTalkRecorder()
        val engine = FakeSpeechToTextEngine()
        val controller = VoicePromptController(recorder, engine)
        controller.start()
        controller.close()
        assertEquals(VoicePromptPhase.Idle, controller.state.value.phase)
        assertTrue(recorder.released)
        assertTrue(engine.released)
        controller.start()
        assertEquals(1, recorder.startCount)
        assertEquals(VoicePromptPhase.Idle, controller.state.value.phase)
    }

    @Test
    fun asynchronousRecorderFailureBecomesErrorAndCleansUp() {
        val recorder = FakePushToTalkRecorder()
        val engine = FakeSpeechToTextEngine()
        val controller = VoicePromptController(recorder, engine)
        controller.start()
        recorder.fail("AudioRecord.read failed (-3).")
        assertEquals(VoicePromptPhase.Error, controller.state.value.phase)
        assertEquals("AudioRecord.read failed (-3).", controller.state.value.errorMessage)
        assertTrue(recorder.released)
        assertTrue(engine.released)
        recorder.fail("stale")
        assertEquals(VoicePromptPhase.Error, controller.state.value.phase)
        assertEquals("AudioRecord.read failed (-3).", controller.state.value.errorMessage)
    }

    @Test
    fun finishRecorderOrEngineExceptionBecomesErrorAndCleansUp() {
        val recorder = FakePushToTalkRecorder()
        recorder.stopError = IllegalStateException("stop failed")
        val engine = FakeSpeechToTextEngine()
        val controller = VoicePromptController(recorder, engine)
        controller.start()
        controller.finish()
        assertEquals(VoicePromptPhase.Error, controller.state.value.phase)
        assertEquals("stop failed", controller.state.value.errorMessage)
        assertTrue(recorder.released)
        assertTrue(engine.released)

        val recorder2 = FakePushToTalkRecorder()
        val engine2 = FakeSpeechToTextEngine()
        engine2.finishError = IllegalStateException("finish failed")
        val controller2 = VoicePromptController(recorder2, engine2)
        controller2.start()
        controller2.finish()
        assertEquals(VoicePromptPhase.Error, controller2.state.value.phase)
        assertEquals("finish failed", controller2.state.value.errorMessage)
        assertTrue(recorder2.released)
        assertTrue(engine2.released)
    }

    @Test
    fun cancelAndCloseFromIdleAreIdempotentAndCleanup() {
        val recorder = FakePushToTalkRecorder()
        val engine = FakeSpeechToTextEngine()
        val controller = VoicePromptController(recorder, engine)
        controller.cancel()
        assertEquals(VoicePromptPhase.Idle, controller.state.value.phase)
        assertEquals(1, recorder.cancelCount)
        assertEquals(1, engine.cancelCount)
        controller.cancel()
        assertEquals(2, recorder.cancelCount)
        assertEquals(2, engine.cancelCount)
        controller.close()
        assertEquals(3, recorder.cancelCount)
        assertEquals(3, engine.cancelCount)
        assertTrue(recorder.released)
        assertTrue(engine.released)
        controller.close()
        assertEquals(4, recorder.cancelCount)
        assertEquals(4, engine.cancelCount)
    }

    @Test
    fun engineStartExceptionBecomesErrorAndCleansUp() {
        val recorder = FakePushToTalkRecorder()
        val engine = FakeSpeechToTextEngine()
        engine.startError = IllegalStateException("recognizer failed")
        val controller = VoicePromptController(recorder, engine)
        controller.start()
        assertEquals(VoicePromptPhase.Error, controller.state.value.phase)
        assertEquals("recognizer failed", controller.state.value.errorMessage)
        assertEquals(0, recorder.startCount)
        assertTrue(recorder.released)
        assertTrue(engine.released)
    }

    @Test
    fun stalePcmAfterCancelDoesNotReachNewEngine() {
        val recorder = FakePushToTalkRecorder()
        val engine = FakeSpeechToTextEngine()
        val controller = VoicePromptController(recorder, engine)
        controller.start()
        val stale = recorder.pcmSink
        controller.cancel()
        controller.start()
        engine.written.clear()
        stale?.invoke(byteArrayOf(9, 9))
        assertTrue(engine.written.isEmpty())
        recorder.emit(byteArrayOf(2))
        assertEquals(listOf(listOf<Byte>(2)), engine.written.map { it.toList() })
    }

    private class FakePushToTalkRecorder : PushToTalkRecorder {
        var startCount = 0
        var stopCount = 0
        var cancelCount = 0
        var released = true
        var stopError: RuntimeException? = null
        var pcmSink: ((ByteArray) -> Unit)? = null
        private var errorSink: ((String) -> Unit)? = null
        override var state: AudioRecordingState = AudioRecordingState.Idle
            private set

        override fun start(
            onPcmChunk: (ByteArray) -> Unit,
            onError: (String) -> Unit,
        ): Result<RoutedMicrophone> {
            startCount += 1
            pcmSink = onPcmChunk
            errorSink = onError
            state = AudioRecordingState.Recording
            released = false
            return Result.success(
                RoutedMicrophone(id = 4, productName = "phone-mic", kind = AudioDeviceKind.BuiltInMic),
            )
        }

        override fun stop() {
            stopCount += 1
            val error = stopError
            if (error != null) {
                throw error
            }
            state = AudioRecordingState.Idle
            released = true
            pcmSink = null
        }

        override fun cancel() {
            cancelCount += 1
            state = AudioRecordingState.Idle
            released = true
            pcmSink = null
        }

        fun emit(bytes: ByteArray) {
            pcmSink?.invoke(bytes)
        }

        fun fail(message: String) {
            errorSink?.invoke(message)
        }
    }

    private class FakeSpeechToTextEngine : SpeechToTextEngine {
        var startCount = 0
        var finishCount = 0
        var cancelCount = 0
        var released = true
        var finishError: RuntimeException? = null
        var startError: RuntimeException? = null
        val written = mutableListOf<ByteArray>()
        private var listener: SpeechToTextListener? = null

        override fun start(listener: SpeechToTextListener) {
            startCount += 1
            this.listener = listener
            released = false
            val error = startError
            if (error != null) {
                throw error
            }
        }

        override fun writeAudio(pcmChunk: ByteArray) {
            written += pcmChunk
        }

        override fun finish() {
            finishCount += 1
            val error = finishError
            if (error != null) {
                throw error
            }
        }

        override fun cancel() {
            cancelCount += 1
            listener = null
            released = true
        }

        fun deliver(transcript: String) {
            val callback = listener
            listener = null
            released = true
            callback?.onFinalResult(transcript)
        }

        fun fail(message: String) {
            val callback = listener
            listener = null
            released = true
            callback?.onError(message)
        }
    }
}
