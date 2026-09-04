package dev.cursorremote.android

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import dev.cursorremote.android.data.local.HiddenModelDao
import dev.cursorremote.android.data.local.HiddenModelEntity
import dev.cursorremote.android.data.local.MachineDao
import dev.cursorremote.android.data.local.MachineEntity
import dev.cursorremote.android.data.local.NavigationSelection
import dev.cursorremote.android.data.local.ReliabilityStore
import dev.cursorremote.android.data.local.VolatileReliabilityStore
import dev.cursorremote.android.data.protocol.RemoteProtocol
import dev.cursorremote.android.data.remote.RemoteConnectionState
import dev.cursorremote.android.data.remote.RemoteRepository
import dev.cursorremote.android.data.security.DeviceCredentialStore
import dev.cursorremote.android.data.transport.ConnectionState
import dev.cursorremote.android.data.transport.TransportMessage
import dev.cursorremote.android.data.transport.TransportMessageQueue
import dev.cursorremote.android.data.transport.WebSocketTransport
import dev.cursorremote.android.di.NOTIFICATION_TARGET_EVENT_ID_LIMIT
import dev.cursorremote.android.di.NotificationTargetMailbox
import dev.cursorremote.android.notify.NotificationTarget
import dev.cursorremote.android.state.CursorRemoteViewModel
import dev.cursorremote.android.ui.AppDestination
import java.math.BigDecimal
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FoundationTest {
    @Test
    fun destinationsStartAtMachinesAndFollowOrder() {
        assertEquals(
            listOf(
                AppDestination.Machines,
                AppDestination.Workspaces,
                AppDestination.Sessions,
                AppDestination.Chat,
            ),
            AppDestination.entries,
        )
        assertEquals(AppDestination.Machines, AppDestination.entries.first())
        assertEquals("machines", AppDestination.Machines.route)
        assertNull(AppDestination.Machines.previous)
        assertEquals(AppDestination.Workspaces, AppDestination.Machines.next)
        assertEquals(AppDestination.Sessions, AppDestination.Workspaces.next)
        assertEquals(AppDestination.Chat, AppDestination.Sessions.next)
        assertNull(AppDestination.Chat.next)
        assertEquals("chat", AppDestination.Chat.route)
    }

    @Test
    fun initialUiStateHasNoSelectionAndDisconnectedTransport() {
        withViewModel { viewModel, _, _ ->
            val state = viewModel.uiState.value
            assertNull(state.selectedMachineId)
            assertNull(state.selectedWorkspaceId)
            assertNull(state.selectedSessionId)
            assertTrue(state.machines.isEmpty())
            assertTrue(state.workspaces.isEmpty())
            assertTrue(state.sessions.isEmpty())
            assertEquals(ConnectionState.Disconnected, viewModel.connectionState.value)
            assertEquals(RemoteConnectionState.Disconnected, state.remoteConnection)
            assertTrue(state.chatMessages.isEmpty())
            assertNull(state.chatStatus)
            assertNull(state.chatError)
            assertNull(state.chatTerminal)
            assertFalse(state.isSending)
            assertFalse(state.isStopping)
            assertNull(state.pendingPermission)
            assertFalse(state.syncGapWarning)
            assertNull(state.diffSnapshot)
            assertFalse(state.diffLoading)
            assertNull(state.diffError)
            assertTrue(state.expandedDiffPaths.isEmpty())
            assertNull(state.fileViewer)
            assertTrue(state.modelCatalog.isEmpty())
            assertNull(state.currentModelId)
            assertNull(state.pendingModelId)
            assertNull(state.modelError)
            assertFalse(state.modelsLoading)
            assertFalse(state.modelPickerVisible)
            assertTrue(state.hiddenModelIds.isEmpty())
            assertFalse(state.manageModelsVisible)
            assertTrue(state.pickerModels.isEmpty())
        }
    }

    @Test
    fun selectingMachineClearsWorkspaceAndSession() {
        withViewModel { viewModel, _, _ ->
            viewModel.selectMachine("machine-1")
            viewModel.selectWorkspace("workspace-1")
            viewModel.selectSession("session-1")
            viewModel.selectMachine("machine-2")
            val state = viewModel.uiState.value
            assertEquals("machine-2", state.selectedMachineId)
            assertNull(state.selectedWorkspaceId)
            assertNull(state.selectedSessionId)
            assertTrue(state.workspaces.isEmpty())
            assertTrue(state.sessions.isEmpty())
        }
    }

    @Test
    fun selectingWorkspaceClearsSession() {
        withViewModel { viewModel, _, _ ->
            viewModel.selectMachine("machine-1")
            viewModel.selectWorkspace("workspace-1")
            viewModel.selectSession("session-1")
            viewModel.selectWorkspace("workspace-2")
            val state = viewModel.uiState.value
            assertEquals("machine-1", state.selectedMachineId)
            assertEquals("workspace-2", state.selectedWorkspaceId)
            assertNull(state.selectedSessionId)
            assertTrue(state.sessions.isEmpty())
        }
    }

    @Test
    fun pairingJsonSuccessLoadsWorkspacesAndInvalidQrStaysOnMachineScreen() {
        withViewModel { viewModel, dao, _ ->
            runBlocking { assertTrue(viewModel.registerFromPairingJson(validQrJson(), "PC")) }
            val success = viewModel.uiState.value
            assertEquals("pc-1", success.selectedMachineId)
            assertEquals("PC", dao.machines.value.single().displayName)
            assertEquals("device-1", dao.machines.value.single().deviceId)
            assertEquals("ws-1", success.workspaces.single().workspaceId)
            assertNull(success.errorMessage)
            runBlocking { assertFalse(viewModel.registerFromPairingJson("{", "PC")) }
            assertEquals("pc-1", viewModel.uiState.value.selectedMachineId)
            assertTrue(viewModel.uiState.value.errorMessage != null)
        }
    }

    @Test
    fun existingMachineReauthWorkspaceListNewAndResumeSession() {
        withViewModel { viewModel, dao, _ ->
            runBlocking {
                dao.upsert(pairedMachine())
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertEquals("ws-1", viewModel.uiState.value.workspaces.single().workspaceId)
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertEquals("sess-1", viewModel.uiState.value.sessions.single().remoteSessionId)
                assertTrue(viewModel.createSession())
                assertEquals("sess-new", viewModel.uiState.value.selectedSessionId)
                assertTrue(viewModel.resumeSession("sess-1"))
                assertEquals("sess-1", viewModel.uiState.value.selectedSessionId)
            }
        }
    }

    @Test
    fun modelCatalogRefreshSelectPendingEventsAndFixtureExtraWithoutProductionIds() {
        withViewModel { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertTrue(viewModel.createSession())
                val created = viewModel.uiState.value
                assertEquals("sess-new", created.selectedSessionId)
                assertEquals(listOf("mock-model", "mock-fast", "fixture-added-model", "unavailable-mock"), created.modelCatalog.map { it.id })
                assertEquals("mock-model", created.currentModelId)
                assertNull(created.pendingModelId)
                assertEquals("Mock", created.modelCatalog.first { it.id == created.currentModelId }.displayName)
                assertEquals(false, created.modelCatalog.any { it.id.contains("gpt") })
                assertTrue(lastCommand(transport, "model.list").contains("\"sessionId\":\"sess-new\""))

                assertTrue(viewModel.resumeSession("sess-1"))
                val resumed = viewModel.uiState.value
                assertEquals("sess-1", resumed.selectedSessionId)
                assertEquals("mock-model", resumed.currentModelId)
                assertTrue(resumed.modelCatalog.any { it.id == "fixture-added-model" })

                viewModel.refreshModels()
                assertEquals(2, transport.sent.count { commandType(it) == "model.list" && it.contains("\"sessionId\":\"sess-1\"") })

                viewModel.selectModel("unavailable-mock")
                assertEquals("mock-model", viewModel.uiState.value.currentModelId)
                assertNull(viewModel.uiState.value.pendingModelId)
                assertEquals(0, transport.sent.count { commandType(it) == "model.select" })

                viewModel.selectModel("fixture-added-model")
                val selected = viewModel.uiState.value
                assertEquals("fixture-added-model", selected.currentModelId)
                assertNull(selected.pendingModelId)
                assertNull(selected.modelError)
                assertTrue(lastCommand(transport, "model.select").contains("\"modelId\":\"fixture-added-model\""))
                assertEquals("model.select", commandType(transport.sent.last()))
                assertEquals(2, transport.sent.count { commandType(it) == "model.list" && it.contains("\"sessionId\":\"sess-1\"") })

                transport.onSend = { text ->
                    if (commandType(text) == "model.select") {
                        transport.emit(resultJson(requestIdOf(text), ok = false, value = "null", error = "Unknown or unavailable model"))
                    } else {
                        transport.emit(successBody(requestIdOf(text), text))
                    }
                }
                viewModel.selectModel("mock-fast")
                val failed = viewModel.uiState.value
                assertEquals("fixture-added-model", failed.currentModelId)
                assertNull(failed.pendingModelId)
                assertEquals("Unknown or unavailable model", failed.modelError)

                transport.emit(eventJson("model.catalog_updated", "other", catalogJson(currentModelId = "mock-fast"), eventId = "evt-other-model"))
                assertEquals("fixture-added-model", viewModel.uiState.value.currentModelId)
                transport.emit(
                    eventJson(
                        "model.catalog_updated",
                        "sess-1",
                        catalogJson(
                            currentModelId = "mock-fast",
                            extraModelJson = """{"id":"fixture-extra-model","displayName":"Fixture Extra","description":null,"parameters":[],"variants":[],"available":true}""",
                        ),
                        eventId = "evt-catalog",
                    ),
                )
                val catalogEvent = viewModel.uiState.value
                assertEquals("mock-fast", catalogEvent.currentModelId)
                assertTrue(catalogEvent.modelCatalog.any { it.id == "fixture-extra-model" })
                transport.emit(
                    eventJson(
                        "model.selection_changed",
                        "sess-1",
                        """{"modelId":"fixture-added-model","confirmed":true}""",
                        eventId = "evt-select",
                    ),
                )
                assertEquals("fixture-added-model", viewModel.uiState.value.currentModelId)

                hangModelList(transport)
                viewModel.refreshModels()
                val hung = lastCommand(transport, "model.list")
                assertTrue(viewModel.uiState.value.modelsLoading)
                viewModel.selectSession("sess-2")
                assertTrue(viewModel.uiState.value.modelCatalog.isEmpty())
                assertNull(viewModel.uiState.value.currentModelId)
                transport.emit(resultJson(requestIdOf(hung), ok = true, value = catalogJson(currentModelId = "mock-model")))
                assertTrue(viewModel.uiState.value.modelCatalog.isEmpty())
                assertNull(viewModel.uiState.value.currentModelId)
            }
        }
    }

    @Test
    fun modelVisibilityDefaultHideShowSelectedHeaderUnavailableSessionPersistWithoutRemoteCommand() {
        val hiddenDao = FakeHiddenModelDao()
        withViewModel(hiddenModelDao = hiddenDao) { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertTrue(viewModel.createSession())
                val created = viewModel.uiState.value
                assertEquals(
                    listOf("mock-model", "mock-fast", "fixture-added-model", "unavailable-mock"),
                    created.modelCatalog.map { it.id },
                )
                assertEquals(
                    listOf("mock-model", "mock-fast", "fixture-added-model"),
                    created.pickerModels.map { it.id },
                )
                assertTrue(created.hiddenModelIds.isEmpty())
                assertFalse(created.pickerModels.any { it.id == "unavailable-mock" })
                assertTrue(created.modelCatalog.any { it.id == "unavailable-mock" && !it.available })

                transport.emit(
                    eventJson(
                        "model.catalog_updated",
                        "sess-new",
                        catalogJson(
                            currentModelId = "mock-model",
                            extraModelJson = """{"id":"fixture-extra-model","displayName":"Fixture Extra","description":null,"parameters":[],"variants":[],"available":true}""",
                        ),
                        eventId = "evt-new-visible",
                    ),
                )
                val detected = viewModel.uiState.value
                assertTrue(detected.pickerModels.any { it.id == "fixture-extra-model" })
                assertFalse("fixture-extra-model" in detected.hiddenModelIds)
                assertTrue(detected.modelCatalog.any { it.id == "fixture-extra-model" })

                val sentBeforeHide = transport.sent.size
                viewModel.setModelHidden("mock-fast", true)
                val hidden = viewModel.uiState.value
                assertTrue("mock-fast" in hidden.hiddenModelIds)
                assertEquals(
                    listOf("mock-model", "fixture-added-model", "fixture-extra-model"),
                    hidden.pickerModels.map { it.id },
                )
                assertTrue(hidden.modelCatalog.any { it.id == "mock-fast" })
                assertEquals(sentBeforeHide, transport.sent.size)
                assertEquals(0, transport.sent.count { commandType(it) == "model.visibility.update" })

                viewModel.setModelHidden("mock-fast", false)
                val shown = viewModel.uiState.value
                assertFalse("mock-fast" in shown.hiddenModelIds)
                assertEquals(
                    listOf("mock-model", "mock-fast", "fixture-added-model", "fixture-extra-model"),
                    shown.pickerModels.map { it.id },
                )
                assertEquals(sentBeforeHide, transport.sent.size)

                viewModel.setModelHidden("mock-model", true)
                val selectedHidden = viewModel.uiState.value
                assertEquals("mock-model", selectedHidden.currentModelId)
                assertEquals("Mock", selectedHidden.modelCatalog.first { it.id == selectedHidden.currentModelId }.displayName)
                assertTrue("mock-model" in selectedHidden.hiddenModelIds)
                assertFalse(selectedHidden.pickerModels.any { it.id == "mock-model" })
                assertTrue(selectedHidden.modelCatalog.any { it.id == "mock-model" })

                viewModel.toggleManageModels()
                assertTrue(viewModel.uiState.value.manageModelsVisible)
                viewModel.selectSession("sess-2")
                val switched = viewModel.uiState.value
                assertTrue(switched.modelCatalog.isEmpty())
                assertNull(switched.currentModelId)
                assertTrue("mock-model" in switched.hiddenModelIds)
                assertFalse(switched.manageModelsVisible)
                assertFalse(switched.modelPickerVisible)

                assertTrue(viewModel.resumeSession("sess-1"))
                val resumed = viewModel.uiState.value
                assertTrue("mock-model" in resumed.hiddenModelIds)
                assertEquals("mock-model", resumed.currentModelId)
                assertEquals("Mock", resumed.modelCatalog.first { it.id == resumed.currentModelId }.displayName)
                assertEquals(
                    listOf("mock-fast", "fixture-added-model"),
                    resumed.pickerModels.map { it.id },
                )
                assertTrue(resumed.modelCatalog.any { it.id == "unavailable-mock" })
                assertFalse(resumed.pickerModels.any { it.id == "unavailable-mock" })
                assertEquals(0, transport.sent.count { commandType(it) == "model.visibility.update" })
            }
        }
        withViewModel(hiddenModelDao = hiddenDao) { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertTrue(viewModel.createSession())
                val persisted = viewModel.uiState.value
                assertTrue("mock-model" in persisted.hiddenModelIds)
                assertEquals("mock-model", persisted.currentModelId)
                assertEquals("Mock", persisted.modelCatalog.first { it.id == persisted.currentModelId }.displayName)
                assertFalse(persisted.pickerModels.any { it.id == "mock-model" })
                assertTrue(persisted.modelCatalog.any { it.id == "mock-model" })
                assertEquals(
                    listOf("mock-fast", "fixture-added-model"),
                    persisted.pickerModels.map { it.id },
                )
                assertEquals(0, transport.sent.count { commandType(it) == "model.visibility.update" })
            }
        }
    }

    @Test
    fun task402SessionContextUsageStoresForSelectedSessionUpdatesClearsAndSendsNoCommand() {
        withViewModel { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertTrue(viewModel.resumeSession("sess-1"))
                assertNull(viewModel.uiState.value.sessionContextUsage)
                transport.emit(eventJson("session.context_updated", "sess-1", """{"used":12,"size":100}"""))
                assertEquals(12L, viewModel.uiState.value.sessionContextUsage?.used)
                assertEquals(100L, viewModel.uiState.value.sessionContextUsage?.size)
                transport.emit(eventJson("session.context_updated", "sess-1", """{"used":50,"size":200,"cost":1}"""))
                assertEquals(50L, viewModel.uiState.value.sessionContextUsage?.used)
                assertEquals(200L, viewModel.uiState.value.sessionContextUsage?.size)
                transport.emit(eventJson("session.context_updated", "other", """{"used":1,"size":1}"""))
                assertEquals(50L, viewModel.uiState.value.sessionContextUsage?.used)
                assertEquals(200L, viewModel.uiState.value.sessionContextUsage?.size)
                transport.emit(eventJson("session.context_updated", null, """{"used":2,"size":2}"""))
                assertEquals(50L, viewModel.uiState.value.sessionContextUsage?.used)
                assertEquals(200L, viewModel.uiState.value.sessionContextUsage?.size)
                transport.emit(eventJson("session.context_updated", "sess-1", """{"used":"12","size":100}"""))
                assertEquals(50L, viewModel.uiState.value.sessionContextUsage?.used)
                assertEquals(200L, viewModel.uiState.value.sessionContextUsage?.size)
                transport.emit(eventJson("agent.completed", "sess-1", """{"reason":null}""", eventId = "evt-context-term"))
                assertEquals(50L, viewModel.uiState.value.sessionContextUsage?.used)
                assertEquals(200L, viewModel.uiState.value.sessionContextUsage?.size)
                assertEquals(0, transport.sent.count { commandType(it) == "session.context.get" })
                viewModel.selectSession("sess-2")
                assertNull(viewModel.uiState.value.sessionContextUsage)
                viewModel.selectSession("sess-1")
                transport.emit(eventJson("session.context_updated", "sess-1", """{"used":9,"size":10}"""))
                assertEquals(9L, viewModel.uiState.value.sessionContextUsage?.used)
                assertEquals(10L, viewModel.uiState.value.sessionContextUsage?.size)
                viewModel.selectWorkspace("ws-2")
                assertNull(viewModel.uiState.value.sessionContextUsage)
                viewModel.selectWorkspace("ws-1")
                viewModel.selectSession("sess-1")
                transport.emit(eventJson("session.context_updated", "sess-1", """{"used":3,"size":4}"""))
                assertEquals(3L, viewModel.uiState.value.sessionContextUsage?.used)
                assertEquals(4L, viewModel.uiState.value.sessionContextUsage?.size)
                viewModel.selectMachine("pc-2")
                assertNull(viewModel.uiState.value.sessionContextUsage)
                assertEquals(0, transport.sent.count { commandType(it) == "session.context.get" })
            }
        }
    }

    @Test
    fun task403SessionContextBreakdownStoresForSelectedSessionIgnoresInvalidAndClearsOnSwitch() {
        withViewModel { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertTrue(viewModel.resumeSession("sess-1"))
                assertNull(viewModel.uiState.value.sessionContextBreakdown)
                transport.emit(
                    eventJson(
                        "session.context_breakdown_updated",
                        "sess-1",
                        """{"categories":[{"id":"system_prompt","displayName":"System prompt","tokens":5000}]}""",
                    ),
                )
                assertEquals(1, viewModel.uiState.value.sessionContextBreakdown?.size)
                assertEquals("system_prompt", viewModel.uiState.value.sessionContextBreakdown?.first()?.id)
                assertEquals("System prompt", viewModel.uiState.value.sessionContextBreakdown?.first()?.displayName)
                assertEquals(5000L, viewModel.uiState.value.sessionContextBreakdown?.first()?.tokens)
                transport.emit(
                    eventJson(
                        "session.context_breakdown_updated",
                        "sess-1",
                        """{"categories":[{"id":"tools","displayName":"Tools","tokens":12},{"id":"unknown_cat","displayName":"Unknown","tokens":3}]}""",
                    ),
                )
                assertEquals(listOf("tools", "unknown_cat"), viewModel.uiState.value.sessionContextBreakdown?.map { it.id })
                assertEquals(12L, viewModel.uiState.value.sessionContextBreakdown?.first()?.tokens)
                transport.emit(
                    eventJson(
                        "session.context_breakdown_updated",
                        "other",
                        """{"categories":[{"id":"rules","displayName":"Rules","tokens":1}]}""",
                    ),
                )
                assertEquals("tools", viewModel.uiState.value.sessionContextBreakdown?.first()?.id)
                transport.emit(
                    eventJson(
                        "session.context_breakdown_updated",
                        null,
                        """{"categories":[{"id":"rules","displayName":"Rules","tokens":1}]}""",
                    ),
                )
                assertEquals("tools", viewModel.uiState.value.sessionContextBreakdown?.first()?.id)
                transport.emit(
                    eventJson(
                        "session.context_breakdown_updated",
                        "sess-1",
                        """{"categories":[{"id":"","displayName":"Bad","tokens":1}]}""",
                    ),
                )
                assertEquals("tools", viewModel.uiState.value.sessionContextBreakdown?.first()?.id)
                viewModel.selectSession("sess-2")
                assertNull(viewModel.uiState.value.sessionContextBreakdown)
                viewModel.selectSession("sess-1")
                transport.emit(
                    eventJson(
                        "session.context_breakdown_updated",
                        "sess-1",
                        """{"categories":[{"id":"mcp","displayName":"MCP","tokens":7}]}""",
                    ),
                )
                assertEquals("mcp", viewModel.uiState.value.sessionContextBreakdown?.first()?.id)
                viewModel.selectWorkspace("ws-2")
                assertNull(viewModel.uiState.value.sessionContextBreakdown)
                viewModel.selectWorkspace("ws-1")
                viewModel.selectSession("sess-1")
                transport.emit(
                    eventJson(
                        "session.context_breakdown_updated",
                        "sess-1",
                        """{"categories":[{"id":"skills","displayName":"Skills","tokens":9}]}""",
                    ),
                )
                assertEquals("skills", viewModel.uiState.value.sessionContextBreakdown?.first()?.id)
                viewModel.selectMachine("pc-2")
                assertNull(viewModel.uiState.value.sessionContextBreakdown)
            }
        }
    }

    @Test
    fun task404SessionUsageStoresForSelectedSessionIgnoresInvalidAndClearsOnSwitch() {
        withViewModel { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertTrue(viewModel.resumeSession("sess-1"))
                assertNull(viewModel.uiState.value.sessionUsage)
                transport.emit(
                    eventJson(
                        "session.usage_updated",
                        "sess-1",
                        """{"cost":{"amount":0.045,"currency":"USD"}}""",
                    ),
                )
                assertEquals(BigDecimal("0.045"), viewModel.uiState.value.sessionUsage?.cost?.amount)
                assertEquals("USD", viewModel.uiState.value.sessionUsage?.cost?.currency)
                transport.emit(
                    eventJson(
                        "session.usage_updated",
                        "other",
                        """{"cost":{"amount":1,"currency":"USD"}}""",
                    ),
                )
                assertEquals(BigDecimal("0.045"), viewModel.uiState.value.sessionUsage?.cost?.amount)
                transport.emit(eventJson("session.usage_updated", null, """{"cost":{"amount":1,"currency":"USD"}}"""))
                assertEquals(BigDecimal("0.045"), viewModel.uiState.value.sessionUsage?.cost?.amount)
                transport.emit(
                    eventJson(
                        "session.usage_updated",
                        "sess-1",
                        """{"cost":{"amount":-1,"currency":"USD"}}""",
                    ),
                )
                assertEquals(BigDecimal("0.045"), viewModel.uiState.value.sessionUsage?.cost?.amount)
                transport.emit(
                    eventJson(
                        "session.usage_updated",
                        "sess-1",
                        """{"amount":0.25,"currency":"USD"}""",
                    ),
                )
                assertEquals(BigDecimal("0.045"), viewModel.uiState.value.sessionUsage?.cost?.amount)
                transport.emit(eventJson("agent.completed", "sess-1", """{"reason":null}""", eventId = "evt-usage-term"))
                assertEquals(BigDecimal("0.045"), viewModel.uiState.value.sessionUsage?.cost?.amount)
                viewModel.selectSession("sess-2")
                assertNull(viewModel.uiState.value.sessionUsage)
                viewModel.selectSession("sess-1")
                transport.emit(
                    eventJson(
                        "session.usage_updated",
                        "sess-1",
                        """{"cost":{"amount":0,"currency":"USD"}}""",
                    ),
                )
                assertEquals(BigDecimal("0"), viewModel.uiState.value.sessionUsage?.cost?.amount)
                viewModel.selectWorkspace("ws-2")
                assertNull(viewModel.uiState.value.sessionUsage)
                viewModel.selectWorkspace("ws-1")
                viewModel.selectSession("sess-1")
                transport.emit(
                    eventJson(
                        "session.usage_updated",
                        "sess-1",
                        """{"cost":{"amount":0.25,"currency":"USD"}}""",
                    ),
                )
                assertEquals(BigDecimal("0.25"), viewModel.uiState.value.sessionUsage?.cost?.amount)
                viewModel.selectMachine("pc-2")
                assertNull(viewModel.uiState.value.sessionUsage)
            }
        }
    }

    @Test
    fun listAndResumeFailuresStayOnCurrentSelection() {
        withViewModel(autoRespond = false) { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                transport.onSend = { text ->
                    val requestId = requestIdOf(text)
                    val failing = commandType(text) == "session.load"
                    transport.emit(
                        if (failing) {
                            resultJson(requestId, ok = false, value = "null", error = "missing")
                        } else {
                            successBody(requestId, text)
                        },
                    )
                }
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertFalse(viewModel.resumeSession("sess-1"))
                assertNull(viewModel.uiState.value.selectedSessionId)
                assertEquals("missing", viewModel.uiState.value.errorMessage)
                assertEquals("ws-1", viewModel.uiState.value.selectedWorkspaceId)
                assertEquals(RemoteConnectionState.Ready, viewModel.uiState.value.remoteConnection)
            }
        }
    }

    @Test
    fun chatFiltersSessionAccumulatesDeltaDedupsEchoAndKeepsTerminal() {
        withViewModel { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertTrue(viewModel.resumeSession("sess-1"))
                hangSessionSend(transport, hangCancel = true)
                viewModel.sendPrompt("hello")
                assertEquals("hello", viewModel.uiState.value.chatMessages.single().text)
                assertTrue(viewModel.uiState.value.isSending)
                transport.emit(eventJson("user.message", "sess-1", """{"text":"he"}"""))
                transport.emit(eventJson("user.message", "sess-1", """{"text":"llo"}"""))
                assertEquals(1, viewModel.uiState.value.chatMessages.size)
                transport.emit(eventJson("assistant.message", "other", """{"text":"nope","delta":true}"""))
                assertEquals(1, viewModel.uiState.value.chatMessages.size)
                transport.emit(eventJson("assistant.message", "sess-1", """{"text":"Hel","delta":true}"""))
                transport.emit(eventJson("assistant.message", "sess-1", """{"text":"lo","delta":true}"""))
                assertEquals("Hello", viewModel.uiState.value.chatMessages.last().text)
                assertTrue(viewModel.uiState.value.chatMessages.last().isStreaming)
                transport.emit(eventJson("assistant.message", "sess-1", """{"text":"Hi","delta":false}"""))
                assertEquals("Hi", viewModel.uiState.value.chatMessages.last().text)
                transport.emit(eventJson("assistant.status", "sess-1", """{"status":"thinking"}"""))
                assertEquals("thinking", viewModel.uiState.value.chatStatus)
                viewModel.stopSession()
                assertTrue(viewModel.uiState.value.isStopping)
                assertTrue(viewModel.uiState.value.isSending)
                transport.emit(eventJson("agent.interrupted", "sess-1", """{"reason":null}"""))
                assertEquals("interrupted", viewModel.uiState.value.chatTerminal)
                assertFalse(viewModel.uiState.value.chatMessages.last().isStreaming)
                assertFalse(viewModel.uiState.value.isSending)
                assertFalse(viewModel.uiState.value.isStopping)
                transport.emit(resultJson(requestIdOf(lastCommand(transport, "session.send")), ok = false, value = "null", error = "cancelled"))
                assertEquals("interrupted", viewModel.uiState.value.chatTerminal)
                assertNull(viewModel.uiState.value.chatError)
                viewModel.selectSession("sess-2")
                assertTrue(viewModel.uiState.value.chatMessages.isEmpty())
                assertNull(viewModel.uiState.value.chatTerminal)
                assertFalse(viewModel.uiState.value.isSending)
                viewModel.sendPrompt("   ")
                assertTrue(viewModel.uiState.value.chatMessages.isEmpty())
                assertTrue(transport.sent.none { commandType(it) == "session.send" && it.contains("\"text\":\"   \"") })
            }
        }
    }

    @Test
    fun agentWaitingDoesNotChangeChatUi() {
        withViewModel { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertTrue(viewModel.resumeSession("sess-1"))
                hangSessionSend(transport)
                viewModel.sendPrompt("hello")
                val before = viewModel.uiState.value
                transport.emit(eventJson("agent.waiting", "sess-1", """{"reason":"need input"}""", eventId = "evt-wait"))
                val after = viewModel.uiState.value
                assertEquals(before.chatMessages, after.chatMessages)
                assertEquals(before.chatStatus, after.chatStatus)
                assertEquals(before.chatError, after.chatError)
                assertEquals(before.chatTerminal, after.chatTerminal)
                assertEquals(before.isSending, after.isSending)
                assertEquals(before.pendingPermission, after.pendingPermission)
            }
        }
    }

    @Test
    fun transportMessageQueueDeliversBufferedFramesInOrderWithoutDrop() {
        val queue = TransportMessageQueue()
        val expected = (0 until 120).map { index -> TransportMessage(1L, "frame-$index") }
        expected.forEach(queue::enqueue)
        val received =
            runBlocking {
                withTimeout(1_000) {
                    queue.messages.take(120).toList()
                }
            }
        assertEquals(expected, received)
    }

    @Test
    fun sendSuccessKeepsSendingUntilTerminalEvent() {
        withViewModel { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertTrue(viewModel.resumeSession("sess-1"))
                hangSessionSend(transport)
                viewModel.sendPrompt("hello")
                assertTrue(viewModel.uiState.value.isSending)
                transport.emit(resultJson(requestIdOf(lastCommand(transport, "session.send")), ok = true, value = "null"))
                assertTrue(viewModel.uiState.value.isSending)
                assertNull(viewModel.uiState.value.chatTerminal)
                transport.emit(eventJson("agent.completed", "sess-1", """{"reason":null}"""))
                assertFalse(viewModel.uiState.value.isSending)
                assertEquals("completed", viewModel.uiState.value.chatTerminal)
            }
        }
    }

    @Test
    fun userEchoPrefixFullMismatchAndTerminalClearPending() {
        withViewModel { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertTrue(viewModel.resumeSession("sess-1"))
                hangSessionSend(transport)
                viewModel.sendPrompt("hello")
                transport.emit(eventJson("user.message", "sess-1", """{"text":"xyz"}"""))
                assertEquals(listOf("hello", "xyz"), viewModel.uiState.value.chatMessages.map { it.text })
                transport.emit(eventJson("agent.completed", "sess-1", """{"reason":null}"""))
                viewModel.sendPrompt("world")
                transport.emit(eventJson("user.message", "sess-1", """{"text":"world"}"""))
                assertEquals(listOf("hello", "xyz", "world"), viewModel.uiState.value.chatMessages.map { it.text })
                transport.emit(resultJson(requestIdOf(lastCommand(transport, "session.send")), ok = true, value = "null"))
                transport.emit(eventJson("agent.completed", "sess-1", """{"reason":null}""", eventId = "evt-done"))
                viewModel.sendPrompt("hello")
                transport.emit(eventJson("agent.completed", "sess-1", """{"reason":null}""", eventId = "evt-no-echo"))
                viewModel.sendPrompt("next")
                transport.emit(eventJson("user.message", "sess-1", """{"text":"next"}"""))
                assertEquals(
                    listOf("hello", "xyz", "world", "hello", "next"),
                    viewModel.uiState.value.chatMessages.map { it.text },
                )
                transport.emit(eventJson("agent.completed", "sess-1", """{"reason":null}""", eventId = "evt-next"))
                viewModel.sendPrompt("fail")
                transport.emit(resultJson(requestIdOf(lastCommand(transport, "session.send")), ok = false, value = "null", error = "nope"))
                assertEquals("nope", viewModel.uiState.value.chatError)
                assertFalse(viewModel.uiState.value.isSending)
                viewModel.sendPrompt("ok")
                transport.emit(eventJson("user.message", "sess-1", """{"text":"ok"}"""))
                assertEquals(
                    listOf("hello", "xyz", "world", "hello", "next", "fail", "ok"),
                    viewModel.uiState.value.chatMessages.map { it.text },
                )
            }
        }
    }

    @Test
    fun permissionRequestedResolvedApproveRejectAndSessionClear() {
        withViewModel { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertTrue(viewModel.resumeSession("sess-1"))
                hangSessionSend(transport, hangCancel = true)
                viewModel.sendPrompt("hello")
                assertTrue(viewModel.uiState.value.isSending)
                transport.emit(
                    eventJson(
                        "permission.requested",
                        "other",
                        """{"permissionId":"perm-other","kind":"execute","command":"nope","risk":"high"}""",
                        eventId = "evt-other",
                    ),
                )
                assertNull(viewModel.uiState.value.pendingPermission)
                transport.emit(
                    eventJson(
                        "permission.requested",
                        "sess-1",
                        """{"permissionId":"perm-1","kind":"execute","command":"Get-ChildItem -Force","risk":"high"}""",
                    ),
                )
                assertEquals("perm-1", viewModel.uiState.value.pendingPermission?.permissionId)
                assertEquals("Get-ChildItem -Force", viewModel.uiState.value.pendingPermission?.command)
                assertTrue(viewModel.uiState.value.isSending)
                transport.emit(
                    eventJson(
                        "permission.resolved",
                        "sess-1",
                        """{"permissionId":"stale","decision":"approved"}""",
                        eventId = "evt-stale",
                    ),
                )
                assertEquals("perm-1", viewModel.uiState.value.pendingPermission?.permissionId)
                viewModel.approvePermission()
                viewModel.approvePermission()
                viewModel.rejectPermission()
                assertEquals(1, transport.sent.count { commandType(it) == "permission.approve" })
                assertEquals(0, transport.sent.count { commandType(it) == "permission.reject" })
                assertTrue(viewModel.uiState.value.pendingPermission?.deciding == true)
                val approve = lastCommand(transport, "permission.approve")
                assertTrue(approve.contains("\"permissionId\":\"perm-1\""))
                assertEquals(false, approve.contains("optionId"))
                transport.emit(resultJson(requestIdOf(approve), ok = true, value = "null"))
                transport.emit(
                    eventJson(
                        "permission.resolved",
                        "sess-1",
                        """{"permissionId":"perm-1","decision":"approved"}""",
                        eventId = "evt-resolved",
                    ),
                )
                assertNull(viewModel.uiState.value.pendingPermission)
                assertTrue(viewModel.uiState.value.isSending)
                val approveCountAfterResolved = transport.sent.count { commandType(it) == "permission.approve" }
                viewModel.approvePermission()
                viewModel.rejectPermission()
                assertEquals(approveCountAfterResolved, transport.sent.count { commandType(it) == "permission.approve" })
                assertEquals(0, transport.sent.count { commandType(it) == "permission.reject" })
                transport.emit(
                    eventJson(
                        "permission.requested",
                        "sess-1",
                        """{"permissionId":"perm-2","kind":"execute","command":"ls","risk":"high"}""",
                        eventId = "evt-req2",
                    ),
                )
                assertEquals("perm-2", viewModel.uiState.value.pendingPermission?.permissionId)
                assertEquals(false, viewModel.uiState.value.pendingPermission?.deciding)
                viewModel.rejectPermission()
                viewModel.rejectPermission()
                assertEquals(1, transport.sent.count { commandType(it) == "permission.reject" })
                assertTrue(lastCommand(transport, "permission.reject").contains("\"permissionId\":\"perm-2\""))
                transport.emit(
                    eventJson(
                        "permission.resolved",
                        "sess-1",
                        """{"permissionId":"perm-2","decision":"rejected"}""",
                        eventId = "evt-rej2",
                    ),
                )
                assertNull(viewModel.uiState.value.pendingPermission)
                viewModel.selectSession("sess-2")
                assertNull(viewModel.uiState.value.pendingPermission)
                viewModel.selectSession("sess-1")
                hangSessionSend(transport)
                viewModel.sendPrompt("again")
                transport.emit(
                    eventJson(
                        "permission.requested",
                        "sess-1",
                        """{"permissionId":"perm-3","kind":"execute","command":"rm","risk":"high"}""",
                        eventId = "evt-req3",
                    ),
                )
                transport.emit(eventJson("agent.completed", "sess-1", """{"reason":null}""", eventId = "evt-term"))
                assertNull(viewModel.uiState.value.pendingPermission)
                assertEquals("completed", viewModel.uiState.value.chatTerminal)
                val sentAfterTerminal = transport.sent.size
                viewModel.approvePermission()
                viewModel.rejectPermission()
                assertEquals(sentAfterTerminal, transport.sent.size)
            }
        }
    }

    @Test
    fun diffRefreshWorkspaceCorrelationStaleRejectionSessionRetentionAndCollapse() {
        withViewModel { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertTrue(viewModel.resumeSession("sess-1"))
                viewModel.refreshDiff()
                assertEquals("ws-1", viewModel.uiState.value.diffSnapshot?.workspaceId)
                assertFalse(viewModel.uiState.value.diffLoading)
                val retained = viewModel.uiState.value.diffSnapshot
                viewModel.selectSession("sess-2")
                assertEquals("sess-2", viewModel.uiState.value.selectedSessionId)
                assertEquals(retained, viewModel.uiState.value.diffSnapshot)
                viewModel.toggleDiffFile("src/foo.ts")
                assertTrue(viewModel.uiState.value.expandedDiffPaths.contains("src/foo.ts"))
                viewModel.toggleDiffFile("src/foo.ts")
                assertTrue(viewModel.uiState.value.expandedDiffPaths.isEmpty())
                hangDiffRead(transport)
                viewModel.refreshDiff()
                val hung = lastCommand(transport, "diff.read")
                assertTrue(viewModel.uiState.value.diffLoading)
                val sentWhileLoading = transport.sent.count { commandType(it) == "diff.read" }
                viewModel.refreshDiff()
                assertEquals(sentWhileLoading, transport.sent.count { commandType(it) == "diff.read" })
                viewModel.selectWorkspace("ws-2")
                assertNull(viewModel.uiState.value.diffSnapshot)
                assertFalse(viewModel.uiState.value.diffLoading)
                assertTrue(viewModel.uiState.value.expandedDiffPaths.isEmpty())
                transport.emit(resultJson(requestIdOf(hung), ok = true, value = snapshotJson("ws-1")))
                assertNull(viewModel.uiState.value.diffSnapshot)
                assertEquals("ws-2", viewModel.uiState.value.selectedWorkspaceId)
                viewModel.selectWorkspace("ws-1")
                transport.emit(eventJson("diff.updated", null, snapshotJson("ws-other", additions = 9), eventId = "evt-other-ws"))
                assertNull(viewModel.uiState.value.diffSnapshot)
                transport.emit(eventJson("diff.updated", null, snapshotJson("ws-1", additions = 4), eventId = "evt-ws-1"))
                assertEquals("ws-1", viewModel.uiState.value.diffSnapshot?.workspaceId)
                assertEquals(4, viewModel.uiState.value.diffSnapshot?.totalAdditions)
            }
        }
    }

    @Test
    fun fileViewerOpenReloadCloseEpochAndStaleResults() {
        withViewModel { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertTrue(viewModel.resumeSession("sess-1"))
                viewModel.openFile("src/foo.ts", 120, 160)
                val opened = viewModel.uiState.value.fileViewer
                assertEquals("src/foo.ts", opened?.path)
                assertEquals(120, opened?.startLine)
                assertEquals(160, opened?.endLine)
                assertEquals("file-body", opened?.content)
                assertEquals(false, opened?.loading)
                assertNull(opened?.error)
                val successFrame = lastCommand(transport, "file.read")
                assertTrue(successFrame.contains("\"sessionId\":\"sess-1\""))
                assertTrue(successFrame.contains("\"path\":\"src/foo.ts\""))
                assertEquals(false, successFrame.contains("workspaceId"))
                assertEquals(false, successFrame.contains("startLine"))
                viewModel.reloadFile()
                assertEquals("file-body", viewModel.uiState.value.fileViewer?.content)
                assertEquals(2, transport.sent.count { commandType(it) == "file.read" })
                viewModel.closeFile()
                assertNull(viewModel.uiState.value.fileViewer)

                hangFileRead(transport)
                viewModel.openFile("src/a.ts", 1, null)
                val first = lastCommand(transport, "file.read")
                assertEquals(true, viewModel.uiState.value.fileViewer?.loading)
                viewModel.openFile("src/b.ts")
                val second = lastCommand(transport, "file.read")
                assertTrue(first != second)
                transport.emit(resultJson(requestIdOf(first), ok = true, value = """{"path":"src/a.ts","content":"A","truncated":false}"""))
                assertEquals("src/b.ts", viewModel.uiState.value.fileViewer?.path)
                assertEquals(true, viewModel.uiState.value.fileViewer?.loading)
                assertNull(viewModel.uiState.value.fileViewer?.content)
                transport.emit(resultJson(requestIdOf(second), ok = true, value = """{"path":"src/b.ts","content":"B","truncated":true}"""))
                assertEquals("src/b.ts", viewModel.uiState.value.fileViewer?.path)
                assertEquals("B", viewModel.uiState.value.fileViewer?.content)
                assertEquals(true, viewModel.uiState.value.fileViewer?.truncated)
                assertEquals(false, viewModel.uiState.value.fileViewer?.loading)

                hangFileRead(transport)
                viewModel.openFile("src/c.ts")
                val hung = lastCommand(transport, "file.read")
                viewModel.selectSession("sess-2")
                assertNull(viewModel.uiState.value.fileViewer)
                transport.emit(resultJson(requestIdOf(hung), ok = true, value = """{"path":"src/c.ts","content":"C","truncated":false}"""))
                assertNull(viewModel.uiState.value.fileViewer)
                viewModel.selectSession("sess-1")
                hangFileRead(transport)
                viewModel.openFile("src/d.ts")
                val workspaceHung = lastCommand(transport, "file.read")
                viewModel.selectWorkspace("ws-2")
                assertNull(viewModel.uiState.value.fileViewer)
                transport.emit(resultJson(requestIdOf(workspaceHung), ok = true, value = """{"path":"src/d.ts","content":"D","truncated":false}"""))
                assertNull(viewModel.uiState.value.fileViewer)

                viewModel.selectWorkspace("ws-1")
                viewModel.selectSession("sess-1")
                transport.onSend = { text ->
                    if (commandType(text) == "file.read") {
                        transport.emit(resultJson(requestIdOf(text), ok = false, value = "null", error = "File is not readable"))
                    } else {
                        transport.emit(successBody(requestIdOf(text), text))
                    }
                }
                viewModel.openFile(".env")
                val failed = viewModel.uiState.value.fileViewer
                assertEquals(".env", failed?.path)
                assertEquals("File is not readable", failed?.error)
                assertNull(failed?.content)
                assertEquals(false, failed?.loading)
            }
        }
    }

    @Test
    fun reconnectKeepsSelectionChatAndSkipsSessionLoad() {
        withViewModel { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertTrue(viewModel.resumeSession("sess-1"))
                hangSessionSend(transport)
                viewModel.sendPrompt("hello")
                transport.emit(eventJson("assistant.message", "sess-1", """{"text":"Hi","delta":false}""", eventId = "evt-chat"))
                assertEquals(listOf("hello", "Hi"), viewModel.uiState.value.chatMessages.map { it.text })
                transport.emit(
                    eventJson(
                        "permission.requested",
                        "sess-1",
                        """{"permissionId":"perm-stale","kind":"execute","command":"ls","risk":"high"}""",
                        eventId = "evt-perm",
                    ),
                )
                assertEquals("perm-stale", viewModel.uiState.value.pendingPermission?.permissionId)
                transport.fail()
                assertEquals(RemoteConnectionState.Failed, viewModel.uiState.value.remoteConnection)
                val loadsBefore = transport.sent.count { commandType(it) == "session.load" }
                val helloSends = transport.sent.count { commandType(it) == "session.send" && it.contains("\"text\":\"hello\"") }
                hangSessionSend(transport)
                assertTrue(viewModel.reconnectSelectedMachine())
                val after = viewModel.uiState.value
                assertEquals("pc-1", after.selectedMachineId)
                assertEquals("ws-1", after.selectedWorkspaceId)
                assertEquals("sess-1", after.selectedSessionId)
                assertEquals(listOf("hello", "Hi"), after.chatMessages.map { it.text })
                assertEquals(RemoteConnectionState.Ready, after.remoteConnection)
                assertFalse(after.syncGapWarning)
                assertNull(after.pendingPermission)
                assertEquals(loadsBefore, transport.sent.count { commandType(it) == "session.load" })
                assertEquals(helloSends, transport.sent.count { commandType(it) == "session.send" && it.contains("\"text\":\"hello\"") })
                assertEquals(true, lastCommand(transport, "sync.catch_up").contains("\"sessionId\":\"sess-1\""))
            }
        }
    }

    @Test
    fun gapResyncKeepsChatSetsWarningAppliesPendingAndDoesNotLoadSession() {
        withViewModel(autoRespond = false) { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                transport.onSend = { text -> transport.emit(successBody(requestIdOf(text), text)) }
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertTrue(viewModel.resumeSession("sess-1"))
                hangSessionSend(transport)
                viewModel.sendPrompt("keep-me")
                assertEquals("keep-me", viewModel.uiState.value.chatMessages.single().text)
                transport.fail()
                val loadsBefore = transport.sent.count { commandType(it) == "session.load" }
                val sendsBefore = transport.sent.count { commandType(it) == "session.send" }
                val cancelsBefore = transport.sent.count { commandType(it) == "session.cancel" }
                transport.onSend = { text ->
                    if (commandType(text) == "sync.catch_up") {
                        transport.emit(
                            resultJson(
                                requestIdOf(text),
                                ok = true,
                                value =
                                    """{"status":"gap","events":[],"headEventId":"evt-head","pendingPermission":{"permissionId":"perm-gap","kind":"execute","command":"ls","risk":"high"}}""",
                            ),
                        )
                    } else {
                        transport.emit(successBody(requestIdOf(text), text))
                    }
                }
                assertTrue(viewModel.reconnectSelectedMachine())
                val after = viewModel.uiState.value
                assertEquals("pc-1", after.selectedMachineId)
                assertEquals("ws-1", after.selectedWorkspaceId)
                assertEquals("sess-1", after.selectedSessionId)
                assertEquals(listOf("keep-me"), after.chatMessages.map { it.text })
                assertTrue(after.syncGapWarning)
                assertEquals("perm-gap", after.pendingPermission?.permissionId)
                assertEquals("ws-1", after.workspaces.single().workspaceId)
                assertEquals("sess-1", after.sessions.single().remoteSessionId)
                assertEquals("ws-1", after.diffSnapshot?.workspaceId)
                assertEquals("mock-model", after.currentModelId)
                assertEquals(loadsBefore, transport.sent.count { commandType(it) == "session.load" })
                assertEquals(sendsBefore, transport.sent.count { commandType(it) == "session.send" })
                assertEquals(cancelsBefore, transport.sent.count { commandType(it) == "session.cancel" })
                assertTrue(transport.sent.count { commandType(it) == "workspace.list" } >= 2)
                assertTrue(transport.sent.count { commandType(it) == "session.list" } >= 2)
                assertTrue(transport.sent.any { commandType(it) == "diff.read" })
                assertTrue(transport.sent.any { commandType(it) == "model.list" })
            }
        }
    }

    @Test
    fun gapResyncFailureKeepsWarningAndRetriesOnReplayedReconnect() {
        withViewModel(autoRespond = false) { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                transport.onSend = { text -> transport.emit(successBody(requestIdOf(text), text)) }
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertTrue(viewModel.resumeSession("sess-1"))
                hangSessionSend(transport)
                viewModel.sendPrompt("keep-me")
                assertEquals("keep-me", viewModel.uiState.value.chatMessages.single().text)
                transport.fail()
                val loadsBefore = transport.sent.count { commandType(it) == "session.load" }
                val sendsBefore = transport.sent.count { commandType(it) == "session.send" }
                val cancelsBefore = transport.sent.count { commandType(it) == "session.cancel" }
                var failWorkspaceList = true
                transport.onSend = { text ->
                    when (commandType(text)) {
                        "sync.catch_up" ->
                            transport.emit(
                                resultJson(
                                    requestIdOf(text),
                                    ok = true,
                                    value =
                                        if (failWorkspaceList) {
                                            """{"status":"gap","events":[],"headEventId":"evt-head","pendingPermission":{"permissionId":"perm-gap","kind":"execute","command":"ls","risk":"high"}}"""
                                        } else {
                                            """{"status":"replayed","events":[],"headEventId":"evt-head","pendingPermission":null}"""
                                        },
                                ),
                            )
                        "workspace.list" ->
                            if (failWorkspaceList) {
                                transport.emit(
                                    resultJson(requestIdOf(text), ok = false, value = "null", error = "workspace list failed"),
                                )
                            } else {
                                transport.emit(successBody(requestIdOf(text), text))
                            }
                        else -> transport.emit(successBody(requestIdOf(text), text))
                    }
                }
                assertFalse(viewModel.reconnectSelectedMachine())
                val afterFail = viewModel.uiState.value
                assertEquals(RemoteConnectionState.Disconnected, afterFail.remoteConnection)
                assertTrue(afterFail.syncGapWarning)
                assertEquals("pc-1", afterFail.selectedMachineId)
                assertEquals("ws-1", afterFail.selectedWorkspaceId)
                assertEquals("sess-1", afterFail.selectedSessionId)
                assertEquals(listOf("keep-me"), afterFail.chatMessages.map { it.text })
                assertEquals("perm-gap", afterFail.pendingPermission?.permissionId)
                assertEquals("workspace list failed", afterFail.errorMessage)
                failWorkspaceList = false
                assertTrue(viewModel.reconnectSelectedMachine())
                val after = viewModel.uiState.value
                assertEquals(RemoteConnectionState.Ready, after.remoteConnection)
                assertTrue(after.syncGapWarning)
                assertEquals("pc-1", after.selectedMachineId)
                assertEquals("ws-1", after.selectedWorkspaceId)
                assertEquals("sess-1", after.selectedSessionId)
                assertEquals(listOf("keep-me"), after.chatMessages.map { it.text })
                assertNull(after.pendingPermission)
                assertEquals("ws-1", after.workspaces.single().workspaceId)
                assertEquals("sess-1", after.sessions.single().remoteSessionId)
                assertEquals(loadsBefore, transport.sent.count { commandType(it) == "session.load" })
                assertEquals(sendsBefore, transport.sent.count { commandType(it) == "session.send" })
                assertEquals(cancelsBefore, transport.sent.count { commandType(it) == "session.cancel" })
                assertTrue(transport.sent.count { commandType(it) == "workspace.list" } >= 3)
                assertTrue(transport.sent.count { commandType(it) == "session.list" } >= 2)
            }
        }
    }

    @Test
    fun reconnectIsIgnoredWhileLoadingOrWhenAlreadyReady() {
        withViewModel { viewModel, dao, _ ->
            runBlocking {
                dao.upsert(pairedMachine())
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertFalse(viewModel.reconnectSelectedMachine())
                assertEquals(RemoteConnectionState.Ready, viewModel.uiState.value.remoteConnection)
            }
        }
    }

    @Test
    fun localRestoreSanitizesSelectionAndPersistsLatestWithoutClobberingCatchUp() {
        val store = VolatileReliabilityStore()
        runBlocking {
            store.setNeedsCatchUp(true)
            store.saveSelection(NavigationSelection("missing", "ws-1", "sess-1"))
        }
        withViewModel(reliabilityStore = store) { viewModel, _, _ ->
            runBlocking {
                assertNull(viewModel.uiState.value.selectedMachineId)
                assertNull(viewModel.uiState.value.selectedWorkspaceId)
                assertNull(viewModel.uiState.value.selectedSessionId)
                assertEquals(0L, viewModel.navigationRestore.value.revision)
                assertEquals(NavigationSelection(null, null, null), store.loadSelection())
                assertTrue(store.needsCatchUp())
                viewModel.selectMachine("pc-1")
                viewModel.selectWorkspace("ws-1")
                viewModel.selectSession("sess-1")
                assertEquals(NavigationSelection("pc-1", "ws-1", "sess-1"), store.loadSelection())
                assertTrue(store.needsCatchUp())
                viewModel.selectMachine("pc-2")
                assertEquals(NavigationSelection("pc-2", null, null), store.loadSelection())
            }
        }
        val blankStore = VolatileReliabilityStore()
        runBlocking { blankStore.saveSelection(NavigationSelection("pc-1", "", "sess-1")) }
        withViewModel(
            reliabilityStore = blankStore,
            prepare = { dao, _ -> dao.upsert(pairedMachine()) },
        ) { viewModel, _, _ ->
            assertEquals("pc-1", viewModel.uiState.value.selectedMachineId)
            assertNull(viewModel.uiState.value.selectedWorkspaceId)
            assertNull(viewModel.uiState.value.selectedSessionId)
            assertEquals(AppDestination.Workspaces, viewModel.navigationRestore.value.destination)
            assertTrue(viewModel.uiState.value.chatMessages.isEmpty())
        }
        val throwing =
            object : ReliabilityStore by VolatileReliabilityStore() {
                override suspend fun saveSelection(selection: NavigationSelection) = error("save")
            }
        withViewModel(reliabilityStore = throwing) { viewModel, _, _ ->
            viewModel.selectMachine("pc-1")
            assertEquals("pc-1", viewModel.uiState.value.selectedMachineId)
        }
        val loaded = CompletableDeferred<Unit>()
        val proceed = CompletableDeferred<Unit>()
        val inner = VolatileReliabilityStore()
        runBlocking { inner.saveSelection(NavigationSelection("pc-old", "ws-old", "sess-old")) }
        val gated =
            object : ReliabilityStore by inner {
                override suspend fun loadSelection(): NavigationSelection {
                    loaded.complete(Unit)
                    proceed.await()
                    return inner.loadSelection()
                }
            }
        withViewModel(
            reliabilityStore = gated,
            prepare = { dao, _ ->
                dao.upsert(pairedMachine())
                dao.upsert(MachineEntity("pc-old", "Old", "ws://127.0.0.1:8787", "device-old", 1L))
            },
        ) { viewModel, _, _ ->
            runBlocking {
                withTimeout(1_000) { loaded.await() }
                viewModel.selectMachine("pc-1")
                viewModel.selectWorkspace("ws-1")
                viewModel.selectSession("sess-1")
                proceed.complete(Unit)
                assertEquals("pc-1", viewModel.uiState.value.selectedMachineId)
                assertEquals("ws-1", viewModel.uiState.value.selectedWorkspaceId)
                assertEquals("sess-1", viewModel.uiState.value.selectedSessionId)
                assertEquals(NavigationSelection("pc-1", "ws-1", "sess-1"), inner.loadSelection())
                assertEquals(0L, viewModel.navigationRestore.value.revision)
            }
        }
    }

    @Test
    fun coldRestoreFallsBackAndLoadsValidSessionOnceWithEmptyChat() {
        val missingWs = VolatileReliabilityStore()
        runBlocking { missingWs.saveSelection(NavigationSelection("pc-1", "ws-gone", "sess-1")) }
        withViewModel(
            reliabilityStore = missingWs,
            appForeground = MutableStateFlow(true),
            prepare = { dao, _ -> dao.upsert(pairedMachine()) },
        ) { viewModel, _, transport ->
            val state = viewModel.uiState.value
            assertEquals("pc-1", state.selectedMachineId)
            assertNull(state.selectedWorkspaceId)
            assertNull(state.selectedSessionId)
            assertEquals(AppDestination.Workspaces, viewModel.navigationRestore.value.destination)
            assertTrue(state.chatMessages.isEmpty())
            assertEquals(0, transport.sent.count { commandType(it) == "session.load" })
            assertEquals(RemoteConnectionState.Ready, state.remoteConnection)
        }
        val missingSess = VolatileReliabilityStore()
        runBlocking { missingSess.saveSelection(NavigationSelection("pc-1", "ws-1", "sess-gone")) }
        withViewModel(
            reliabilityStore = missingSess,
            appForeground = MutableStateFlow(true),
            prepare = { dao, _ -> dao.upsert(pairedMachine()) },
        ) { viewModel, _, transport ->
            val state = viewModel.uiState.value
            assertEquals("pc-1", state.selectedMachineId)
            assertEquals("ws-1", state.selectedWorkspaceId)
            assertNull(state.selectedSessionId)
            assertEquals(AppDestination.Sessions, viewModel.navigationRestore.value.destination)
            assertEquals(0, transport.sent.count { commandType(it) == "session.load" })
        }
        val valid = VolatileReliabilityStore()
        runBlocking { valid.saveSelection(NavigationSelection("pc-1", "ws-1", "sess-1")) }
        withViewModel(
            reliabilityStore = valid,
            appForeground = MutableStateFlow(true),
            prepare = { dao, _ -> dao.upsert(pairedMachine()) },
        ) { viewModel, _, transport ->
            val state = viewModel.uiState.value
            assertEquals("pc-1", state.selectedMachineId)
            assertEquals("ws-1", state.selectedWorkspaceId)
            assertEquals("sess-1", state.selectedSessionId)
            assertEquals(AppDestination.Chat, viewModel.navigationRestore.value.destination)
            assertTrue(state.chatMessages.isEmpty())
            assertEquals(1, transport.sent.count { commandType(it) == "session.load" })
            assertEquals(0, transport.sent.count { commandType(it) == "session.send" })
        }
    }

    @Test
    fun notificationMailboxDedupsConsumeAndEvictsOldest() {
        val mailbox = NotificationTargetMailbox(maxDispatchedEventIds = 2)
        val first = NotificationTarget("pc-1", "sess-1", "evt-1")
        val second = NotificationTarget("pc-1", "sess-1", "evt-2")
        val third = NotificationTarget("pc-1", "sess-1", "evt-3")
        mailbox.publish(first)
        mailbox.publish(first)
        assertEquals(first, mailbox.target.value)
        mailbox.consume("evt-2")
        assertEquals(first, mailbox.target.value)
        mailbox.consume("evt-1")
        assertNull(mailbox.target.value)
        mailbox.publish(second)
        mailbox.publish(first)
        assertEquals(second, mailbox.target.value)
        mailbox.consume("evt-1")
        assertEquals(second, mailbox.target.value)
        mailbox.publish(third)
        mailbox.publish(first)
        assertEquals(first, mailbox.target.value)
        mailbox.consume("evt-2")
        assertEquals(first, mailbox.target.value)
        assertEquals(4096, NOTIFICATION_TARGET_EVENT_ID_LIMIT)
    }

    @Test
    fun deepLinkLoadsValidSessionOnceAndOpensEmptyChat() {
        val targets = MutableStateFlow<NotificationTarget?>(null)
        val consumed = mutableListOf<String>()
        withViewModel(
            notificationTargets = targets,
            consumeNotificationTarget = { consumed += it },
            prepare = { dao, _ -> dao.upsert(pairedMachine()) },
        ) { viewModel, _, transport ->
            targets.value = NotificationTarget("pc-1", "sess-1", "evt-valid")
            val state = viewModel.uiState.value
            assertEquals("pc-1", state.selectedMachineId)
            assertEquals("ws-1", state.selectedWorkspaceId)
            assertEquals("sess-1", state.selectedSessionId)
            assertEquals(AppDestination.Chat, viewModel.navigationRestore.value.destination)
            assertTrue(state.chatMessages.isEmpty())
            assertEquals(1, transport.sent.count { commandType(it) == "session.load" })
            assertNoPromptOrPermissionFrames(transport)
            assertEquals(listOf("evt-valid"), consumed)
        }
    }

    @Test
    fun deepLinkAlreadySelectedPreservesChatAndSkipsLoad() {
        val targets = MutableStateFlow<NotificationTarget?>(null)
        withViewModel(
            notificationTargets = targets,
            prepare = { dao, _ -> dao.upsert(pairedMachine()) },
        ) { viewModel, _, transport ->
            runBlocking {
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertTrue(viewModel.resumeSession("sess-1"))
                hangSessionSend(transport)
                viewModel.sendPrompt("keep-chat")
                assertEquals(listOf("keep-chat"), viewModel.uiState.value.chatMessages.map { it.text })
                val loadsBefore = transport.sent.count { commandType(it) == "session.load" }
                val sendsBefore = transport.sent.count { commandType(it) == "session.send" }
                val approvalsBefore = transport.sent.count { commandType(it) == "permission.approve" }
                val rejectsBefore = transport.sent.count { commandType(it) == "permission.reject" }
                targets.value = NotificationTarget("pc-1", "sess-1", "evt-same")
                val after = viewModel.uiState.value
                assertEquals("pc-1", after.selectedMachineId)
                assertEquals("ws-1", after.selectedWorkspaceId)
                assertEquals("sess-1", after.selectedSessionId)
                assertEquals(listOf("keep-chat"), after.chatMessages.map { it.text })
                assertEquals(AppDestination.Chat, viewModel.navigationRestore.value.destination)
                assertEquals(loadsBefore, transport.sent.count { commandType(it) == "session.load" })
                assertEquals(sendsBefore, transport.sent.count { commandType(it) == "session.send" })
                assertEquals(approvalsBefore, transport.sent.count { commandType(it) == "permission.approve" })
                assertEquals(rejectsBefore, transport.sent.count { commandType(it) == "permission.reject" })
            }
        }
    }

    @Test
    fun deepLinkMissingSessionSkipsLoadAndFallsBackToWorkspaces() {
        val targets = MutableStateFlow<NotificationTarget?>(null)
        withViewModel(
            notificationTargets = targets,
            prepare = { dao, _ -> dao.upsert(pairedMachine()) },
        ) { viewModel, _, transport ->
            targets.value = NotificationTarget("pc-1", "sess-gone", "evt-missing")
            val state = viewModel.uiState.value
            assertEquals("pc-1", state.selectedMachineId)
            assertNull(state.selectedWorkspaceId)
            assertNull(state.selectedSessionId)
            assertEquals("ws-1", state.workspaces.single().workspaceId)
            assertTrue(state.sessions.isEmpty())
            assertEquals(AppDestination.Workspaces, viewModel.navigationRestore.value.destination)
            assertEquals(0, transport.sent.count { commandType(it) == "session.load" })
            assertNoPromptOrPermissionFrames(transport)
        }
    }

    @Test
    fun deepLinkStaleMachineSkipsNetworkAndFallsBackToMachines() {
        val targets = MutableStateFlow<NotificationTarget?>(null)
        withViewModel(notificationTargets = targets) { viewModel, _, transport ->
            targets.value = NotificationTarget("missing-pc", "sess-1", "evt-stale")
            val state = viewModel.uiState.value
            assertNull(state.selectedMachineId)
            assertEquals(AppDestination.Machines, viewModel.navigationRestore.value.destination)
            assertTrue(transport.sent.isEmpty())
            assertEquals(RemoteConnectionState.Disconnected, state.remoteConnection)
            assertNoPromptOrPermissionFrames(transport)
        }
    }

    @Test
    fun deepLinkDoesNotOverrideUserSelectDuringSearch() {
        val targets = MutableStateFlow<NotificationTarget?>(null)
        withViewModel(
            autoRespond = false,
            notificationTargets = targets,
            prepare = { dao, _ -> dao.upsert(pairedMachine()) },
        ) { viewModel, _, transport ->
            runBlocking {
                val listed = CompletableDeferred<String>()
                transport.onSend = { text ->
                    if (commandType(text) == "workspace.list") {
                        listed.complete(text)
                    } else {
                        transport.emit(successBody(requestIdOf(text), text))
                    }
                }
                targets.value = NotificationTarget("pc-1", "sess-1", "evt-stale-user")
                val hung = withTimeout(1_000) { listed.await() }
                viewModel.selectMachine("pc-2")
                viewModel.selectWorkspace("ws-keep")
                transport.emit(successBody(requestIdOf(hung), hung))
                val after = viewModel.uiState.value
                assertEquals("pc-2", after.selectedMachineId)
                assertEquals("ws-keep", after.selectedWorkspaceId)
                assertNull(after.selectedSessionId)
                assertEquals(RemoteConnectionState.Disconnected, after.remoteConnection)
                assertEquals(0L, viewModel.navigationRestore.value.revision)
                assertEquals(0, transport.sent.count { commandType(it) == "session.load" })
                assertNoPromptOrPermissionFrames(transport)
            }
        }
    }

    @Test
    fun deepLinkMismatchedLoadIdFallsBackToWorkspaces() {
        val targets = MutableStateFlow<NotificationTarget?>(null)
        withViewModel(
            autoRespond = false,
            notificationTargets = targets,
            prepare = { dao, _ -> dao.upsert(pairedMachine()) },
        ) { viewModel, _, transport ->
            transport.onSend = { text ->
                if (commandType(text) == "session.load") {
                    transport.emit(
                        resultJson(
                            requestIdOf(text),
                            ok = true,
                            value =
                                """{"remoteSessionId":"sess-other","cursorSessionId":null,"workspaceId":"ws-1","title":"Session","status":"idle","createdAt":"c","updatedAt":"u"}""",
                        ),
                    )
                } else {
                    transport.emit(successBody(requestIdOf(text), text))
                }
            }
            targets.value = NotificationTarget("pc-1", "sess-1", "evt-mismatch")
            val state = viewModel.uiState.value
            assertEquals("pc-1", state.selectedMachineId)
            assertNull(state.selectedWorkspaceId)
            assertNull(state.selectedSessionId)
            assertEquals("ws-1", state.workspaces.single().workspaceId)
            assertEquals(AppDestination.Workspaces, viewModel.navigationRestore.value.destination)
            assertEquals(1, transport.sent.count { commandType(it) == "session.load" })
            assertNoPromptOrPermissionFrames(transport)
        }
    }

    @Test
    fun durableNeedsCatchUpForcesResyncClearsOnSuccessPreservesOnFailure() {
        val successStore = VolatileReliabilityStore()
        runBlocking { successStore.setNeedsCatchUp(true) }
        withViewModel(autoRespond = false, reliabilityStore = successStore) { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                transport.onSend = { text -> transport.emit(successBody(requestIdOf(text), text)) }
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                assertTrue(viewModel.resumeSession("sess-1"))
                transport.fail()
                val listsBefore = transport.sent.count { commandType(it) == "workspace.list" }
                val loadsBefore = transport.sent.count { commandType(it) == "session.load" }
                assertTrue(viewModel.reconnectSelectedMachine())
                assertFalse(successStore.needsCatchUp())
                assertTrue(transport.sent.count { commandType(it) == "workspace.list" } > listsBefore)
                assertEquals(loadsBefore, transport.sent.count { commandType(it) == "session.load" })
            }
        }
        val failStore = VolatileReliabilityStore()
        runBlocking { failStore.setNeedsCatchUp(true) }
        withViewModel(autoRespond = false, reliabilityStore = failStore) { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                transport.onSend = { text -> transport.emit(successBody(requestIdOf(text), text)) }
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                assertTrue(viewModel.openWorkspace("ws-1"))
                transport.fail()
                transport.onSend = { text ->
                    if (commandType(text) == "workspace.list") {
                        transport.emit(resultJson(requestIdOf(text), ok = false, value = "null", error = "workspace list failed"))
                    } else {
                        transport.emit(successBody(requestIdOf(text), text))
                    }
                }
                assertFalse(viewModel.reconnectSelectedMachine())
                assertTrue(failStore.needsCatchUp())
            }
        }
        val throwing =
            object : ReliabilityStore by VolatileReliabilityStore() {
                override suspend fun needsCatchUp(): Boolean = error("db")
            }
        withViewModel(reliabilityStore = throwing) { viewModel, dao, transport ->
            runBlocking {
                dao.upsert(pairedMachine())
                assertTrue(viewModel.connectExistingMachine("pc-1"))
                transport.fail()
                val listsBefore = transport.sent.count { commandType(it) == "workspace.list" }
                assertTrue(viewModel.reconnectSelectedMachine())
                assertEquals(RemoteConnectionState.Ready, viewModel.uiState.value.remoteConnection)
                assertTrue(viewModel.uiState.value.syncGapWarning)
                assertTrue(transport.sent.count { commandType(it) == "workspace.list" } > listsBefore)
            }
        }
    }

    @Test
    fun onClearedDoesNotDisconnectRepository() {
        val job = SupervisorJob()
        val scope = CoroutineScope(job + Dispatchers.Unconfined)
        val dao = FakeMachineDao()
        val transport = FakeTransport(true)
        val repository =
            RemoteRepository(
                transport = transport,
                credentialStore = JavaEcdsaCredentialStore(),
                scope = scope,
                requestTimeoutMs = 1_000,
            )
        val store = ViewModelStore()
        val provider =
            ViewModelProvider(
                store,
                object : ViewModelProvider.Factory {
                    @Suppress("UNCHECKED_CAST")
                    override fun <T : ViewModel> create(modelClass: Class<T>): T =
                        CursorRemoteViewModel(
                            machineDao = dao,
                            hiddenModelDao = FakeHiddenModelDao(),
                            remoteRepository = repository,
                            coroutineScope = scope,
                            nowMillis = { 1_699_000_000_000L },
                        ) as T
                },
            )
        try {
            val viewModel = provider[CursorRemoteViewModel::class.java]
            runBlocking {
                dao.upsert(pairedMachine())
                assertTrue(viewModel.connectExistingMachine("pc-1"))
            }
            assertEquals(RemoteConnectionState.Ready, repository.connectionState.value)
            store.clear()
            assertEquals(RemoteConnectionState.Ready, repository.connectionState.value)
            assertEquals(ConnectionState.Connected, transport.connectionState.value)
        } finally {
            repository.disconnect()
            job.cancel()
        }
    }

    private fun withViewModel(
        autoRespond: Boolean = true,
        hiddenModelDao: HiddenModelDao = FakeHiddenModelDao(),
        reliabilityStore: ReliabilityStore = VolatileReliabilityStore(),
        appForeground: MutableStateFlow<Boolean> = MutableStateFlow(false),
        notificationTargets: StateFlow<NotificationTarget?> = MutableStateFlow(null),
        consumeNotificationTarget: (String) -> Unit = {},
        prepare: suspend (FakeMachineDao, ReliabilityStore) -> Unit = { _, _ -> },
        block: (CursorRemoteViewModel, FakeMachineDao, FakeTransport) -> Unit,
    ) {
        val job = SupervisorJob()
        val scope = CoroutineScope(job + Dispatchers.Unconfined)
        val dao = FakeMachineDao()
        runBlocking { prepare(dao, reliabilityStore) }
        val transport = FakeTransport(autoRespond)
        val repository =
            RemoteRepository(
                transport = transport,
                credentialStore = JavaEcdsaCredentialStore(),
                scope = scope,
                requestTimeoutMs = 1_000,
            )
        val viewModel =
            CursorRemoteViewModel(
                machineDao = dao,
                hiddenModelDao = hiddenModelDao,
                remoteRepository = repository,
                coroutineScope = scope,
                nowMillis = { 1_699_000_000_000L },
                reliabilityStore = reliabilityStore,
                appForeground = appForeground,
                notificationTargets = notificationTargets,
                consumeNotificationTarget = consumeNotificationTarget,
            )
        try {
            block(viewModel, dao, transport)
        } finally {
            repository.disconnect()
            job.cancel()
        }
    }

    private fun validQrJson(): String {
        val token = RemoteProtocol.encodeBase64Url(ByteArray(32) { 3 })
        return """{"v":1,"relayUrl":"ws://127.0.0.1:8787","machineId":"pc-1","token":"$token","expiresAt":1700000000000}"""
    }

    private fun pairedMachine(): MachineEntity {
        return MachineEntity("pc-1", "PC", "ws://127.0.0.1:8787", "device-1", 1L)
    }
}

