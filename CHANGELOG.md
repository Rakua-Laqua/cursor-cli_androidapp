# CHANGELOG

## [1.3.0] - 2026-08-17

### 追加

- Relay WebSocket Core を追加した。Local Daemon は `/machine` へ outbound 接続し、`/client` から受けた Remote Protocol の `workspace.*` / `session.*` Command を中継する。`requestId` で応答を送信元 client へ返し、Workspace / Session Event は同じ Machine の client へ転送する。Relay は Command / Event、ソースコード、ファイル内容を永続化しない。
- WebSocket の ping / pong heartbeat、stale connection 終了、Machine 切断時の pending request エラー化、offline 中の Command 拒否、Machine 置換後の旧 connection 無効化を追加した。

### 変更

- Remote Protocol に `command` / `event` / `result` frame と `RemoteCommandResult` を追加した。成功時の未定義値は JSON `null`、失敗時は stack trace を含まない単一行メッセージとして扱う。既存の Event / Command 形式は維持する。
- ルートの `npm test` で Protocol、Daemon、Relay の build と test を一連で実行する。WebSocket 実装には `ws` 8.21.3 と `@types/ws` 8.18.1 を使用する。

### セキュリティ

- 現段階の Relay は localhost 用の非認証 `ws://` core であり、インターネットへ公開しない。Pairing、device authentication、TLS、Android client は TASK-201 以降で実装する。

### テスト

- Protocol frame/result の round-trip と不整合拒否、Relay の routing / correlation / heartbeat / disconnect / replacement、mock ACP での Workspace 登録・Session 作成・streaming・cancel・Daemon 再起動・load・会話継続を WebSocket 越しに検証した。

## [1.2.1] - 2026-08-17

### 変更

- `remote-dev e2e` は mock 固有の `echo:` / `DELAY` 契約を使わない。初回と follow-up は一意 token（`E2ESTR_` / `E2ECON_`）を含む `assistant.message` を確認し、streaming は `agent.completed` / `agent.failed` / `agent.interrupted` より前に `assistant.message` が届いたことで判定する。cancel は長い回答を要求した直後に in-process の `session/cancel` notification を送る。e2e 中の `session/request_permission` には、TASK-100 で観測した `reject-once` を返す。
- `--acp-command` を省略した `remote-dev e2e` は実 Cursor CLI の ACP で一連操作できる。mock ACP 経路は回帰として残す。

### 削除

- 単発 `session cancel` は公開しない。各起動が新しい ACP プロセスになるため、別プロセスの prompt を止められることは実測していない。実行中の停止は `session send` の Ctrl+C、または in-process の `e2e`。呼び出した場合は usage error になる。

### ドキュメント

- `docs/local_e2e_report.md` に、Windows 上で実 Cursor CLI（`--acp-command` 省略）に対する `remote-dev e2e` が成功したことを記録した。出力は `streamed E2ESTR_...` → `cancelled` → `daemon restarted` → `session loaded` → `continued E2ECON_...` → `e2e ok`。Gate A は実 Cursor CLI 経路で通過。Relay / Android は未着手。

### テスト

- token 含有と in-process cancel による e2e、単発 `session cancel` が usage error になることを検証するテストを更新した。

## [1.2.0] - 2026-08-17

### 追加

- Local E2E ハーネス `remote-dev` を追加した。`workspace list` / `workspace select` / `workspace register`、`session create` / `session list` / `session send` / `session cancel` / `session load`、`e2e` を、リポジトリルートの `npm run remote-dev` から実行できる。`session list` は `workspaceId` を省略すると登録済み全 Workspace の Session を返す。Cursor Desktop は不要。Relay と Android の実データフローは Phase 2。
- `remote-dev e2e` は `workspace select` → `session create` → prompt → streaming → cancel → Daemon 再起動 → `session load` → 会話継続を一連で実行する。`--state-dir` / `--allowed-root` / `--workspace` を省略すると一時ディレクトリを使う。リポジトリ全体を既定の `allowedRoots` にはしない。自動テストは mock ACP を使う。実 Cursor CLI に対する `remote-dev e2e` は未実施。
- 単発コマンドは `--state-dir` と `--allowed-root`（または `REMOTE_DEV_STATE_DIR` / `REMOTE_DEV_ALLOWED_ROOTS`）が必須。各起動が新しい ACP プロセスになるため、`session send` は送る前に `session.load` する。実行中の streaming を止める場合は `session send` を Ctrl+C するか、`e2e` を使う。
- `--json` で結果を JSON 出力する。`session create` は `--title` / `--prompt`、`e2e` は `--workspace`、ACP は `--acp-command` / `--acp-arg` を取る。`--acp-command` を省略すると実 Cursor CLI の ACP を解決する。`--acp-arg` には `--acp-command` が必要。

