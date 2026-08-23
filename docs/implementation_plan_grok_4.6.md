# Cursor CLI Remote for Android — Grok 4.6向け実装計画

- 文書バージョン: v0.2
- 対象設計書: `docs/cursor_remote_android_spec_v0.3.md`
- 実装モデル: Grok 4.6
- 開発方針: 縦切り・検証可能・Phase境界厳守
- 対象リポジトリ: `Rakua-Laqua/cursor-cli_androidapp`
- 進捗スナップショット: `docs/implementation_status.md`（2026-08-21 時点）

この計画書は作業順と Scope の正本である。各タスクの「いま完了しているか」は進捗スナップショットを見る。計画本文の未着手タスクは消さない。

---

## 1. 実装方針

このプロジェクトでは、Grok 4.6へ大きな機能群を一括で渡さず、1タスクごとに「動作確認できる縦切り」を完成させる。

各タスクは必ず以下の順序で実施する。

1. 関連コードと設計書を読む。
2. 現状を短く整理する。
3. 実装方法を決める。
4. 対象範囲だけ実装する。
5. Unit / Integration / Buildのうち該当する検証を実行する。
6. 失敗した検証を修正する。
7. 変更差分を自己レビューする。
8. 完了条件を満たしたか確認する。
9. 未解決事項があれば明示して終了する。

一つのタスク中に次Phaseの機能を先回りして実装しない。

---

## 2. Grok 4.6へ渡す共通ルール

各実装タスクの先頭に以下のルールを付与する。

```text
あなたはこのリポジトリの実装担当です。

最初に以下を読んでください。
- docs/cursor_remote_android_spec_v0.3.md
- このタスクで関係する既存コード
- 既存テスト

ルール:
- 設計書をSource of Truthとする。
- このタスクのScope外を実装しない。
- 既存仕様を推測で変更しない。
- Cursor Desktop依存を追加しない。
- Cursor CLI / ACPの構造化インターフェースを優先する。
- ANSI/TTY文字列解析を主要経路にしない。
- モデル名やCursor固有の可変値をハードコードしない。
- Account Usage等、取得不能な値を推測で生成しない。
- Workspace外アクセスを許可しない。
- 実装後は必ず該当テストまたはBuildを実行する。
- テスト失敗を残したまま完了扱いにしない。
- 大きな設計変更が必要なら勝手に実施せず、理由と最小案を報告する。

完了報告には以下を含めてください。
1. 実装した内容
2. 変更ファイル
3. 実行したテスト/Build
4. 結果
5. 残課題
```

---

# Phase 0 — Repository Foundation

目的は、後続実装が独立して進められる最小構造を確立することである。

## TASK-000: リポジトリ初期構成

### Scope

以下の基本構造を作る。

```text
android/
daemon/
relay/
protocol/
docs/
```

各モジュールの責務をREADMEまたは短いREADMEファイルで明記する。

### 実装内容

- Androidプロジェクトの最小構成
- Daemonプロジェクトの最小構成
- Relayプロジェクトの最小構成
- Protocolモジュール
- root `.gitignore`
- 開発用README
- format / lintの基本設定

### 完了条件

- Android側がbuildできる。
- Daemon側がbuildまたはtypecheckできる。
- Relay側がbuildまたはtypecheckできる。
- ProtocolをDaemon / Relayから参照できる。
- 空の構成だけでCI可能な状態になっている。

---

## TASK-001: Remote Protocol基礎型

### Scope

設計書11章のEvent / Commandをコード上の型として定義する。

### 優先実装

```text
workspace.*
session.*
user.message
assistant.message
assistant.status
agent.*
```

Approval / File / Diff / Usageは型だけ先行して定義してよいが、実処理は行わない。

### 完了条件

- Eventに`eventId`, `sessionId`, `timestamp`, `type`, `payload`がある。
- Commandに一意なrequest IDがある。
- JSON serialize / deserialize testが通る。
- 未知Eventを受信してもプロセス全体が落ちない。

---

# Phase 1 — Cursor CLI / ACP Local Vertical Slice

このPhaseを最優先する。

AndroidやRelayより先に、「Cursor Desktopなしで継続Sessionを操作できる」ことを証明する。

