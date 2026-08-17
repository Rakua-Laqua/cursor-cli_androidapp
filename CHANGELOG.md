# CHANGELOG

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