### ドキュメント

- `docs/local_e2e_report.md` に、Windows 上で mock ACP に対する `remote-dev e2e` が成功したことを記録した。コマンドは `npm run build`、`npm run remote-dev -- --help`、`npm run remote-dev -- e2e --acp-command node --acp-arg test/fixtures/mock-acp.mjs`。成功出力は `streamed echo:e2e-stream` から `e2e ok` まで。実 Cursor CLI に対する `remote-dev e2e` は未実施。

### テスト

- `remote-dev` の argv、単発コマンドの `--state-dir` / `--allowed-root` 必須、mock ACP での e2e 一連を検証するテストを追加した。

## [1.1.1] - 2026-08-17

### 変更

- `selectedModelId` は `session/new` / `session/load` 応答の `models.currentModelId` から `metadata.json` に保存する。無い、または空文字のときは `null`。モデル ID はハードコードしない。`SessionPayload` と `session.list` には含まれず、`model.select` は未実装。

### 修正

- 許可ルート外になって復元されなかった Workspace を修復して再 `workspace.register` すると、保存済み `workspaceId` を再利用し、`metadata.json` に同一 path の重複を残さない。
- 壊れた `metadata.json` や不正な `allowedRoots` では ACP 子プロセスを起動せず、それぞれ `MetadataStoreError` / `WorkspacePathError` になる。

### ドキュメント

- `docs/acp_capability_report.md` に、ACP プロセス再起動後の `session/load` と follow-up `session/prompt` の実測を追記した。load 後に前回の `agent_message_chunk` が再送される場合がある。会話履歴 replay の完全性は未確認。

### テスト

- `selectedModelId` の保存、修復後の `workspaceId` 再利用、壊れた metadata / 不正な `allowedRoots` で ACP を起動しないことを検証するテストを追加した。

## [1.1.0] - 2026-08-17

### 追加

- `Daemon.start({ stateDir })` を渡すと、Workspace と Session の metadata を `stateDir/metadata.json` に保存する。再起動後に Workspace 一覧と Session 一覧を復元し、`session.load` したうえで `session.send` を続けられる。会話本文は Cursor 側 Session を正本とし、ファイルには含めない。`stateDir` を渡さない場合は従来どおりプロセス内メモリのみ。Relay と Android の実データフロー、および Local E2E ハーネスは TASK-105。保存形式は `version` 1 で、非対応の version や壊れた JSON は起動時に `MetadataStoreError` になる。個別の不正レコードは読み飛ばす。
- `session.list` を実装した。`workspaceId` で絞り込み、`daemon.sessions.list` と `handleCommand` から使える。未知の `workspaceId` は `WorkspaceNotFoundError` になる。

### 変更

- 復元時、保存されていた `running` / `waiting_approval` / `waiting_user` は `disconnected` にする。

### セキュリティ

- 復元時に許可ルート外へ出る Workspace / Session はメモリへ載せない。ディスク上の記録は残る。

### テスト

- 再起動後の list / load / send、`session.list` の `workspaceId` 絞り込み、`running` の `disconnected` 復元、許可ルート外差し替え後の非復元を検証するテストを追加した。

## [1.0.2] - 2026-08-17

### セキュリティ