## TASK-100: Cursor ACP Capability Probe

### 目的

本格実装前に、現在インストールされているCursor CLI / ACPで実際に使える機能を確認する。

### 確認項目

- `agent acp`起動
- initialize / handshake
- capabilities
- session create
- session load / resume
- prompt送信
- streaming update
- tool update
- permission request
- cancel
- Session Config Options
- model options
- usage update
- slash commands
- context関連Capability

### 成果物

```text
docs/acp_capability_report.md
```

に、実測したCapabilityを記録する。

### 重要

設計書に書かれていても、現在のCursor CLIが提供していない機能を「存在する前提」で実装しない。

### 完了条件

- ACPとのhandshake成功。
- 最低1Sessionを作れる。
- 1Promptを送りresponseを受け取れる。
- 実測Capability一覧が記録されている。

---

## TASK-101: Cursor ACP Process Manager

### Scope

Local Daemonから`agent acp`を子プロセスとして安全に管理する。

### 実装内容

- process spawn
- stdin/stdout JSON-RPC transport
- stderr logging
- graceful shutdown
- unexpected exit detection
- request ID管理
- pending request cleanup

### 完了条件

- Daemon起動でACPを開始できる。
- JSON-RPC request / responseを送受信できる。
- ACP異常終了時にDaemonがクラッシュしない。
- Daemon終了時に子プロセスが残らない。

---

## TASK-102: ACP Session Adapter

### Scope

Remote ProtocolとCursor ACP Session APIを接続する。

### 最初に対応

```text
session.create
session.load
session.send
session.cancel
```

### Event変換

最低限:

```text
assistant.message
assistant.status
agent.completed
agent.failed
agent.interrupted
```

### 完了条件

ローカルテストクライアントから以下ができる。

1. Workspace指定
2. Session作成
3. Prompt送信
4. Streaming response受信
5. Session終了
6. 同じSessionをload
7. 続きのPrompt送信

---

## TASK-103: Workspace Manager

### Scope

Workspaceを第一級オブジェクトとして実装する。

### 実装内容

- allowedRoots設定
- Workspace一覧
- Workspace登録
- canonical path解決
- symlink escape防止
- Git root / branch取得
- last-used metadata

### Security tests

必須:

```text
allowedRoot/project                 -> allow
allowedRoot/project/src             -> allow
allowedRoot/project/../other        -> policy次第で拒否
../../etc/passwd                    -> reject
symlink -> outside allowedRoot      -> reject
```

### 完了条件

Workspace境界をDaemon側だけで強制できる。

---

## TASK-104: Session Metadata Store

### Scope

Remote SessionとCursor Sessionの対応を永続化する。

### 保存項目

```text
remoteSessionId
cursorSessionId
workspaceId
title
status
createdAt
updatedAt
lastEventId
selectedModelId
```

### 完了条件

- Daemon再起動後もSession一覧を復元できる。
- Cursor側Sessionを再loadできる。
- WorkspaceごとにSessionを絞り込める。

---

## TASK-105: Local E2E Harness

### 目的

Relay / Android実装前にPhase 1全体を固定する。

### 作るもの

CLIまたはIntegration Test用の簡易クライアント。

例:

```text
remote-dev workspace list
remote-dev session create <workspace>
remote-dev session list
remote-dev session send <session> "..."
```

単発 `session cancel` は、別 ACP プロセスの prompt を止められることが実測されていないため公開しない。cancel は in-process の `e2e`、または `session send` 中の Ctrl+C。

### 完了条件

Cursor Desktopを起動せずに以下を一連で実行できる。

```text
workspace select
→ session create
→ prompt
→ streaming response
→ cancel
→ restart daemon
→ load session
→ continue conversation
```

ここを通過するまでPhase 2へ進まない。

### 実施記録

2026-08-17、Windows 上で実 Cursor CLI に対する `remote-dev e2e` が成功した。記録は `docs/local_e2e_report.md`。mock ACP 経路は回帰として残す。単発 `session cancel` は未実測のため非公開。

---

# Phase 2 — Relay + Android Text Remote