internal class FakeMachineDao : MachineDao {
    val machines = MutableStateFlow<List<MachineEntity>>(emptyList())

    override fun observeMachines(): Flow<List<MachineEntity>> = machines

    override suspend fun getMachine(id: String): MachineEntity? = machines.value.find { it.id == id }

    override suspend fun upsert(machine: MachineEntity) {
        machines.value = machines.value.filter { it.id != machine.id } + machine
    }

    override suspend fun updateConnectionInfo(
        id: String,
        relayUrl: String,
        deviceId: String,
        lastConnectedAt: Long,
    ) {
        machines.value =
            machines.value.map { machine ->
                if (machine.id == id) {
                    machine.copy(relayUrl = relayUrl, deviceId = deviceId, lastConnectedAt = lastConnectedAt)
                } else {
                    machine
                }
            }
    }
}

internal class FakeHiddenModelDao : HiddenModelDao {
    val hidden = MutableStateFlow<List<String>>(emptyList())

    override fun observeHiddenModelIds(): Flow<List<String>> = hidden

    override suspend fun hide(entity: HiddenModelEntity) {
        hidden.value = hidden.value.filter { it != entity.modelId } + entity.modelId
    }

    override suspend fun show(modelId: String) {
        hidden.value = hidden.value.filter { it != modelId }
    }
}

