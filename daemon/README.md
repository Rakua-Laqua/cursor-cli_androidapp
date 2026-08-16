# daemon

PC 上で Cursor CLI / ACP と通信し、Workspace 境界・Session・Permission・File access の最終 authority になる Local Daemon です。

Phase 1 の TASK-101 では Cursor ACP を子プロセスとして起動し、stdin/stdout の JSON-RPC とプロセス寿命を管理します。Session 作成・Prompt・Event 変換は TASK-102 の Scope です。