2026-08-22 時点: TASK-200 は v1.3.0、TASK-201 は v1.4.0、TASK-202 は v1.5.0、TASK-203 は v1.6.0、TASK-204 は v1.7.0 で実装済み。Gate B は 2026-08-22 に通過。詳細は `docs/implementation_status.md`。Gate B〜D は維持する。

## TASK-200: Relay WebSocket Core

### Scope

AndroidとDaemon間の中継だけを実装する。

### 実装内容

- machine connection
- client connection
- message routing
- request/response correlation
- session event forwarding
- heartbeat
- disconnect detection

### 非Scope

- Push通知
- Account Usage
- File content保存
- Source code保存

### 完了条件

Local E2E Harness相当のCommandをWebSocket越しに実行できる。

### 実施記録

2026-08-17、v1.3.0 でリリース。localhost の非認証 `ws://` core。`/machine` outbound と `/client` inbound、`command` / `event` / `result` の相関、heartbeat、切断・置換。Pairing / TLS / Android は含まない。

---

## TASK-201: Device Pairing

### Scope

PC DaemonとAndroidの初回Pairing。

### Flow

```text
Daemon
→ temporary pairing token
→ QR
→ Android scan
→ device public key registration
→ token invalidation
```

### 完了条件

- 使い捨てtoken。
- token再利用不可。
- 未Pairing端末からCommand送信不可。

### 実施記録

2026-08-21、v1.4.0 でリリース。Protocol / Daemon / Relay のバックエンド。QR JSON、P-256 証明、`/client` 認証ゲート、public device の metadata 永続化。Android QR / Keystore / TLS / `/machine` 認証 / インターネット公開対応は含まない。次は TASK-202。

---

## TASK-202: Android Application Skeleton

### 実装内容

- Jetpack Compose
- Navigation
- DI
- WebSocket transport
- Room
- Keystore credential storage
- app state

### 最初の画面

```text
Machines
Workspaces
Sessions
Chat
```

見た目の磨き込みよりデータフローを優先する。

### 実施記録

2026-08-21、v1.5.0 で実装。Compose Navigation の 4 destination（開始は Machines）、Application 所有の手動 DI、OkHttp WebSocket transport（`ws` / `wss` のみ、起動時自動接続なし）、Room の `MachineEntity` 一覧 Flow、Keystore の EC P-256 device key（秘密鍵は export / Room 保存しない）、選択 cascade の AppState / ViewModel。各画面は TASK-203 / TASK-204 未実装のプレースホルダ。実データ一覧・Chat 送受信・QR カメラ・TLS・Relay 自動接続は含まない。Gate B は未到達。次は TASK-203。

---

## TASK-203: Workspace / Session UI

### 完了条件

Androidだけで以下ができる。

```text
Machine選択
→ Workspace一覧
→ Workspace選択
→ Session一覧
→ New Session
→ 過去Session再開
```

### 実施記録

2026-08-22、v1.6.0 で実装。Android だけで Pairing JSON 登録 / 再認証、Workspace 一覧・選択、Session 一覧、New Session、過去 Session 再開まで行う。Chat 本文と streaming は TASK-204。Camera scan は未実装。Gate B は未到達。次は TASK-204。

---

## TASK-204: Chat Streaming UI

### Scope

Chatの基本縦切り。

### 対応

- User message
- Assistant streaming message
- Status
- Error
- Completed
- Stop

### 完了条件

AndroidからPromptを送り、Cursorの応答が逐次表示される。

### 実施記録

2026-08-22、v1.7.0 で実装。選択中 Session への Prompt、逐次応答、status / error / completed / stop。会話はメモリ内のみ。2026-08-22、SM-S928Q / Android 16 の localhost Relay + adb reverse で Gate B 通過。履歴永続化 / 再接続復元、QR カメラ、TLS は未完。詳細は `docs/implementation_status.md`。

---

# Phase 3 — Coding UX

## TASK-300: Permission Flow

### 対応

```text
permission.requested
permission.approve
permission.reject
permission.resolved
```

### 必須

権限判定の最終authorityはDaemon。

AndroidはDaemonのpolicyを突破できない。

### 完了条件

実際のCursor approval requestをAndroidで確認し、Approve / Rejectして実行結果まで追える。

