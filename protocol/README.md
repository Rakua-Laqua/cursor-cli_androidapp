# protocol

Remote Protocol の共有型と JSON 境界処理を提供します。

このモジュールは Cursor ACP の型を Android / Relay へ漏らしません。未知の Event type は `unknown` として保持し、将来 Cursor/Daemon 側で Event が追加されても受信プロセス全体を停止させないことを境界条件とします。

v1.3.0 で `command` / `event` / `result` の Remote frame を追加しました。v1.4.0 で Device Pairing の QR / 証明型を追加しました。進捗は `docs/implementation_status.md` を見てください。
