# android

Android ネイティブクライアントです。設計上の UI 技術は Kotlin / Jetpack Compose です。

## TASK-202 の範囲

v1.5.0 の Application Skeleton です。開始画面は Machines で、Machines / Workspaces / Sessions / Chat の 4 destination を Navigation Compose で定義します。各画面は TASK-203 / TASK-204 未実装と分かるプレースホルダで、前後へ遷移できます。実 Machine / Workspace / Session 一覧、Chat 送受信、QR カメラ、TLS、Relay 自動接続は含みません。Gate B は未到達です。次は TASK-203 です。

## モジュール構成

- `CursorRemoteApplication` / `di.AppContainer` — Application 所有の手動 DI。Room、Keystore credential store、OkHttp WebSocket transport、ViewModel factory を生成して注入します。Hilt / Koin は使いません。
- `ui.CursorRemoteApp` — 4 destination のプレースホルダと前後遷移。
- `state.CursorRemoteViewModel` — 選択中 machine / workspace / session と transport 接続状態。選択変更時は下位選択をクリアします。
- `data.local.CursorRemoteDatabase` — `MachineEntity` の Flow 一覧。秘密情報や message / file 内容は保存しません。
- `data.security.DeviceCredentialStore` — Android Keystore の EC P-256 device key の作成・取得・削除。秘密鍵は export しません。
- `data.transport.WebSocketTransport` — `connect` / `send` / `disconnect`。URL は `ws` / `wss` のみ。起動時に自動接続しません。

## 検証

```bash
gradle :app:assembleDebug :app:testDebugUnitTest
```

`FoundationTest` は destination 順序、初期 state、選択の cascade clear を検証します。
