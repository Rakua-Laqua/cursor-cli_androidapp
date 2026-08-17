# daemon

PC 上で Cursor CLI / ACP と通信し、Workspace 境界・Session・Permission・File access の最終 authority になる Local Daemon です。

Phase 1 の TASK-103 では Workspace を第一級オブジェクトとして扱い、`allowedRoots` 配下だけを `workspace.register` できます。`allowedRoots` は Daemon 起動時に実在するディレクトリとして canonicalize し、その値を結界として固定します。判定時に許可ルート自身を再 realpath しません。`session.create` / `session.load` の直前には、登録済み path を realpath して固定済み `allowedRoots` に再照合します。`session.create` の `workspaceId` は登録済み Workspace の ID です。

`workspace.list` / `workspace.register` は Git branch・未コミット変更・稼働中 Session 数・最終利用日時を返します。Workspace / Session のディスク永続化は TASK-104 の Scope です。
