# CLAUDE.md

このファイルは、本リポジトリで Claude Code が作業する際の指針です。

## プロジェクト概要

Chrome 上で動作する QR コードリーダー（Vite + TypeScript の SPA）。
カメラごとの機能差を吸収しつつ、ユーザーに「次にすべき操作」を明確に表示することを最重要視する。
詳細な要件・思想は `QRコードリーダー設計指針.md` を必ず参照すること。

## 開発コマンド

```bash
npm install        # 依存導入
npm run dev        # https://localhost:5173/ で dev サーバ起動（自己署名）
npm run build      # tsc --noEmit + vite build
npm run preview    # build 成果物のローカル確認
npx tsc --noEmit   # 型チェックのみ
```

`getUserMedia` は `localhost` でも特定環境で HTTPS 必須となるため、dev サーバは
`@vitejs/plugin-basic-ssl` で常に HTTPS 化している。HTTP に戻さないこと。

## デプロイ（docs/webapp）

GitHub Pages 用の公開先は `docs/webapp/`。デプロイ手順：

```bash
npm run build
cp dist/assets/index.js  docs/webapp/assets/index.js
cp dist/assets/index.css docs/webapp/assets/index.css
cp dist/assets/zxing.js  docs/webapp/assets/zxing.js
```

- `docs/webapp/index.html` には OGP メタタグ・Google Analytics（gtag）・footer・
  manifest リンクなどのカスタマイズが入っているので **触らない**。
  vite の出力は `assets/index.js` / `assets/index.css` の固定名（ハッシュなし、
  `vite.config.ts` の `entryFileNames`/`assetFileNames` で固定）なので、
  `assets/` 配下を上書きコピーするだけで反映できる。
- `assets/zxing.js` は ZXing-js（フォールバック用 QR デコーダ）の動的 import チャンク。
  プライマリが jsQR で読み取りに失敗したときだけランタイム取得されるが、
  ファイル自体はデプロイ時に必ずコピーすること（`vite.config.ts` の `manualChunks` で
  ファイル名を `zxing.js` に固定済み）。
- `dist/index.html` を `docs/webapp/index.html` に上書きしないこと（OGP・GA が消える）。
- 配下の `manifest.webmanifest` と `icons/` も基本触らない（変更が必要な場合のみ手動更新）。

## アーキテクチャ

```
src/
  main.ts      DOM 構築・イベント結線・履歴 UI 描画。ロジックは持たない。
  scanner.ts   Scanner クラス。getUserMedia / 能力判定 / フレームスキャン /
               行動指示生成 / 光学系自動試行（フォーカス・ズーム）を担う。
               状態は外部に onResults / onStatus / onRuntimeChange の
               3 種類のコールバックで通知。
  decoder.ts   createDecoder() が BarcodeDetector を優先、未対応なら
               jsQR にフォールバックする Decoder を返す。Decoder.kind は
               'native' | 'jsqr' | 'zxing' の 3 種。複数 QR 同時検出は
               'native' のときのみ。createJsqrDecoder() / createZxingDecoder()
               で個別取得も可能。ZXing は @zxing/library の動的 import で
               別チャンク（assets/zxing.js）に切り出されている。
               3 経路すべて QR 専用（native: formats=['qr_code'] / jsQR は QR 専用 lib /
               ZXing は QRCodeReader 直接利用）。1 次元バーコードは検出しない方針。
  history.ts   重複排除・回数カウント・localStorage 永続化。
  styles.css   ダークテーマ。状態別の色（ok/warn/error/info）を CSS で表現。
```

### データフロー

