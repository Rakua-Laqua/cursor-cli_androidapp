# Local E2E Report

- 文書バージョン: v0.2
- 対象タスク: TASK-105
- 確認日: 2026-08-17
- 対象設計書: `docs/cursor_remote_android_spec_v0.3.md`
- 実装計画: `docs/implementation_plan_grok_4.6.md`
- 確認方針: Cursor Desktop を起動せず、リポジトリの `remote-dev` を Windows 上で実行した結果だけを記録する。mock ACP と実 Cursor CLI の両方を記録する。未観測の ACP API は存在前提にしない。

---

## 1. 実行環境

| 項目 | 値 |
| --- | --- |
| OS | Microsoft Windows [Version 10.0.26200.8875] |
| 作業ディレクトリ | `C:\Users\Rakua\Documents\VS Code\Android_App\cursor-cli_androidapp`（リポジトリルート） |
| パッケージ | `cursor-cli-androidapp@1.2.0` |
| クライアント | `remote-dev`（`daemon/dist/cli/remote-dev.js`） |
| Cursor Desktop | 未起動 |

ルートの `npm run remote-dev` は `@cursor-remote/daemon` ワークスペースで実行される。

---

## 2. TASK-105 完了条件

計画書の一連操作。判定は実 Cursor CLI の実行（セクション 4）を正とする。

| 完了条件 | mock ACP | 実 Cursor CLI |
| --- | --- | --- |
| workspace select | 成功 | **成功** |
| session create | 成功 | **成功** |
| prompt | 成功 | **成功** |
| streaming response | 成功。`assistant.message` が terminal より前 | **成功**。token を含む `assistant.message` |
| cancel | 成功。in-process `session/cancel` notification | **成功**。`agent.interrupted` |
| restart daemon | 成功 | **成功** |
| load session | 成功。同じ `remoteSessionId` | **成功**。同じ `remoteSessionId` |
| continue conversation | 成功 | **成功**。follow-up token を含む `assistant.message` |

`echo:` 完全一致や mock 固有の `DELAY` Prompt は使っていない。初回 / follow-up は一意 token の含有、streaming は terminal event より前の `assistant.message`、cancel は長い回答要求の直後に in-process notification を送る。

---

## 3. 実 Cursor CLI（Gate A）

`--acp-command` を省略し、インストール済み Cursor CLI ACP を解決した。

| 項目 | 値 |
| --- | --- |
| ACP | 実 Cursor CLI。`resolveAcpCommand()` が latest の `node.exe` + `index.js acp` を選ぶ |
| CLI Version | `2026.08.11-e8db854`（`%LOCALAPPDATA%\cursor-agent\versions` の latest） |
| 所要時間 | 約 55 秒（`npm run remote-dev -- e2e`） |

### 3.1 コマンド

```bat
npm run remote-dev -- e2e
```

一時 `stateDir` / Workspace を作成する。リポジトリルートは `allowedRoots` に使わない。

### 3.2 出力

UUID と一時パス、token 末尾は実行ごとに変わる。

```text
workspace selected 1e2000ff-a2a8-4d51-a3e9-2ed6a9070a22 C:\Users\Rakua\AppData\Local\Temp\remote-dev-root-TLdptA\project
session created 5e1e15f7-f630-4e1f-817e-85e772fa3b12
streamed E2ESTR_844b83c4e8b75494
cancelled
daemon restarted
session loaded 5e1e15f7-f630-4e1f-817e-85e772fa3b12
continued E2ECON_49863124f9053fef
e2e ok 5e1e15f7-f630-4e1f-817e-85e772fa3b12
```

固定してよい判定材料:

- `streamed E2ESTR_` で始まる token
- `cancelled`
- `daemon restarted`
- `session loaded` の ID が `session created` と同じ
- `continued E2ECON_` で始まる token
- 終端が `e2e ok <remoteSessionId>`

この実行では Cursor Desktop を起動していない。

---

## 4. mock ACP（回帰）

自動テストと手動確認の両方で、同じ harness を mock ACP でも通す。

```bat
npm run remote-dev -- e2e --acp-command node --acp-arg test/fixtures/mock-acp.mjs
```

`--acp-arg` は daemon ワークスペース基準。成功時の行は実 CLI と同じ形（`streamed E2ESTR_...` / `cancelled` / `continued E2ECON_...` / `e2e ok`）になる。`npm test` にも含まれる。

---

## 5. `--help`

`npm run remote-dev -- --help` は次のコマンドを出す。`session cancel` は載らない。

- `workspace list` / `workspace select` / `workspace register`
- `session create` / `session list` / `session send` / `session load`
- `e2e`

単発 `session cancel` は usage error になる。各起動が新しい ACP プロセスになるため、別プロセスの prompt を止められることは実測していない。実行中の停止は `session send` の Ctrl+C、または in-process の `e2e`。

---

## 6. この確認に含まれないもの

- Relay WebSocket
- Android 実データフロー
- Permission UI（e2e 中に `session/request_permission` が来た場合は、TASK-100 で観測した `reject-once` を返すだけ）
- Diff / Model Picker / Voice
- 別 CLI プロセスからの cancel（未実測のため非公開）

---

## 7. Gate

実装計画の Gate A（TASK-105 Local E2E が成功するまで Android 実装へ進まない）について、**実 Cursor CLI 経路は 2026-08-17 に通過した。** Phase 1 の一連操作は PC 上の Local Daemon だけで確認済み。Phase 2（Relay / Android）は未着手である。
