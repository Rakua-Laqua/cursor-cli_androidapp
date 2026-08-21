# 実装進捗スナップショット

- 文書バージョン: v0.1
- 記録日: 2026-08-22
- 対象設計書: `docs/cursor_remote_android_spec_v0.3.md`
- 実装計画: `docs/implementation_plan_grok_4.6.md`
- 対象リポジトリ: `Rakua-Laqua/cursor-cli_androidapp`
- ブランチ: `main`
- 直前リリース基準（v1.3.0）: `c7bff3137511396d8a86d27a341fcddb70f8b316`（`v1.3.0にアップデート`）
- パッケージ版: `1.7.0`（Android `versionCode` 19 / `versionName` 1.7.0）

この文書は「いまどこまで動くか」の正本である。設計の正本は仕様書、作業順の正本は実装計画である。計画書の未着手タスクを消さない。完了扱いにできるのはリリース済みの範囲だけである。

---

## 1. いまの結論

**Cursor Desktop なしで、PC 上の Local Daemon だけから Workspace / Session を操作し、Android からメモリ内 Chat を送受信できる。** Relay 経由の Command / Event 中継も localhost では動く。Device Pairing は v1.4.0、Android Skeleton は v1.5.0、Workspace / Session UI は v1.6.0、Chat は v1.7.0。QR カメラ、TLS、履歴永続化 / 再接続復元、Gate B は未完。次は Android 実機の Gate B。

| 区分 | 状態 |
| --- | --- |
| Milestone 1 — Cursor CLI Local Core（TASK-000〜105） | **完了・リリース済み** |
| Gate A（実 Cursor CLI の Local E2E） | **通過**。記録は `docs/local_e2e_report.md` |
| TASK-200 Relay WebSocket Core | **完了・v1.3.0 でリリース済み** |
| TASK-201 Device Pairing | **完了・v1.4.0 でリリース済み** |
| TASK-202 Android Application Skeleton | **実装済み・v1.5.0** |
| TASK-203 Workspace / Session UI | **実装済み・v1.6.0 / compile 修正 v1.6.1** |
| TASK-204 Chat Streaming UI | **実装済み・v1.7.0** |
| Gate B（Android 実機の Chat Streaming） | **未到達** |
| Phase 3 以降（Diff / Voice / Permission UI など） | **未着手** |

次の作業は Gate B（Android 実機の Chat Streaming）である。

---

## 2. 動くものと動かないもの

### 動く（リリース済み v1.4.0）

- `remote-dev` による in-process 操作。Cursor Desktop は不要。
- 実 Cursor CLI ACP（`2026.08.11-e8db854`）での一連操作: Workspace 選択、Session 作成、Prompt、streaming、cancel、Daemon 再起動、Session load、会話継続。
- mock ACP による同じ一連操作（`npm test` の回帰）。
- localhost Relay: Daemon が `/machine?machineId=` へ outbound 接続し、client が `/client?machineId=` から Command を送る。
- `kind=command|event|result` の frame。`requestId` で result を送信元 client へ返す。Event は同じ Machine の client へ転送する。
- WebSocket ping/pong heartbeat、Machine 切断・offline・置換。
- Workspace 結界、`metadata.json` への Workspace / Session 永続化、再起動後の `session.load`。
- Pairing 用 QR JSON、ECDSA P-256 の pair / auth proof、Relay 上の `/client` 認証ゲート。
- 未 Pairing の client Command は Machine に届かない。Event は認証済み client にだけ送る。
- Daemon 再起動後も、永続化した public device で `auth_proof` できる。

### 動く（v1.6.0）

- Pairing JSON 登録 / 既存 Machine 再認証、Workspace / Session 一覧、New Session、過去 Session 再開。Chat / Camera は未実装。

### 動く（v1.7.0）

- 選択中 Session への Prompt と逐次応答（メモリ内 Chat）。履歴永続化 / 再接続復元はない。

### まだない

