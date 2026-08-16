# android

Android ネイティブクライアントです。設計上の UI 技術は Kotlin / Jetpack Compose です。

Phase 0 は build 可能性だけを固定し、Machines / Workspaces / Sessions / Chat、WebSocket、Room、Keystore 等は TASK-202 以降で実装します。

```bash
gradle :app:assembleDebug :app:testDebugUnitTest
```
