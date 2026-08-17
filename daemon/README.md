# daemon

PC 上で Cursor CLI / ACP と通信し、Workspace 境界・Session・Permission・File access の最終 authority になる Local Daemon です。

Phase 1 の TASK-103 では Workspace を第一級オブジェクトとして扱い、`allowedRoots` 配下だけを `workspace.register` できます。canonical path と symlink 解決後に許可ルート外へ出るパスは拒否します。`session.create` の `workspaceId` は登録済み Workspace の ID です。

`workspace.list` / `workspace.register` は Git branch・未コミット変更・稼働中 Session 数・最終利用日時を返します。Workspace / Session のディスク永続化は TASK-104 の Scope です。