- `session.send` の直前にも、登録済み path を realpath して固定済み `allowedRoots` に再照合する。登録後に Workspace を許可ルート外への symlink に差し替えた場合は `WorkspaceNotAllowedError` で拒否し、Session の `status` は `running` にしない。
- `workspace.list` と Git metadata の更新でも、登録済み path を realpath して固定済み `allowedRoots` に再照合する。差し替えられた Workspace があると `workspace.list` 全体が `WorkspaceNotAllowedError` で拒否される。

### テスト

- 登録済み Workspace 差し替え後の `workspace.list` 拒否と、`session.send` 拒否（照合失敗後も Session が `running` にならないこと）を検証するテストを追加した。

## [1.0.1] - 2026-08-17

### セキュリティ

- `allowedRoots` は Daemon 起動時に実在するディレクトリとして canonicalize し、その値を結界として固定する。判定時に許可ルート自身を再 realpath しないため、起動後に許可ルートを許可外への symlink に差し替えても信頼しない。存在しないパスやディレクトリでない `allowedRoots` は起動時に `WorkspacePathError` になる。
- `session.create` / `session.load` の直前に、登録済み path を realpath して固定済み `allowedRoots` に再照合する。登録後に Workspace を許可ルート外への symlink に差し替えた場合は `WorkspaceNotAllowedError` で拒否する。

### ドキュメント

- `daemon/README.md` に、`allowedRoots` の起動時固定と、`session.create` / `session.load` 直前の再照合を追記した。

### テスト

- 起動後の許可ルート差し替え、存在しない / ディレクトリでない `allowedRoots` の拒否、登録済み Workspace 差し替え後の `session.create` / `session.load` 拒否を検証するテストを追加した。

## [1.0.0] - 2026-08-17

### 変更

- `session.create` の `workspaceId` は、実在するディレクトリへのパスではなく、先に `workspace.register` した Workspace の ID になった。`CreateSessionInput` の `workspacePath` は `workspaceId` に置き換わり、Session の `workspaceId` も登録 ID を返す。パスを直接渡していた呼び出しは、登録して得た ID を使う必要がある。未知の ID は `WorkspaceNotFoundError` になる。

### 追加

- Local Daemon に Workspace Manager を追加した。`Daemon.start` の `workspaces.allowedRoots` 配下のディレクトリだけを `workspace.register` でき、`daemon.workspaces` および `daemon.handleCommand` から `workspace.register` / `workspace.list` を使える。`allowedRoots` を渡さない場合は空で、登録はすべて拒否される。
- `workspace.list` / `workspace.register` は `name`・`path`・`gitBranch`・`modified`・`activeSessionCount`・`lastUsedAt` を返し、登録時に `workspace.updated` を発行する。同一 canonical path の再登録は既存の `workspaceId` を返す。Git リポジトリでなければ `gitBranch` は null、`modified` は false。`session.create` / `load` / `send` で `lastUsedAt` を更新し、prompt 実行中は `activeSessionCount` を 1 にする。登録内容はプロセス内メモリのみで、ディスク永続化は TASK-104。Relay と Android の実データフローはまだ有効ではない。

### セキュリティ

- 登録パスは symlink を解決した canonical path がいずれかの `allowedRoots` 配下にあるときだけ許可する。許可ルート外への `..` 脱出、symlink で許可ルート外へ出るパス、ディレクトリでないパスは拒否する。

### ドキュメント

- `daemon/README.md` の Phase 境界を、TASK-103（Workspace 登録と `allowedRoots` 結界）まで実装済み、ディスク永続化は TASK-104 と明記する内容へ更新した。

### テスト

- `allowedRoots` 配下の許可、ルート外への脱出、symlink 脱出、`workspace.register` / `workspace.list`、登録済み ID による `session.create`、`lastUsedAt` / `activeSessionCount` を検証するテストを追加した。

## [0.3.1] - 2026-08-17

### 修正

