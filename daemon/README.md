# daemon

PC 上で Cursor CLI / ACP と通信し、Workspace 境界・Session・Permission・File access の最終 authority になる Local Daemon です。

Phase 1 の TASK-104 では、Workspace と Session の metadata を `stateDir/metadata.json` に永続化します。`Daemon.start({ stateDir })` を渡すと、再起動後に Workspace 一覧と Session 一覧を復元し、Cursor 側 Session を `session.load` できます。`session.list` は `workspaceId` で絞り込みます。`selectedModelId` は `session/new` / `session/load` 応答の `models.currentModelId` から保存し、モデル名はハードコードしません。壊れた metadata や不正な `allowedRoots` では ACP を起動しません。`stateDir` を渡さない場合は従来どおりプロセス内メモリのみです。

`allowedRoots` は Daemon 起動時に実在するディレクトリとして canonicalize し、その値を結界として固定します。判定時に許可ルート自身を再 realpath しません。`session.create` / `session.load` / `session.send`、および `workspace.list` や Git metadata の更新は、登録済み path を realpath して固定済み `allowedRoots` に再照合したうえで行います。復元時に許可ルート外へ出る Workspace / Session はメモリへ載せません。`session.create` の `workspaceId` は登録済み Workspace の ID です。

`workspace.list` / `workspace.register` は Git branch・未コミット変更・稼働中 Session 数・最終利用日時を返します。会話本文は Cursor 側 Session を正本とし、ファイルには含めません。

## Local E2E

`remote-dev` は Relay / Android の前に Phase 1 を固定する簡易クライアントです。mock ACP に対する一連操作は `npm test` に含まれます。2026-08-17 の Windows 確認（mock ACP）は `docs/local_e2e_report.md` に記録済みです。

リポジトリルート:

```bat
npm run build
npm run remote-dev -- --help
npm run remote-dev -- e2e --acp-command node --acp-arg test/fixtures/mock-acp.mjs
```

`--acp-arg` のパスは daemon ワークスペース基準です。成功時は `streamed echo:e2e-stream`、`cancelled`、`daemon restarted`、`continued echo:e2e-continue`、`e2e ok <remoteSessionId>` まで進みます。

単発コマンドは `--state-dir` と `--allowed-root` が必要です。リポジトリルートは既定の許可ルートになりません。各コマンドが ACP を起動し直すため、`session send` は送る前に Cursor 側 Session を `session.load` します。実行中の streaming を止める場合は `session send` を Ctrl+C するか、`e2e` コマンドを使います。

```bash
npm run remote-dev -- --state-dir ./runtime-data --allowed-root <workspace> workspace select <workspace>
npm run remote-dev -- --state-dir ./runtime-data --allowed-root <workspace> session create <workspaceId>
npm run remote-dev -- --state-dir ./runtime-data --allowed-root <workspace> session list
npm run remote-dev -- --state-dir ./runtime-data --allowed-root <workspace> session send <sessionId> "..."
npm run remote-dev -- --state-dir ./runtime-data --allowed-root <workspace> session cancel <sessionId>
```

`--acp-command` を省略すると実 Cursor CLI の ACP を解決します。Cursor Desktop は不要です。Relay と Android の実データフローは Phase 2 です。