```
Scanner.scanLoop (rAF)
  ├─ video → canvas に描画（反転処理は加えない）
  ├─ primary.detect(canvas) → DetectedCode[]
  │   └─ 空なら secondaryDecoder?.detect(canvas) も試す（active 時のみ）
  ├─ 検出あり → failureFrames=0 / onResults(codes) /
  │             main.ts が drawOverlay + history.add + renderHistory
  └─ 検出なし → failureFrames++
                ├─ onResults([]) で overlay をクリア
                ├─ failureFrames が閾値を超えたら secondary を起動
                │   （native→jsqr / jsqr→ZXing。ZXing は動的 import）
                ├─ 鏡像試行ウィンドウ内なら左右反転 canvas でも primary→secondary を試す
                │   （成功時は cornerPoints を unflip して onResults へ）
                ├─ 中央 120×120 を輝度＋鮮鋭度（stdDev / 勾配）でサンプリング
                ├─ onStatus で行動指示（暗い／白飛び／距離変更／レンズ汚れ）
                └─ 45 フレーム毎に tryAdjustOptics でフォーカス・ズームを試行
```

### 検出失敗時の段階的フォールバック

`Scanner.maybeActivateSecondaryDecoder()` が `failureFrames >= 60`（約 1 秒）で
セカンダリデコーダを起動する：

- プライマリが `native` の場合 → `createJsqrDecoder()` を即時生成
- プライマリが `jsqr` の場合 → `createZxingDecoder()` を `await import` で読み込み
  （`secondaryLoading` フラグで多重起動を防止）

起動後はセカンダリがセッション終了まで保持され、毎フレーム「primary が空 →
secondary」の二段検出になる。`detectFromFile` も native→jsqr→ZXing と段階的に試す。

### 鏡像読み取りフォールバック

`facingMode` だけでは判定できない「カメラが映像を左右反転して出力している」ケース
（仮想カメラ・OBS 等）に対応するため、検出失敗が続いたときに左右反転した canvas でも
試行する。

- 開始閾値: `failureFrames >= MIRROR_FALLBACK_THRESHOLD`（30 フレーム ≒ 0.5 秒）
- 試行ウィンドウ: `MIRROR_TRIAL_DURATION`（90 フレーム ≒ 1.5 秒）
- 周期: `MIRROR_TRIAL_PERIOD`（180 フレーム ≒ 3 秒）— 試行 ON / 休止 OFF を交互に繰り返す。
  これにより「試行中」状態が無期限に固着するのを防ぎつつ、後から QR をかざしても拾える。
- 反転 canvas 用に `Scanner.flipCanvas` を 1 つ持ち回し、`buildFlippedCanvas` で再利用する。
- 反転検出で成功したら `unflipCodesHorizontally` で cornerPoints / boundingBox の x 座標を
  元の向きに戻してから `onResults` に渡す（overlay 描画の coords を狂わせない）。
- 状態は `mirrorTrialActive` フラグで管理し、ON/OFF が変わるたびに `onRuntimeChange` を
  発火する。`isMirrorTrialActive()` を main.ts から参照して以下に反映：
  - 能力欄 (`#capability`) に「左右反転で試行中 / Trying mirrored read」を表示
  - `applyVideoTransforms` で `isMirrored() XOR isMirrorTrialActive()` を `scaleX(-1)` の
    判定に用い、デコーダが見ている向きと画面表示を一致させる
- `detectFromFile` も最終フォールバックとして反転試行を実装（native→jsqr→ZXing が全て
  失敗したあとに、反転画像で同 3 段を試す）。

### tryAdjustOptics の試行内容

`failureFrames` が 45 の倍数のたびに呼ばれ、`trialIndex` を進めながら以下を試す：

- **フォーカス** — `continuous` モードがあれば最初に一回適用、その後は `manual` +
  `focusDistance` の min〜max を 5 段階でスイープ。
- **ズーム** — `caps.zoom` があれば、能力に応じて広角 (0.5x) / 標準 (1x) / 望遠 (2x)
  を `trialIndex` 偶奇で巡回適用。`currentZoom` を更新して `onRuntimeChange` を発火。
  これは **ハードウェアレベルのズーム**（`applyConstraints({ advanced: [{ zoom }] })`）で
  あり、main.ts 側の CSS スケールによる「2倍ズーム」トグル（視覚のみ・検出には効かない）
  とは独立。

### overlay canvas（検出位置のハイライト）

- `index.html` 上では `<video>` と `<canvas id="overlay">` を `.video-wrap` 内に重ねている。
  両者とも `object-fit: cover` で同じクロップを受けるため、cornerPoints をそのまま描画して位置が合う。
