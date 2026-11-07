# EEW モニター

緊急地震速報・地震情報を表示する静的PWA。ビルドなし。Vercel プロジェクト名は `eew`。

## 構成
`index.html` / `styles.css` / `app.js` / `sw.js` / `data/land.json` / `vercel.json`

## 守ること（コードから読み取れない制約）
- 取得データの表示は `textContent` 経由のみ。`innerHTML` を使わない。
- 外部接続は `api.wolfx.jp` と `wss://ws-api.wolfx.jp` のみ。増やすときは `vercel.json` の CSP も更新する。
- Wolfx Project の規約：出典表示を残す／公式警報として見せない／機能を有料化しない／データを独立した供給元として再配信しない。
- 訓練報（`isTraining`）と取消報（`isCancel`）は通知しない。発表から90秒を超えた電文も鳴らさない。
- 通知と音声はタブが開いている間だけ動く。閉じていても届けるには、サーバー側から Web Push を送る別実装が要る。
- P/S波の円は 7/4 km/s の概算。気象庁の走時表ではない。
- `sw.js` を変えたら `CACHE` 名を更新する。

## 完了の条件
- `node --check app.js` が通る。
- 実機で2本の WebSocket チップが緑になり、地震情報が50件出る。
- 完了報告には、確認した証拠（画面・ログ）を添える。
