# relay

Android と Local Daemon の接続を中継する Relay Server です。Relay はソースコードや File content の正本を保持しません。

v1.3.0 の TASK-200 で localhost WebSocket core を持ちます。Daemon は `/machine?machineId=`、client は `/client?machineId=` に接続します。frame は `command` / `event` / `result` です。heartbeat は WebSocket ping/pong です。インターネット公開と TLS は Scope 外です。

v1.4.0 で Device Pairing による `/client` 認証ゲートを追加しました。TLS とインターネット公開は未実装です。進捗は `docs/implementation_status.md` を見てください。
