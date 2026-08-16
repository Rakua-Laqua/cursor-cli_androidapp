# daemon

PC 上で Cursor CLI / ACP と通信し、Workspace 境界・Session・Permission・File access の最終 authority になる Local Daemon です。

Phase 0 では module boundary と Protocol 参照だけを定義します。ACP process 管理や Workspace 実処理は Phase 1 の Scope です。
