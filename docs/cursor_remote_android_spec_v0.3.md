# Cursor CLI Remote for Android — 仕様書

- 文書バージョン: v0.3
- 対象: MVP
- クライアント: Android
- PC側バックエンド: Cursor CLI / ACP
- 基本モデル: Workspace → Session → Conversation
- Cursor Desktop依存: なし
- 文書ステータス: 基本設計

---

## 1. 概要

本アプリは、PC上で動作するCursor CLIをAndroid端末から操作するためのネイティブクライアントである。

Cursor Desktopを起動して遠隔操作するのではなく、PC側でCursor CLI / ACPとLocal Daemonのみを動作させる。AndroidアプリはLocal Daemonを介してCursorのセッションを作成・再開し、会話、実行状態、承認要求、Diff、ファイル参照、音声入力を扱う。

ユーザー体験は一般的なAIチャットアプリに近づける。プロジェクトフォルダをWorkspaceとして登録し、そのWorkspace内に複数のSessionを持ち、過去Sessionを一覧から再開できる構成とする。

ターミナル画面そのものは主要UIにしない。Cursor CLIの構造化イベントをAndroid向けのイベントへ変換し、ユーザーが必要な情報だけを確認・操作できるようにする。

---

## 2. プロダクトの定義

本アプリは「Cursorのリモートデスクトップ」ではなく、「Cursor CLIをバックエンドにしたAndroid用AIコーディングクライアント」である。

基本操作は以下に限定する。

- Workspaceを選ぶ
- Sessionを作成または再開する
- テキストまたは音声で指示する
- Cursorの応答を見る
- ツール実行状態を見る
- 必要な操作をApprove / Rejectする
- Diffを見る
- Cursor応答内のファイル参照を開く
- 実行を停止する
- 完了・失敗・承認待ちを通知で受け取る
- 利用可能なモデルを選択する
- 不要なモデルをモデル一覧から非表示にする
- Sessionのコンテキスト使用量と内訳を確認する
- 取得可能な場合はCursorアカウントの利用状況を確認する

Cursor Desktopはこれらの操作に不要とする。

---

## 3. 必須目標

1. Cursor Desktopを起動せずに利用できる。
2. AndroidからPC上のCursor CLIセッションを作成できる。
3. 過去のCursorセッション一覧をAndroidから確認できる。
4. 過去セッションを選択して会話を再開できる。
5. セッション作成時に対象Workspaceを指定できる。
6. 複数Workspaceを登録・切り替えできる。
7. Androidからテキスト指示を送信できる。
8. Cursorの応答をストリーミング表示できる。
9. Cursorのツール実行・コマンド実行状態を表示できる。
10. Cursorからの承認要求をAndroidでApprove / Rejectできる。
11. 実行中の処理をAndroidから停止できる。
12. Cursorによるファイル変更とDiffをAndroidから確認できる。
13. Cursor応答中のWorkspace内ファイル参照を自動でリンク化できる。
14. ファイルリンクをタップするとAndroid上で読み取り専用表示できる。
15. Androidから音声でプロンプト入力できる。
16. Bluetoothイヤホン接続中でも、既定ではAndroid端末本体マイクを使用できる。
17. Bluetooth音声を意図せず通話用モードへ切り替えないことを目標とする。
18. セッション完了、失敗、承認待ちをPush通知できる。
19. PC側へインターネットから直接到達可能なポートを開放せずに利用できる。
20. Workspace外へのファイルアクセスをLocal Daemon側で拒否できる。
21. 現在のCursorアカウントで利用可能なモデル一覧を自動取得できる。
22. Sessionごとに使用モデルを選択・変更できる。
23. 不要なモデルをAndroid側のModel Pickerから非表示にできる。
24. Sessionのコンテキスト使用量を合計値として表示できる。
25. 取得可能な場合はコンテキスト使用量のカテゴリ別内訳を表示できる。
26. Cursorから契約上の利用済み量・残量を正式に取得できる場合、Android上で利用状況を表示できる。
27. 利用枠情報を取得できない環境では推測値を表示しない。

---

## 4. 非目標

MVPでは以下を対象外とする。

- Cursor Desktopの画面転送
- リモートデスクトップ
- 完全なSSHクライアント
- Android上での本格的なコード編集
- Android上でのIDE再現
- 任意のPCファイルシステム閲覧
- `[[file]]` 等を使った手動ファイル参照構文
- ファイル検索・補完UI
- 複数人共同操作
- Cursor以外のAIエージェント正式対応
- 常時録音型音声アシスタント
- Relay Serverへのソースコード永続保存

---

## 5. 中心データモデル

アプリの情報構造は以下の3階層とする。

