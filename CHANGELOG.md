# CHANGELOG

## [1.15.0] - 2026-08-24

### 追加

- Session Context Breakdown の防御的基盤。ACP `usage_update` に structured `breakdown` 配列が現れたときだけ、Daemon が `session.context_breakdown_updated {categories: [{id, displayName, tokens}]}` を発行する。`id` は非空文字列、`tokens` は非負の safe integer、`displayName` は欠落・非文字列なら `id` と同じ値にする。無効な要素が1つでもあれば breakdown event は出さず、valid な `session.context_updated` は従来どおり出す。推測でのカテゴリ配分はしない。
- Android は breakdown を選択中 session にだけメモリ保持し、machine / workspace / session 選択変更で usage と一緒に clear する。未知カテゴリも `id + displayName + tokens` として表示できる。Room 永続化なし。
- Chat header の Context 表示は、breakdown があるときだけタップで展開し、カテゴリ別の displayName と tokens を一覧表示する。breakdown が無い環境では従来どおり合計のみでタップ不可。

### 変更

- パッケージ版 1.15.0、Android `versionCode` 28 / `versionName` 1.15.0。`session.context_breakdown.get` コマンド、`/context` slash command の parser、text scraping、polling は追加していない。Relay は generic のまま。設定変更と data migration は不要。installed Cursor CLI `2026.08.11-e8db854` では structured breakdown は未観測のため、実運用 UI は従来どおり合計のみ表示。経路は test fixture の structured update で検証した。token/cost は TASK-404、Account Usage は TASK-405。

### テスト

- `npm test` は protocol 18 / daemon 122 / relay 8、fail 0。`npm run lint` pass。Gradle `:app:testDebugUnitTest :app:assembleDebug :app:lintDebug` BUILD SUCCESSFUL（53 tasks、63 tests pass）。`git diff --check` pass。実機検証はユーザー方針により未実施。

## [1.14.0] - 2026-08-23

### 追加

- Session Context Usage。ACP v1 の structured `usage_update` は top-level `used` / `size` だけを見る。Daemon は `Number.isSafeInteger` かつ非負のときだけ remote `session.context_updated {used,size}` にする。`cost` / breakdown / account / extra fields は remote payload に出さない。malformed update は event を出さない。
- Android は `used` / `size` を JSON integer Long（`0..9007199254740991`）として検証し、選択中の非空 session にだけメモリ保持する。machine / workspace / session 選択変更で clear。別 session、`sessionId` null、malformed、terminal event では既存値を消さない。Room 永続化なし。
- valid event を受信したときだけ Chat header に Context を表示する。1000 未満は exact decimal、1000 以上は `floor(value/1000)K`。`size=0` は percent なし。`size>0` は overflow-safe な exact `floor(used*100/size)%`（clamp なし）。

### 変更

- パッケージ版 1.14.0、Android `versionCode` 27 / `versionName` 1.14.0。`session.context.get`、polling、text scraping、private API、model context size の推測は追加していない。Relay は generic のまま。設定変更と data migration は不要。値が無い既存環境の表示は変わらない。
- installed Cursor CLI `2026.08.11-e8db854` の既存 capability 観測では `usage_update` は未観測。実運用 UI は valid event を受信するまで非表示。経路は test fixture の structured update で検証した。Context Breakdown は TASK-403、token/cost は TASK-404、Account Usage は TASK-405。

### テスト

- `npm test` は protocol 17 / daemon 118 / relay 8、fail 0。`npm run lint` pass。対象 TS/MJS Prettier pass。Gradle `:app:testDebugUnitTest :app:assembleDebug :app:lintDebug` BUILD SUCCESSFUL（53 tasks）。初回 Android unit test は Int/Long assertion mismatch 1 件で失敗し、Long 期待値へ修正後 60 tests pass。`git diff --check` pass。実機検証はユーザー方針により未実施。

## [1.13.0] - 2026-08-23

### 追加

- Android ローカルの Model Visibility。キーは exact `modelId`。通常 Model Picker は available かつ hidden でない catalog だけを出す。Manage Models は取得済み catalog 全件（unavailable 含む）を高さ制限付きダイアログで縦スクロールし、Hide / Show できる。長い displayName でも操作ボタンは行内に残る。通常 Picker も高さ制限付きで縦スクロールする。選択中モデルを hidden にしても Session / Chat header の `displayName` / `currentModelId` は維持する。

### 変更

