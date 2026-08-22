# 実装進捗スナップショット

- 文書バージョン: v0.1
- 記録日: 2026-08-22
- 対象設計書: `docs/cursor_remote_android_spec_v0.3.md`
- 実装計画: `docs/implementation_plan_grok_4.6.md`
- 対象リポジトリ: `Rakua-Laqua/cursor-cli_androidapp`
- ブランチ: `main`
- 直前リリース基準（v1.3.0）: `c7bff3137511396d8a86d27a341fcddb70f8b316`（`v1.3.0にアップデート`）
- パッケージ版: `1.11.0`（Android `versionCode` 24 / `versionName` 1.11.0）

この文書は「いまどこまで動くか」の正本である。設計の正本は仕様書、作業順の正本は実装計画である。計画書の未着手タスクを消さない。完了扱いにできるのはリリース済みの範囲だけである。

---

## 1. いまの結論

**Cursor Desktop なしで、PC 上の Local Daemon だけから Workspace / Session を操作し、Android からメモリ内 Chat を送受信し、実 ACP の permission を Approve / Reject でき、選択中 Workspace の変更 Diff を手動で確認でき、Assistant 応答内の workspace ファイルを read-only Viewer で開け、background かつ process / 既存 WebSocket 生存中に対象 event を in-process 通知できる。** Relay 経由の Command / Event 中継も localhost では動く。Device Pairing は v1.4.0、Android Skeleton は v1.5.0、Workspace / Session UI は v1.6.0、Chat は v1.7.0、Permission Flow は v1.8.0、Diff Pipeline は v1.9.0、応答内ファイルリンクは v1.10.0、in-process 通知は v1.11.0。QR カメラ、TLS、履歴永続化 / 再接続復元は未完。次は TASK-400。

| 区分 | 状態 |
| --- | --- |
| Milestone 1 — Cursor CLI Local Core（TASK-000〜105） | **完了・リリース済み** |
| Gate A（実 Cursor CLI の Local E2E） | **通過**。記録は `docs/local_e2e_report.md` |
| TASK-200 Relay WebSocket Core | **完了・v1.3.0 でリリース済み** |
| TASK-201 Device Pairing | **完了・v1.4.0 でリリース済み** |
| TASK-202 Android Application Skeleton | **実装済み・v1.5.0** |
| TASK-203 Workspace / Session UI | **実装済み・v1.6.0 / compile 修正 v1.6.1** |
| TASK-204 Chat Streaming UI | **実装済み・v1.7.0**。Gate B 通過 |
| Gate B（Android 実機の Chat Streaming） | **通過**。2026-08-22、SM-S928Q / Android 16。詳細は §8 |
| TASK-300 Permission Flow | **完了・v1.8.0**。Gate C 通過 |
| Gate C（Permission Flow） | **通過**。詳細は §8 |
| TASK-301 Diff Pipeline | **完了・v1.9.0** |
| TASK-302 Cursor Response File Links | **完了・v1.10.0** |
| TASK-303 Push Notifications | **完了・v1.11.0**。in-process 限定 |
| Phase 3 | TASK-300〜303 完了。次は TASK-400 |

次の作業は TASK-400 である。

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

### 動く（v1.8.0）

- 実 ACP `session/request_permission` の Android approval card。Approve は保存済み `allow_once`、Reject / timeout / cancel / invalid / non-running / exit は `reject_once` または fail-closed。`allow_always` は選ばない。Android は `permissionId` のみ。

### 動く（v1.9.0）

- 選択中の登録済み Workspace に対する手動 Refresh Diff。観測した ACP に構造化 diff Event が無いため、Daemon の bounded Git fallback のみ。非 Git は `available: false` の空状態。Relay は generic のまま。

### 動く（v1.10.0）

- Assistant 応答内の workspace 相対参照をリンク化し、Chat 内の read-only Viewer で開く。User メッセージはリンク化しない。Android は候補抽出のみ。`file.read` の最終 authority は Daemon。Relay は generic のまま。file content は保存しない。