```text
Workspace
  └── Session
        └── Conversation / Events
```

### 5.1 Workspace

WorkspaceはCursorに作業させるPC上のフォルダを表す。

例:

```text
~/projects/my-app
~/projects/backend
~/work/internal-tool
```

Workspaceごとに複数のSessionを持てる。

### 5.2 Session

Sessionは1つの継続可能なCursor会話を表す。

例:

```text
Workspace: ~/projects/my-app

Sessions
├─ 認証周りの修正
├─ Androidレイアウト修正
├─ APIエラー調査
└─ README更新
```

SessionはCursor側のSession IDとRemote側のSession IDを紐付ける。

### 5.3 Conversation / Events

Session内部では、単純なチャット履歴だけでなく、以下のイベントを時系列で扱う。

- User message
- Assistant message
- Tool execution
- Command execution
- Permission request
- File change
- Diff
- Test result
- Error
- Completion

---

## 6. システム構成

```text
┌──────────────────────────────┐
│ Android App                  │
│                              │
│ - Workspace UI               │
│ - Session UI                 │
│ - Chat UI                    │
│ - Voice Input                │
│ - Diff Viewer                │
│ - File Viewer                │
│ - Approve / Reject           │
│ - Push Notifications         │
└──────────────┬───────────────┘
               │
               │ HTTPS / WebSocket
               ▼
┌──────────────────────────────┐
│ Relay Server                 │
│                              │
│ - Authentication             │
│ - Device Pairing             │
│ - Connection Routing         │
│ - Event Relay                │
│ - Push Notification Trigger  │
└──────────────┬───────────────┘
               │
               │ outbound WebSocket
               ▼
┌──────────────────────────────┐
│ Local Daemon on PC           │
│                              │
│ - Workspace Manager          │
│ - Session Manager            │
│ - Cursor ACP Client          │
│ - Permission Policy          │
│ - File Access                │
│ - Git / Diff Collector       │
└──────────────┬───────────────┘
               │
               │ stdio / JSON-RPC
               ▼
┌──────────────────────────────┐
│ Cursor CLI / ACP             │
│                              │
│ - Agent                      │
│ - Session                    │
│ - Tools                      │
│ - Model                      │
└──────────────────────────────┘
```

Cursor Desktopは構成要素に含めない。

---

## 7. Cursor接続方式

### 7.1 基本方針

MVPではCursor CLIのACPインターフェースを正式な接続方式とする。

Local DaemonがACPクライアントとしてCursor CLIと通信する。

```text
Android
   ↓
Relay
   ↓
Local Daemon
   ↓
ACP
   ↓
Cursor CLI
```

ターミナル表示文字列のスクレイピングやANSI解析は主要経路として使用しない。

### 7.2 ACPで扱う責務

最低限以下を扱う。

- Session作成
- Session再開
- Prompt送信
- Assistant response
- Streaming update
- Tool execution update
- Permission request
- Permission response
- Cancel
- Session state

ACPの実際のAPI差異はLocal Daemon内部へ隠蔽し、AndroidにはRemote独自Protocolだけを公開する。

### 7.3 フォールバック

ACP側で不足機能が存在する場合に限り、Cursor CLIの構造化出力またはCLIコマンドを補助的に使用する。

PTY画面解析は最終手段とし、MVP要件には含めない。

---

## 8. Workspace仕様

## 8.1 Workspace登録

Local Daemonに複数の許可ルートを設定できる。

例:

```yaml
allowedRoots:
  - /home/user/projects
  - /home/user/work
```

Androidから閲覧可能なのは、この許可ルート配下のみとする。

### 8.2 Workspace選択

Androidのトップレベル画面でWorkspace一覧を表示する。

表示項目:

- Workspace名
- フルパスまたは短縮パス
- Git branch
- 未コミット変更の有無
- 稼働中Session数
- 最終利用日時

例:

```text
Projects

my-app
~/projects/my-app
main · 2 sessions

backend
~/projects/backend
feature/auth · modified

internal-tool
~/work/internal-tool
idle
```

### 8.3 Workspace追加

Androidから許可ルート配下のフォルダを選択し、Workspaceとして登録できる。

MVPでは新規フォルダ作成は必須としない。

### 8.4 WorkspaceとCursor Session

Session作成時に対象WorkspaceのパスをCursor CLI / ACPへ作業ディレクトリとして渡す。

Sessionの途中でWorkspaceを変更しない。

別Workspaceで作業する場合は別Sessionを作成する。

---

## 9. Session仕様

## 9.1 Session一覧

Workspaceを開くと、そのWorkspaceに紐づくSession一覧を表示する。

例:

