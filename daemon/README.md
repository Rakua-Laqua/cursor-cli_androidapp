# daemon

PC 上で Cursor CLI / ACP と通信し、Workspace 境界・Session・Permission・File access の最終 authority になる Local Daemon です。

Phase 1 の TASK-104 では、Workspace と Session の metadata を `stateDir/metadata.json` に永続化します。`Daemon.start({ stateDir })` を渡すと、再起動後に Workspace 一覧と Session 一覧を復元し、Cursor 側 Session を `session.load` できます。`session.list` は `workspaceId` で絞り込みます。`stateDir` を渡さない場合は従来どおりプロセス内メモリのみです。

`allowedRoots` は Daemon 起動時に実在するディレクトリとして canonicalize し、その値を結界として固定します。判定時に許可ルート自身を再 realpath しません。`session.create` / `session.load` / `session.send`、および `workspace.list` や Git metadata の更新は、登録済み path を realpath して固定済み `allowedRoots` に再照合したうえで行います。復元時に許可ルート外へ出る Workspace / Session はメモリへ載せません。`session.create` の `workspaceId` は登録済み Workspace の ID です。

`workspace.list` / `workspace.register` は Git branch・未コミット変更・稼働中 Session 数・最終利用日時を返します。会話本文は Cursor 側 Session を正本とし、Local E2E ハーネスは TASK-105 の Scope です。