### 実施記録

2026-08-22、v1.8.0 で実装。Daemon が ACP `session/request_permission` の最終 authority。Android は `permissionId` のみ。`allow_once` / `reject_once` 限定、fail-closed、`allow_always` は選ばない。Gate C 通過。詳細は `docs/implementation_status.md`。

---

## TASK-301: Diff Pipeline

### 優先順位

1. Cursorの構造化変更Event
2. DaemonのGit diff

### Android

- changed files
- + / - summary
- unified diff
- collapse
- horizontal scroll

### 完了条件

Cursor変更後、PCを開かずAndroidからDiffを確認できる。

### 実施記録

2026-08-22、v1.9.0 で実装。観測した ACP に構造化 diff が無いため、Daemon の bounded Git fallback と手動 refresh のみ。Android は summary / 折りたたみ / unified diff / 横スクロール。SM-S928Q Android 16 で受け入れ。次は TASK-302。詳細は `docs/implementation_status.md`。

---

## TASK-302: Cursor Response File Links

### Scope

Assistant response内のWorkspaceファイル参照だけをリンク化する。

### 対応

```text
src/foo.ts
src/foo.ts:120
src/foo.ts:120-160
```

### Security

リンク解析結果をAndroidで信用しない。

`file.read`時にDaemonで再検証する。

### 完了条件

- 応答中のファイルパスがタップ可能。
- 読み取り専用Viewerで表示。
- 指定行へ移動。
- Workspace外は拒否。
- sensitive filesは拒否。

### 実施記録

2026-08-22、v1.10.0 で実装。Assistant 応答のみリンク化。Android は候補抽出、`file.read` の最終 authority は Daemon。Chat 内 read-only Viewer。SM-S928Q Android 16 で受け入れ。次は TASK-303。詳細は `docs/implementation_status.md`。

---

## TASK-303: Push Notifications

### 対象

```text
permission.requested
agent.completed
agent.failed
long agent.waiting
```

通常streaming responseは通知しない。

### 実施記録

2026-08-22、v1.11.0 で実装。in-process 限定。SM-S928Q Android 16 で受け入れ。TASK-400 は v1.12.0。詳細は `docs/implementation_status.md`。

---

# Phase 4 — Models / Usage / Context

## TASK-400: Dynamic Model Catalog

### Scope

現在利用可能なCursorモデルを動的取得する。

### 優先順位

1. ACP Session Config Options
2. Cursor公式SDK / model catalog
3. その他Cursor公式構造化interface

### 禁止

モデル名リストのハードコード。

### 完了条件

- Model Picker表示。
- 新モデル追加がアプリ更新なしで反映可能。
- Sessionモデル変更が可能。

### 実施記録

2026-08-23、v1.12.0 で実装。ACP `session/new` / `session/load` の models / configOptions を防御的に変換し、Android Chat header の Model Picker から available モデルを選ぶ。モデル ID / 名前のハードコードなし。Model Visibility は v1.13.0。Context / Usage は TASK-402 以降。実機検証は未実施。詳細は `CHANGELOG.md` と `docs/implementation_status.md`。

---

## TASK-401: Model Visibility

### Scope

大量のモデルを整理するユーザー設定。

### 状態

```text
visible
hidden
```

### 完了条件

- hiddenモデルは通常Pickerから消える。
- Manage Modelsでは再表示できる。
- 選択中モデルはhiddenでもSession Headerへ表示する。

### 実施記録

2026-08-23、v1.13.0 で実装。Android ローカルの exact `modelId` 表示設定。通常 Picker から hidden を除外し、Manage Models から再表示できる。選択中 hidden は header に残す。実機検証は未実施。次は TASK-402。詳細は `CHANGELOG.md` と `docs/implementation_status.md`。

---

## TASK-402: Session Context Usage

### 第一段階

構造化された:

```text
used
size
```

だけを扱う。

Android表示:

```text
Context 53K / 200K · 26%
```

### 完了条件

Prompt後にContext量が更新される。

---

## TASK-403: Context Breakdown

### 実装優先順位

1. ACP structured breakdown
2. Cursor公式structured interface
3. `/context`の隔離parser

### 方針

取得できなければ合計だけ表示する。