```text
my-app

認証周りの修正
2分前 · waiting

APIレスポンス調査
昨日 · completed

UIリファクタ
8月15日 · completed

＋ New session
```

### 9.2 Session状態

```text
idle
running
waiting_approval
waiting_user
completed
failed
interrupted
disconnected
```

### 9.3 Session作成

新規Session作成時に最低限以下を指定する。

```text
workspace
initial prompt
optional title
```

タイトルを指定しない場合は、最初のPromptまたはCursorの会話内容からLocal Daemon側で短い表示名を生成してよい。

### 9.4 Session再開

過去Sessionを選択すると、Cursor側Session IDを使用して会話コンテキストを復元する。

Remote側で過去メッセージ全文を再送して擬似的に再現する方式は基本としない。

### 9.5 Session識別子

```json
{
  "id": "remote_sess_123",
  "cursorSessionId": "cursor_sess_abc",
  "workspaceId": "ws_001",
  "title": "認証周りの修正",
  "status": "running",
  "createdAt": "...",
  "updatedAt": "..."
}
```

### 9.6 Session永続化

Local Daemonは以下を永続化する。

- Remote Session ID
- Cursor Session ID
- Workspace ID
- Title
- Status
- CreatedAt
- UpdatedAt
- 最終Event ID
- 最低限必要なRemote UIメタデータ

会話本文の正本は可能な限りCursor側Sessionとし、Relay Serverを正本にしない。

---

## 10. Androidアプリ

### 10.1 推奨技術

- Kotlin
- Jetpack Compose
- Coroutines / Flow
- OkHttp WebSocket
- Room
- Android Keystore
- Firebase Cloud Messaging

### 10.2 主要画面

#### A. Machines

PC一覧。

表示:

- PC名
- Online / Offline
- 最終接続時刻

#### B. Workspaces

選択PC上のWorkspace一覧。

表示:

- Workspace名
- Path
- Git branch
- 変更状態
- Session数

#### C. Sessions

選択Workspace上のSession一覧。

操作:

- New Session
- Open Session
- Resume Session
- Session削除またはRemote履歴非表示

Cursor側Session削除機能が安全に利用できない場合、MVPではRemote側非表示のみでもよい。

#### D. Chat

ChatGPT等に近い縦型会話UIとする。

表示:

- User message
- Cursor message
- Tool state
- Command state
- Approval card
- File references
- Diff summary
- Error
- Completion

入力:

- Text
- Voice
- Send
- Stop

#### E. Chat Top Bar

Session画面上部には、現在モデルと、取得可能な場合のCursor利用状況を表示する。

```text
┌────────────────────────────────────┐
│ my-app / 認証周りの修正       ◔  │
│ GPT-5.6 Sol ▾                      │
└────────────────────────────────────┘
```

- モデル名タップ: Model Pickerを開く
- 右上の円形ゲージ: Cursor Account Usageを開く
- Account Usageを取得できない環境: 円形ゲージ自体を非表示にする

右上ゲージはSession Contextではなく、Cursor契約上の利用枠を表す。両者を同じ指標として扱わない。

#### F. Context Summary

Chat画面にはSession Contextの合計値をコンパクトに表示する。

```text
Context  53K / 200K  26%
```

初期状態では合計値だけを表示し、タップで詳細を展開する。

```text
Context  53K / 200K  26%
────────────────────────
System prompt           5K
Tools                  12K
Rules                   3K
Skills                  2K
MCP                     4K
Subagents               1K
Conversation           20K
Summarized conversation 6K
```

詳細値をCursorから取得できない場合は合計値のみ表示し、推測内訳は生成しない。

---

## 11. Remote Protocol

AndroidはCursor ACPを直接理解しない。

Local DaemonがCursor固有イベントをRemote Protocolへ変換する。

### 11.1 Event Types

```text
workspace.updated

model.catalog_updated
model.selection_changed

account.usage_updated

session.created
session.loaded
session.status_changed
session.context_updated
session.context_breakdown_updated

user.message
assistant.message
assistant.status

tool.started
tool.output
tool.completed
tool.failed

command.started
command.output
command.completed
command.failed

permission.requested
permission.resolved

file.changed
file.reference
file.content

diff.updated

test.started
test.completed

agent.waiting
agent.completed
agent.failed
agent.interrupted
```

### 11.2 Command Types

```text
workspace.list
workspace.register

model.list
model.select
model.visibility.update

account.usage.get

session.list
session.create
session.load
session.send
session.cancel
session.context.get
session.context_breakdown.get

permission.approve
permission.reject

file.read
diff.read
```

### 11.3 Event例