internal class FakeTransport(
    autoRespond: Boolean,
    initialAutoChallenge: Boolean = true,
) : WebSocketTransport {
    private val _connectionState = MutableStateFlow(ConnectionState.Disconnected)
    private val _incoming = MutableSharedFlow<TransportMessage>(extraBufferCapacity = 64)
    override val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()
    override val incomingMessages = _incoming.asSharedFlow()
    override var generation: Long = 0L
        private set
    var connectUrl: String? = null
    val sent = mutableListOf<String>()
    var autoChallenge = initialAutoChallenge
    var onSend: ((String) -> Unit)? = if (autoRespond) ({ text -> emit(successBody(requestIdOf(text), text)) }) else null
    var onConnect: (() -> Unit)? = null

    override fun connect(url: String) {
        connectUrl = url
        generation += 1
        _connectionState.value = ConnectionState.Connected
        onConnect?.invoke()
        if (autoChallenge && _connectionState.value == ConnectionState.Connected) {
            val nonce = RemoteProtocol.encodeBase64Url(ByteArray(32) { 4 })
            emit("""{"kind":"auth_challenge","nonce":"$nonce"}""")
        }
    }

    override fun send(text: String) {
        sent += text
        onSend?.invoke(text)
    }

    override fun disconnect() {
        _connectionState.value = ConnectionState.Disconnected
    }

    fun emit(
        text: String,
        generationOverride: Long? = null,
    ) {
        _incoming.tryEmit(TransportMessage(generationOverride ?: generation, text))
    }

    fun fail() {
        _connectionState.value = ConnectionState.Failed
    }
}

