# Cursor ACP Capability Report

- 文書バージョン: v0.2
- 対象タスク: TASK-100 / TASK-404 / TASK-405
- 実測日: 2026-08-17
- 対象設計書: `docs/cursor_remote_android_spec_v0.3.md`
- 実測方針: インストール済み Cursor CLI に対する JSON-RPC 実測のみを記録する。公式ドキュメントや設計書に書かれていても、この実行で観測しなかった機能は「存在する」とは扱わない。

---

## 1. 実行環境

| 項目 | 実測値 |
| --- | --- |
| OS | Windows 10 / 11 (`win32`, x64) |
| CLI 入口 | `C:\Users\Rakua\AppData\Local\cursor-agent\agent.cmd` |
| 実体 | `C:\Users\Rakua\AppData\Local\cursor-agent\versions\2026.08.11-e8db854\node.exe` + `index.js` |
| CLI Version | `2026.08.11-e8db854` |
| アカウント | `agent whoami` でログイン済み（Pro） |
| ACP 起動 | `node.exe index.js acp`（`agent acp` と同等。stdio を確実に握るため version 配下の `node.exe` を直接 spawn） |
| Transport | JSON-RPC 2.0、newline-delimited JSON、stdin/stdout。ログは stderr |
| 作業ディレクトリ | 空の一時 workspace（本リポジトリは cwd に使っていない） |

`agent acp --help` は help 以外の起動オプションを公開しなかった。`--api-key` 等は root CLI オプションとして `agent --api-key ... acp` の形で渡せる。

---

## 2. TASK-100 完了条件

| 完了条件 | 結果 |
| --- | --- |
| ACP handshake 成功 | **成功**。`initialize` → `authenticate(methodId=cursor_login)` |
| 最低 1 Session を作れる | **成功**。`session/new` が `sessionId` を返した |
| 1 Prompt を送り response を受け取れる | **成功**。`session/prompt` の `stopReason=end_turn`、本文 `ACP_PROBE_OK` |
| 実測 Capability 一覧を記録 | 本ファイル |

---

## 3. 確認項目の実測結果

凡例:

- **観測**: この実行で request / response / notification を確認した
- **未観測**: 今回の probe では現れなかった。欠如とは断定しない
- **不在**: この CLI が JSON-RPC で明示的に拒否した

| 確認項目 | 判定 | 実測メモ |
| --- | --- | --- |
| `agent acp` 起動 | 観測 | pid 付きで起動し、JSON-RPC を受信した |
| initialize / handshake | 観測 | `protocolVersion: 1` を返した。`agentInfo` は initialize 応答に含まれなかった |
| capabilities | 観測 | 下記 `agentCapabilities` |
| session create | 観測 | `session/new` → UUID `sessionId` |
| session load / resume | 観測 | `loadSession: true`。同一プロセス内の `session/load` に加え、ACP プロセス終了後に新プロセスで同じ `sessionId` を `session/load` し、follow-up prompt まで成功した |
| prompt 送信 | 観測 | `session/prompt`。応答は `{ stopReason }` のみ。本文は `session/update` 側 |
| streaming update | 観測 | `session/update` の chunk 通知 |
| tool update | 観測 | `tool_call` / `tool_call_update` |
| permission request | 観測 | `session/request_permission` |
| cancel | 観測 | **notification** として成功。request としては不在 |
| Session Config Options | 観測 | `session/new` 応答の `configOptions`。更新は `session/set_config_option` |
| model options | 観測 | `session/new` の `models` と `configOptions[id=model]` |
| usage update | **未観測** | 今回の 3 本の prompt では `usage_update` も usage フィールドも現れなかった |
| slash commands | 観測 | 専用 RPC は不在。`available_commands_update` 通知で一覧が来た |
| context 関連 Capability | 観測 | `promptCapabilities.embeddedContext = false`。構造化 context breakdown は未観測 |

---

## 4. Handshake

### 4.1 Client → Agent `initialize`

送信した params:

```json
{
  "protocolVersion": 1,
  "clientCapabilities": {
    "fs": { "readTextFile": false, "writeTextFile": false },
    "terminal": false
  },
  "clientInfo": { "name": "task100-acp-probe", "version": "0.1.0" }
}
```