- Pairing の CLI / QR 表示 UI（`remote-dev` に pairing サブコマンドはない）。
- Android の QR カメラ。
- TLS / インターネット公開用の認証。`/machine` は localhost の非認証 `ws://` のまま。
- Chat 履歴の永続化と再接続復元。
- Push、Account Usage、File content 保存、Diff UI、Voice、Permission UI。
- 単発 `session cancel`（別プロセスからの停止は未実測のため非公開）。

---

## 3. Phase / タスク一覧

状態の意味:

- **リリース済み**: パッケージ版 v1.4.0 までに含まれるバックエンド。v1.3.0 の基準コミットは `c7bff3137511396d8a86d27a341fcddb70f8b316`。
- **実装済み v1.6.0**: TASK-203 Workspace / Session UI。
- **実装済み v1.5.0**: TASK-202 Android Application Skeleton。
- **未着手**: 計画書の Scope どおり、実装していない。

### Phase 0 — Repository Foundation

| タスク | 内容 | 状態 |
| --- | --- | --- |
| TASK-000 | `android/` `daemon/` `relay/` `protocol/` `docs/` の module boundary、format / lint | リリース済み |
| TASK-001 | Remote Protocol の Event / Command 型と JSON 境界 | リリース済み。v1.3.0 で `command` / `event` / `result` frame を追加 |

Android は TASK-204 まで。Gate B は未実施。

### Phase 1 — Cursor CLI Local Core（Milestone 1）

完了条件: **Cursor Desktop を一度も起動せず、PC 上の Local Daemon だけで Workspace を指定し、Cursor Session を作成・継続・再開・停止できる。**

| タスク | 内容 | 状態 |
| --- | --- | --- |
| TASK-100 | 実 Cursor CLI / ACP Capability Probe | リリース済み。記録は `docs/acp_capability_report.md` |
| TASK-101 | ACP Process Manager | リリース済み |
| TASK-102 | ACP Session Adapter | リリース済み |
| TASK-103 | Workspace Manager と path guard | リリース済み |
| TASK-104 | Session Metadata Store | リリース済み |
| TASK-105 | Local E2E Harness `remote-dev` | リリース済み。Gate A 通過 |

確認コマンド:

```bat
npm run build
npm run remote-dev -- e2e
```

成功時の末尾は `streamed E2ESTR_...` → `cancelled` → `daemon restarted` → `session loaded` → `continued E2ECON_...` → `e2e ok <remoteSessionId>`。詳細は `docs/local_e2e_report.md`。

### Phase 2 — Relay + Android Text Remote

| タスク | 内容 | 状態 |
| --- | --- | --- |
| TASK-200 | Relay WebSocket Core | **リリース済み v1.3.0** |
| TASK-201 | Device Pairing | **リリース済み v1.4.0** |
| TASK-202 | Android Application Skeleton | **実装済み v1.5.0** |
| TASK-203 | Workspace / Session UI | **実装済み v1.6.0 / compile 修正 v1.6.1** |
| TASK-204 | Chat Streaming UI | **実装済み v1.7.0** |

Phase 2 の Chat は v1.7.0。Gate B は Android 実機の Chat Streaming まで通過しない。

### Phase 3 以降

計画書どおり未着手。Gate C（Permission Flow）と Gate D（Audio Routing Spike）にも未到達。

---

## 4. TASK-200（リリース済み）の範囲

localhost 専用の Relay WebSocket core。Pairing / TLS / Android / Push は含まない。CHANGELOG 1.3.0 のセキュリティ注記どおり、インターネットへ公開しない。

接続:

```text
Daemon  →  ws://127.0.0.1:<port>/machine?machineId=<id>
Client  →  ws://127.0.0.1:<port>/client?machineId=<id>
```

frame:

| `kind` | 役割 |
| --- | --- |
| `command` | client → Relay → Daemon。`workspace.*` / `session.*` |
| `event` | Daemon → Relay → 同じ Machine の client |
| `result` | Daemon の応答。`requestId` で送信元 client へ返す |

主なファイル（v1.3.0）:

- `protocol/src/protocol.ts` — `RemoteFrame`、`RemoteCommandResult`、serialize / parse
- `relay/src/server.ts`、`relay/src/router.ts`
- `daemon/src/transport/relay-client.ts` — `attachDaemonToRelay`
- テスト: `protocol/test/protocol.test.mjs`、`relay/test/relay-server.test.mjs`、`daemon/test/relay-e2e.test.mjs`

