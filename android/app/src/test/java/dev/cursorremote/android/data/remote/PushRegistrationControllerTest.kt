package dev.cursorremote.android.data.remote

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PushRegistrationControllerTest {
    @Test
    fun eligibilitySendsOnlyWhenReadyIncludingNullToken() {
        withController(state = RemoteConnectionState.Disconnected) { _, sends, connection, token, fg, _ ->
            assertEquals(0, sends.size)
            connection.value = RemoteConnectionState.Connecting
            connection.value = RemoteConnectionState.Authenticating
            connection.value = RemoteConnectionState.Failed
            assertEquals(0, sends.size)
            connection.value = RemoteConnectionState.Ready
            assertEquals(listOf(null to false), sends.toList())
            token.value = "tok.a"
            assertEquals(null to false, sends[0])
            assertEquals("tok.a" to false, sends[1])
            fg.value = true
            assertEquals("tok.a" to true, sends.last())
            assertEquals(3, sends.size)
        }
    }

    @Test
    fun readyReentryReregistersAndSameAssignmentDoesNot() {
        withController(state = RemoteConnectionState.Ready, token = "tok.a", foreground = true) {
            _,
            sends,
            connection,
            token,
            fg,
            _,
            ->
            assertEquals(1, sends.size)
            token.value = "tok.a"
            fg.value = true
            connection.value = RemoteConnectionState.Ready
            assertEquals(1, sends.size)
            connection.value = RemoteConnectionState.Disconnected
            assertEquals(1, sends.size)
            connection.value = RemoteConnectionState.Ready
            assertEquals(2, sends.size)
            connection.value = RemoteConnectionState.Connecting
            connection.value = RemoteConnectionState.Authenticating
            connection.value = RemoteConnectionState.Ready
            assertEquals(3, sends.size)
            assertTrue(sends.all { it == "tok.a" to true })
        }
    }

    @Test
    fun latestChangeCancelsInFlightAndNeverOverlaps() =
        runBlocking {
            val hold = CompletableDeferred<Unit>()
            val firstStarted = CompletableDeferred<Unit>()
            val inFlight = AtomicInteger(0)
            val maxInFlight = AtomicInteger(0)
            withController(
                state = RemoteConnectionState.Ready,
                token = "tok.a",
                registerOverride = { value, _ ->
                    val current = inFlight.incrementAndGet()
                    maxInFlight.updateAndGet { maxOf(it, current) }
                    try {
                        if (value == "tok.a") {
                            if (!firstStarted.isCompleted) {
                                firstStarted.complete(Unit)
                            }
                            hold.await()
                        }
                    } finally {
                        inFlight.decrementAndGet()
                    }
                },
            ) { _, sends, _, token, _, _ ->
                withTimeout(1_000) { firstStarted.await() }
                token.value = "tok.b"
                hold.complete(Unit)
                withTimeout(1_000) {
                    while (sends.lastOrNull()?.first != "tok.b") {
                        yield()
                    }
                }
                assertEquals(1, maxInFlight.get())
                assertEquals(listOf("tok.b" to false), sends.toList())
            }
        }

    @Test
    fun retryCapDelayAndAttemptResetOnNewState() {
        val delays = mutableListOf<Long>()
        withController(
            state = RemoteConnectionState.Ready,
            registerOverride = { _, _ -> error("isolated") },
            delayMs = { delays += it },
            jitter = { 1.0 },
        ) { _, sends, connection, token, _, attempts ->
            assertEquals(0, sends.size)
            assertEquals(5, attempts.get())
            assertEquals(listOf(500L, 1_000L, 2_000L, 4_000L), delays.toList())
            delays.clear()
            attempts.set(0)
            token.value = "tok.b"
            assertEquals(5, attempts.get())
            assertEquals(4, delays.size)
            delays.clear()
            attempts.set(0)
            connection.value = RemoteConnectionState.Connecting
            connection.value = RemoteConnectionState.Ready
            assertEquals(5, attempts.get())
        }
        assertEquals(0L, PushRegistrationController.fullJitterDelayMs(1, 0.0))
        assertEquals(500L, PushRegistrationController.fullJitterDelayMs(1, 1.0))
        assertEquals(250L, PushRegistrationController.fullJitterDelayMs(1, 0.5))
        assertEquals(1_000L, PushRegistrationController.fullJitterDelayMs(2, 1.0))
        assertEquals(8_000L, PushRegistrationController.fullJitterDelayMs(5, 1.0))
        assertEquals(10_000L, PushRegistrationController.fullJitterDelayMs(6, 1.0))
        assertEquals(10_000L, PushRegistrationController.fullJitterDelayMs(16, 1.0))
    }

    @Test
    fun closeCancelsRetryAndBlocksLaterReady() =
        runBlocking {
            val hold = CompletableDeferred<Unit>()
            val enteredDelay = CompletableDeferred<Unit>()
            withController(
                state = RemoteConnectionState.Ready,
                registerOverride = { _, _ -> error("isolated") },
                delayMs = {
                    if (!enteredDelay.isCompleted) {
                        enteredDelay.complete(Unit)
                    }
                    hold.await()
                },
            ) { controller, _, connection, _, _, attempts ->
                withTimeout(1_000) { enteredDelay.await() }
                assertEquals(1, attempts.get())
                controller.close()
                connection.value = RemoteConnectionState.Disconnected
                connection.value = RemoteConnectionState.Ready
                assertEquals(1, attempts.get())
            }
        }

    private fun withController(
        state: RemoteConnectionState,
        token: String? = null,
        foreground: Boolean = false,
        delayMs: suspend (Long) -> Unit = {},
        jitter: () -> Double = { 1.0 },
        registerOverride: (suspend (String?, Boolean) -> Unit)? = null,
        block: suspend (
            PushRegistrationController,
            MutableList<Pair<String?, Boolean>>,
            MutableStateFlow<RemoteConnectionState>,
            MutableStateFlow<String?>,
            MutableStateFlow<Boolean>,
            AtomicInteger,
        ) -> Unit,
    ) {
        val job = SupervisorJob()
        val scope = CoroutineScope(job + Dispatchers.Unconfined)
        val connection = MutableStateFlow(state)
        val tokenFlow = MutableStateFlow(token)
        val fg = MutableStateFlow(foreground)
        val sends = mutableListOf<Pair<String?, Boolean>>()
        val attempts = AtomicInteger(0)
        val controller =
            PushRegistrationController(
                scope = scope,
                connectionState = connection,
                fcmToken = tokenFlow,
                appForeground = fg,
                register = { value, foregroundValue ->
                    attempts.incrementAndGet()
                    if (registerOverride != null) {
                        registerOverride(value, foregroundValue)
                    }
                    sends += value to foregroundValue
                },
                delayMs = delayMs,
                jitter = jitter,
            )
        try {
            runBlocking { block(controller, sends, connection, tokenFlow, fg, attempts) }
        } finally {
            controller.close()
            job.cancel()
        }
    }
}
