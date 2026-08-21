# Cursor CLI Remote for Android

Android から PC 上の Cursor CLI / ACP セッションを操作するためのクライアント群です。設計の Source of Truth は `docs/cursor_remote_android_spec_v0.3.md`、実装順序は `docs/implementation_plan_grok_4.6.md`、現時点の進捗は `docs/implementation_status.md` です。

## Repository layout

- `android/` — Android ネイティブクライアント。v1.8.0 は Workspace / Session / メモリ内 Chat と Permission approval。QR カメラと TLS は未完です。
- `daemon/` — PC 上で動作する Local Daemon。Phase 1 の ACP / Workspace / Session / metadata と、簡易クライアント `remote-dev`、Relay outbound、Device Pairing バックエンドを含みます。
- `relay/` — Android と Daemon を中継する Relay Server。v1.4.0 で localhost WebSocket core と `/client` 認証ゲートを持ちます。
- `protocol/` — Android 向け Remote Protocol の共有 TypeScript 型と安全な JSON 境界処理です。
- `docs/` — 仕様書、実装計画、進捗スナップショット、Capability 実測結果、Local E2E 確認記録を保持します。

## Requirements

- Node.js 20 以上
- npm 10 以上
- JDK 17 以上
- Android SDK（Android アプリをローカル build する場合）

## TypeScript modules

```bash
npm install
npm run build
npm test
npm run lint
npm run format:check
```

`daemon` と `relay` は workspace dependency として `@cursor-remote/protocol` を参照します。

## Local E2E

Phase 1 の完了条件は、Cursor Desktop なしで Local Daemon だけから Workspace 指定・Session 作成・ストリーミング・停止・再起動後の再開ができることです。簡易クライアントは `remote-dev` です。Windows 上の実 Cursor CLI 確認は `docs/local_e2e_report.md` に記録済みです。

リポジトリルートで実 Cursor CLI:

```bat
npm run build
npm run remote-dev -- --help
npm run remote-dev -- e2e
```

mock ACP（`npm test` でも実行）:

```bat
npm run remote-dev -- e2e --acp-command node --acp-arg test/fixtures/mock-acp.mjs
```

成功時の末尾は次の形です。UUID・一時パス・token は実行ごとに変わります。

```text
workspace selected <workspaceId> <temp>\project
session created <remoteSessionId>
streamed E2ESTR_<token>
cancelled
daemon restarted
session loaded <remoteSessionId>
continued E2ECON_<token>
e2e ok <remoteSessionId>
```

`--acp-command` を省略すると実 Cursor CLI の ACP を解決します。`--state-dir` と `--allowed-root` を省略した `e2e` は一時ディレクトリを使います。リポジトリ全体を既定の許可ルートにはしません。実行中の停止は `session send` の Ctrl+C、または in-process の `e2e` です。単発 `session cancel` は公開しません。

## Android

```bash
cd android
gradle :app:assembleDebug :app:testDebugUnitTest
```

開始画面は Machines です。Pairing JSON または既存 Machine 再認証の成功時だけ Workspaces / Sessions / Chat へ進みます。Chat は選択中 Session への Prompt と逐次応答（メモリ内）。Permission は approval card。QR カメラ、TLS、履歴永続化 / 再接続復元は未完です。詳細は `docs/implementation_status.md`。

## Phase boundary

Phase 1 の Local Daemon / ACP / Workspace / Session / metadata / Local E2E は `remote-dev` で固定します。実機の Cursor CLI / ACP Capability は `docs/acp_capability_report.md`、TASK-105 の一連確認は `docs/local_e2e_report.md` に記録済みです。未観測の機能を存在する前提で実装しないという拘束は維持します。

Phase 2 は TASK-200〜204（v1.3.0〜v1.7.1）で Gate B 通過。Phase 3 の TASK-300 は v1.8.0 で Gate C 通過。次は TASK-301。QR カメラ、TLS、履歴永続化 / 再接続復元は未完です。詳細は `CHANGELOG.md` と `docs/implementation_status.md` です。