- 同時の `session.create` / `session.load` が `initialize` と `authenticate` を1回の handshake にまとめるようにした。handshake が失敗した場合は、次の呼び出しで再試行できる。
- 同一 Session で prompt 実行中（`running`）の `send` / `load` を拒否する。`session.cancel` は実行中でも送れる。
- Session が `completed` / `failed` / `interrupted` / `disconnected` になったあと、終端 Event を重ねて出さない。prompt 中の ACP 異常終了は `agent.failed` を1回出す。

### ドキュメント

- `daemon/README.md` に、handshake の同時呼び出し集約と、prompt 実行中の `send` / `load` 拒否を追記した。

### テスト

- handshake の共有と失敗後の再試行、prompt 実行中の `send` / `load` 拒否、ACP クラッシュ時の `agent.failed` が1回であることを検証するテストを追加した。

## [0.3.0] - 2026-08-17

### 追加

- Local Daemon に Session Adapter を追加した。`daemon.sessions` および `handleCommand` から Remote Protocol の `session.create` / `session.load` / `session.send` / `session.cancel` を、Cursor ACP の `session/new` / `session/load` / `session/prompt` / `session/cancel`（notification）へ接続する。これら以外の Command type は TASK-102 では受け付けない。Relay と Android の実データフローはまだ有効ではない。
- 初回の `session.create` または `session.load` で `initialize` と `authenticate`（`methodId` は `cursor_login`）を遅延実行する。`Daemon.start` は従来どおり ACP プロセス起動のみで handshake は行わない。Cursor CLI にログイン済みであることが前提になる。
- `session.create` の `workspaceId` は実在するディレクトリへのパスとして扱う。ディレクトリでなければ拒否する。ACP へは `cwd` とそのパス、`mcpServers` は空配列を渡す。`title` が null のときは `Session` を使い、`initialPrompt` が空なら作成直後は `idle`、非空なら作成時に prompt を実行する。allowedRoots / symlink 検査は TASK-103。
- 作成した Session はプロセス内メモリで `remoteSessionId` と ACP の `cursorSessionId` を対応付ける。`session.load` は同一プロセスで作成済みの `remoteSessionId` だけを対象にする。Daemon 再起動後の永続化は TASK-104。
- ACP の `session/update` のうち `user_message_chunk` を `user.message`、`agent_message_chunk` を `assistant.message`（`delta: true`）、`agent_thought_chunk` を `assistant.status`（`thinking`）へ変換する。`tool_call` などそれ以外の update、permission / file / diff の Event はまだ変換しない。
- Prompt 開始時に `session.status_changed` と `assistant.status` を `running` にする。`session/prompt` の `stopReason` が `cancelled` なら `agent.interrupted`、それ以外は `agent.completed`。prompt 失敗や ACP の予期しない終了は `agent.failed`。`session.cancel` は ACP へ notification として送る。

### ドキュメント

- `daemon/README.md` の Phase 境界を、TASK-102（Session Adapter と handshake の遅延実行）まで実装済み、Workspace の allowedRoots / symlink 検査は TASK-103 と明記する内容へ更新した。

### テスト

- mock ACP を使って Session の作成・streaming・終了・load・続きの prompt、`session.cancel` による `agent.interrupted`、`handleCommand`、および未知の `session/update` を変換しないことを検証するテストを追加した。

## [0.2.1] - 2026-08-17

### 修正

- Windows で PATH 上の `agent.cmd` や明示した `.cmd` / `.bat` を、`shell` なしでも `cmd.exe /d /c` 経由で spawn できるようにした。`%LOCALAPPDATA%\cursor-agent\versions` の `node.exe` + `index.js` 起動は従来どおり直接 spawn する。
- `Daemon.stop` が stdin close を無視する ACP 子プロセスに対し、待ち時間のあと `SIGTERM`、さらに応答しなければ `SIGKILL` を送り、子プロセスが残らないようにした。
- shutdown 中または終了後に完了する incoming request の応答書き込みや stdin の書き込み失敗で、Daemon プロセスが落ちないようにした。
- incoming request の handler が値を返さない場合、JSON-RPC 成功応答の `result` を欠かさず `null` として送るようにした。

### テスト