推測でSystem / Tools等へ配分しない。

### UI

初期は折りたたみ。

```text
Context 53K / 200K · 26% >
```

展開時だけ詳細表示。

---

## TASK-404: Session Token Usage / Cost

取得可能な値のみ表示する。

想定:

```text
input
output
cache read
cache write
reasoning
total
cost
```

ない値は`0`ではなく非表示。

---

## TASK-405: Account Usage Capability

このタスクはPhase 4最後に行う。

### 目的

Cursor契約上の残量を正式に取得できる方法が存在するか確認する。

### 実装条件

公式・安定した構造化interfaceが存在する場合のみ実装。

### 禁止

- Dashboard HTML scraping
- 非公開endpointへの依存
- Token量から月間残量を推測
- 複数Poolの根拠なき合算

### UI

取得可能なら右上に円形ゲージ。

取得不能ならゲージを表示しない。

この機能が取得不能でもMVP全体をBlockしない。

---

# Phase 5 — Voice Input

## TASK-500: Android Audio Routing Spike

音声認識より先に実施する。

### 確認する構成

```text
Bluetooth earbuds: connected for playback
Android built-in mic: recording input
```

### 実測対象

- built-in mic選択
- actual routed device
- Bluetooth playback継続
- communication modeへ意図せず移行しないか
- 複数Android端末

### 成果物

```text
docs/android_audio_routing_report.md
```

### Gate

Bluetooth接続中に本体マイク録音が成立することを少なくとも対象端末で確認してからSTT UIを作る。

---

## TASK-501: Push-to-Talk Recorder

### 実装

- AudioRecord
- device selection
- record start/stop
- cancel
- PCM stream
- audio state

---

## TASK-502: STT Adapter

STT実装を抽象化する。

```text
SpeechToTextEngine
start()
writeAudio()
finish()
cancel()
```

MVPは1engineのみでよい。

---

## TASK-503: Voice Prompt UX

Flow:

```text
Hold / Tap mic
→ Listening
→ Stop
→ STT result
→ Edit
→ Send
```

自動送信しない。

---

# Phase 6 — Reliability / Security

## TASK-600: Event Replay / Reconnect

- lastEventId
- deduplication
- reconnect
- state resync

---

## TASK-601: Daemon Restart Recovery

Daemon再起動後に:

```text
Workspace metadata
Session metadata
Cursor session mapping
```

を復元する。

---

## TASK-602: Cursor Process Recovery

ACP異常終了時:

- session状態を壊さない
- process再起動
- load可能Sessionは再接続
- 実行中commandを勝手に再実行しない

---

## TASK-603: Security Hardening

最低限:

- path traversal
- symlink escape
- sensitive file policy
- device auth
- replay protection
- permission policy
- secret logging check

---

## TASK-604: Android Background Reliability

- process lifecycle
- WebSocket reconnect
- FCM
- notification deep link
- Doze影響確認

---

# 3. テスト戦略

## 3.1 Daemon Unit Tests

重点:

- Workspace path sandbox
- symlink escape
- Session store
- Event normalization
- ACP JSON-RPC transport
- file reference parser
- sensitive file matcher
- Context parser

---

## 3.2 ACP Integration Tests

可能な限り二層にする。

### Mock ACP

高速CI用。

以下をfixture化する。

```text
streaming message
tool call
permission request
cancel
usage update
unknown event
process crash
```

### Real Cursor CLI Smoke

ローカルまたは明示的CIのみ。

- handshake
- create
- prompt
- load
- cancel
- model config

外部利用量を消費するため通常Unit Testには含めない。

---

## 3.3 Relay Tests

- routing
- auth rejection
- reconnect
- duplicate event
- machine offline
- multiple sessions

---

## 3.4 Android Tests

### Unit

- ViewModel state
- Event reducer
- model visibility
- context calculation
- file reference rendering

### UI

- Workspace → Session → Chat navigation
- streaming text
- approval card
- diff
- file viewer
- model picker
- context expansion

### Device manual

- Bluetooth playback + built-in mic
- notification actions
- background reconnect

---

# 4. Grok 4.6へ渡すタスク形式

GrokにはTASK ID単位で渡す。