- overlay の内部解像度は `videoWidth × videoHeight` に同期（`loadedmetadata` と `syncOverlay()` で）。
- 内蔵カメラ等で video が `scaleX(-1)` で鏡像表示される場合、overlay にも同じ transform を当てて
  座標変換を不要にしている（`Scanner.isMirrored()` を main.ts から参照）。
- 鏡像読み取り試行中は `applyVideoTransforms` が `isMirrored() XOR isMirrorTrialActive()`
  で判定するため、video / overlay とも追加で反転（または既存の反転を打ち消す）。
  Scanner 側で cornerPoints は元の向きに戻してから渡しているので、overlay の描画 coords は
  常に raw canvas 座標系で OK。
- 描画は main.ts の `drawOverlay(codes)` が担当。Scanner は描画ロジックを持たない。

## 設計指針からの不変条件

これらは `QRコードリーダー設計指針.md` を反映した「壊してはいけない」性質：

1. **勝手に完了しない** — 検出した QR で自動的にページ遷移しない。履歴に残しユーザー操作を待つ。
2. **複数 QR 想定** — 単一検出を仮定したコード（`codes[0]` 決め打ちなど）を書かない。
3. **権限拒否で詰まない** — `NotAllowedError` を捕捉し、再試行ボタンを常に有効に保つ。
4. **行動指示を出す** — 検出失敗が続いたら必ず原因推定（暗い／明るい／距離／フォーカス）と
   ユーザーへの具体的指示を `onStatus` で通知する。
5. **能力差を吸収** — `track.getCapabilities()` の有無・キーの有無を毎回チェックし、
   存在しない機能は黙って諦める（例外を投げない）。
6. **ファイル画像にも対応** — カメラ起動なしで `detectFromFile` が動くこと。
7. **検出時はビジュアルでも示す** — overlay canvas に cornerPoints / boundingBox で枠を描画する。
   検出が外れたフレームは即クリアする（残像を残さない）。
8. **`onResults` は毎フレーム呼ばれる契約** — 検出なしのフレームでも `onResults([])` を発火する。
   overlay クリアがこれに依存しているので、空配列の発火を止めないこと。

## 設計判断（やらないこと）

- **固定の「ここに収めて」ガイド枠は出さない**
  - 内蔵カメラの最短焦点距離はまちまち（30〜50cm）かつ QR の物理サイズもまちまちなため、
    固定枠で誘導すると却って合焦できない／読めない状態を招く。
  - `BarcodeDetector` は中央以外のコードも検出できるので、枠で限定すると強みを潰す。
  - 代わりに「検出されたコードを枠で示す」フィードバック方針（不変条件 7）を採る。
- **センサ値で裏付けが取れない行動指示は出さない**
  - 「もう少し近づけて」「遠ざけて」「手ブレを抑えて」「中央に来るように」といった
    ヒントは、Scanner 側で距離・動き量・コード位置を測っていない以上ただの当てずっぽう。
    かつて hints カルーセルで出していたが、根拠が無いため削除済み。
  - 検出失敗時は「カメラからの距離を変えてみてください」のような中立的な誘導と、
    輝度・鮮鋭度から判定できる事象（暗い／白飛び／レンズ汚れ）に限定する。
- **CSS の `scale(2)` を「読み取り改善」のために使わない**
  - main.ts の 2倍ズームトグルは `<video>` への CSS transform であり、
    Scanner が読み込む canvas 解像度には影響しない（=検出には無効）。
  - 検出に効かせたい場合は `applyConstraints({ advanced: [{ zoom }] })` で
    ハードウェアズームを動かす。tryAdjustOptics の自動オシレーションがこの方針。
- **1 次元バーコードは検出させない（現時点）**
  - ZXing で `MultiFormatReader` + `POSSIBLE_FORMATS` ヒントだけだと CODE_128 等が
    すり抜けて返ってくることがあるため、`QRCodeReader` を直接使う形に固定している。
  - 将来バーコード対応を加える際は `MultiFormatReader` に戻し、許可フォーマットを
    `POSSIBLE_FORMATS` で明示する。`DetectedCode.format` も `'qr_code'` 以外を扱える
    ようにする必要がある（現状 ZXing 経路は format を `'qr_code'` 固定で返す）。

