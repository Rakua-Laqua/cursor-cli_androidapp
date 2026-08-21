# android

Android ネイティブクライアントです。設計上の UI 技術は Kotlin / Jetpack Compose です。

## v1.6.0（TASK-203）

開始画面は Machines。Pairing QR v1 JSON の貼り付け、または既存 Machine の再認証に成功したときだけ Workspaces / Sessions へ進みます。Workspace は name / path / gitBranch / modified / activeSessionCount、Session は title / status / updatedAt を表示します。Chat は TASK-204 未実装。Camera / TLS / Gate B は含みません。

秘密鍵は Android Keystore に置き export しません。Room には成功した `deviceId` と接続情報だけを保存します。

## 検証

```bash
gradle :app:assembleDebug :app:testDebugUnitTest
```

JVM unit test は codec、canonical proof、invalid QR、request correlation / auth、ViewModel の list / new / resume を検証します。実機、network、Android Keystore は使いません。