良い例:

```text
TASK-102を実装してください。

Source of Truth:
- docs/cursor_remote_android_spec_v0.3.md
- docs/implementation_plan_grok_4.6.md

Scope:
- ACP Session Adapter
- session.create
- session.load
- session.send
- session.cancel
- assistant.message / assistant.status / agent.completed / failed / interrupted

Non-goals:
- Android
- Relay
- Diff
- File Viewer
- Model Picker
- Voice

Acceptance criteria:
[この計画書のTASK-102をそのまま記載]

実装前に既存コードを調査し、最小変更案を決めてから実装してください。
完了前に関連テストを実行してください。
```

悪い例:

```text
設計書を読んでアプリ全部作って。
```

長時間実行できるモデルでも、この指定では機能境界、検証点、レビュー単位が失われるため使用しない。

---

# 5. 1タスクの理想サイズ

目安は以下。

```text
変更ファイル: 3〜10程度
新規概念: 1つ
主要Acceptance Test: 1〜5個
```

例外はRepository FoundationやAndroid Skeleton。

1タスク内に以下を同時に含めない。

```text
ACP + Relay + Android UI
Permission + Diff + File Viewer
Models + Account Usage + Voice
```

境界をまたぐ必要がある場合でも、先にProtocolを定義し、その後各層を別TASKで実装する。

---

# 6. コミット方針

原則として1 TASK = 1 logical commit。

例:

```text
chore: initialize project structure
feat(protocol): add session event types
feat(daemon): add cursor ACP process manager
feat(daemon): add resumable session adapter
feat(android): add workspace and session navigation
feat(android): stream cursor chat responses
feat(daemon): add permission bridge
feat(android): add diff viewer
feat(android): add dynamic model picker
feat(android): add context usage panel
feat(android): add push-to-talk voice input
```

Grokには自動pushを常に許可せず、まず変更とテスト結果を確認できる運用でもよい。

---

# 7. 実装順のGate

以下をGateとして扱う。

## Gate A

TASK-105 Local E2Eが成功するまでAndroid実装へ進まない。

理由:
Cursor CLI / ACP側が成立しない状態でAndroidを作ると、UIが未確定Backend APIへ依存する。

2026-08-17: 実 Cursor CLI での Local E2E は成功。記録は `docs/local_e2e_report.md`。Gate A を通過。

## Gate B

TASK-204 Chat StreamingがAndroid実機で動くまでDiff / Voiceへ進まない。

2026-08-22: TASK-204 は v1.7.0。SM-S928Q / Android 16、localhost Relay + adb reverse で Chat Streaming を確認し Gate B を通過。詳細は `docs/implementation_status.md`。

理由:
Remote通信とSession lifecycleを先に安定させる。

## Gate C

TASK-300 Permission Flowが完成するまで危険な自動実行機能を追加しない。

2026-08-22: TASK-300 は v1.8.0。SM-S928Q / Android 16 で Approve / Reject の両経路から completed まで確認し Gate C を通過。詳細は `docs/implementation_status.md`。

## Gate D

TASK-500 Audio Routing Spikeが成功するまでSTT UIを完成させない。

理由:
今回の音声機能で最重要なのは認識エンジンよりBluetooth接続時の入力経路である。

---

# 8. 最初にGrok 4.6へ渡すタスク

最初の実装タスクは`TASK-000`ではなく、リポジトリが実質空の場合は以下の順序とする。

```text
TASK-000  Repository Foundation
TASK-001  Remote Protocol基礎型
TASK-100  Cursor ACP Capability Probe
TASK-101  Cursor ACP Process Manager
TASK-102  ACP Session Adapter
TASK-103  Workspace Manager
TASK-104  Session Metadata Store
TASK-105  Local E2E Harness
```

ここまでを最初のマイルストーンとする。

名称:

```text
Milestone 1 — Cursor CLI Local Core
```

完了条件:

**Cursor Desktopを一度も起動せず、PC上のLocal DaemonだけでWorkspaceを指定し、Cursor Sessionを作成・継続・再開・停止できる。**

この状態を確認してからRelayとAndroidへ進む。確認記録は `docs/local_e2e_report.md`。