```json
{
  "type": "permission.requested",
  "sessionId": "remote_sess_123",
  "eventId": "evt_456",
  "timestamp": "2026-08-17T07:00:00+09:00",
  "payload": {
    "kind": "shell",
    "command": "git push origin main",
    "risk": "high"
  }
}
```

---

## 12. モデル管理

モデル一覧はアプリへ固定値として埋め込まず、Cursorが現在の認証アカウント・チームに対して公開しているカタログをSource of Truthとする。

### 12.1 モデル一覧の自動取得

取得優先順位:

1. ACP Session Config Optionsで`category = model`として公開された選択肢
2. Cursor SDKの`Cursor.models.list()`によるアカウント/チーム別モデルカタログ
3. Cursor CLIが公式に公開する構造化モデル情報

Local Daemonは取得結果をRemote Protocolの共通形式へ変換する。

```json
{
  "id": "model-id",
  "displayName": "Model Name",
  "description": "Optional description",
  "parameters": [],
  "variants": [],
  "available": true
}
```

モデルID、モデル名、parameter、variantはハードコードしない。

以下のタイミングで再取得可能とする。

- Local Daemon起動時
- Cursor再認証時
- Model Pickerの手動Refresh
- Cursor側から設定更新が通知された場合
- キャッシュ有効期限経過時

### 12.2 Model Picker

Session画面のモデル名をタップするとModel Pickerを開く。

```text
Models

● GPT-5.6 Sol
  Claude Sonnet 5
  Claude Opus 5
  Gemini 3.1 Pro
  Grok 4.6
  Composer 2.5
  Auto / Router

Manage models
```

通常一覧には、現在利用可能かつユーザーが非表示にしていないモデルだけを表示する。

### 12.3 Sessionモデル変更

モデル選択はSession単位とする。

ACPがSession Config Optionsとしてモデル選択を公開している場合、その設定変更を正式経路として使用する。

モデル変更後、Androidは「変更要求中」と「Cursor側で確定済み」を区別できる状態を持つ。

Run進行中にCursor側がモデル変更を許可しない場合、現在Run終了後に反映してよい。

実際に使用されたモデルがCursor側から報告された場合は、その値を最終的な表示状態とする。

### 12.4 モデル固有設定

Cursorがモデルに関連する追加設定を公開する場合、Model Picker内に副設定として表示する。

例:

- reasoning / thought level
- fast mode
- context configuration
- Router optimization mode
- その他`model_config`カテゴリ

項目名と候補値はCursorから動的取得し、特定モデル専用の設定値をAndroidへ固定実装しない。

### 12.5 モデル非表示

モデル数が多いことを前提に、表示管理機能を持つ。

各モデルについて以下を設定できる。

```text
visible
hidden
```

非表示は本アプリ内だけの表示設定であり、Cursorアカウント側のモデル利用可否を変更しない。

仕様:

- 現在選択中モデルは、hiddenでもSession画面上では表示する。
- Model Picker通常一覧ではhiddenモデルを除外する。
- Manage Modelsでは取得済み全モデルを表示し、再表示できる。
- 新規検出モデルはデフォルトでvisibleとする。
- Cursor側で利用不可になったモデルは通常一覧から除外する。
- 過去Sessionが利用不可モデルを参照する場合は`Unavailable`として履歴表示してよい。

モデル表示設定はモデルIDをキーとして永続化する。

---

## 13. Cursor利用状況

Cursor契約上の「どのくらい使えるか」と、Session Context Windowの使用量は別概念として扱う。

### 13.1 Account Usage

Cursorの正式なAPIまたは構造化インターフェースから、現在の認証ユーザーについて以下を取得できる場合に表示する。

- Usage Pool名
- 利用済み量
- 残量
- 上限
- リセット日時
- On-demand利用状態
- 必要に応じた金額

複数Usage Poolが存在する場合は1つの数字へ無理に統合しない。

例:

```text
Cursor Usage

Cursor Models
68% remaining

Other Models
42% remaining

Resets Sep 3
```

### 13.2 右上円形ゲージ

Session画面右上に小型の円形ゲージを表示する。

現在選択モデルが消費するUsage PoolをCursorの情報から判別できる場合、そのPoolの残量または消費率をゲージに使用する。

```text
◔ 68%
```

判別できない場合は、複数Poolを1つの割合へ合成しない。Account Usageを取得できる場合は、割合を持たないUsageアイコンとして表示し、タップ後のPanelで各Poolを確認できるようにしてよい。

ゲージタップでUsage Panelを開く。

### 13.3 Account Usageを取得できない場合

個人アカウント等で契約上の利用枠を取得する正式なインターフェースが存在しない場合:

