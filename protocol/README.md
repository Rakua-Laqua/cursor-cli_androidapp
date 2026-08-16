# protocol

Remote Protocol の共有型と JSON 境界処理を提供します。

このモジュールは Cursor ACP の型を Android / Relay へ漏らしません。未知の Event type は `unknown` として保持し、将来 Cursor/Daemon 側で Event が追加されても受信プロセス全体を停止させないことを境界条件とします。
