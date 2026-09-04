# android

Android ネイティブクライアントです。設計上の UI 技術は Kotlin / Jetpack Compose です。製品範囲の正本は `docs/implementation_status.md`、運用向け FCM は `relay/README.md`、payload 契約は `protocol/README.md` です。

## v1.20.0（TASK-604）

`android/app/google-services.json` があるときだけ `google-services` plugin を適用します。ファイルは gitignore 済みです。無い場合も build と非 FCM 機能は動き、FCM bootstrap は no-op です。FCM token は process memory のみで、永続化も log もしません。

foreground 中は FCM 通知を出さず、bounded reconnect / catch-up だけを行います。background 時は FCM を wake path にし、background WebSocket を常駐再接続しません。通知 tap は厳密な machine / session 解決です。通知から prompt / permission action は自動再実行しません。

Room database v4 へ、選択、machine 別 cursor、`needsCatchUp`、通知 `eventId` dedup を永続化します（非破壊 Migration 3→4）。Chat 本文は永続化しません。live FCM 配送・通知 tap 実機・Doze 配送は未実施です。

## v1.7.0（TASK-204）

開始画面は Machines。Pairing QR v1 JSON の貼り付け、または既存 Machine の再認証に成功したときだけ Workspaces / Sessions / Chat へ進みます。Workspace は name / path / gitBranch / modified / activeSessionCount、Session は title / status / updatedAt を表示します。Chat は User / Assistant、status / error / completed / stopped、入力、Send、応答中 Stop をメモリ内で扱います。履歴永続化 / 再接続復元、Camera / TLS / Gate B は含みません。

秘密鍵は Android Keystore に置き export しません。Room には成功した `deviceId` と接続情報だけを保存します。

## 検証

```bash
gradle :app:assembleDebug :app:testDebugUnitTest
```

JVM unit test は codec、canonical proof、invalid QR、request correlation / auth、ViewModel の list / new / resume、Chat payload / event / send / terminal、Room reliability、FCM bootstrap / deep link を検証します。実機、network、Android Keystore、live FCM は使いません。