- パッケージ版 1.13.0、Android `versionCode` 26 / `versionName` 1.13.0。Room database v3 に `hidden_models(modelId PRIMARY KEY)` を追加し、非破壊 Migration 2→3。行なしは visible。新規検出 ID は、その exact ID が以前 hidden でなければ visible。hidden ID は catalog / session 切替とアプリ再起動後も残る。表示設定はアプリ内のみ。`model.visibility.update` を含む Remote command は送らない。Protocol / Daemon / Relay の公開挙動は変えない。Context / Usage は TASK-402、Account capability は TASK-405。

### テスト

- `npm test` は protocol 16 / daemon 114 / relay 8、fail 0。Gradle `:app:testDebugUnitTest :app:assembleDebug :app:lintDebug` BUILD SUCCESSFUL（53 tasks）。Room 生成コードを含む compile / lint は通過した。`git diff --check` pass。実機検証はユーザー方針により未実施。unit は FakeHiddenModelDao。実 Room データベースに対する Migration 2→3 の実行と close/reopen 永続化は未検証。

## [1.12.0] - 2026-08-23

### 追加

- Android Chat header の Model Picker。選択中 Session の動的 catalog から available なモデルだけを出し、手動 Refresh、pending / 確定 / error を表示する。表示名は catalog の `displayName`、無ければ `currentModelId`。固定のモデル ID / 名前 / parameter / variant は持たない。
- ACP `session/new` と `session/load` の `models.availableModels` / `currentModelId` / `configOptions` を防御的に共通 catalog へ変換する。`model.list` は選択 Session の cache。`model.select` は catalog 内 available だけを、`configOptions` から得た `configId` で `session/set_config_option` へ送る。Run 中は拒否し、成功後だけ確定・metadata・event を更新する。新しい catalog は新規 Session または明示 load の ACP 応答でのみ検出する。専用 refresh ACP method は推測しない。

### 変更

- パッケージ版 1.12.0、Android `versionCode` 25 / `versionName` 1.12.0。Model Visibility / Manage Models は TASK-401、Context / Usage は TASK-402 以降。

### テスト

- `npm test` は protocol 16 / daemon 114 / relay 8、全 pass。`npm run lint` pass。targeted Prettier pass。Gradle `:app:testDebugUnitTest :app:assembleDebug :app:lintDebug` BUILD SUCCESSFUL（53 tasks）。初回 Android unit test は選択成功 result を捨てる二重 `model.list` で 1 件失敗し、修正後 pass。実機検証は未実施。

## [1.11.0] - 2026-08-22

### 追加

- Android の in-process system notification。アプリが background で process と既存 WebSocket が生存中だけ、`permission.requested` / `agent.completed` / `agent.failed` を即時通知し、`agent.waiting` は 60 秒継続後に通知する。通常 streaming、foreground、`agent.interrupted`、`permission.resolved` は通知しない。通知 tap は MainActivity を開き auto-cancel。notification action と approval action は付けない。権限判断は app 内 approval card のまま。Android 13+ で `POST_NOTIFICATIONS` を deny すると通知しない。同一 `eventId` は process メモリ内で再通知しない。session の waiting timer は terminal / permission / interrupted / 非 Ready 接続で cancel する。FCM、process lifecycle、WebSocket reconnect、notification deep link、Doze は TASK-604。現在の Daemon は `agent.waiting` を emit しないため、その live E2E は未実施で parsing / coordinator unit test のみ。

### 変更

- パッケージ版 1.11.0、Android `versionCode` 24 / `versionName` 1.11.0。Protocol / Daemon / Relay の公開挙動は変えない。

### テスト

- Gradle `:app:testDebugUnitTest :app:assembleDebug :app:lintDebug` pass（53 tasks）。実機事実と未実施範囲は `docs/implementation_status.md`。

## [1.10.0] - 2026-08-22

### 追加

- Assistant 応答内の workspace 相対ファイル参照（`src/foo.ts`、`:120`、`:120-160`）をリンク化し、Chat 内の読み取り専用 Viewer で開く。行番号、等幅、折り返しなし、指定開始行への移動、範囲表示、Copy、Reload、Close。User メッセージはリンク化しない。編集機能はない。Android は候補抽出のみ。file content は保存しない。Push 通知は含まない。

### 変更

- パッケージ版 1.10.0、Android `versionCode` 23 / `versionName` 1.10.0。Relay の generic routing は変えない。

### セキュリティ