依存: `ws` 8.21.3、`@types/ws` 8.18.1。ルートの `npm test` は Protocol / Daemon / Relay を build してから test する。

`remote-dev` と `Daemon.handleCommand` は in-process の信頼経路のまま Relay を通らない。

---

## 5. TASK-201（リリース済み v1.4.0）の範囲

計画書の完了条件は次の 3 点である。

- 使い捨て token
- token 再利用不可
- 未 Pairing 端末から Command 送信不可

Android の QR スキャン UI は TASK-202 以降。このタスクは Protocol / Daemon / Relay のバックエンドだけである。

### 5.1 設計

QR JSON:

```json
{
  "v": 1,
  "relayUrl": "ws://127.0.0.1:port",
  "machineId": "...",
  "token": "<base64url 32 bytes>",
  "expiresAt": 1234567890000
}
```

`expiresAt` は ISO 文字列ではなく、正の safe integer（ミリ秒）。token TTL は 300_000 ms。token は 32 乱数バイト。保存するのは SHA-256 digest のみ。成功した pair で消費する。失敗した proof では消費しない。期限切れ digest は throw 前に削除する。`createToken` 時に prune する。

暗号:

- Node 20 `node:crypto`
- ECDSA P-256、SHA-256、DER 署名
- 公開 JWK は `{kty, crv, x, y}`。秘密 `d` は出さない
- 証明の canonical JSON 配列。domain は `cursor-remote.pair.v1` と `cursor-remote.auth.v1`
- `deviceId` は公開鍵から導出する。metadata に書いた値と不一致なら拒否する

永続化:

- `metadata.json` version 1 に public device `{deviceId, publicKey, createdAt}` を保存する
- 旧 store（`devices` なし）も読める
- 秘密鍵は Daemon に保存しない

Relay 上の追加 frame（TASK-200 の `RemoteFrame` とは別）:

| `kind` | 方向 | 役割 |
| --- | --- | --- |
| `auth_challenge` | Relay → client | 接続直後の nonce |
| `pair` | client → Relay → Daemon | 初回登録 |
| `auth_proof` | client → Relay → Daemon | 再接続認証 |
| `pairing_verify` | Relay → Daemon | 検証依頼 |
| `pairing_result` | Daemon → Relay | 成否 |

ゲート:

- 未認証 client の Command は `Device is not paired` で拒否し、Machine に転送しない
- Event は認証済み client にだけ送る
- 成功後は nonce を消す。追加の `pair` / `auth_proof` は転送しない
- 失敗後は新しい challenge を出す
- Machine 切断・置換で client を未認証に戻し、再 challenge する
- `/machine` は引き続き非認証（localhost 前提）

### 5.2 追加・変更ファイル

追加:

- `protocol/src/pairing.ts`
- `protocol/test/pairing.test.mjs`
- `daemon/src/pairing/pairing-manager.ts`
- `daemon/test/pairing-manager.test.mjs`

変更:

- `protocol/src/index.ts`
- `daemon/src/daemon.ts`、`daemon/src/index.ts`
- `daemon/src/store/metadata-store.ts`
- `daemon/src/transport/relay-client.ts`
- `daemon/test/metadata-store.test.mjs`、`daemon/test/relay-e2e.test.mjs`
- `relay/src/router.ts`、`relay/test/relay-server.test.mjs`

API 入口: `Daemon.pairing`（`PairingManager`）。`createToken` / `createQrPayload` / `verifyPair` / `verifyAuth`。`remote-dev` からはまだ呼べない。

### 5.3 残作業（Scope 外）

v1.4.0 でバックエンドはリリース済み。計画書の完了条件 3 点（使い捨て token、再利用不可、未 Pairing からの Command 不可）は Protocol / Daemon / Relay のテスト範囲に含まれる。CHANGELOG 1.3.0 の「Pairing は TASK-201 以降」は当時の事実として残し、現状は 1.4.0 を見る。

未実装のまま残すもの（Scope 外）:

