# Android Audio Routing Report

- 文書の性質: 測定記録と runbook。成功証拠ではない。
- 対象: TASK-500（未完了） / Gate D（未通過）
- 記録日: 2026-08-24
- 正本: [`docs/cursor_remote_android_spec_v0.3.md`](cursor_remote_android_spec_v0.3.md)（音声入力）、[`docs/implementation_plan_grok_4.6.md`](implementation_plan_grok_4.6.md)（TASK-500 / Gate D）

この文書は debug-only 診断 harness の起動手順と、将来の実機記入欄を残す。TASK-500 も Gate D も、対象実機で Bluetooth playback と本体マイク routing を測るまで pending のままである。TASK-501 / TASK-502 / TASK-503 は未着手。STT UI や本番 voice flow は存在しない。

---

## 1. いまの位置

| 項目 | 状態 |
| --- | --- |
| debug-only `AudioRoutingProbeActivity` | 実装済み（debug ビルド、明示 adb launch） |
| fail-closed Built-in mic policy | 実装済み（JVM unit test）。実機未測 |
| TASK-500 | **未完了** |
| Gate D | **未通過** |
| TASK-501 Push-to-Talk Recorder | **未着手** |
| TASK-502 STT Adapter | **未着手** |
| TASK-503 Voice Prompt UX | **未着手** |

本番 `AndroidManifest` と Chat にはマイク権限も voice UI もない。診断結果を Gate D 成功と読まない。

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

未記入は未測定を意味する。行を埋めても、Bluetooth playback 継続と本体マイク routing が対象端末で揃うまで TASK-500 / Gate D は閉じない。

| Device | Android | BT playback connected | Built-in preferred accepted | Routed input | mode before / during / after | PCM frames / peak / RMS | Errors | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | 未測定。TASK-500 pending |

コピー用メモ（Start 後の Result から転記）:

```text
manufacturer / model / sdk:
preference / decision:
setPreferredDevice accepted:
routed-device observations:
AudioManager.mode before/during/after:
PCM frames / bytes / peak / RMS / samples arrived:
errors:
```

---

## 4. この文書が証明しないこと

- TASK-500 完了
- Gate D 通過
- Phase 5 完了
- Bluetooth 接続中の本体マイク録音が実機で成立したこと
- STT / Push-to-Talk / Voice UX の実装