internal class JavaEcdsaCredentialStore : DeviceCredentialStore {
    private val keyPair: KeyPair =
        KeyPairGenerator.getInstance("EC").run {
            initialize(ECGenParameterSpec("secp256r1"))
            generateKeyPair()
        }

    override fun createDeviceKey(): PublicKey = keyPair.public

    override fun getDeviceKey(): PublicKey? = keyPair.public

    override fun deleteDeviceKey() = Unit

    override fun signSha256Ecdsa(payload: ByteArray): ByteArray {
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(keyPair.private)
        signature.update(payload)
        return signature.sign()
    }
}

internal fun requestIdOf(text: String): String {
    val root = Json.parseToJsonElement(text).jsonObject
    return if (root["kind"]?.jsonPrimitive?.content == "command") {
        root.getValue("command").jsonObject.getValue("requestId").jsonPrimitive.content
    } else {
        root.getValue("requestId").jsonPrimitive.content
    }
}

internal fun commandType(text: String): String? {
    val root = Json.parseToJsonElement(text).jsonObject
    if (root["kind"]?.jsonPrimitive?.content != "command") {
        return null
    }
    return root.getValue("command").jsonObject.getValue("type").jsonPrimitive.content
}

internal fun resultJson(
    requestId: String,
    ok: Boolean,
    value: String,
    error: String? = null,
): String {
    val errorJson = if (error == null) "null" else "\"$error\""
    return """{"kind":"result","result":{"requestId":"$requestId","ok":$ok,"value":$value,"error":$errorJson}}"""
}

