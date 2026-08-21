# android

Android ネイティブクライアントです。設計上の UI 技術は Kotlin / Jetpack Compose です。

Phase 0 は build 可能性だけを固定し、Machines / Workspaces / Sessions / Chat、WebSocket、Room、Keystore 等は TASK-202 以降で実装します。v1.4.0 でも Android 実データフローは未着手です。バックエンド側の進捗は `docs/implementation_status.md` を見てください。

```bash
gradle :app:assembleDebug :app:testDebugUnitTest
```
