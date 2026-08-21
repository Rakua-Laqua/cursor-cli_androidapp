package dev.cursorremote.android.data.protocol

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class RemoteProtocolTest {
    private val now = 1_699_000_000_000L
    private val expiresAt = 1_700_000_000_000L

    @Test
    fun pairingQrAcceptsV1OriginAnd32ByteToken() {
        val payload = RemoteProtocol.parsePairingQrPayload(qrJson("ws://127.0.0.1:8787/", token(3)), now)
        assertEquals(1, payload.v)
        assertEquals("ws://127.0.0.1:8787", payload.relayUrl)
        assertEquals("pc-1", payload.machineId)
        assertEquals(token(3), payload.token)
        assertEquals(expiresAt, payload.expiresAt)
    }

    @Test
    fun pairingQrRejectsInvalidPayloads() {
        assertParseError("v must be 1") { qrJson().replace("\"v\":1", "\"v\":2") }
        assertParseError("ws or wss origin") { qrJson("http://127.0.0.1:8787") }
        assertParseError("credentials") { qrJson("ws://user:pass@127.0.0.1:8787") }
        assertParseError("query or fragment|origin") { qrJson("ws://127.0.0.1:8787/client?machineId=pc-1") }
        assertParseError("query or fragment") { qrJson("ws://127.0.0.1:8787/#frag") }
        assertParseError("unexpected or missing fields") { qrJson().replace("}", ",\"extra\":true}") }
        assertParseError("32 bytes") { qrJson(pairingToken = token(3, 31)) }
        assertParseError("base64url") { qrJson(pairingToken = token(3) + "=") }
        assertParseError("expired", expiresAt) { qrJson() }
    }

    @Test
    fun relayOriginAndClientUrlMatchTypeScriptHostRules() {
        assertEquals("ws://[::1]:8787", RemoteProtocol.parseRelayOrigin("ws://[::1]:8787"))
        assertEquals("ws://127.0.0.1", RemoteProtocol.parseRelayOrigin("ws://127.0.0.1:80"))
        assertEquals("wss://example.com", RemoteProtocol.parseRelayOrigin("wss://example.com:443"))
        assertEquals(
            "ws://[::1]/client?machineId=pc-1",
            RemoteProtocol.clientUrl("ws://[::1]:80", "pc-1"),
        )
    }

    @Test
    fun canonicalPairAndAuthProofBytesMatchTypeScriptJsonStringify() {
        val nonce = token(4)
        val pairingToken = token(5)
        val publicKey = P256PublicJwk("EC", "P-256", token(6), token(7))
        val pairJson =
            String(RemoteProtocol.canonicalPairProofBytes("pc-1", nonce, pairingToken, publicKey), StandardCharsets.UTF_8)
        assertEquals(
            """["cursor-remote.pair.v1","pc-1","$nonce","$pairingToken",{"kty":"EC","crv":"P-256","x":"${publicKey.x}","y":"${publicKey.y}"}]""",
            pairJson,
        )
        val canonicalKeyJson = """{"kty":"EC","crv":"P-256","x":"${publicKey.x}","y":"${publicKey.y}"}"""
        val expectedDeviceId =
            RemoteProtocol.encodeBase64Url(
                MessageDigest.getInstance("SHA-256").digest(canonicalKeyJson.toByteArray(StandardCharsets.UTF_8)),
            )
        val deviceId = RemoteProtocol.deviceIdFromPublicKey(publicKey)
        assertEquals(expectedDeviceId, deviceId)
        assertEquals(
            """["cursor-remote.auth.v1","pc-1","$nonce","$deviceId"]""",
            String(RemoteProtocol.canonicalAuthProofBytes("pc-1", nonce, deviceId), StandardCharsets.UTF_8),
        )
    }

    @Test
    fun incomingCodecParsesChallengeResultAndEventAndEncodesPairAuthCommand() {
        val nonce = token(8)
        assertEquals(
            IncomingRemoteFrame.AuthChallenge(nonce),
            RemoteProtocol.parseIncomingFrame("""{"kind":"auth_challenge","nonce":"$nonce"}"""),
        )
        try {
            RemoteProtocol.parseIncomingFrame("""{"kind":"auth_challenge","nonce":"$nonce","extra":1}""")
            fail("expected extra field rejection")
        } catch (error: ProtocolParseError) {
            assertTrue(error.message!!.contains("unexpected or missing fields"))
        }
        val result =
            RemoteProtocol.parseIncomingFrame(
                """{"kind":"result","result":{"requestId":"req-1","ok":true,"value":{"deviceId":"dev-1"},"error":null}}""",
            ) as IncomingRemoteFrame.Result
        assertEquals("dev-1", RemoteProtocol.parseDeviceIdValue(result.result.value))
        val workspaceJson =
            """{"workspaceId":"ws-1","name":"app","path":"/app","gitBranch":"main","modified":false,"activeSessionCount":1,"lastUsedAt":null}"""
        val event =
            RemoteProtocol.parseIncomingFrame(
                """{"kind":"event","event":{"eventId":"evt-1","sessionId":null,"timestamp":"t","type":"workspace.updated","payload":$workspaceJson}}""",
            ) as IncomingRemoteFrame.Event
        assertEquals("ws-1", RemoteProtocol.parseWorkspace(event.event.payload).workspaceId)
        try {
            RemoteProtocol.parseWorkspace(
                kotlinx.serialization.json.Json.parseToJsonElement(
                    """{"workspaceId":"ws-1","name":"app","path":"/app","gitBranch":null,"modified":false,"lastUsedAt":null}""",
                ),
            )
            fail("expected missing field rejection")
        } catch (error: ProtocolParseError) {
            assertTrue(error.message!!.contains("activeSessionCount"))
        }
        assertTrue(
            RemoteProtocol.encodePairFrame(
                "pair-1",
                token(9),
                P256PublicJwk("EC", "P-256", token(6), token(7)),
                byteArrayOf(0x30, 0x05),
            ).contains("\"kind\":\"pair\""),
        )
        assertTrue(RemoteProtocol.encodeAuthProofFrame("auth-1", "dev-1", byteArrayOf(0x30, 0x05)).contains("\"kind\":\"auth_proof\""))
        val command =
            RemoteProtocol.encodeCommandFrame(
                requestId = "cmd-1",
                type = "session.create",
                payload = RemoteProtocol.sessionCreatePayload("ws-1"),
                timestamp = "2026-08-22T00:00:00Z",
            )
        assertTrue(command.contains("\"initialPrompt\":\"\""))
        assertTrue(command.contains("\"title\":null"))
        assertTrue(command.contains("\"sessionId\":null"))
    }

    @Test
    fun sessionPayloadRequiresKnownStatusAndNonEmptyTitle() {
        val valid =
            """{"remoteSessionId":"s1","cursorSessionId":null,"workspaceId":"ws-1","title":"Session","status":"idle","createdAt":"c","updatedAt":"u"}"""
        assertEquals("s1", RemoteProtocol.parseSession(kotlinx.serialization.json.Json.parseToJsonElement(valid)).remoteSessionId)
        try {
            RemoteProtocol.parseSession(kotlinx.serialization.json.Json.parseToJsonElement(valid.replace("idle", "unknown")))
            fail("expected status rejection")
        } catch (error: ProtocolParseError) {
            assertTrue(error.message!!.contains("status"))
        }
    }

    private fun qrJson(
        relayUrl: String = "ws://127.0.0.1:8787",
        pairingToken: String = token(3),
    ): String = """{"v":1,"relayUrl":"$relayUrl","machineId":"pc-1","token":"$pairingToken","expiresAt":$expiresAt}"""

    private fun token(
        fill: Int,
        size: Int = 32,
    ): String = RemoteProtocol.encodeBase64Url(ByteArray(size) { fill.toByte() })

    private fun assertParseError(
        messagePattern: String,
        nowMillis: Long = now,
        json: () -> String,
    ) {
        try {
            RemoteProtocol.parsePairingQrPayload(json(), nowMillis)
            fail("expected ProtocolParseError")
        } catch (error: ProtocolParseError) {
            assertTrue("message=${error.message}", Regex(messagePattern).containsMatchIn(error.message ?: ""))
        }
    }
}
