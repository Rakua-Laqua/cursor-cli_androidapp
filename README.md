# Cursor CLI Remote for Android

Android から PC 上の Cursor CLI / ACP セッションを操作するためのクライアント群です。設計の Source of Truth は `docs/cursor_remote_android_spec_v0.3.md`、実装順序は `docs/implementation_plan_grok_4.6.md` です。

## Repository layout

- `android/` — Android ネイティブクライアント。Phase 0 では build 可能な Jetpack Compose 最小アプリのみを保持します。
- `daemon/` — PC 上で動作する Local Daemon。Cursor ACP、Workspace、Session 等の実処理は Phase 1 以降で追加します。
- `relay/` — Android と Daemon を中継する Relay Server。WebSocket 実装は Phase 2 で追加します。
- `protocol/` — Android 向け Remote Protocol の共有 TypeScript 型と安全な JSON 境界処理です。
- `docs/` — 仕様書、実装計画、Capability 実測結果を保持します。

## Requirements

- Node.js 20 以上
- npm 10 以上
- JDK 17 以上
- Android SDK（Android アプリをローカル build する場合）

## TypeScript modules

```bash
npm ci
npm run build
npm test
npm run lint
npm run format:check
```

`daemon` と `relay` は workspace dependency として `@cursor-remote/protocol` を参照します。

## Android

```bash
cd android
gradle :app:assembleDebug :app:testDebugUnitTest
```

Phase 0 の Android アプリは起動確認用の最小 Compose 画面だけを持ちます。Machines / Workspaces / Sessions / Chat の実データフローは TASK-202 以降の Scope です。

## Phase boundary

Phase 0 完了後、Phase 1 は `TASK-100: Cursor ACP Capability Probe` から開始します。実機の Cursor CLI / ACP Capability を測定して `docs/acp_capability_report.md` に記録するまで、ACP API の存在を仮定した実装には進みません。
