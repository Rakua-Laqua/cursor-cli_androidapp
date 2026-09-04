# relay

Android と Local Daemon の接続を中継する Relay Server です。Relay はソースコードや File content の正本を保持しません。

v1.3.0 の TASK-200 で localhost WebSocket core を持ちます。Daemon は `/machine?machineId=`、client は `/client?machineId=` に接続します。frame は `command` / `event` / `result` です。heartbeat は WebSocket ping/pong です。インターネット公開と TLS は Scope 外です。

v1.4.0 で Device Pairing による `/client` 認証ゲートを追加しました。TLS とインターネット公開は未実装です。localhost の非認証 `/machine` `ws://` のままインターネットへ公開しないでください。

## FCM（v1.20.0）

`FCM_PROJECT_ID` と `FCM_ACCESS_TOKEN` の両方があるときだけ HTTP v1 で data-only、Android `priority: HIGH` を送ります。片方でも無ければ従来の WebSocket Relay は動き、FCM だけ無効です。access token は短命なので、運用側で更新して Relay を再起動してください。秘密は commit / log しません。

token registry は process memory のみです。認証済み端末を `machineId`+`deviceId` の slot として保持し、同じ machine event の対象にできます。payload 契約は `protocol/README.md`、端末側の wake / deep link は `android/README.md` です。

進捗は `docs/implementation_status.md` を見てください。