internal fun successBody(
    requestId: String,
    text: String,
): String {
    val value =
        when (Json.parseToJsonElement(text).jsonObject.getValue("kind").jsonPrimitive.content) {
            "pair", "auth_proof" -> """{"deviceId":"device-1"}"""
            "transport_register" -> """{"registered":true}"""
            "command" ->
                when (commandType(text)) {
                    "workspace.list" ->
                        """[{"workspaceId":"ws-1","name":"app","path":"/app","gitBranch":"main","modified":false,"activeSessionCount":0,"lastUsedAt":null}]"""
                    "session.list" ->
                        """[{"remoteSessionId":"sess-1","cursorSessionId":null,"workspaceId":"ws-1","title":"Session","status":"idle","createdAt":"c","updatedAt":"u"}]"""
                    "session.create" ->
                        """{"remoteSessionId":"sess-new","cursorSessionId":null,"workspaceId":"ws-1","title":"Session","status":"idle","createdAt":"c","updatedAt":"u"}"""
                    "session.load" ->
                        """{"remoteSessionId":"sess-1","cursorSessionId":null,"workspaceId":"ws-1","title":"Session","status":"idle","createdAt":"c","updatedAt":"u"}"""
                    "diff.read" -> snapshotJson(
                        Json.parseToJsonElement(text).jsonObject.getValue("command").jsonObject
                            .getValue("payload").jsonObject.getValue("workspaceId").jsonPrimitive.content,
                    )
                    "file.read" -> {
                        val path =
                            Json.parseToJsonElement(text).jsonObject.getValue("command").jsonObject
                                .getValue("payload").jsonObject.getValue("path").jsonPrimitive.content
                        """{"path":"$path","content":"file-body","truncated":false}"""
                    }
                    "model.list" -> catalogJson()
                    "model.select" -> {
                        val modelId =
                            Json.parseToJsonElement(text).jsonObject.getValue("command").jsonObject
                                .getValue("payload").jsonObject.getValue("modelId").jsonPrimitive.content
                        catalogJson(currentModelId = modelId)
                    }
                    "sync.catch_up" -> {
                        val lastEventId =
                            Json.parseToJsonElement(text)
                                .jsonObject
                                .getValue("command")
                                .jsonObject
                                .getValue("payload")
                                .jsonObject
                                .getValue("lastEventId")
                        val head = if (lastEventId.toString() == "null") "null" else lastEventId.toString()
                        """{"status":"replayed","events":[],"headEventId":$head,"pendingPermission":null}"""
                    }
                    else -> "null"
                }
            else -> "null"
        }
    return resultJson(requestId, ok = true, value = value)
}