### 動く（v1.11.0）

- アプリが background で process と既存 WebSocket が生存中だけ、`permission.requested` / `agent.completed` / `agent.failed` を即時通知し、`agent.waiting` は 60 秒継続後に通知する。通常 streaming、foreground、`agent.interrupted`、`permission.resolved` は通知しない。tap は MainActivity、auto-cancel。notification action は付けない。`POST_NOTIFICATIONS` deny 時は通知しない。同一 `eventId` は process メモリ内で再通知しない。

### まだない

- Pairing の CLI / QR 表示 UI（`remote-dev` に pairing サブコマンドはない）。
- Android の QR カメラ。
- TLS / インターネット公開用の認証。`/machine` は localhost の非認証 `ws://` のまま。
- Chat 履歴の永続化と再接続復元。
- FCM、process 死亡後の到達、WebSocket reconnect、notification deep link、Doze（TASK-604）。
- Account Usage、File content 保存、Voice。
- Diff の agent 完了連動の自動更新。
- 単発 `session cancel`（別プロセスからの停止は未実測のため非公開）。
- `agent.waiting` の live E2E（current Daemon に emitter が無い。parsing / coordinator unit test のみ）。

---

## 3. Phase / タスク一覧

状態の意味:

- **リリース済み**: パッケージ版 v1.4.0 までに含まれるバックエンド。v1.3.0 の基準コミットは `c7bff3137511396d8a86d27a341fcddb70f8b316`。
- **実装済み v1.11.0**: TASK-303 Push Notifications（in-process）。
- **実装済み v1.10.0**: TASK-302 Cursor Response File Links。
- **実装済み v1.9.0**: TASK-301 Diff Pipeline。
- **実装済み v1.8.0**: TASK-300 Permission Flow。
- **実装済み v1.7.0**: TASK-204 Chat Streaming UI。
- **実装済み v1.6.0**: TASK-203 Workspace / Session UI。
- **実装済み v1.5.0**: TASK-202 Android Application Skeleton。
- **未着手**: 計画書の Scope どおり、実装していない。

### Phase 0 — Repository Foundation

| タスク | 内容 | 状態 |
| --- | --- | --- |
| TASK-000 | `android/` `daemon/` `relay/` `protocol/` `docs/` の module boundary、format / lint | リリース済み |
| TASK-001 | Remote Protocol の Event / Command 型と JSON 境界 | リリース済み。v1.3.0 で `command` / `event` / `result` frame を追加 |

Android は TASK-303 まで。Gate B / C は通過。Gate D は TASK-500 の将来 gate であり未通過。

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
| TASK-204 | Chat Streaming UI | **実装済み v1.7.0**。Gate B 通過 |

Phase 2 の Chat は v1.7.0。Gate B は 2026-08-22 に通過。実機記録は §8。

### Phase 3 以降

TASK-300 Permission Flow は **v1.8.0 で完了**。Gate C 通過。TASK-301 Diff Pipeline は **v1.9.0 で完了**。TASK-302 Cursor Response File Links は **v1.10.0 で完了**。TASK-303 Push Notifications は **v1.11.0 で完了**。Phase 3 はここまで。次は TASK-400。Gate D は TASK-500 Audio Routing の将来 gate であり未通過。

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

v1.5.0 時点の次は TASK-203。

---

## 7. TASK-203（v1.6.0 実装・v1.6.1 compile 修正）

Android だけで Pairing JSON / 再認証、Workspace / Session 一覧、New Session、過去 Session 再開。v1.6.1 は Compose `weight` 明示 import の compile 修正のみ。Camera は未完。Chat は v1.7.0。Gate B は §8。

---

## 7.1 TASK-204（v1.7.0）

選択中 Session へ Prompt を送り、User / Assistant を逐次表示し、status / error / completed / stop を扱う。会話はメモリ内のみ。履歴永続化 / 再接続復元、QR カメラ、TLS は未完。Gate B 通過の実機記録は §8。

