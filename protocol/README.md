# protocol

Remote Protocol の共有型と JSON 境界処理を提供します。

このモジュールは Cursor ACP の型を Android / Relay へ漏らしません。未知の Event type は `unknown` として保持し、将来 Cursor/Daemon 側で Event が追加されても受信プロセス全体を停止させないことを境界条件とします。

v1.3.0 で `command` / `event` / `result` の Remote frame を追加しました。v1.4.0 で Device Pairing の QR / 証明型を追加しました。

## transport_register / FCM data（v1.20.0）

`transport_register` は認証後 client が Relay へ出す frame です。キーは `kind` / `requestId` / `fcmToken` / `appForeground` のみ。本文は 8192 bytes まで。`requestId` は 128 文字まで。`appForeground` は boolean。`fcmToken` は `null`、または 4096 文字までの `[A-Za-z0-9_.:-]+` です。

FCM data payload は `eventId` / `type` / `machineId` / `sessionId` の 4 キーだけです。余分なフィールドは拒否します。`type` は `permission.requested` / `agent.completed` / `agent.failed` / `agent.waiting`。`sessionId` だけ空文字を許します。各 ID は 512 文字まで。notification の `notification` ブロックは契約に含めません。

進捗は `docs/implementation_status.md` を見てください。
