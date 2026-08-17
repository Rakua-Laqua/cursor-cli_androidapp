# Local E2E Report

- 文書バージョン: v0.1
- 対象タスク: TASK-105
- 確認日: 2026-08-17
- 対象設計書: `docs/cursor_remote_android_spec_v0.3.md`
- 実装計画: `docs/implementation_plan_grok_4.6.md`
- 確認方針: Cursor Desktop を起動せず、リポジトリの `remote-dev` を Windows 上で実行した結果だけを記録する。この確認は mock ACP に対するものであり、実 Cursor CLI に対する `remote-dev e2e` は未実施とする。

---

## 1. 実行環境

| 項目 | 値 |
| --- | --- |
| OS | Microsoft Windows [Version 10.0.26200.8875] |
| 作業ディレクトリ | `C:\Users\Rakua\Documents\VS Code\Android_App\cursor-cli_androidapp`（リポジトリルート） |
| パッケージ | `cursor-cli-androidapp@1.1.1` |
| クライアント | `remote-dev`（`daemon/dist/cli/remote-dev.js`） |
| ACP | mock ACP（`daemon/test/fixtures/mock-acp.mjs`）。Cursor Desktop は未起動 |
| Cursor CLI | この確認では未使用（`--acp-command node` を明示） |

ルートの `npm run remote-dev` は `@cursor-remote/daemon` ワークスペースで実行される。そのため `--acp-arg test/fixtures/mock-acp.mjs` は daemon パッケージからの相対パスになる。

---

## 2. TASK-105 完了条件

計画書の一連操作と、この実行での結果。

| 完了条件 | 結果 |
| --- | --- |
| workspace select | **成功**。一時 Workspace を登録した |
| session create | **成功**。`remoteSessionId` を発行した |
| prompt | **成功**。`e2e-stream` を送った |
| streaming response | **成功**。結合本文 `echo:e2e-stream` |
| cancel | **成功**。遅延 prompt を中断した |
| restart daemon | **成功**。同一 `stateDir` で再起動した |
| load session | **成功**。同じ `remoteSessionId` を load した |
| continue conversation | **成功**。結合本文 `echo:e2e-continue` |

`--help` も同じ環境で表示できた。

---

## 3. 実行したコマンド

リポジトリルートで、次の順に実行した。

```bat
npm run build
npm run remote-dev -- --help
npm run remote-dev -- e2e --acp-command node --acp-arg test/fixtures/mock-acp.mjs
```

`npm run build` は protocol / daemon / relay の `tsc` が成功した。

---

## 4. 観測した出力

UUID と一時ディレクトリ名は実行ごとに変わる。本文トークンは固定である。

### 4.1 `npm run remote-dev -- --help`

`node dist/cli/remote-dev.js --help` 相当が走り、次を表示した。

- `workspace list` / `workspace select` / `workspace register`
- `session create` / `session list` / `session send` / `session cancel` / `session load`
- `e2e`
- `--state-dir` / `--allowed-root` / `--acp-command` / `--acp-arg` などのオプション

### 4.2 `npm run remote-dev -- e2e --acp-command node --acp-arg test/fixtures/mock-acp.mjs`

この実行での出力:

```text
workspace selected c7851f6b-8637-495d-b4c0-08a57d6fb448 C:\Users\Rakua\AppData\Local\Temp\remote-dev-root-wFnlPu\project
session created b0a31416-8baf-422d-935c-37a098ac939c
streamed echo:e2e-stream
cancelled
daemon restarted
session loaded b0a31416-8baf-422d-935c-37a098ac939c
continued echo:e2e-continue
e2e ok b0a31416-8baf-422d-935c-37a098ac939c
```

固定してよい判定材料:

- `streamed echo:e2e-stream`
- `cancelled`
- `daemon restarted`
- `session loaded` の ID が `session created` と同じ
- `continued echo:e2e-continue`
- 終端が `e2e ok <remoteSessionId>`

---

## 5. この確認に含まれないもの

- 実 Cursor CLI / ACP に対する `remote-dev e2e`（`--acp-command` を省略した実行）
- Relay WebSocket
- Android 実データフロー
- Permission / Diff / Model Picker / Voice

実 Cursor CLI で試す場合は `--acp-command` を付けず、`--state-dir` と `--allowed-root` を明示する。リポジトリルートは既定の許可ルートにならない。

---

## 6. Gate

実装計画の Gate A（TASK-105 Local E2E が成功するまで Android 実装へ進まない）について、**mock ACP 経路は 2026-08-17 に通過した。** 詳細は本ファイル。Phase 2（Relay / Android）は未着手である。