- HTMLスクレイピングへ依存しない
- Dashboardの非公開APIへ依存しない
- Session Token Usageから月間残量を逆算しない
- 推測による残量%を表示しない
- Account Usage Gaugeを非表示にする

取得不能はエラーではなく、対応Capabilityがない状態として扱う。

### 13.4 Session Token Usage / Cost

Cursorから取得できる場合、Session単位のToken Usageと累積CostをUsage Panelへ表示する。

例:

```text
This session

Total tokens   184K
Cost           $0.42
```

Token内訳を取得可能な場合:

```text
Input
Output
Cache read
Cache write
Reasoning
Total
```

値が提供されないRuntimeでは該当項目を表示しない。

Account UsageとSession Costは別表示とする。

---

## 14. コンテキスト使用量

Context Window使用量はSession単位で管理する。

### 14.1 合計

ACPの`usage_update`等から以下を取得する。

```text
used
size
```

Android側では以下を算出する。

```text
remaining = size - used
percentage = used / size * 100
```

基本表示:

```text
Context 53K / 200K · 26%
```

合計表示は折りたたみ状態でも確認できる。

### 14.2 折りたたみ詳細

初期状態:

```text
Context 53K / 200K · 26%  >
```

展開状態:

```text
Context
53K / 200K · 26%

System prompt            5K
Tools                   12K
Rules                    3K
Skills                   2K
MCP                      4K
Subagents                1K
Conversation            20K
Summarized conversation  6K
```

### 14.3 Contextカテゴリ

Cursorが提供するカテゴリを動的に保持できるデータモデルとする。

既知カテゴリとして最低限以下を扱えること。

```text
system_prompt
tools
rules
skills
mcp
subagents
conversation
summarized_conversation
```

将来Cursorがカテゴリを追加した場合にアプリ更新を必須にしないよう、未知カテゴリも`id + displayName + tokens`として表示可能にする。

### 14.4 詳細取得方法

取得優先順位:

1. ACPが構造化Context Breakdownを提供する場合はそれを使用する。
2. Cursor CLIが`/context`をACP Slash Commandとして公開している場合、詳細展開時に取得する。
3. その他Cursor公式の構造化インターフェースが利用可能な場合は使用する。

`/context`の結果が人間向けテキストのみの場合、解析処理はCursor Adapter内部へ隔離し、UIやRemote Protocolをその文字列表現へ依存させない。

詳細を取得できない場合は`used / size`の合計だけを表示する。

### 14.5 Context更新

以下で表示を更新する。

- Session作成/再開後
- Prompt完了後
- `usage_update`受信時
- Compaction発生時
- モデル切替によりContext Window Sizeが変わった場合

Cursorが過去会話を要約・圧縮した場合も、新しい合計値を正として扱う。

MVPでは本アプリ独自の自動Compactionを実装しない。

---

## 15. Cursor応答内ファイルリンク

Cursorの応答中に現在のWorkspace内ファイルを示すパスが含まれる場合、自動的にリンク化する。

例:

```text
src/auth/login.ts を変更しました。
```

Androidでは `src/auth/login.ts` をタップ可能にする。

### 15.1 対応形式

最低限以下を扱う。

```text
src/auth/login.ts
docs/spec.md
src/api/client.kt:120
src/api/client.kt:120-160
```

行番号付きの場合、File Viewerを該当行付近まで自動スクロールする。

### 15.2 パス解決

Android側だけでパスの正当性を判断しない。

Local Daemonで以下を行う。

1. SessionのWorkspace Rootを取得する。
2. 参照文字列をWorkspace Rootからの相対パスとして解決する。
3. canonical pathを取得する。
4. Workspace Root配下か確認する。
5. 禁止ファイルでないことを確認する。
6. ファイル内容を返す。

### 15.3 File Viewer

MVPでは読み取り専用。

最低限:

- Syntax-friendly text display
- Line number
- 指定行へのスクロール
- Copy
- Reload

編集機能は持たない。

### 15.4 禁止対象

Workspace内でも以下はデフォルトで非表示または拒否可能とする。

```text
.env
.env.*
*.pem
*.key
credentials*
secrets*
```

禁止規則はLocal Daemon設定で変更可能とする。

---

## 16. Diff仕様

Cursorがファイルを変更した場合、AndroidからDiffを確認できる。

### 16.1 表示

- Changed files
- Added lines
- Removed lines
- Unified diff
- File単位折りたたみ
- 横スクロール

例:

```text
src/auth/login.ts
+18 -7

[View diff] [View file]
```

### 16.2 Diff取得元

可能な場合はCursorのイベント情報を利用する。

不足する場合はLocal DaemonがGit diffを取得する。

Git repositoryでないWorkspaceでは、利用可能な変更情報だけを表示する。

