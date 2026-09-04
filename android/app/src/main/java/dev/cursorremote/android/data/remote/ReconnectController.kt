package dev.cursorremote.android.data.remote

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.coroutineContext
import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class ReconnectController(
    private val scope: CoroutineScope,
    private val appForeground: StateFlow<Boolean>,
    private val selectedMachineId: StateFlow<String?>,
    private val connectionState: StateFlow<RemoteConnectionState>,
    private val attempt: suspend () -> Unit,
    private val delayMs: suspend (Long) -> Unit = { delay(it) },
    private val jitter: () -> Double = { Random.nextDouble() },
) {
    private val lock = Any()
    private val closed = AtomicBoolean(false)
    private val inAttempt = AtomicBoolean(false)
    private val attemptCount = AtomicInteger(0)
    private val retryJob = AtomicReference<Job?>(null)
    private val lastMachine = AtomicReference<String?>(null)
    private val machineInitialized = AtomicBoolean(false)
    private val collectJobs = ArrayList<Job>(3)

    init {
        collectJobs += scope.launch { appForeground.collect { onForeground(it) } }
        collectJobs += scope.launch { selectedMachineId.collect { onSelectedMachine(it) } }
        collectJobs +=
            scope.launch {
                connectionState.collect { state ->
                    if (state == RemoteConnectionState.Ready) {
                        attemptCount.set(0)
                    }
                    schedule()
                }
            }
    }

    fun close() {
        closed.set(true)
        collectJobs.forEach { it.cancel() }
        collectJobs.clear()
        cancelRetryIfIdle()
    }

    private fun onForeground(foreground: Boolean) {
        if (!foreground) {
            attemptCount.set(0)
        }
        schedule()
    }

    private fun onSelectedMachine(id: String?) {
        val normalized = id?.takeIf { it.isNotBlank() }
        val previous = lastMachine.getAndSet(normalized)
        if (machineInitialized.getAndSet(true) && previous != normalized) {
            attemptCount.set(0)
            cancelRetryIfIdle()
        }
        schedule()
    }

    private fun schedule() {
        if (closed.get()) {
            return
        }
        var jobToStart: Job? = null
        synchronized(lock) {
            if (closed.get()) {
                return
            }
            if (!eligible()) {
                if (!inAttempt.get()) {
                    retryJob.get()?.cancel()
                    retryJob.set(null)
                }
                return
            }
            val current = retryJob.get()
            if (current != null && current.isActive) {
                return
            }
            val job =
                scope.launch(start = CoroutineStart.LAZY) {
                    try {
                        runLoop()
                    } finally {
                        retryJob.compareAndSet(coroutineContext[Job], null)
                    }
                }
            retryJob.set(job)
            jobToStart = job
        }
        jobToStart?.start()
    }

    private suspend fun runLoop() {
        while (!closed.get()) {
            if (!eligible()) {
                return
            }
            val prior = attemptCount.get()
            if (prior >= MAX_ATTEMPTS) {
                return
            }
            if (prior > 0) {
                delayMs(fullJitterDelayMs(prior, jitter()))
                if (!eligible() || closed.get()) {
                    return
                }
            }
            if (attemptCount.incrementAndGet() > MAX_ATTEMPTS) {
                return
            }
            inAttempt.set(true)
            try {
                attempt()
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
            } finally {
                inAttempt.set(false)
            }
        }
    }

    private fun cancelRetryIfIdle() {
        synchronized(lock) {
            if (!inAttempt.get()) {
                retryJob.get()?.cancel()
                retryJob.set(null)
            }
        }
    }

    private fun eligible(): Boolean {
        if (closed.get() || !appForeground.value) {
            return false
        }
        if (selectedMachineId.value.isNullOrBlank()) {
            return false
        }
        val state = connectionState.value
        return state == RemoteConnectionState.Failed || state == RemoteConnectionState.Disconnected
    }

    companion object {
        const val MIN_DELAY_MS = 250L
        const val MAX_DELAY_MS = 10_000L
        const val MAX_ATTEMPTS = 16

        fun fullJitterDelayMs(priorAttempts: Int, jitterFraction: Double): Long {
            val shift = (priorAttempts - 1).coerceAtLeast(0)
            val window =
                min(MAX_DELAY_MS.toDouble(), MIN_DELAY_MS.toDouble() * 2.0.pow(shift.toDouble()))
            return (window * jitterFraction.coerceIn(0.0, 1.0)).toLong()
        }
    }
}