## UI 表示テキスト（日本語／英語併記）

画面に出る文字列はすべて日本語と英語を併記する。意図せず片方だけになっていたら直す。

- **ステータス（`#status`）** — `ScannerStatus` の `message`/`hint` に加えて
  `messageEn`/`hintEn` も埋める。`main.ts` の `showStatus` が英語を `<span class="en">` で
  2 行目として描画する（CSS の `.status strong .en` / `.status small .en` でスタイル）。
  英語訳を省略すると日本語だけになるので、新しい `onStatus` 呼び出しを追加するときは
  必ず英語版も書く。
- **ボタン・トグル・ヘッダ等の短いラベル** — `日本語 / English` のインライン併記
  （例: `開始 / Start`、`削除 / Delete`、`コピー / Copy`、`コピー済 / Copied`）。
  動的にテキストを差し替える箇所（`startBtn.textContent`、`copyBtn.textContent` 等）も
  併記形式で書くこと。
- **能力表示（`#capability`）** — `フォーカス / Focus: ...` のようにキー部分も併記。
- **履歴のカウント** — `N回検出 / N× detected` の形式。
- **`confirm` ダイアログは使わない** — `window.confirm()` のような同期ブロッキング
  ダイアログはスキャン中の `requestAnimationFrame` ループや video 再生を中断させ、
  ダイアログ閉鎖後にスクリーンが追従しなくなる現象を引き起こす。代わりに
  「履歴をクリア」ボタンのような 2 段階クリック方式を使う：1 回目で `.confirm` クラスを
  付与してラベルを「もう一度押して確定 / Click again to confirm」に切り替え、3 秒以内に
  もう一度押されたら実行、タイムアウトで元に戻す。新しい確認 UI を追加する際も
  `confirm`/`alert`/`prompt` を避け、非ブロッキングなパターン（インライン確定 or
  カスタムモーダル）で実装すること。併記が必要な場合は改行区切りで 1 文字列に入れる
  （例: `'履歴をすべて削除しますか？\nClear all history?'`）。
- **CSS 擬似要素** — `#history-list:empty::after` のような CSS 内のテキストも
  `日本語 / English` 形式で書く。
- **footer の商標表記** — `index.html` / `docs/webapp/index.html` の footer は
  既に併記済み。触らない。
- **HTML の `lang` 属性** — `lang="ja"` のままで OK（一次言語は日本語）。

## コーディング規約

- TypeScript は `strict` + `noUnusedLocals` + `noUnusedParameters`。未使用変数は残さない。
- `BarcodeDetector` のような未公開型は本ファイル内で局所的に型定義する（`globalThis` 経由でアクセス）。
  `@types/dom-mediacapture-*` 等の型パッケージは入れない。
- DOM 操作で `innerHTML` に外部由来の文字列を入れる場合は必ず `escapeHtml` を通す
  （現状 `main.ts` で QR 内容を `textContent` に入れる方針を維持）。
- ライブラリ追加時は Vite 5 互換のメジャーを選ぶ（例: `@vitejs/plugin-basic-ssl@^1.x`）。
  バンドルサイズに敏感なため、デコード用 lib の追加は慎重に。

## 動作確認の留意点

- カメラを使う UI なので、型チェック (`npx tsc --noEmit`) と `npm run build` の通過は確認できるが、
  実際の検出精度・行動指示の妥当性は人間がブラウザで触らないと検証できない。
  完了報告では「ビルドは通った／ブラウザでの動作確認はユーザー側で必要」と明示すること。
- カメラ拒否状態のテストはブラウザのサイト設定変更が必要。コードからは再現できない。

## ファイル命名

- 設計ドキュメント `QRコードリーダー設計指針.md` は日本語ファイル名のまま維持する（履歴と参照リンクのため）。
