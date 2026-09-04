package dev.cursorremote.android.data.protocol

import java.math.BigDecimal
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
    fun chatPayloadsAndEventsParseTypedAndRejectMalformed() {
        assertEquals("""{"text":"hello"}""", RemoteProtocol.sessionSendPayload("hello").toString())
        assertEquals("{}", RemoteProtocol.sessionCancelPayload().toString())
        val status =
            RemoteProtocol.parseChatEvent(chatRemoteEvent("session.status_changed", """{"status":"running"}"""))
                as ChatEvent.SessionStatusChanged
        assertEquals("running", status.status)
        val user =
            RemoteProtocol.parseChatEvent(chatRemoteEvent("user.message", """{"text":"hi"}""")) as ChatEvent.UserMessage
        assertEquals("hi", user.text)
        val assistant =
            RemoteProtocol.parseChatEvent(chatRemoteEvent("assistant.message", """{"text":"Hel","delta":true}"""))
                as ChatEvent.AssistantMessage
        assertEquals("Hel", assistant.text)
        assertTrue(assistant.delta)
        val assistantStatus =
            RemoteProtocol.parseChatEvent(chatRemoteEvent("assistant.status", """{"status":"thinking"}"""))
                as ChatEvent.AssistantStatus
        assertEquals("thinking", assistantStatus.status)
        val completed =
            RemoteProtocol.parseChatEvent(chatRemoteEvent("agent.completed", """{"reason":null}"""))
                as ChatEvent.AgentCompleted
        assertNull(completed.reason)
        val failed =
            RemoteProtocol.parseChatEvent(chatRemoteEvent("agent.failed", """{"reason":"boom"}""")) as ChatEvent.AgentFailed
        assertEquals("boom", failed.reason)
        val interrupted =
            RemoteProtocol.parseChatEvent(chatRemoteEvent("agent.interrupted", """{"reason":null}"""))
                as ChatEvent.AgentInterrupted
        assertEquals("sess-1", interrupted.sessionId)
        val waiting =
            RemoteProtocol.parseChatEvent(chatRemoteEvent("agent.waiting", """{"reason":"need input"}"""))
                as ChatEvent.AgentWaiting
        assertEquals("need input", waiting.reason)
        val waitingNull =
            RemoteProtocol.parseChatEvent(chatRemoteEvent("agent.waiting", """{"reason":null}"""))
                as ChatEvent.AgentWaiting
        assertNull(waitingNull.reason)
        val workspaceJson =
            """{"workspaceId":"ws-1","name":"app","path":"/app","gitBranch":"main","modified":false,"activeSessionCount":1,"lastUsedAt":null}"""
        val unrelated =
            RemoteProtocol.parseIncomingFrame(
                """{"kind":"event","event":{"eventId":"evt-1","sessionId":null,"timestamp":"t","type":"workspace.updated","payload":$workspaceJson}}""",
            ) as IncomingRemoteFrame.Event
        assertNull(RemoteProtocol.parseChatEvent(unrelated.event))
        val unknown =
            RemoteProtocol.parseIncomingFrame(
                """{"kind":"event","event":{"eventId":"evt-2","sessionId":"sess-1","timestamp":"t","type":"tool.started","payload":{}}}""",
            ) as IncomingRemoteFrame.Event
        assertNull(RemoteProtocol.parseChatEvent(unknown.event))
        assertChatParseError("sessionId must be a non-empty string") {
            chatRemoteEvent("user.message", """{"text":"hi"}""", sessionId = null)
        }
        assertChatParseError("delta") { chatRemoteEvent("assistant.message", """{"text":"hi"}""") }
        assertChatParseError("text") { chatRemoteEvent("user.message", """{"delta":true}""") }
        assertChatParseError("status") { chatRemoteEvent("session.status_changed", """{"status":"unknown"}""") }
        assertChatParseError("reason") { chatRemoteEvent("agent.completed", """{}""") }
        assertChatParseError("reason") { chatRemoteEvent("agent.waiting", """{}""") }
    }

    @Test
    fun permissionPayloadsParseTypedAndRejectMalformed() {
        assertEquals("""{"permissionId":"perm-1"}""", RemoteProtocol.permissionApprovePayload("perm-1").toString())
        assertEquals("""{"permissionId":"perm-1"}""", RemoteProtocol.permissionRejectPayload("perm-1").toString())
        assertEquals(false, RemoteProtocol.permissionApprovePayload("perm-1").toString().contains("optionId"))
        assertEquals(false, RemoteProtocol.permissionRejectPayload("perm-1").toString().contains("allow"))
        val requested =
            RemoteProtocol.parseChatEvent(
                chatRemoteEvent(
                    "permission.requested",
                    """{"permissionId":"perm-1","kind":"execute","command":"Get-ChildItem -Force","risk":"high"}""",
                ),
            ) as ChatEvent.PermissionRequested
        assertEquals("perm-1", requested.permissionId)
        assertEquals("execute", requested.kind)
        assertEquals("Get-ChildItem -Force", requested.command)
        assertEquals("high", requested.risk)
        val resolved =
            RemoteProtocol.parseChatEvent(
                chatRemoteEvent("permission.resolved", """{"permissionId":"perm-1","decision":"rejected"}"""),
            ) as ChatEvent.PermissionResolved
        assertEquals("perm-1", resolved.permissionId)
        assertEquals("rejected", resolved.decision)
        assertChatParseError("permissionId") {
            chatRemoteEvent("permission.requested", """{"kind":"execute","command":"ls","risk":"high"}""")
        }
        assertChatParseError("decision") {
            chatRemoteEvent("permission.resolved", """{"permissionId":"perm-1","decision":"always"}""")
        }
    }

    @Test
    fun diffSnapshotParsesTypedPayloadsAndRejectsMalformed() {
        assertEquals("""{"workspaceId":"ws-1"}""", RemoteProtocol.diffReadPayload("ws-1").toString())
        val validFile =
            """{"path":"src/foo.ts","previousPath":null,"change":"modified","binary":false,"sensitive":false,"additions":1,"deletions":2,"unifiedDiff":"diff text","truncated":false,"note":"extra"}"""
        val valid =
            """{"workspaceId":"ws-1","available":true,"source":"git","files":[$validFile],"truncated":false,"omittedCount":0,"totalAdditions":1,"totalDeletions":2,"extra":true}"""
        val parsed = RemoteProtocol.parseDiffSnapshot(kotlinx.serialization.json.Json.parseToJsonElement(valid))
        assertEquals("ws-1", parsed.workspaceId)
        assertEquals(true, parsed.available)
        assertEquals("git", parsed.source)
        assertEquals("src/foo.ts", parsed.files.single().path)
        assertEquals(1, parsed.files.single().additions)
        val renamed =
            """{"workspaceId":"ws-1","available":true,"source":"git","files":[{"path":"b.ts","previousPath":"a.ts","change":"renamed","binary":false,"sensitive":true,"additions":0,"deletions":0,"unifiedDiff":null,"truncated":false}],"truncated":true,"omittedCount":3,"totalAdditions":0,"totalDeletions":0}"""
        val renamedParsed = RemoteProtocol.parseDiffSnapshot(kotlinx.serialization.json.Json.parseToJsonElement(renamed))
        assertEquals("a.ts", renamedParsed.files.single().previousPath)
        assertEquals("renamed", renamedParsed.files.single().change)
        assertEquals(3, renamedParsed.omittedCount)
        val none =
            """{"workspaceId":"ws-1","available":false,"source":"none","files":[],"truncated":false,"omittedCount":0,"totalAdditions":0,"totalDeletions":0}"""
        assertEquals("none", RemoteProtocol.parseDiffSnapshot(kotlinx.serialization.json.Json.parseToJsonElement(none)).source)
        val event =
            RemoteProtocol.parseIncomingFrame(
                """{"kind":"event","event":{"eventId":"evt-d","sessionId":null,"timestamp":"t","type":"diff.updated","payload":$none}}""",
            ) as IncomingRemoteFrame.Event
        assertEquals("diff.updated", event.event.type)
        assertEquals("ws-1", RemoteProtocol.parseDiffSnapshot(event.event.payload).workspaceId)
        assertDiffParseError("source") {
            valid.replace("\"git\"", "\"acp\"")
        }
        assertDiffParseError("change") {
            valid.replace("\"modified\"", "\"copied\"")
        }
        assertDiffParseError("additions") {
            valid.replace("\"additions\":1", "\"additions\":-1")
        }
        assertDiffParseError("deletions") {
            valid.replace("\"deletions\":2", "\"deletions\":1.5")
        }
        assertDiffParseError("unifiedDiff") {
            valid.replace("\"unifiedDiff\":\"diff text\"", "\"unifiedDiff\":true")
        }
        assertDiffParseError("files") {
            """{"workspaceId":"ws-1","available":true,"source":"git","truncated":false,"omittedCount":0,"totalAdditions":0,"totalDeletions":0}"""
        }
        assertDiffParseError("previousPath") {
            """{"workspaceId":"ws-1","available":true,"source":"git","files":[{"path":"a.ts","previousPath":"old.ts","change":"modified","binary":false,"sensitive":false,"additions":0,"deletions":0,"unifiedDiff":null,"truncated":false}],"truncated":false,"omittedCount":0,"totalAdditions":0,"totalDeletions":0}"""
        }
        assertDiffParseError("previousPath") {
            """{"workspaceId":"ws-1","available":true,"source":"git","files":[{"path":"a.ts","previousPath":null,"change":"renamed","binary":false,"sensitive":false,"additions":0,"deletions":0,"unifiedDiff":null,"truncated":false}],"truncated":false,"omittedCount":0,"totalAdditions":0,"totalDeletions":0}"""
        }
    }

    @Test
    fun fileReadPayloadAndContentParseTypedAndRejectMalformed() {
        assertEquals("""{"path":"src/foo.ts"}""", RemoteProtocol.fileReadPayload("src/foo.ts").toString())
        assertEquals(false, RemoteProtocol.fileReadPayload("src/foo.ts").toString().contains("workspaceId"))
        assertEquals(false, RemoteProtocol.fileReadPayload("src/foo.ts").toString().contains("startLine"))
        val valid = """{"path":"src/foo.ts","content":"export const n = 1;\n","truncated":false,"extra":true}"""
        val parsed = RemoteProtocol.parseFileContent(kotlinx.serialization.json.Json.parseToJsonElement(valid))
        assertEquals("src/foo.ts", parsed.path)
        assertEquals("export const n = 1;\n", parsed.content)
        assertEquals(false, parsed.truncated)
        val empty = RemoteProtocol.parseFileContent(kotlinx.serialization.json.Json.parseToJsonElement("""{"path":"a.ts","content":"","truncated":true}"""))
        assertEquals("", empty.content)
        assertEquals(true, empty.truncated)
        assertFileContentParseError("path") {
            """{"path":"","content":"x","truncated":false}"""
        }
        assertFileContentParseError("content") {
            """{"path":"a.ts","truncated":false}"""
        }
        assertFileContentParseError("truncated") {
            """{"path":"a.ts","content":"x","truncated":"yes"}"""
        }
    }

    private fun assertDiffParseError(
        messagePattern: String,
        json: () -> String,
    ) {
        try {
            RemoteProtocol.parseDiffSnapshot(kotlinx.serialization.json.Json.parseToJsonElement(json()))
            fail("expected ProtocolParseError")
        } catch (error: ProtocolParseError) {
            assertTrue("message=${error.message}", Regex(messagePattern).containsMatchIn(error.message ?: ""))
        }
    }

    private fun assertFileContentParseError(
        messagePattern: String,
        json: () -> String,
    ) {
        try {
            RemoteProtocol.parseFileContent(kotlinx.serialization.json.Json.parseToJsonElement(json()))
            fail("expected ProtocolParseError")
        } catch (error: ProtocolParseError) {
            assertTrue("message=${error.message}", Regex(messagePattern).containsMatchIn(error.message ?: ""))
        }
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

    @Test
    fun modelCatalogAndSelectionPayloadsParseFixtureWithoutProductionIds() {
        assertEquals("{}", RemoteProtocol.modelListPayload().toString())
        assertEquals("""{"modelId":"fixture-added-model"}""", RemoteProtocol.modelSelectPayload("fixture-added-model").toString())
        val catalogJson =
            """{"models":[{"id":"mock-model","displayName":"Mock","description":null,"parameters":[],"variants":[],"available":true},{"id":"fixture-added-model","displayName":"fixture-added-model","description":"Fixture only","parameters":[{"id":"p1"}],"variants":["v1"],"available":true},{"id":"unavailable-mock","displayName":"Unavailable Mock","description":null,"parameters":[],"variants":[],"available":false}],"currentModelId":"mock-model"}"""
        val catalog = RemoteProtocol.parseModelCatalog(kotlinx.serialization.json.Json.parseToJsonElement(catalogJson))
        assertEquals(listOf("mock-model", "fixture-added-model", "unavailable-mock"), catalog.models.map { it.id })
        assertEquals("Mock", catalog.models.first().displayName)
        assertEquals("fixture-added-model", catalog.models[1].displayName)
        assertEquals("Fixture only", catalog.models[1].description)
        assertEquals(false, catalog.models[2].available)
        assertEquals("mock-model", catalog.currentModelId)
        assertEquals(false, catalog.models.any { it.id.contains("gpt") || it.displayName.contains("GPT") })
        val extraJson =
            """{"models":[{"id":"fixture-extra-model","displayName":"Fixture Extra","description":null,"parameters":[],"variants":[],"available":true}],"currentModelId":"fixture-extra-model"}"""
        val extra = RemoteProtocol.parseModelCatalog(kotlinx.serialization.json.Json.parseToJsonElement(extraJson))
        assertEquals(listOf("fixture-extra-model"), extra.models.map { it.id })
        val frame =
            RemoteProtocol.parseIncomingFrame(
                """{"kind":"event","event":{"eventId":"e-model","sessionId":"sess-1","timestamp":"t","type":"model.catalog_updated","payload":$catalogJson}}""",
            ) as IncomingRemoteFrame.Event
        assertEquals("model.catalog_updated", frame.event.type)
        assertEquals("sess-1", frame.event.sessionId)
        val selection =
            RemoteProtocol.parseModelSelectionChanged(
                kotlinx.serialization.json.Json.parseToJsonElement("""{"modelId":"fixture-added-model","confirmed":true}"""),
            )
        assertEquals("fixture-added-model", selection.modelId)
        assertEquals(true, selection.confirmed)
        try {
            RemoteProtocol.parseModelCatalog(kotlinx.serialization.json.Json.parseToJsonElement("""{"models":[{"id":"","displayName":"x","description":null,"parameters":[],"variants":[],"available":true}],"currentModelId":null}"""))
            fail("expected ProtocolParseError")
        } catch (error: ProtocolParseError) {
            assertTrue(error.message!!.contains("id"))
        }
    }

    @Test
    fun sessionContextUsageParsesBoundsAndRejectsMalformedWithoutExactKeys() {
        val extra = RemoteProtocol.parseSessionContextUsage(
            kotlinx.serialization.json.Json.parseToJsonElement("""{"used":12,"size":100,"cost":1.5,"nested":{"tokens":1}}"""),
        )
        assertEquals(12L, extra.used)
        assertEquals(100L, extra.size)
        val zero = RemoteProtocol.parseSessionContextUsage(
            kotlinx.serialization.json.Json.parseToJsonElement("""{"used":0,"size":0}"""),
        )
        assertEquals(0L, zero.used)
        assertEquals(0L, zero.size)
        val max = RemoteProtocol.parseSessionContextUsage(
            kotlinx.serialization.json.Json.parseToJsonElement("""{"used":9007199254740991,"size":9007199254740991}"""),
        )
        assertEquals(RemoteProtocol.JS_MAX_SAFE_INTEGER, max.used)
        assertEquals(RemoteProtocol.JS_MAX_SAFE_INTEGER, max.size)
        val frame =
            RemoteProtocol.parseIncomingFrame(
                """{"kind":"event","event":{"eventId":"e-context","sessionId":"sess-1","timestamp":"t","type":"session.context_updated","payload":{"used":1,"size":2}}}""",
            ) as IncomingRemoteFrame.Event
        assertEquals("session.context_updated", frame.event.type)
        assertEquals(1L, RemoteProtocol.parseSessionContextUsage(frame.event.payload).used)
        assertSessionContextParseError("used") { """{"size":1}""" }
        assertSessionContextParseError("size") { """{"used":1}""" }
        assertSessionContextParseError("used") { """{"used":"1","size":1}""" }
        assertSessionContextParseError("size") { """{"used":1,"size":"1"}""" }
        assertSessionContextParseError("used") { """{"used":1.5,"size":1}""" }
        assertSessionContextParseError("size") { """{"used":1,"size":1.5}""" }
        assertSessionContextParseError("used") { """{"used":1e2,"size":1}""" }
        assertSessionContextParseError("size") { """{"used":1,"size":1e2}""" }
        assertSessionContextParseError("used") { """{"used":-1,"size":1}""" }
        assertSessionContextParseError("size") { """{"used":1,"size":-1}""" }
        assertSessionContextParseError("used") { """{"used":9007199254740992,"size":1}""" }
        assertSessionContextParseError("size") { """{"used":1,"size":9007199254740992}""" }
        try {
            RemoteProtocol.parseIncomingFrame(
                """{"kind":"event","event":{"eventId":"e-bad","sessionId":"sess-1","timestamp":"t","type":"session.context_updated","payload":{"used":"1","size":2}}}""",
            )
            fail("expected ProtocolParseError")
        } catch (error: ProtocolParseError) {
            assertTrue(error.message!!.contains("used"))
        }
    }

    @Test
    fun sessionContextBreakdownParsesAndRejectsMalformed() {
        val parsed =
            RemoteProtocol.parseSessionContextBreakdown(
                kotlinx.serialization.json.Json.parseToJsonElement(
                    """{"categories":[{"id":"system_prompt","displayName":"System prompt","tokens":5000},{"id":"unknown_cat","displayName":"Unknown","tokens":12}]}""",
                ),
            )
        assertEquals(2, parsed.size)
        assertEquals("system_prompt", parsed[0].id)
        assertEquals("System prompt", parsed[0].displayName)
        assertEquals(5000L, parsed[0].tokens)
        assertEquals("unknown_cat", parsed[1].id)
        assertEquals("Unknown", parsed[1].displayName)
        assertEquals(12L, parsed[1].tokens)
        val zero =
            RemoteProtocol.parseSessionContextBreakdown(
                kotlinx.serialization.json.Json.parseToJsonElement(
                    """{"categories":[{"id":"tools","displayName":"Tools","tokens":0}]}""",
                ),
            )
        assertEquals(0L, zero[0].tokens)
        val max =
            RemoteProtocol.parseSessionContextBreakdown(
                kotlinx.serialization.json.Json.parseToJsonElement(
                    """{"categories":[{"id":"tools","displayName":"Tools","tokens":9007199254740991}]}""",
                ),
            )
        assertEquals(RemoteProtocol.JS_MAX_SAFE_INTEGER, max[0].tokens)
        val frame =
            RemoteProtocol.parseIncomingFrame(
                """{"kind":"event","event":{"eventId":"e-breakdown","sessionId":"sess-1","timestamp":"t","type":"session.context_breakdown_updated","payload":{"categories":[{"id":"mcp","displayName":"MCP","tokens":7}]}}}""",
            ) as IncomingRemoteFrame.Event
        assertEquals("session.context_breakdown_updated", frame.event.type)
        assertEquals("sess-1", frame.event.sessionId)
        val fromFrame = RemoteProtocol.parseSessionContextBreakdown(frame.event.payload)
        assertEquals("mcp", fromFrame[0].id)
        assertEquals("MCP", fromFrame[0].displayName)
        assertEquals(7L, fromFrame[0].tokens)
        assertSessionContextBreakdownParseError("id") {
            """{"categories":[{"id":"","displayName":"System prompt","tokens":1}]}"""
        }
        assertSessionContextBreakdownParseError("tokens") {
            """{"categories":[{"id":"tools","displayName":"Tools","tokens":-1}]}"""
        }
        assertSessionContextBreakdownParseError("tokens") {
            """{"categories":[{"id":"tools","displayName":"Tools","tokens":1.5}]}"""
        }
        assertSessionContextBreakdownParseError("categories") { """{"used":1}""" }
        try {
            RemoteProtocol.parseIncomingFrame(
                """{"kind":"event","event":{"eventId":"e-bad-breakdown","sessionId":"sess-1","timestamp":"t","type":"session.context_breakdown_updated","payload":{"categories":[{"id":"","displayName":"x","tokens":1}]}}}""",
            )
            fail("expected ProtocolParseError")
        } catch (error: ProtocolParseError) {
            assertTrue(error.message!!.contains("id"))
        }
    }

    @Test
    fun sessionUsageParsesNestedCostAndRejectsMalformed() {
        val parsed =
            RemoteProtocol.parseSessionUsage(
                kotlinx.serialization.json.Json.parseToJsonElement(
                    """{"cost":{"amount":0.045,"currency":"USD"}}""",
                ),
            )
        assertEquals(BigDecimal("0.045"), parsed.cost.amount)
        assertEquals("0.045", parsed.cost.amount.toPlainString())
        assertEquals("USD", parsed.cost.currency)
        val precise =
            RemoteProtocol.parseSessionUsage(
                kotlinx.serialization.json.Json.parseToJsonElement(
                    """{"cost":{"amount":0.123456789012345678,"currency":"USD"}}""",
                ),
            )
        assertEquals("0.123456789012345678", precise.cost.amount.toPlainString())
        val zero =
            RemoteProtocol.parseSessionUsage(
                kotlinx.serialization.json.Json.parseToJsonElement("""{"cost":{"amount":0,"currency":"USD"}}"""),
            )
        assertEquals(BigDecimal("0"), zero.cost.amount)
        val scientific =
            RemoteProtocol.parseSessionUsage(
                kotlinx.serialization.json.Json.parseToJsonElement("""{"cost":{"amount":1e-2,"currency":"USD"}}"""),
            )
        assertEquals(BigDecimal("0.01"), scientific.cost.amount)
        val scientificUpper =
            RemoteProtocol.parseSessionUsage(
                kotlinx.serialization.json.Json.parseToJsonElement("""{"cost":{"amount":1E-2,"currency":"USD"}}"""),
            )
        assertEquals(BigDecimal("0.01"), scientificUpper.cost.amount)
        val negativeZero =
            RemoteProtocol.parseSessionUsage(
                kotlinx.serialization.json.Json.parseToJsonElement("""{"cost":{"amount":-0,"currency":"USD"}}"""),
            )
        assertEquals(BigDecimal("0"), negativeZero.cost.amount)
        val frame =
            RemoteProtocol.parseIncomingFrame(
                """{"kind":"event","event":{"eventId":"e-usage","sessionId":"sess-1","timestamp":"t","type":"session.usage_updated","payload":{"cost":{"amount":1,"currency":"USD"}}}}""",
            ) as IncomingRemoteFrame.Event
        assertEquals("session.usage_updated", frame.event.type)
        assertEquals(BigDecimal("1"), RemoteProtocol.parseSessionUsage(frame.event.payload).cost.amount)
        try {
            RemoteProtocol.parseSessionUsage(
                kotlinx.serialization.json.Json.parseToJsonElement("""{"cost":{"amount":-1,"currency":"USD"}}"""),
            )
            fail("expected ProtocolParseError")
        } catch (error: ProtocolParseError) {
            assertTrue(error.message!!.contains("amount"))
        }
        try {
            RemoteProtocol.parseSessionUsage(
                kotlinx.serialization.json.Json.parseToJsonElement("""{"cost":{"amount":1,"currency":"usd"}}"""),
            )
            fail("expected ProtocolParseError")
        } catch (error: ProtocolParseError) {
            assertTrue(error.message!!.contains("currency"))
        }
        try {
            RemoteProtocol.parseSessionUsage(
                kotlinx.serialization.json.Json.parseToJsonElement("""{"cost":{"amount":1,"currency":"US"}}"""),
            )
            fail("expected ProtocolParseError")
        } catch (error: ProtocolParseError) {
            assertTrue(error.message!!.contains("currency"))
        }
        try {
            RemoteProtocol.parseIncomingFrame(
                """{"kind":"event","event":{"eventId":"e-bad-usage","sessionId":"sess-1","timestamp":"t","type":"session.usage_updated","payload":{"amount":1,"currency":"USD"}}}""",
            )
            fail("expected ProtocolParseError")
        } catch (error: ProtocolParseError) {
            assertTrue(error.message!!.contains("cost"))
        }
        try {
            RemoteProtocol.parseIncomingFrame(
                """{"kind":"event","event":{"eventId":"e-bad-amount","sessionId":"sess-1","timestamp":"t","type":"session.usage_updated","payload":{"cost":{"amount":"1","currency":"USD"}}}}""",
            )
            fail("expected ProtocolParseError")
        } catch (error: ProtocolParseError) {
            assertTrue(error.message!!.contains("amount"))
        }
    }

    @Test
    fun syncCatchUpPayloadAndResultParseDefensively() {
        assertEquals("""{"lastEventId":null}""", RemoteProtocol.syncCatchUpPayload(null).toString())
        assertEquals("""{"lastEventId":"evt-1"}""", RemoteProtocol.syncCatchUpPayload("evt-1").toString())
        val frame =
            RemoteProtocol.encodeCommandFrame(
                requestId = "req-sync",
                type = "sync.catch_up",
                payload = RemoteProtocol.syncCatchUpPayload("evt-1"),
                timestamp = "2026-09-04T00:00:00Z",
                sessionId = "sess-1",
            )
        assertTrue(frame.contains("\"type\":\"sync.catch_up\""))
        assertTrue(frame.contains("\"lastEventId\":\"evt-1\""))
        assertTrue(frame.contains("\"sessionId\":\"sess-1\""))
        val parsed =
            RemoteProtocol.parseSyncCatchUpResult(
                kotlinx.serialization.json.Json.parseToJsonElement(
                    """{"status":"replayed","events":[{"eventId":"evt-2","sessionId":"sess-1","timestamp":"t","type":"assistant.message","payload":{"text":"hi","delta":true}}],"headEventId":"evt-2","pendingPermission":{"permissionId":"perm-1","kind":"execute","command":"ls","risk":"high"}}""",
                ),
            )
        assertEquals("replayed", parsed.status)
        assertEquals("evt-2", parsed.events.single().eventId)
        assertEquals("evt-2", parsed.headEventId)
        assertEquals("perm-1", parsed.pendingPermission?.permissionId)
        val gap =
            RemoteProtocol.parseSyncCatchUpResult(
                kotlinx.serialization.json.Json.parseToJsonElement(
                    """{"status":"gap","events":[],"headEventId":null,"pendingPermission":null}""",
                ),
            )
        assertEquals("gap", gap.status)
        assertTrue(gap.events.isEmpty())
        assertNull(gap.headEventId)
        assertNull(gap.pendingPermission)
        try {
            RemoteProtocol.parseSyncCatchUpResult(
                kotlinx.serialization.json.Json.parseToJsonElement(
                    """{"status":"gap","events":[{"eventId":"evt-2","sessionId":"sess-1","timestamp":"t","type":"assistant.message","payload":{"text":"hi","delta":true}}],"headEventId":"evt-2","pendingPermission":null}""",
                ),
            )
            fail("expected ProtocolParseError")
        } catch (error: ProtocolParseError) {
            assertTrue(error.message!!.contains("empty events"))
        }
        try {
            RemoteProtocol.parseSyncCatchUpResult(
                kotlinx.serialization.json.Json.parseToJsonElement(
                    """{"status":"other","events":[],"headEventId":null,"pendingPermission":null}""",
                ),
            )
            fail("expected ProtocolParseError")
        } catch (error: ProtocolParseError) {
            assertTrue(error.message!!.contains("status"))
        }
        try {
            RemoteProtocol.parseSyncCatchUpResult(
                kotlinx.serialization.json.Json.parseToJsonElement(
                    """{"status":"replayed","events":[],"headEventId":null,"pendingPermission":{"permissionId":"p","kind":"k","command":"c","risk":"low"}}""",
                ),
            )
            fail("expected ProtocolParseError")
        } catch (error: ProtocolParseError) {
            assertTrue(error.message!!.contains("risk"))
        }
    }

    @Test
    fun transportRegisterFrameAndResultAreStrict() {
        assertEquals(
            """{"kind":"transport_register","requestId":"reg-1","fcmToken":"d1.tok-APA91b:x","appForeground":false}""",
            RemoteProtocol.encodeTransportRegisterFrame("reg-1", "d1.tok-APA91b:x", false),
        )
        assertEquals(
            """{"kind":"transport_register","requestId":"reg-1","fcmToken":null,"appForeground":true}""",
            RemoteProtocol.encodeTransportRegisterFrame("reg-1", null, true),
        )
        val max =
            RemoteProtocol.encodeTransportRegisterFrame("r".repeat(128), "A.za9_-:".padEnd(4096, 'a'), false)
        assertTrue(max.toByteArray(StandardCharsets.UTF_8).size <= 8192)
        assertEncodeError("non-empty") { RemoteProtocol.encodeTransportRegisterFrame("", "tok", true) }
        assertEncodeError("128") { RemoteProtocol.encodeTransportRegisterFrame("r".repeat(129), "tok", true) }
        assertEncodeError("non-empty string or null") { RemoteProtocol.encodeTransportRegisterFrame("reg-1", "", true) }
        assertEncodeError("4096") { RemoteProtocol.encodeTransportRegisterFrame("reg-1", "a".repeat(4097), true) }
        assertEncodeError("invalid characters") { RemoteProtocol.encodeTransportRegisterFrame("reg-1", "tok/slash", true) }
        RemoteProtocol.parseTransportRegistrationResult(
            kotlinx.serialization.json.Json.parseToJsonElement("""{"registered":true}"""),
        )
        assertResultError("registered") { kotlinx.serialization.json.Json.parseToJsonElement("""{"registered":false}""") }
        assertResultError("unexpected") {
            kotlinx.serialization.json.Json.parseToJsonElement("""{"registered":true,"extra":1}""")
        }
        assertResultError("JSON object") { kotlinx.serialization.json.Json.parseToJsonElement("true") }
        assertResultError("JSON object") { null }
    }

    private fun assertEncodeError(
        messagePattern: String,
        block: () -> Unit,
    ) {
        try {
            block()
            fail("expected ProtocolParseError")
        } catch (error: ProtocolParseError) {
            assertTrue("message=${error.message}", Regex(messagePattern).containsMatchIn(error.message ?: ""))
        }
    }

    private fun assertResultError(
        messagePattern: String,
        value: () -> kotlinx.serialization.json.JsonElement?,
    ) {
        try {
            RemoteProtocol.parseTransportRegistrationResult(value())
            fail("expected ProtocolParseError")
        } catch (error: ProtocolParseError) {
            assertTrue("message=${error.message}", Regex(messagePattern).containsMatchIn(error.message ?: ""))
        }
    }

    private fun chatRemoteEvent(
        type: String,
        payload: String,
        sessionId: String? = "sess-1",
    ): RemoteEvent {
        val sessionJson = if (sessionId == null) "null" else "\"$sessionId\""
        val frame =
            RemoteProtocol.parseIncomingFrame(
                """{"kind":"event","event":{"eventId":"e1","sessionId":$sessionJson,"timestamp":"t","type":"$type","payload":$payload}}""",
            ) as IncomingRemoteFrame.Event
        return frame.event
    }

    private fun assertSessionContextParseError(
        messagePattern: String,
        json: () -> String,
    ) {
        try {
            RemoteProtocol.parseSessionContextUsage(kotlinx.serialization.json.Json.parseToJsonElement(json()))
            fail("expected ProtocolParseError")
        } catch (error: ProtocolParseError) {
            assertTrue("message=${error.message}", Regex(messagePattern).containsMatchIn(error.message ?: ""))
        }
    }

    private fun assertSessionContextBreakdownParseError(
        messagePattern: String,
        json: () -> String,
    ) {
        try {
            RemoteProtocol.parseSessionContextBreakdown(kotlinx.serialization.json.Json.parseToJsonElement(json()))
            fail("expected ProtocolParseError")
        } catch (error: ProtocolParseError) {
            assertTrue("message=${error.message}", Regex(messagePattern).containsMatchIn(error.message ?: ""))
        }
    }

    private fun assertChatParseError(
        messagePattern: String,
        block: () -> Unit,
    ) {
        try {
            block()
            fail("expected ProtocolParseError")
        } catch (error: ProtocolParseError) {
            assertTrue("message=${error.message}", Regex(messagePattern).containsMatchIn(error.message ?: ""))
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
