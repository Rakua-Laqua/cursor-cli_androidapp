# CHANGELOG

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