private val eventJsonSeq = AtomicLong(0)

internal fun eventJson(
    type: String,
    sessionId: String?,
    payload: String,
    eventId: String? = null,
): String {
    val id = eventId ?: "evt-auto-${eventJsonSeq.incrementAndGet()}"
    val sessionJson = if (sessionId == null) "null" else "\"$sessionId\""
    return """{"kind":"event","event":{"eventId":"$id","sessionId":$sessionJson,"timestamp":"t","type":"$type","payload":$payload}}"""
}

internal fun snapshotJson(
    workspaceId: String,
    additions: Int = 0,
): String =
    """{"workspaceId":"$workspaceId","available":true,"source":"git","files":[],"truncated":false,"omittedCount":0,"totalAdditions":$additions,"totalDeletions":0}"""

internal fun catalogJson(
    currentModelId: String? = "mock-model",
    extraModelJson: String? = null,
): String {
    val current = if (currentModelId == null) "null" else "\"$currentModelId\""
    val extra = extraModelJson?.let { ",$it" } ?: ""
    return """{"models":[{"id":"mock-model","displayName":"Mock","description":null,"parameters":[],"variants":[],"available":true},{"id":"mock-fast","displayName":"Mock Fast","description":"Faster mock","parameters":[],"variants":[],"available":true},{"id":"fixture-added-model","displayName":"fixture-added-model","description":null,"parameters":[],"variants":[],"available":true},{"id":"unavailable-mock","displayName":"Unavailable Mock","description":null,"parameters":[],"variants":[],"available":false}$extra],"currentModelId":$current}"""
}

