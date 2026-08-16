# relay

Android と Local Daemon の接続を中継する Relay Server です。Relay はソースコードや File content の正本を保持しません。

Phase 0 では module boundary と Protocol 参照だけを定義します。WebSocket routing、pairing、heartbeat は Phase 2 の Scope です。