- Android QR カメラ（TASK-202 でも未実装）
- TLS
- pairing 用 `remote-dev` サブコマンド
- `/machine` の認証

---

## 6. TASK-202（v1.5.0）の範囲

Android Application Skeleton。Protocol / Daemon / Relay の公開挙動は変えない。

実装済み:

- Navigation Compose の 4 destination。開始は Machines。TASK-202 時点では TASK-203 / TASK-204 未実装のプレースホルダで前後遷移できた
- Application 所有の手動 DI（`AppContainer`）。Room、Keystore credential store、OkHttp WebSocket transport、ViewModel factory。Hilt / Koin なし
- OkHttp WebSocket transport。`connect` / `send` / `disconnect`、`ConnectionState` StateFlow、受信 text Flow。URL は `ws` / `wss` のみ。起動時自動接続なし
- Room の `MachineEntity` / `MachineDao` / `CursorRemoteDatabase`。Flow 一覧。秘密情報や message / file 内容は保存しない
- Android Keystore の EC P-256 device key の作成・取得・削除。秘密鍵は export せず Room にも保存しない
- 選択中 machine / workspace / session と transport 接続状態。選択変更時は下位選択をクリア
- `FoundationTest` による destination 順序、初期 state、cascade clear

未実装のまま残すもの:

- QR カメラ / pairing UI
- TLS、Relay 自動接続
- Gate B（Android 実機の Chat Streaming）

v1.5.0 時点の次は TASK-203。

---

## 7. TASK-203（v1.6.0 実装・v1.6.1 compile 修正）

Android だけで Pairing JSON / 再認証、Workspace / Session 一覧、New Session、過去 Session 再開。v1.6.1 は Compose `weight` 明示 import の compile 修正のみ。Camera / Gate B は未完。Chat は v1.7.0。

---

## 7.1 TASK-204（v1.7.0）

選択中 Session へ Prompt を送り、User / Assistant を逐次表示し、status / error / completed / stop を扱う。会話はメモリ内のみ。履歴永続化 / 再接続復元、QR カメラ、TLS、Android 実機 Gate B は未完。

---

## 8. 検証の記録

| 対象 | 結果 | 備考 |
| --- | --- | --- |
| TASK-100 実 ACP probe | 成功 | `docs/acp_capability_report.md` |
| TASK-105 mock ACP e2e | 成功 | `npm test` の回帰 |
| TASK-105 実 Cursor CLI e2e | 成功（2026-08-17） | Gate A。`docs/local_e2e_report.md` |
| TASK-200 `npm test` / lint / format | 成功 | v1.3.0 リリース時 |
| TASK-201 `npm run build` | 成功 | v1.4.0 |
| TASK-201 `npm test` / lint / format:check | 成功 | v1.4.0 リリース時 |
| Android `assembleDebug` / `testDebugUnitTest` | GitHub Actions CI | v1.6.1 成功済み。v1.7.0 の unit / build は Codex が GitHub Actions で実施 |
| Android 実機の Relay / Pairing / Chat | 未実施 | Gate B 未到達 |

---

## 9. モジュール別の現状

| モジュール | 実装済み v1.7.0 | 未着手 |
| --- | --- | --- |
| `protocol/` | Event / Command 型、Remote frame、Pairing 型・証明・QR payload | Android 向け追加画面用の型は不要な範囲で増やさない |
| `daemon/` | ACP、Workspace、metadata、`remote-dev`、Relay outbound、`PairingManager`、device 永続化 | pairing CLI、Permission 実処理 |
| `relay/` | WebSocket routing / correlation / heartbeat、`/client` の pairing ゲート | TLS、Push |
| `android/` | TASK-204 Chat（メモリ内） | QR カメラ、履歴永続化 / 再接続復元 |
| `docs/` | 仕様、計画、ACP 実測、Local E2E、本ファイル | — |

---

## 10. 次の実装順

計画書と Gate を崩さない。

```text
Gate B まで Android 実機で Chat が動くこと
```

TASK-204 は v1.7.0。Camera / TLS / 履歴永続化 / 再接続復元 / Gate B は未完。