internal fun lastCommand(
    transport: FakeTransport,
    type: String,
): String = transport.sent.last { commandType(it) == type }

internal fun hangDiffRead(transport: FakeTransport) {
    transport.onSend = { text ->
        if (commandType(text) != "diff.read") {
            transport.emit(successBody(requestIdOf(text), text))
        }
    }
}

internal fun hangModelList(transport: FakeTransport) {
    transport.onSend = { text ->
        if (commandType(text) != "model.list") {
            transport.emit(successBody(requestIdOf(text), text))
        }
    }
}

internal fun hangFileRead(transport: FakeTransport) {
    transport.onSend = { text ->
        if (commandType(text) != "file.read") {
            transport.emit(successBody(requestIdOf(text), text))
        }
    }
}

internal fun hangSessionSend(
    transport: FakeTransport,
    hangCancel: Boolean = false,
) {
    transport.onSend = { text ->
        val type = commandType(text)
        val hang = type == "session.send" || (hangCancel && type == "session.cancel")
        if (!hang) {
            transport.emit(successBody(requestIdOf(text), text))
        }
    }
}

internal fun assertNoPromptOrPermissionFrames(transport: FakeTransport) {
    assertEquals(0, transport.sent.count { commandType(it) == "session.send" })
    assertEquals(0, transport.sent.count { commandType(it) == "permission.approve" })
    assertEquals(0, transport.sent.count { commandType(it) == "permission.reject" })
}