応答:

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": { "http": true, "sse": true },
    "promptCapabilities": {
      "audio": false,
      "embeddedContext": false,
      "image": true
    },
    "sessionCapabilities": {
      "list": {}
    }
  },
  "authMethods": [
    {
      "id": "cursor_login",
      "name": "Cursor Login",
      "description": "Authenticate using existing Cursor login credentials. Run 'agent login' first if not logged in."
    }
  ]
}
```

### 4.2 `authenticate`

- `methodId: "cursor_login"` で成功
- 応答 body は `{}`
- 事前に `agent login` / `agent whoami` 済みの状態で実施した。未ログイン時の browser flow は未実測

---

## 5. 実測した JSON-RPC メソッド

### 5.1 成功した request

| method | 必須 params（実測） | 応答の要点 |
| --- | --- | --- |
| `initialize` | `protocolVersion`, `clientCapabilities`, `clientInfo` | capabilities / authMethods |
| `authenticate` | `methodId` | `{}` |
| `session/new` | `cwd`, `mcpServers` | `sessionId`, `modes`, `models`, `configOptions` |
| `session/load` | `sessionId`, `cwd`, `mcpServers` | `modes`, `models`, `configOptions`（`sessionId` は応答に含まれなかった） |
| `session/prompt` | `sessionId`, `prompt[]` | `{ stopReason }` |
| `session/list` | `sessionId` だけでも成功 | `{ sessions: [{ sessionId, cwd, title, updatedAt }] }` |
| `session/set_mode` | `sessionId`, `modeId` | `{}`。続けて `current_mode_update` が来た |
| `session/set_config_option` | `sessionId`, `configId`, `value` | 更新後の `configOptions` 全体 |

`session/prompt` の prompt item は `{ "type": "text", "text": "..." }` で通った。image / audio の prompt item は未送信。

### 5.2 notification として成功

| method | params | 結果 |
| --- | --- | --- |
| `session/cancel` | `{ sessionId }` | 進行中の `session/prompt` が `stopReason: "cancelled"` で完了 |

`session/cancel` を **request**（`id` 付き）で送ると `-32601 Method not found` になった。cancel は request ではなく notification として実装する。

### 5.3 この CLI が拒否した method

| method | 結果 | 解釈 |
| --- | --- | --- |
| `session/cancel`（request） | `-32601 Method not found` | notification を使う |
| `session/slash_command` | `-32601 Method not found` | slash は prompt 文字列または `available_commands_update` 経由 |
| `session/available_commands` | `-32601 Method not found` | 同上。一覧は notification で届く |

存在確認のために params 不足で叩いた結果（method 自体は存在する）:

| method | 不足時の validation |
| --- | --- |
| `session/set_mode` | `modeId: string` が必須 |
| `session/set_config_option` | `configId: string` と `value: string` が必須 |

---

## 6. Session 作成時に返る設定面

`session/new` は次の 4 キーだけを返した。

- `sessionId`
- `modes`
- `models`
- `configOptions`

### 6.1 Modes

`modes.availableModes`:

| id | name | description（原文） |
| --- | --- | --- |
| `agent` | Agent | Full agent capabilities with tool access |
| `plan` | Plan | Read-only mode for planning and designing before implementation |
| `ask` | Ask | Q&A mode - no edits or command execution |

初期値は `currentModeId: "agent"`。`session/set_mode` の `modeId` と、`configOptions[id=mode]` の `value` は同じ三値だった。

### 6.2 Config Options

観測した option は 2 件のみ。

| id | category | type | 役割 |
| --- | --- | --- | --- |
| `mode` | `mode` | `select` | Agent / Plan / Ask |
| `model` | `model` | `select` | モデル選択 |

`session/set_config_option` で `mode=plan` と `model=composer-2.5[fast=true]` を更新し、応答の `currentValue` が書き換わることを確認した。モデル ID は実行アカウントと CLI バージョンに依存する。実装側は ID をハードコードせず、`configOptions` / `models` をそのまま使う。

この実行での初期 `currentModelId` は `grok-4.6[effort=high,fast=true]`。`availableModels` は 35 件だった。`agent models` の CLI 表示名（例: `cursor-grok-4.6-xhigh`）と ACP の `modelId`（例: `grok-4.6[effort=high,fast=true]`）は一致しない。ACP 経路では ACP 側の ID を使う。

---

## 7. `session/update` で観測した種別

| `sessionUpdate` | 観測状況 |
| --- | --- |
| `session_info_update` | title 更新。例: `{ title: "Probe Status OK" }` |
| `available_commands_update` | slash / skill 一覧 |
| `current_mode_update` | `session/set_mode` 後 |
| `user_message_chunk` | prompt 送信後 |
| `agent_thought_chunk` | 思考テキストの stream |
| `agent_message_chunk` | 応答テキストの stream。`content.text` |
| `tool_call` | 新規 tool。`toolCallId`, `title`, `kind`, `status`, `rawInput` |
| `tool_call_update` | 状態更新。`pending` → `in_progress` → `completed`。完了時に `rawOutput` が付く場合あり |

観測した `tool_call.kind`: `execute`, `search`。

`usage_update` は未観測。Account Usage UI をこの通知だけで埋める実装は、再実測するまで行わない。

---

## 8. Permission

`session/request_permission` を 1 回観測した。params キーは `sessionId`, `toolCall`, `options`。

`options`:

| optionId | name | kind |
| --- | --- | --- |
| `allow-once` | Allow once | `allow_once` |
| `allow-always` | Allow always | `allow_always` |
| `reject-once` | Reject | `reject_once` |

probe は `reject-once` を返した。その後も turn は継続し、別 tool（`kind: search`）が permission なしで完了した。どの tool が permission 対象かは allowlist 依存で、今回は `Get-ChildItem -Force`（`kind: execute`）が対象だった。

公式ドキュメント例の `{ outcome: { outcome: "selected", optionId: "allow-once" } }` 形式で応答を受け付けた。

---

## 9. Slash commands

`session/slash_command` という RPC は無い。`session/update` の `available_commands_update.availableCommands[]` で `{ name, description }` が届く。

この実行で届いた name の例:

- builtin / global: `copy-request-id`, `multi-model-review`, `simplify`, `babysit`, `create-hook`, `create-rule`, `create-skill`, `create-subagent`, `loop`, `migrate-to-skills`, `rename-chat`, `sdk`, `shell`, `split-to-prs`, `statusline`, `update-cli-config`
- このマシンの user skill も混在する（Obsidian / Ix 等）

一覧は環境依存。実装は固定リストを持たず、通知内容をそのまま Session に載せる。slash 実行そのもの（prompt に `/name` を載せる等）は未実測。

---

## 10. Cursor 拡張メソッド（公式ドキュメント記載、今回未観測）

[Cursor CLI ACP](https://cursor.com/docs/cli/acp) は次を記載する。本 probe の incoming には現れなかった。

| method | ドキュメント上の種別 | 今回 |
| --- | --- | --- |
| `cursor/ask_question` | blocking request | 未観測 |
| `cursor/create_plan` | blocking request | 未観測 |
| `cursor/update_todos` | notification | 未観測 |
| `cursor/task` | notification | 未観測 |
| `cursor/generate_image` | notification | 未観測 |

未観測のまま Daemon の必須経路にはしない。blocking 拡張が来た場合に備えた「未知 request を落とさず拒否または cancel する」防御は TASK-101 以降で検討してよいが、スキーマを仮定した機能実装はしない。

---

## 11. 後続実装への拘束

1. Local Daemon の ACP 接続は、実測した `initialize` → `authenticate(cursor_login)` → `session/new` を正式経路とする。
2. 子プロセスは `agent acp`、または同等の `node.exe index.js acp`。stdio は NDJSON。
3. Session 作成後の mode / model は `configOptions` と `session/set_config_option` / `session/set_mode` を使う。モデル名のハードコード禁止。
4. 応答本文・思考・tool・slash 一覧は `session/update` から取る。`session/prompt` の result は `stopReason` だけを前提にする。
5. cancel は notification。request として送らない。
6. `usage_update`、構造化 context breakdown、`cursor/*` 拡張、audio prompt、`embeddedContext` は未観測または capability false。これらを前提にした UI / Protocol 埋め込みはしない。
7. `session/load` と `session/list` は使ってよい。ACP プロセスを終了して新プロセスを handshake したあとでも、同じ `sessionId` で `session/load` し follow-up prompt まで通ることを確認した。load 後に前回の `agent_message_chunk` が再送される場合がある。会話履歴 replay の完全性（全メッセージ・tool の再現）は未確認。
8. MCP `http` / `sse` capability は advertise された。実際の MCP 接続は未実測。

---

## 12. 未実測で残す項目

- 未ログイン状態からの `authenticate`
- image prompt（`promptCapabilities.image = true`）
- audio prompt（capability は false）
- slash command の実行
- `allow-once` / `allow-always` 選択時の tool 実行継続
- `usage_update` の有無（長時間 turn / 別モデルでも再確認する価値あり）
- `cursor/*` 拡張の実着信
- MCP server を `session/new.mcpServers` に渡した場合の挙動
- プロセス再起動後 `session/load` における会話履歴 replay の完全性

これらが必要になった時点で再 probe し、本レポートを更新してから実装する。

---

## 13. TASK-104 追実測: ACP プロセス再起動後の `session/load`

- 実測日: 2026-08-17
- 対象 CLI: `2026.08.11-e8db854`（TASK-100 と同じ version ディレクトリの `node.exe` + `index.js acp`）
- 作業ディレクトリ: 空の一時 workspace（本リポジトリは cwd に使っていない）
- clientInfo: `{ name: "task104-restart-load-probe", version: "1.1.0" }`
- incoming `session/request_permission` には `reject-once` を返した

手順:

1. `initialize` → `authenticate({ methodId: "cursor_login" })` → `session/new`
2. `session/prompt`（token `ACP_RESTART_LOAD_OK` を返すよう依頼）
3. ACP プロセスを shutdown
4. 新しい ACP プロセスを起動し、同じ handshake
5. 同じ `sessionId` と `cwd` で `session/load`
6. follow-up の `session/prompt`（token `ACP_RESTART_FOLLOWUP_OK`）

結果:

| 項目 | 結果 |
| --- | --- |
| 初回 `session/new` | 成功。`sessionId` は UUID |
| 初回 `session/prompt` | `stopReason: end_turn`。本文は `session/update` の `agent_message_chunk` で `ACP_RESTART_LOAD_OK` |
| プロセス再起動後の handshake | 成功 |
| `session/load` | 成功。応答に `models.currentModelId` を含んだ。`sessionId` は応答に含まれなかった（TASK-100 と同じ） |
| follow-up `session/prompt` | `stopReason: end_turn`。本文に `ACP_RESTART_FOLLOWUP_OK` |
| 履歴 replay | load 後の `session/update` に、初回応答の `ACP_RESTART_LOAD_OK` も現れた。前回 chunk の再送があり得る。全履歴の完全再現は未確認 |

この実行での `models.currentModelId` は `composer-2.5[fast=true]` だった。値はアカウントと CLI に依存する。実装はモデル ID をハードコードせず、`session/new` / `session/load` 応答の `models.currentModelId` を保存する。

---

## 14. TASK-404 / TASK-405 契約監査（2026-08-24）

公式 ACP v1 の [`UsageUpdate`](https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/schema/v1/schema.json) は `used` / `size` と optional な累積 `cost` のみ。`PromptResponse` は `stopReason` のみで、token 内訳と `state_update` は無い。Cursor の [ACP 拡張](https://cursor.com/docs/cli/acp) に個人 Account Usage の安定 structured interface は無い。個人向け案内は [Spending Dashboard](https://cursor.com/help/models-and-usage/usage-limits) であり、typed personal REST API は未確認。[CLI changelog](https://cursor.com/changelog/cli-jan-16-2026) も個人 usage REST を公開しない。[Team Admin API](https://cursor.com/docs/account/teams/admin-api) と [Organization pooled usage](https://cursor.com/docs/account/organizations/organization-admin-api#org-pooled-usage) は別 admin / org credentials と組織 semantics のため、現 product scope 外。

probe（§3 / §7）では `usage_update` は未観測のまま。公式 schema 上の `used` / `size` / optional `cost` だけを TASK-402 / 404 が防御的に扱う。token 内訳は実装しない。TASK-405 は Dashboard scraping / private endpoint / `/usage` text parse / session cost 推測 / pool 合算を行わず dormant。installed CLI `2026.08.11-e8db854` でも `usage_update` 未観測。
