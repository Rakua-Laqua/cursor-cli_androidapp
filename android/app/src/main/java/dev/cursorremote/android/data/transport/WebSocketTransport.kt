package dev.cursorremote.android.data.transport

import java.net.URI
import java.util.Locale
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

enum class ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Failed,
}

interface WebSocketTransport {
    val connectionState: StateFlow<ConnectionState>
    val incomingText: Flow<String>

    fun connect(url: String)

    fun send(text: String)

    fun disconnect()
}

class OkHttpWebSocketTransport(
    private val client: OkHttpClient = OkHttpClient(),
) : WebSocketTransport {
    private val lock = Any()
    private var webSocket: WebSocket? = null

    private val _connectionState = MutableStateFlow(ConnectionState.Disconnected)
    override val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _incomingText = MutableSharedFlow<String>(extraBufferCapacity = 64)
    override val incomingText: Flow<String> = _incomingText.asSharedFlow()

    private val listener =
        object : WebSocketListener() {
            override fun onOpen(
                webSocket: WebSocket,
                response: Response,
            ) {
                synchronized(lock) {
                    if (this@OkHttpWebSocketTransport.webSocket !== webSocket) {
                        return
                    }
                    _connectionState.value = ConnectionState.Connected
                }
            }

            override fun onMessage(
                webSocket: WebSocket,
                text: String,
            ) {
                synchronized(lock) {
                    if (this@OkHttpWebSocketTransport.webSocket !== webSocket) {
                        return
                    }
                    _incomingText.tryEmit(text)
                }
            }

            override fun onClosing(
                webSocket: WebSocket,
                code: Int,
                reason: String,
            ) {
                synchronized(lock) {
                    if (this@OkHttpWebSocketTransport.webSocket !== webSocket) {
                        return
                    }
                    webSocket.close(code, reason)
                }
            }

            override fun onClosed(
                webSocket: WebSocket,
                code: Int,
                reason: String,
            ) {
                synchronized(lock) {
                    if (this@OkHttpWebSocketTransport.webSocket !== webSocket) {
                        return
                    }
                    this@OkHttpWebSocketTransport.webSocket = null
                    _connectionState.value = ConnectionState.Disconnected
                }
            }

            override fun onFailure(
                webSocket: WebSocket,
                t: Throwable,
                response: Response?,
            ) {
                synchronized(lock) {
                    if (this@OkHttpWebSocketTransport.webSocket !== webSocket) {
                        return
                    }
                    this@OkHttpWebSocketTransport.webSocket = null
                    _connectionState.value = ConnectionState.Failed
                }
            }
        }

    override fun connect(url: String) {
        val webSocketUrl = requireWebSocketUrl(url)
        val request = Request.Builder().url(webSocketUrl).build()
        synchronized(lock) {
            val previous = webSocket
            webSocket = null
            previous?.cancel()
            _connectionState.value = ConnectionState.Connecting
            webSocket = client.newWebSocket(request, listener)
        }
    }

    override fun send(text: String) {
        val socket =
            synchronized(lock) { webSocket }
                ?: error("WebSocket is not connected")
        check(socket.send(text)) { "WebSocket send failed" }
    }

    override fun disconnect() {
        synchronized(lock) {
            val previous = webSocket
            webSocket = null
            _connectionState.value = ConnectionState.Disconnected
            previous?.cancel()
        }
    }

    private fun requireWebSocketUrl(url: String): String {
        val uri =
            try {
                URI(url)
            } catch (error: Exception) {
                throw IllegalArgumentException("Invalid WebSocket URL", error)
            }
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        if (scheme != "ws" && scheme != "wss") {
            throw IllegalArgumentException("URL must use ws or wss")
        }
        if (uri.host.isNullOrBlank()) {
            throw IllegalArgumentException("URL must include a host")
        }
        return url
    }
}