---

## 17. 承認機能

Cursorがユーザー承認を必要とした場合、Androidへ即時反映する。

### 17.1 UI

例:

```text
Approval required

git push origin main

Risk: High

[Reject] [Approve]
```

### 17.2 Push通知

アプリがバックグラウンドの場合:

```text
Cursor is waiting for approval
git push origin main
```

低〜中リスク操作では通知ActionからApproveを許可してもよい。

高リスク以上ではアプリを開いて詳細確認させる方式を推奨する。

### 17.3 Local Policy

最終権限はLocal Daemon側が保持する。

例:

```yaml
permissions:
  low: auto
  medium: cursor_policy
  high: require_remote_approval
  critical: deny
```

AndroidまたはRelayが改ざんされても、Local Daemonの禁止ポリシーを超えて実行できない設計とする。

---

## 18. 音声入力

音声入力はPush-to-Talk方式を基本とする。

### 18.1 目的

キーボード入力を減らし、Androidから自然言語でCursorへ追加指示を送れるようにする。

### 18.2 必須要件

- Bluetoothイヤホン接続中でも利用できる。
- 既定ではAndroid端末本体マイクを使用する。
- Bluetoothマイクへ自動的に切り替えない。
- Bluetoothイヤホンを通話用Audio Routeへ切り替える処理をアプリ自身では行わない。
- 実際に使用中の録音デバイスを確認できる。
- STTと物理マイク選択を分離する。
- 認識結果は送信前に編集できる。
- MVPでは自動送信しない。

### 18.3 音声経路

```text
Android Built-in Mic
        ↓
AudioRecord
        ↓
PCM
        ↓
Speech-to-Text
        ↓
Editable Text
        ↓
Send
        ↓
Session
```

### 18.4 Bluetooth利用時の基本動作

```text
Bluetooth Headphones
       ↑
       │ Media playback
       │
Android
       │
       └── Built-in Mic → STT
```

設定:

```text
音声入力マイク

● スマートフォン本体
○ 自動
○ Bluetooth機器
```

初期値は「スマートフォン本体」。

### 18.5 Android API方針

録音はアプリ側で管理する。

候補:

- AudioRecord
- AudioManager
- AudioDeviceInfo
- AudioRouting
- MediaRecorder.AudioSource.VOICE_RECOGNITION

STTエンジン自身に物理マイク選択を全面的に任せない。

---

## 19. Local Daemon

Local Daemonは本システムの中核とする。

### 19.1 必須機能

- Relayへのoutbound常時接続
- Device pairing
- Allowed roots管理
- Workspace登録
- Workspace一覧取得
- Git状態取得
- Cursor CLI / ACP起動
- ACP接続
- ACP Session Config Options取得・更新
- 利用可能モデルカタログ取得
- Cursor SDK等の公式カタログ読み取り
- Model Catalog cache
- Model visibility設定管理
- Session model選択・変更
- ACP `usage_update`受信
- Session Context集計
- Context Breakdown取得
- Session Token Usage / Cost取得
- 取得可能な場合のAccount Usage取得
- Cursor Session作成
- Cursor Session再開
- Prompt送信
- Event変換
- Permission処理
- Cancel
- Diff取得
- Cursor応答内ファイル参照解析
- Workspace内ファイル読み取り
- Sensitive file policy
- Session metadata永続化
- Relay再接続
- Event再同期

### 19.2 Cursor process管理

Cursor CLIプロセスはLocal Daemonが管理する。

プロセス寿命とSession寿命を必ずしも1:1にしない。

再接続やDaemon再起動後でも、Cursor側で再開可能なSessionは再利用する。

### 19.3 PCリソース方針

Cursor Desktopを常駐させない。

PC側常駐プロセスは可能な限り以下へ限定する。

```text
Local Daemon
Cursor CLI / ACP
必要な開発ツール
```

不要なCursor Desktopプロセスを本システムが起動することは禁止する。

---

## 20. Relay Server

Relayは実行主体ではなく中継層とする。

### 20.1 必須機能

- User authentication
- Device authentication
- Machine authentication
- Pairing
- WebSocket routing
- Connection state
- Push notification trigger
- 一時イベント配送

### 20.2 保存しない情報

原則として永続保存しない。

- Source code全文
- File contents
- `.env`
- Credentials
- SSH keys
- Cursor credentials
- Git credentials
- Raw voice audio

Session metadataをクラウド同期したくなった場合は将来仕様とする。

---

## 21. 認証・ペアリング

### 21.1 初回

1. Local Daemonが一時Pairing Tokenを生成する。
2. PC側にQRコードを表示する。
3. Androidで読み取る。
4. Android Device Keyを登録する。
5. Pairing Tokenを失効させる。