- Windows の `.cmd` spawn、stdin close / `SIGTERM` を無視する子プロセスの強制終了、shutdown 後の非同期 incoming request、`undefined` 結果の `result: null` を検証するテストを追加した。

## [0.2.0] - 2026-08-17

### 追加

- Local Daemon が Cursor ACP を子プロセスとして起動し、stdin/stdout の JSON-RPC 2.0（newline-delimited）で request / notification を送受信できるようにした。`Daemon.start` はプロセス起動と輸送までを行い、`initialize` / `authenticate` / Session 作成 / Prompt / Event 変換はまだ自動では行わない（TASK-102）。
- 明示の `command` が無い場合、Windows では `%LOCALAPPDATA%\cursor-agent\versions` の最新版ディレクトリにある `node.exe`（または `node`）と `index.js` を `acp` 引数付きで起動する。見つからない場合は PATH 上の `agent` / `agent.cmd` / `agent.exe` を探す。どちらも無い場合は `AcpCommandNotFoundError` になる。
- ACP からの `session/update` などの notification を購読でき、`session/request_permission` などの incoming request に `onIncomingRequest` で応答できる。ハンドラが無い場合は JSON-RPC の Method not found（`-32601`）を返してエージェントを待たせない。不正な stdout 行は無視し、stderr は logger へ転送する。
- ACP が予期せず終了しても Daemon 自体は落ちず、未完了の request は `AcpProcessExitedError` で失敗する。`Daemon.stop` は stdin を閉じたあと子プロセスを終了し、残さない。request の既定タイムアウトは 30 秒、shutdown の既定待ちは 3 秒。

### ドキュメント

- `daemon/README.md` の Phase 境界を、TASK-101（ACP 子プロセスと JSON-RPC / プロセス寿命）まで実装済み、Session 作成・Prompt・Event 変換は TASK-102 と明記する内容へ更新した。

### テスト

- mock ACP を使って JSON-RPC の id 対応、notification、incoming request、異常終了、timeout、shutdown 後に子プロセスが残らないこと、および Cursor agent の version ディレクトリ解決を検証するテストを daemon に追加した。ルートの `npm test` は protocol に加えて daemon も実行する。

## [0.1.1] - 2026-08-17

### 追加

- インストール済み Cursor CLI / ACP の実測 Capability を `docs/acp_capability_report.md` に記録した。`initialize` / `authenticate`、`session/new`、`session/prompt` は成功し、`session/update`、`session/request_permission`、`session/cancel`（notification）、Session Config Options を観測した。`usage_update` と `cursor/*` 拡張は未観測であり、Local Daemon の ACP 接続はまだ有効ではない。

### ドキュメント

- README の Phase 境界を、Capability 未記録から `docs/acp_capability_report.md` 記録済みへ更新した。未観測機能を前提にしない拘束は TASK-101 以降でも維持する。

## [0.1.0] - 2026-08-17

### 追加

- Phase 0 の実装基盤として、Android、Local Daemon、Relay、Remote Protocol の最小構成を追加した。Android は Jetpack Compose の起動可能な骨格、Daemon と Relay は共有 Protocol を参照できる TypeScript ワークスペースとして利用できる。
- Remote Protocol の Event / Command 基礎型を追加し、Event の `eventId`・`sessionId`・`timestamp`・`type`・`payload` と、Command の一意な `requestId` を共通形式として扱えるようにした。未知の Event type は受信プロセスを停止させず、未知イベントとして保持する。

### 変更

- CI で TypeScript の build・test・typecheck・format check と Android の build・unit test を実行する基盤を追加し、実装ブランチでも検証できるようにした。
- このリリースの機能範囲は Phase 0 に限定される。Cursor ACP 接続、Relay WebSocket、Device Pairing、Android の Machines / Workspaces / Sessions / Chat の実データフローはまだ有効ではなく、後続 Phase で実装する。

### ドキュメント

- 各モジュールの責務、開発時の build / test 手順、Phase 境界を README に記載した。

### テスト

- Remote Protocol の JSON serialize / deserialize、未知 Event の安全な受信、不正な Event envelope の拒否を検証するテストを追加した。