---

## 7.2 TASK-300（v1.8.0）

実 ACP `session/request_permission` を Daemon が最終 authority として扱い、Android に approval card を出す。Approve は保存済み `allow_once`、Reject / timeout / cancel / invalid / non-running / exit は `reject_once` または fail-closed。`allow_always` は選ばない。Android は `permissionId` だけで相関し、optionId / policy は送れない。Gate C 通過の実機記録は §8。

---

## 7.3 TASK-301（v1.9.0）

観測した ACP Capability に構造化 diff / ファイル変更 Event が無いため、Daemon の bounded Git fallback が唯一のソース。`diff.read` は `workspaceId` のみ。Daemon は信頼済み path を再解決し、shell なしで Workspace 結界内の Git を実行する。非 Git は `available: false`。`.env` / key / 証明書 / credentials / secrets の内容と binary / symlink / submodule / 非 regular の内容は返さない。上限超過は truncation / omission の metadata。Android は手動 Refresh Diff、変更一覧、+/- 合計、折りたたみ、unified diff、等幅横スクロール。自動更新は含まない。実機記録は §8。

---

## 7.4 TASK-302（v1.10.0）

Assistant 応答だけから `src/foo.ts`、`:120`、`:120-160` 相当の workspace 相対参照をリンク化する。User メッセージはリンク化しない。Android は候補抽出のみで authority ではない。`file.read` は sessionId と path だけ。Daemon が session の登録済み Workspace を毎回再解決し、path 構文、canonical containment、sensitive 名、regular file、binary/NUL、strict UTF-8 を検証する。最大 262144 bytes。超過は UTF-8 境界で truncate metadata。error に raw absolute path を含めない。Relay は generic のまま。file content は保存しない。Viewer は Chat 内の read-only 画面（行番号、等幅、折り返しなし、指定開始行、範囲表示、Copy、Reload、Close）。編集機能はない。実機記録は §8。

---

## 7.5 TASK-303（v1.11.0）

Android の in-process system notification。配信は生きている process と既存 WebSocket に限定する。FCM、process lifecycle 越え、reconnect、deep link、Doze は TASK-604。現在の Daemon は `agent.waiting` を emit しない。実機記録は §8。

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
| Android `assembleDebug` / `testDebugUnitTest` | GitHub Actions CI / ローカル Gradle | v1.6.1 成功済み。v1.7.0 は disconnect 中 in-flight `session.send` テスト競合で失敗。v1.7.1 で競合を修正。v1.8.0 / v1.9.0 / v1.10.0 / v1.11.0 は `:app:testDebugUnitTest :app:assembleDebug :app:lintDebug` BUILD SUCCESSFUL |
| `npm test` v1.8.0 | 成功 | protocol 13 / daemon 89 / relay 8、fail 0。targeted Prettier pass |
| `npm test` v1.9.0 | 成功 | protocol 14 / daemon 101 / relay 8、fail 0。`npm lint` pass。targeted Prettier pass |
| `npm test` v1.10.0 | 成功 | protocol 15 / daemon 112 / relay 8、fail 0。`npm run lint` pass。対象 TS/MJS の Prettier check pass。Gradle 53 tasks pass |
| Gradle v1.11.0 | 成功 | `:app:testDebugUnitTest :app:assembleDebug :app:lintDebug` 53 tasks pass |
| Android 実機 Chat（Gate B） | 通過（2026-08-22） | SM-S928Q / Android 16。下記 |
| Android 実機 Permission（Gate C） | 通過（2026-08-22） | SM-S928Q / Android 16。下記 |
| Android 実機 Diff（TASK-301） | 受け入れ（2026-08-22） | SM-S928Q / Android 16。下記 |
| Android 実機 File Links（TASK-302） | 受け入れ（2026-08-22） | SM-S928Q / Android 16。下記 |
| Android 実機 Notifications（TASK-303） | 受け入れ（2026-08-22） | SM-S928Q / Android 16。下記 |