### 21.2 Android

秘密情報はAndroid Keystoreへ保存する。

### 21.3 PC

OSのcredential storageを優先する。

長期間有効な秘密鍵を平文設定ファイルへ保存しない。

---

## 22. 通信

### Android ↔ Relay

- HTTPS
- WebSocket
- JSON

### Relay ↔ Local Daemon

- TLS WebSocket
- PCからのoutbound接続

PC側のインバウンドポート開放を不要とする。

### 再接続

再接続時:

```text
lastReceivedEventId
currentSessionId
```

を送信し、可能な範囲でイベント欠落を補完する。

---

## 23. オフライン・異常系

### Android切断

Cursor処理は継続可能とする。

再接続後に状態同期する。

### Relay切断

Local DaemonおよびCursor処理は不要に停止しない。

承認待ち中は勝手にApproveしない。

### PC切断

AndroidではMachineをOffline表示する。

Sessionは`disconnected`として表示する。

### Cursor CLI異常終了

該当Sessionを`failed`または`disconnected`へ遷移させる。

可能であればSession再ロードを試行できる。

### Daemon再起動

永続化済みのWorkspace / Session metadataを読み込み、Cursor側Sessionとの再接続可能性を確認する。

---

## 24. 通知

Push対象:

- `permission.requested`
- `agent.completed`
- `agent.failed`
- 長時間の`agent.waiting`

通常のストリーミングメッセージでは通知しない。

同一Event IDに対する重複通知は禁止する。

---

## 25. ログ

### Local Daemon

- Cursor CLI process
- ACP connection
- Workspace access
- Session state
- Permission decision
- File access rejection
- Relay connection
- Errors

### Relay

- Authentication
- Connection
- Routing
- Push delivery
- Errors

### Android

- Connection state
- Audio routing
- STT errors
- UI errors

通常ログへ以下を含めない。

- Source code全文
- Raw audio
- Secrets
- Credentials
- `.env`内容

---

## 26. MVP受け入れ条件

以下をすべて満たした時点をMVP完成とする。

### Cursor CLI / Session

- Cursor Desktopを起動せずに動作する。
- Local DaemonからCursor CLI / ACPへ接続できる。
- Androidから新規Sessionを作成できる。
- Session作成時にWorkspaceを指定できる。
- Androidから過去Session一覧を確認できる。
- 過去Sessionを再開できる。
- Sessionごとに会話コンテキストが維持される。
- AndroidからPrompt送信できる。
- Cursor応答をストリーミング表示できる。
- Androidから処理を停止できる。

### Workspace

- 複数Workspaceを登録できる。
- AndroidからWorkspaceを切り替えられる。
- Allowed Root外のフォルダをWorkspaceにできない。
- WorkspaceごとにSession一覧が分離される。

### Approval / Diff

- 承認要求をAndroidでApprove / Rejectできる。
- ファイル変更を確認できる。
- DiffをAndroidから閲覧できる。
- 完了・失敗・承認待ちをPush通知できる。

### File Link

- Cursor応答中のWorkspace内ファイルパスをリンク化できる。
- リンクタップで読み取り専用File Viewerを開ける。
- 行番号付き参照で該当行付近へ移動できる。
- Workspace外参照をLocal Daemon側で拒否できる。
- 禁止されたSensitive Fileを開けない。

### Model / Usage / Context

- 現在のCursorアカウントで利用可能なモデル一覧を自動取得できる。
- 新しいモデルをアプリ更新なしで検出できる。
- Model PickerからSessionモデルを選択できる。
- Cursorがモデル固有パラメータを公開する場合、それを動的表示できる。
- 不要なモデルを通常のModel Pickerから非表示にできる。
- hiddenモデルをManage Modelsから再表示できる。
- Session Contextの`used / size / percentage`を表示できる。
- Context詳細を取得できる場合は折りたたみ式内訳を表示できる。
- Context詳細を取得できない場合は合計値だけを表示する。
- Account Usageを正式に取得できる環境では右上に利用状況ゲージを表示できる。
- Account Usageを取得できない環境では推測ゲージを表示しない。
- Session Token Usage / Costを取得できる場合はUsage Panelへ表示できる。

### Voice

- Android本体マイクから音声入力できる。
- Bluetoothイヤホン接続中でも本体マイク入力を選択できる。
- アプリ自身が不要なCommunication Audio Routeへ切り替えない。
- STT結果を編集してSessionへ送信できる。

### Network / Security

- PC側ポート開放なしで外出先から利用できる。
- RelayにSource Codeを永続保存しない。
- Android / PC双方のDevice Authenticationが機能する。

