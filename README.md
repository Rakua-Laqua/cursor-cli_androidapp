# Cursor CLI Remote for Android

Android から PC 上の Cursor CLI / ACP セッションを操作するためのクライアント群です。設計の Source of Truth は `docs/cursor_remote_android_spec_v0.3.md`、実装順序は `docs/implementation_plan_grok_4.6.md` です。

## Repository layout

- `android/` — Android ネイティブクライアント。Phase 0 では build 可能な Jetpack Compose 最小アプリのみを保持します。
- `daemon/` — PC 上で動作する Local Daemon。Phase 1 の ACP / Workspace / Session / metadata と、簡易クライアント `remote-dev` を含みます。
- `relay/` — Android と Daemon を中継する Relay Server。WebSocket 実装は Phase 2 で追加します。
- `protocol/` — Android 向け Remote Protocol の共有 TypeScript 型と安全な JSON 境界処理です。
- `docs/` — 仕様書、実装計画、Capability 実測結果、Local E2E 確認記録を保持します。

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

Phase 1 の完了条件は、Cursor Desktop なしで Local Daemon だけから Workspace 指定・Session 作成・ストリーミング・停止・再起動後の再開ができることです。簡易クライアントは `remote-dev` です。Windows 上の mock ACP 確認は `docs/local_e2e_report.md` に記録済みです。

リポジトリルート:

```bat
npm run build
npm run remote-dev -- --help
npm run remote-dev -- e2e --acp-command node --acp-arg test/fixtures/mock-acp.mjs
```

成功時の末尾は次の形です。UUID と一時パスは実行ごとに変わります。

```text
workspace selected <workspaceId> <temp>\project
session created <remoteSessionId>
streamed echo:e2e-stream
cancelled
daemon restarted
session loaded <remoteSessionId>
continued echo:e2e-continue
e2e ok <remoteSessionId>
```

`npm test` も同じ一連を mock ACP で実行します。実 Cursor CLI を使う場合は `--acp-command` を付けず、`--state-dir` と `--allowed-root` を明示します。リポジトリ全体を既定の許可ルートにはしません。

## Android

```bash
cd android
gradle :app:assembleDebug :app:testDebugUnitTest
```

Phase 0 の Android アプリは起動確認用の最小 Compose 画面だけを持ちます。Machines / Workspaces / Sessions / Chat の実データフローは TASK-202 以降の Scope です。

## Phase boundary

Phase 1 の Local Daemon / ACP / Workspace / Session / metadata / Local E2E は `remote-dev` と `npm test` で固定します。実機の Cursor CLI / ACP Capability は `docs/acp_capability_report.md`、mock ACP での Local E2E は `docs/local_e2e_report.md` に記録済みです。未観測の機能を存在する前提で実装しないという拘束は維持します。Relay と Android の実データフローは Phase 2 です。