Gate B（2026-08-22、SM-S928Q / Android 16）: localhost Relay と adb reverse。既存 pairing の再認証、Workspace / Session resume、terminal 前の逐次 Assistant 表示、Stop 後の `interrupted` / `stopped` を確認した。TLS とインターネット公開は使っていない。

Gate C（2026-08-22、同端末）: `Get-ChildItem -Force` の `permission.requested` / approval card / high risk を確認した。Approve は `waiting_approval` → `permission.resolved` approved → コマンド結果 `.git` → completed。Reject は `permission.resolved` rejected → 非実行の Assistant 応答 → completed。Daemon が最終 authority。`allow_once` / `reject_once` 限定、fail-closed。Android は optionId / policy を送れない。検証後、Android keyboard subtype は日本語へ復元、adb reverse 削除、runner / ACP 停止、port 8787 free。

TASK-301（2026-08-22、同端末）: localhost Relay と adb reverse。手動 Refresh Diff で 21 ファイルの summary、+/- 合計、展開/折りたたみ、unified diff、横スクロールを確認した。構造化 ACP diff、自動更新、TLS、インターネット公開は使っていない。検証後、stay-on を 0 に戻し、adb reverse を削除し、runner / ACP を停止し、port 8787 は空いた。証跡はローカル一時ディレクトリにあり、リポジトリ文書としてはリンクしない。

TASK-302（2026-08-22、同端末）: localhost Relay と adb reverse。3 種の有効参照が下線付きリンクになり、`daemon/src/daemon.ts:120-150` で 120 行目から read-only Viewer を表示した。Copy / Reload 後も内容維持・crash なし。`daemon/.env` は `File is not readable`。`../outside.txt` は下線なしの plain text。Push 通知、TLS、インターネット公開は使っていない。

TASK-303（2026-08-22、同端末）: localhost Relay と adb reverse。foreground completion は通知 0。background streaming 中は通知 0。background completed は title/body を表示。background `permission.requested` は command body と contentIntent、notification action なし。tap で Chat を開き auto-cancel。`POST_NOTIFICATIONS` deny 中の background completed は通知 0。`agent.failed` と 60 秒 `agent.waiting` は unit test。`agent.waiting` の live E2E は current Daemon に emitter が無いため未実施。

---

## 9. モジュール別の現状

| モジュール | 実装済み v1.11.0 | 未着手 |
| --- | --- | --- |
| `protocol/` | Event / Command 型、Remote frame、Pairing 型・証明・QR payload、permission requested/resolved と permissionId のみの approve/reject、diff snapshot payload、`file.read` / FileContent payload。`agent.waiting` は既存共有型 | Android 向け追加画面用の型は不要な範囲で増やさない |
| `daemon/` | ACP、Workspace、metadata、`remote-dev`、Relay outbound、`PairingManager`、device 永続化、PermissionBridge（fail-closed）、bounded Git DiffPipeline、session-bound `file.read` | pairing CLI、`agent.waiting` emitter |
| `relay/` | WebSocket routing / correlation / heartbeat、`/client` の pairing ゲート。generic のまま | TLS |
| `android/` | TASK-204 Chat（メモリ内）、TASK-300 Permission approval card、TASK-301 手動 Diff UI、TASK-302 応答内リンクと read-only Viewer、TASK-303 in-process 通知 | QR カメラ、履歴永続化 / 再接続復元、FCM / reconnect / deep link / Doze（TASK-604） |
| `docs/` | 仕様、計画、ACP 実測、Local E2E、本ファイル | — |

---

## 10. 次の実装順

計画書と Gate を崩さない。

```text
TASK-400 Dynamic Model Catalog
```

TASK-303 は v1.11.0。Gate D は TASK-500 の将来 gate であり未通過。Camera / TLS / 履歴永続化 / 再接続復元 / FCM は未完。
