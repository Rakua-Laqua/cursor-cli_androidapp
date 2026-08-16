# daemon

PC 上で Cursor CLI / ACP と通信し、Workspace 境界・Session・Permission・File access の最終 authority になる Local Daemon です。

Phase 1 の TASK-102 では、Remote Protocol の `session.create` / `session.load` / `session.send` / `session.cancel` を Cursor ACP の `session/new` / `session/load` / `session/prompt` / `session/cancel`（notification）へ接続します。`initialize` → `authenticate` は Session Adapter が初回利用時に遅延実行し、`Daemon.start` ではプロセス起動だけを行います。

Workspace の allowedRoots / symlink 検査は TASK-103 の Scope です。TASK-102 では `session.create` の `workspaceId` を、実在するディレクトリへのパスとして扱います。