---

## 27. MVP実装優先順位

### Phase 1 — Cursor CLI基盤

- Local Daemon
- Cursor CLI / ACP接続
- Workspaceモデル
- Session create / load
- Text prompt
- Streaming response
- Local Session metadata

このPhase終了時点で、PCローカルの簡易クライアントからCursor Desktopなしで継続Sessionを操作できること。確認記録は `docs/local_e2e_report.md`。

### Phase 2 — Android Remote

- Relay WebSocket
- Pairing
- Machine一覧
- Workspace一覧
- Session一覧
- Chat UI
- Stop
- 再接続

このPhase終了時点で、Androidからテキスト中心のCursor CLI操作が完結すること。

### Phase 3 — Coding UX

- Approval
- Push notification
- Diff Viewer
- Cursor応答内ファイルリンク
- Read-only File Viewer
- Git状態表示

このPhase終了時点で、PCを開かずに変更内容の確認と承認判断ができること。

### Phase 4 — Model / Usage / Context

- ACP Session Config Options
- 利用可能モデル自動取得
- Model Picker
- モデル固有パラメータ
- モデル非表示設定
- Session model変更
- ACP `usage_update`
- Context合計表示
- Context Breakdown
- Session Token Usage / Cost
- 取得可能な場合のAccount Usage
- 右上Usage Gauge

このPhase終了時点で、モデル選択とSessionのリソース状況をAndroidだけで把握できること。

### Phase 5 — Voice

- AudioRecord
- Built-in microphone優先
- Bluetooth接続時routing確認
- STT
- Push-to-Talk
- 認識テキスト編集

### Phase 6 — 安定化

- Event replay
- Daemon restart recovery
- Cursor process recovery
- Permission policy
- Sensitive file policy
- ログ
- Androidバックグラウンド動作
- 複数Android端末検討
- 端末別Bluetooth検証

---

## 28. 推奨リポジトリ構成

```text
cursor-cli-remote/
├── android/
│   ├── app/
│   ├── core/
│   ├── data/
│   ├── domain/
│   └── feature/
│       ├── machines/
│       ├── workspaces/
│       ├── sessions/
│       ├── chat/
│       ├── models/
│       ├── usage/
│       ├── context/
│       ├── approval/
│       ├── diff/
│       ├── fileviewer/
│       └── voice/
│
├── daemon/
│   ├── cursor/
│   │   ├── acp/
│   │   ├── catalog/
│   │   ├── usage/
│   │   ├── context/
│   │   ├── process/
│   │   └── sessions/
│   ├── workspace/
│   ├── files/
│   ├── git/
│   ├── permissions/
│   ├── storage/
│   └── transport/
│
├── relay/
│   ├── auth/
│   ├── pairing/
│   ├── websocket/
│   └── notifications/
│
├── protocol/
│   ├── events/
│   ├── commands/
│   └── schemas/
│
└── docs/
```

---

## 29. 将来拡張

Cursorを中心に設計するが、Remote Protocolは特定Agentへ密結合させない。

将来的には以下のAdapterを追加可能とする。

```text
AgentAdapter

createSession()
listSessions()
loadSession()
sendMessage()
streamEvents()
approve()
reject()
cancel()
getDiff()
```

候補:

```text
CursorAcpAdapter
ClaudeCodeAdapter
GrokAdapter
CopilotAdapter
GenericCliAdapter
```

ただしMVPでは抽象化を優先してCursor実装を複雑化しない。

---

## 30. 設計原則

### 30.1 Cursor Desktop非依存

Cursor Desktopを起動しないことを通常運用とする。

### 30.2 Workspace first

すべてのSessionはWorkspaceに所属する。

ファイル、Diff、Git状態、権限境界もWorkspaceを基準にする。

### 30.3 Session first

単発CLI実行の集合として扱わず、継続可能なAI Sessionを第一級オブジェクトとして扱う。

### 30.4 Structured events

ターミナル画面ではなく、意味のあるイベントをAndroidへ送る。

### 30.5 Local authority

ファイルアクセスと実行権限の最終判断はPC側Local Daemonが持つ。

### 30.6 Dynamic model catalog

モデル名やモデル固有設定をハードコードせず、Cursorから取得したカタログを表示する。

### 30.7 No fabricated usage

Account Usage、Context Breakdown、Cost等を取得できない場合は推測値で埋めない。

### 30.8 Mobile-native UX

AndroidではPCのUIを縮小再現しない。

スマートフォンで必要な以下の操作へ最適化する。

- Workspace選択
- Session選択
- 指示
- 音声入力
- 状態確認
- Diff確認
- File確認
- Approve / Reject
- Stop
- 通知確認