- `file.read` は sessionId と path だけ。Daemon が session の登録済み Workspace を毎回再解決し、path 構文、canonical containment、sensitive 名、regular file、binary/NUL、strict UTF-8 を検証する。最大 262144 bytes。超過は UTF-8 境界で truncate metadata。error に raw absolute path を含めない。workspace 外と `.env` 等は拒否。

### テスト

- `npm test` は protocol 15 / daemon 112 / relay 8 全 pass。`npm run lint` pass。対象 TS/MJS の Prettier check pass。Gradle `:app:testDebugUnitTest :app:assembleDebug :app:lintDebug` pass（53 tasks）。実機 SM-S928Q Android 16、localhost Relay + adb reverse で 3 種の有効参照が下線リンク、`daemon/src/daemon.ts:120-150` で 120 行目から Viewer、Copy / Reload 後も内容維持。`daemon/.env` は `File is not readable`。`../outside.txt` は下線なし。詳細は `docs/implementation_status.md`。

## [1.9.0] - 2026-08-22

### 追加

- Android の手動 Refresh Diff。選択中の登録済み Workspace について、変更ファイル一覧、ファイル数と +/- 合計、折りたたみ行、unified diff、等幅フォントの横スクロールを表示する。観測した ACP Capability に構造化 diff / ファイル変更 Event が無いため、Daemon の bounded Git fallback が唯一のソース。Relay は generic のまま変えない。非 Git Workspace は `available: false` の空状態を返す。agent 完了からの自動更新と、TASK-302 の View file / 応答内リンクは含まない。

### 変更

- パッケージ版 1.9.0、Android `versionCode` 22 / `versionName` 1.9.0。

### セキュリティ

- Android は `workspaceId` だけを送る。Daemon は信頼済み path を再解決し、shell なしの bounded Git を Workspace 結界内で実行する。`.env` / key / 証明書 / credentials / secrets の内容と、binary / symlink / submodule / 非 regular の内容は返さない。ファイル数・1ファイル・全体の上限では truncation / omission の metadata を出す。

### テスト

- `npm test` は protocol 14 / daemon 101 / relay 8 全 pass。`npm lint` pass。targeted Prettier pass。Gradle `:app:testDebugUnitTest :app:assembleDebug :app:lintDebug` pass。実機 SM-S928Q Android 16、localhost Relay + adb reverse で 21 ファイルの summary、+/- 合計、展開/折りたたみ、unified diff、横スクロールを確認。詳細は `docs/implementation_status.md`。

## [1.8.0] - 2026-08-22

### 追加

- Permission Flow。実 ACP の `session/request_permission` を Android の approval card に出し、Approve / Reject のあと実行結果まで追える。Approve は Daemon が保持した `allow_once` だけを ACP に返す。Reject、timeout、cancel、invalid、非 running session、ACP 終了は `reject_once` または fail-closed。`allow_always` は選ばない。Android は `permissionId` だけで相関し、optionId / policy は送れない。決定中の二重送信を防ぐ。session status と terminal まで追跡する。

### 変更

- パッケージ版 1.8.0、Android `versionCode` 21 / `versionName` 1.8.0。

### セキュリティ

- 権限判定の最終 authority は Daemon。今回の実機確認は localhost `ws://` と adb reverse であり、TLS・インターネット公開・unattended dangerous execution・allow-always は含まない。

### テスト

- `npm test` は protocol 13 / daemon 89 / relay 8 全 pass。targeted Prettier pass。Gradle `testDebugUnitTest assembleDebug lintDebug` pass。実機 SM-S928Q Android 16 で Approve と Reject の両経路から completed まで確認。詳細は `docs/implementation_status.md`。

## [1.7.1] - 2026-08-22

### 修正

- Android unit test の disconnect 中 in-flight `session.send` のスケジューリング競合を決定的にした。製品挙動と Remote Protocol の変更はない。

## [1.7.0] - 2026-08-22

### 追加

- Android Chat の基本縦切り（TASK-204）。選択中 Session へ Prompt を送り、User / Assistant の逐次表示、status / error / completed / stopped、応答中 Stop を扱う。会話はメモリ内のみ。

### 変更

- パッケージ版 1.7.0、Android `versionCode` 19 / `versionName` 1.7.0。Protocol / Daemon / Relay の公開挙動は変えない。Android 実機 Gate B、QR カメラ、TLS、履歴永続化 / 再接続復元は未完。

### テスト

