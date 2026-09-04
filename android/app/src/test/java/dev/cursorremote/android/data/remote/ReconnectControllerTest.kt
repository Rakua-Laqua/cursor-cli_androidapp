package dev.cursorremote.android.data.remote

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReconnectControllerTest {
    @Test
    fun eligibilityImmediateAttemptJitterCapAndMaxAttempts() {
        val delays = mutableListOf<Long>()
        withController(
            foreground = false,
            machineId = "pc-1",
            state = RemoteConnectionState.Failed,
            delayMs = { delays += it },
            jitter = { 1.0 },
        ) { controller, attempts, fg, machine, state, _ ->
            assertEquals(0, attempts.get())
            fg.value = true
            assertEquals(16, attempts.get())
            assertEquals(15, delays.size)
            assertEquals(250L, delays.first())
            assertEquals(10_000L, delays.last())
            assertTrue(delays.all { it in 0L..10_000L })
            fg.value = false
            attempts.set(0)
            delays.clear()
            fg.value = true
            assertEquals(16, attempts.get())
            controller.close()
        }
        assertEquals(0L, ReconnectController.fullJitterDelayMs(1, 0.0))
        assertEquals(250L, ReconnectController.fullJitterDelayMs(1, 1.0))
        assertEquals(500L, ReconnectController.fullJitterDelayMs(2, 1.0))
        assertEquals(8_000L, ReconnectController.fullJitterDelayMs(6, 1.0))
        assertEquals(10_000L, ReconnectController.fullJitterDelayMs(7, 1.0))
        assertEquals(10_000L, ReconnectController.fullJitterDelayMs(16, 1.0))
        assertEquals(125L, ReconnectController.fullJitterDelayMs(1, 0.5))
        withController(
            foreground = true,
            machineId = null,
            state = RemoteConnectionState.Failed,
        ) { _, attempts, _, machine, _, _ ->
            assertEquals(0, attempts.get())
            machine.value = "pc-1"
            assertEquals(16, attempts.get())
        }
        withController(
            foreground = true,
            machineId = "pc-1",
            state = RemoteConnectionState.Ready,
        ) { _, attempts, fg, _, state, _ ->
            assertEquals(0, attempts.get())
            fg.value = false
            state.value = RemoteConnectionState.Failed
            assertEquals(0, attempts.get())
        }
    }

    @Test
    fun backgroundAndMachineChangeCancelDelayWithoutDuplicateOrSelfCancel() =
        runBlocking {
            val hold = CompletableDeferred<Unit>()
            val enteredDelay = CompletableDeferred<Unit>()
            withController(
                foreground = true,
                machineId = "pc-1",
                state = RemoteConnectionState.Failed,
                delayMs = {
                    if (!enteredDelay.isCompleted) {
                        enteredDelay.complete(Unit)
                    }
                    hold.await()
                },
            ) { _, attempts, fg, _, _, _ ->
                assertEquals(1, attempts.get())
                withTimeout(1_000) { enteredDelay.await() }
                fg.value = false
                assertEquals(1, attempts.get())
            }
            val holdMachine = CompletableDeferred<Unit>()
            val enteredMachineDelay = CompletableDeferred<Unit>()
            withController(
                foreground = true,
                machineId = "pc-1",
                state = RemoteConnectionState.Failed,
                delayMs = {
                    if (!enteredMachineDelay.isCompleted) {
                        enteredMachineDelay.complete(Unit)
                    }
                    holdMachine.await()
                },
            ) { _, attempts, _, machine, _, _ ->
                assertEquals(1, attempts.get())
                withTimeout(1_000) { enteredMachineDelay.await() }
                machine.value = "pc-2"
                assertEquals(2, attempts.get())
            }
            val finished = AtomicInteger(0)
            val holdAttempt = CompletableDeferred<Unit>()
            withController(
                foreground = true,
                machineId = "pc-1",
                state = RemoteConnectionState.Failed,
                attemptOverride = { connection ->
                    finished.incrementAndGet()
                    connection.value = RemoteConnectionState.Connecting
                    connection.value = RemoteConnectionState.Authenticating
                    holdAttempt.await()
                },
            ) { _, attempts, _, _, state, _ ->
                assertEquals(1, finished.get())
                assertEquals(1, attempts.get())
                state.value = RemoteConnectionState.Failed
                assertEquals(1, attempts.get())
                state.value = RemoteConnectionState.Ready
                holdAttempt.complete(Unit)
            }
            val gate = CompletableDeferred<Unit>()
            withController(
                foreground = true,
                machineId = "pc-1",
                state = RemoteConnectionState.Failed,
                attemptOverride = { gate.await() },
            ) { _, attempts, _, _, state, _ ->
                assertEquals(1, attempts.get())
                state.value = RemoteConnectionState.Disconnected
                state.value = RemoteConnectionState.Failed
                assertEquals(1, attempts.get())
                state.value = RemoteConnectionState.Ready
                gate.complete(Unit)
            }
        }

    private fun withController(
        foreground: Boolean,
        machineId: String?,
        state: RemoteConnectionState,
        delayMs: suspend (Long) -> Unit = {},
        jitter: () -> Double = { 1.0 },
        attemptOverride: (suspend (MutableStateFlow<RemoteConnectionState>) -> Unit)? = null,
        block: suspend (
            ReconnectController,
            AtomicInteger,
            MutableStateFlow<Boolean>,
            MutableStateFlow<String?>,
            MutableStateFlow<RemoteConnectionState>,
            MutableList<Long>,
        ) -> Unit,
    ) {
        val job = SupervisorJob()
        val scope = CoroutineScope(job + Dispatchers.Unconfined)
        val fg = MutableStateFlow(foreground)
        val machine = MutableStateFlow(machineId)
        val connection = MutableStateFlow(state)
        val attempts = AtomicInteger(0)
        val delays = mutableListOf<Long>()
        val controller =
            ReconnectController(
                scope = scope,
                appForeground = fg,
                selectedMachineId = machine,
                connectionState = connection,
                attempt = {
                    attempts.incrementAndGet()
                    if (attemptOverride != null) {
                        attemptOverride(connection)
                    }
                },
                delayMs = {
                    delays += it
                    delayMs(it)
                },
                jitter = jitter,
            )
        try {
            runBlocking { block(controller, attempts, fg, machine, connection, delays) }
        } finally {
            controller.close()
            job.cancel()
        }
    }
}
