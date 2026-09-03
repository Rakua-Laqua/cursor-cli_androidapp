# Cursor CLI Remote for Android

Android から PC 上の Cursor CLI / ACP セッションを操作するためのクライアント群です。設計の Source of Truth は `docs/cursor_remote_android_spec_v0.3.md`、実装順序は `docs/implementation_plan_grok_4.6.md`、現時点の進捗は `docs/implementation_status.md` です。

## Repository layout

- `android/` — Android ネイティブクライアント。v1.16.0 までの Workspace / Session / メモリ内 Chat、Permission approval、手動 Diff、応答内ファイルリンクと read-only Viewer、in-process 通知、Chat header の動的 Model Picker と Model Visibility、valid Context 表示、structured breakdown の条件付き内訳、valid Session Cost の独立 Usage。v1.17.0 は debug-only の audio routing 診断を追加（操作と証拠の扱いは `docs/android_audio_routing_report.md`）。v1.18.0 は Push-to-Talk 音声入力を追加（Chat 画面からの本体マイク録音・Android 13+ SpeechRecognizer による文字起こし・Prompt 反映）。v1.19.0 は同一プロセス内のフォアグラウンド Event Replay / Reconnect を追加する。永続履歴とバックグラウンド復旧は含まない。QR カメラと TLS は未完です。
- `daemon/` — PC 上で動作する Local Daemon。Phase 1 の ACP / Workspace / Session / metadata と、簡易クライアント `remote-dev`、Relay outbound（想定外切断後の bounded 再接続）、Device Pairing バックエンドを含みます。
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

開始画面は Machines です。Pairing JSON または既存 Machine 再認証の成功時だけ Workspaces / Sessions / Chat へ進みます。Chat は選択中 Session への Prompt と逐次応答（メモリ内）。Permission は approval card。Refresh Diff は選択中の登録済み Workspace の変更一覧・+/-・折りたたみ・unified diff・横スクロールで、Git fallback かつ手動更新のみです。Assistant 応答内の workspace 相対パスはリンクになり、Chat 内の read-only Viewer で開きます。アプリが background で process と既存 WebSocket が生存中だけ in-process 通知します。Chat header の Model Picker は選択中 Session の動的 catalog です。Manage Models で表示/非表示を端末内に保存します。v1.18.0 で Push-to-Talk 音声入力（本体マイク録音、Android 13+ SpeechRecognizer による文字起こし、Prompt 編集反映）に対応しました。v1.19.0 で同一プロセス内の明示フォアグラウンド Reconnect と event replay に対応します。永続履歴とバックグラウンド復旧は未完です。QR カメラ、TLS は未完です。詳細は `docs/implementation_status.md`。

## Phase boundary

Phase 1 の Local Daemon / ACP / Workspace / Session / metadata / Local E2E は `remote-dev` で固定します。実機の Cursor CLI / ACP Capability は `docs/acp_capability_report.md`、TASK-105 の一連確認は `docs/local_e2e_report.md` に記録済みです。未観測の機能を存在する前提で実装しないという拘束は維持します。

Phase 2 は TASK-200〜204（v1.3.0〜v1.7.1）で Gate B 通過。Phase 3 の TASK-300〜303 は v1.8.0〜v1.11.0 で完了（TASK-300 は Gate C 通過）。Phase 4 の TASK-400〜405 は v1.12.0〜v1.16.0 で完了（Session Cost は v1.16.0。Account Usage は公式安定 interface が無く dormant）。Phase 5 の TASK-500〜503 は v1.18.0 で完了（Gate D 通過、Push-to-Talk Recorder、STT Adapter、Voice Prompt UX）。Phase 6 は進行中。TASK-600 は v1.19.0 で完了し、次は TASK-601。QR カメラ、TLS、Chat 履歴の永続化、バックグラウンド復旧、FCM は未完です。詳細は `CHANGELOG.md` と `docs/implementation_status.md` です。