- JVM unit test で Chat payload / event 解析、Repository の event 配信と長時間 send、ViewModel の session フィルタ / delta / echo 重複排除 / terminal を検証する。

## [1.6.1] - 2026-08-22

### 修正

- Android Compose の誤った `weight` 明示 import による compile 失敗を修正した。機能と Remote Protocol の変更はない。

## [1.6.0] - 2026-08-22

### 追加

- Android Workspace / Session UI（TASK-203）。Pairing QR v1 JSON の貼り付けまたは既存 Machine の再認証、Workspace 一覧・選択、Session 一覧、New Session、過去 Session 再開。Chat 本文 / streaming は TASK-204。Camera scan は未実装。

### 変更

- Room `MachineEntity` version 2（`relayUrl` / `deviceId` / `lastConnectedAt`）と破壊しない Migration 1→2。成功 `deviceId` のみ保存し、秘密鍵・token・本文は Room に入れない。パッケージ版 1.6.0、Android `versionCode` 17 / `versionName` 1.6.0。Protocol / Daemon / Relay の公開挙動は変えない。

### テスト

- JVM unit test で codec、canonical proof、invalid QR、request correlation / auth、ViewModel の list / new / resume を検証する。実機、network、Android Keystore は使わない。

## [1.5.0] - 2026-08-22

### 追加

- Android Application Skeleton（TASK-202）を追加した。Jetpack Compose Navigation の開始画面は Machines で、Machines / Workspaces / Sessions / Chat の 4 destination を定義する。各画面は TASK-203 / TASK-204 未実装と分かるプレースホルダであり、前後へ遷移できる。実 Machine / Workspace / Session 一覧と Chat 送受信は含まない。
- Application 所有の手動 DI（`AppContainer`）を追加し、Room database、Keystore credential store、OkHttp WebSocket transport、ViewModel factory を生成して注入する。Hilt / Koin は使わない。
- OkHttp WebSocket の最小 transport を追加した。`connect` / `send` / `disconnect`、`ConnectionState` の StateFlow、受信 text の Flow を提供する。URL は `ws` / `wss` のみ受け付け、起動時に自動接続しない。
- Room の最小永続層として `MachineEntity` / `MachineDao` / `CursorRemoteDatabase` を追加し、Flow で一覧取得できる。秘密情報や message / file 内容は保存しない。
- Android Keystore の EC P-256 device key を作成・取得・削除できる `CredentialStore` を追加した。秘密鍵は export せず、Room にも保存しない。
- 選択中の machine / workspace / session と transport 接続状態を持つ AppState / ViewModel を追加した。選択変更時は下位選択をクリアする。

### 変更

- リポジトリ全体のパッケージ版を 1.5.0 に同期した。Android は `versionCode` 16 / `versionName` 1.5.0。Protocol / Daemon / Relay の公開挙動は変えない。

### ドキュメント

- TASK-202 の実装済み範囲と、TASK-203 / TASK-204 および Gate B が未完であること、次が TASK-203 であることを README と実装計画・実装状況に記録した。

### テスト

- `FoundationTest` を destination 順序、初期 state、選択の cascade clear を検証する unit test に更新した。

## [1.4.0] - 2026-08-21

### 追加

- Device Pairing のバックエンドを追加した。PC 側は Pairing 用 QR JSON（`relayUrl`、`machineId`、one-use `token`、`expiresAt`）を発行できる。token は1回の成功した pair で消費し、再利用できない。Android の QR スキャンと Keystore は未実装。
- ECDSA P-256 の `pair` / `auth_proof` で初回登録と再接続を検証する。公開 device metadata（`deviceId` と公開鍵）は Daemon の `metadata.json` に永続化する。秘密鍵は Daemon に保存しない。再起動後も登録済み公開鍵で再認証できる。
- Relay の `/client` は認証ゲートになる。未 Pairing の Command は Machine に届かず、Event は認証済み client にだけ送る。失敗後および Machine 切断・置換後は再 challenge / 再認証が必要になる。

### セキュリティ

- `/client` は pairing 済み device だけが Command / Event を扱える。`/machine` 認証、TLS、インターネット公開対応は未実装である。localhost の非認証 `ws://` のまま Relay をインターネットへ公開しない。

### テスト

- QR payload、P-256 pair/auth proof、token の one-use、未 pairing の Command / Event 遮断、再 challenge / 再認証、public device 永続化を Protocol / Daemon / Relay のテストで検証した。

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
