# Android Audio Routing Report

- 文書の性質: TASK-500 の対象実機測定記録と runbook
- 対象: TASK-500（完了） / Gate D（通過）
- 記録日: 2026-09-03
- 正本: [`docs/cursor_remote_android_spec_v0.3.md`](cursor_remote_android_spec_v0.3.md)（音声入力）、[`docs/implementation_plan_grok_4.6.md`](implementation_plan_grok_4.6.md)（TASK-500 / Gate D）

2026-09-03、対象実機で Bluetooth playback を継続したまま本体マイクの PCM 入力を確認した。TASK-500 は完了、Gate D は通過とする。TASK-501 / TASK-502 / TASK-503 は未着手であり、STT UI や本番 voice flow はまだ存在しない。

---

## 1. いまの位置

| 項目 | 状態 |
| --- | --- |
| debug-only `AudioRoutingProbeActivity` | 実装済み（debug ビルド、明示 adb launch） |
| fail-closed Built-in mic policy | 実装済み。JVM unit test と対象実機で確認済み |
| TASK-500 | **完了（2026-09-03）** |
| Gate D | **通過（2026-09-03）** |
| TASK-501 Push-to-Talk Recorder | **未着手** |
| TASK-502 STT Adapter | **未着手** |
| TASK-503 Voice Prompt UX | **未着手** |

本番 `AndroidManifest` と Chat にはマイク権限も voice UI もない。Gate D の判定は probe 画面だけではなく、同時取得した MediaSession、AudioFlinger、AudioService の状態を合わせて行った。

---

## 2. Debug ビルド / インストール / 起動

作業ディレクトリは `android/`。

```bat
cd android
gradle :app:assembleDebug
adb install -r app\build\outputs\apk\debug\app-debug.apk
adb shell pm grant dev.cursorremote.android android.permission.RECORD_AUDIO
adb shell am start -n dev.cursorremote.android/dev.cursorremote.android.voice.AudioRoutingProbeActivity
```

- 起動は明示コンポーネント指定だけ。launcher には出さない。
- `RECORD_AUDIO` は debug manifest のみ。Activity は実行時にも要求する。
- Activity は `AudioManager.mode` を読むだけである。communication mode や Bluetooth SCO は要求しない。
- 結果テキストは画面上で選択できる。PCM 本体は保存もログもしない。
- 測定時は Bluetooth イヤホンを再生接続したうえで Refresh → Start し、Stop / Cancel で打ち切れる。

APK 経路が異なる場合は `app/build/outputs/apk/debug/` の debug APK を使う。

---

## 3. 実機結果表

最終確認は 2026-09-03 22:35 JST。debug APK は `versionName=1.17.0` / `versionCode=30`、Bluetooth 再生には 12.84 秒の WAV テスト音源を使用した。音源と画面取得用の一時ファイルは検証後に端末と PC から削除した。

| Device | Android | BT playback connected | Built-in preferred accepted | Routed input | mode before / during / after | PCM frames / peak / RMS | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Samsung SM-S928Q | 16 / SDK 36 | JBL Tour Pro 3 / BLE。before・during・after とも再生中 | `true` | `TYPE_BUILTIN_MIC`、id 22 | `MODE_NORMAL` / `MODE_NORMAL` / `MODE_NORMAL` | 48640 / 699 / 182.798 | なし | `VOICE_RECOGNITION`、16-bit mono 16 kHz、97280 bytes、samples arrived=`true` |

外部状態の確認結果:

- MediaSession は before / during / after の全時点で `PLAYING`。
- AudioFlinger の `AUDIO_DEVICE_OUT_BLE_HEADSET` thread は全時点で `Standby: no`、active track は 1。
- `setPreferredDevice` は `true`。録音中の actual routed device は本体マイク id 22 のみ。
- `communicationModeRequested=false`、`bluetoothScoRequested=false`。SCO は requested / applied とも `false`、`SCO_STATE_INACTIVE`。
- PCM 本体は保存していない。

以上から、計画書の「Bluetooth 接続中に本体マイク録音が成立することを少なくとも対象端末で確認する」を満たすため、TASK-500 完了・Gate D 通過と判定する。

---

## 4. 未確認・未実装の範囲

- Phase 5 完了
- SM-S928Q / Android 16 以外の端末での互換性
- STT / Push-to-Talk / Voice UX の実装
