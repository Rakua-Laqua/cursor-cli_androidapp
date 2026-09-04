package dev.cursorremote.android.data.remote

import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

class PushRegistrationController(
    scope: CoroutineScope,
    connectionState: StateFlow<RemoteConnectionState>,
    fcmToken: StateFlow<String?>,
    appForeground: StateFlow<Boolean>,
    private val register: suspend (String?, Boolean) -> Unit,
    private val delayMs: suspend (Long) -> Unit = { delay(it) },
    private val jitter: () -> Double = { Random.nextDouble() },
) {
    private val closed = AtomicBoolean(false)
    private val job: Job =
        scope.launch {
            combine(connectionState, fcmToken, appForeground) { state, token, foreground ->
                Snapshot(state, token, foreground)
            }.distinctUntilChanged()
                .collectLatest { snapshot ->
                    if (closed.get() || snapshot.connection != RemoteConnectionState.Ready) {
                        return@collectLatest
                    }
                    registerWithRetry(snapshot.token, snapshot.foreground)
                }
        }

    fun close() {
        closed.set(true)
        job.cancel()
    }

    private suspend fun registerWithRetry(token: String?, foreground: Boolean) {
        var failures = 0
        while (!closed.get()) {
            try {
                register(token, foreground)
                return
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                failures += 1
                if (failures >= MAX_ATTEMPTS || closed.get()) {
                    return
                }
            }
            delayMs(fullJitterDelayMs(failures, jitter()))
        }
    }

    private data class Snapshot(
        val connection: RemoteConnectionState,
        val token: String?,
        val foreground: Boolean,
    )

    companion object {
        const val MIN_DELAY_MS = 500L
        const val MAX_DELAY_MS = 10_000L
        const val MAX_ATTEMPTS = 5

        fun fullJitterDelayMs(priorFailures: Int, jitterFraction: Double): Long {
            val shift = (priorFailures - 1).coerceAtLeast(0)
            val window =
                min(MAX_DELAY_MS.toDouble(), MIN_DELAY_MS.toDouble() * 2.0.pow(shift.toDouble()))
            return (window * jitterFraction.coerceIn(0.0, 1.0)).toLong()
        }
    }
}
