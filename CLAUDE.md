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

## アーキテクチャ

```
src/
  main.ts      DOM 構築・イベント結線・履歴 UI 描画。ロジックは持たない。
  scanner.ts   Scanner クラス。getUserMedia / 能力判定 / フレームスキャン /
               行動指示生成 / フォーカス自動試行 を担う。状態は外部に
               onResults / onStatus コールバックで通知。
  decoder.ts   createDecoder() が BarcodeDetector を優先、未対応なら
               jsQR にフォールバックする Decoder を返す。Decoder.kind で
               判別可能（複数 QR 同時検出は 'native' のときのみ）。
  history.ts   重複排除・回数カウント・localStorage 永続化。
  styles.css   ダークテーマ。状態別の色（ok/warn/error/info）を CSS で表現。
```

### データフロー

```
Scanner.scanLoop (rAF)
  ├─ video → canvas に描画（反転処理は加えない）
  ├─ decoder.detect(canvas) → DetectedCode[]
  │   ├─ 検出あり → onResults(codes) → main.ts が drawOverlay + history.add + renderHistory
  │   └─ 検出なし → failureFrames++
  │                  ├─ onResults([]) で overlay をクリア
  │                  ├─ 中央 120x120 の輝度サンプリングで状態判定
  │                  ├─ onStatus で行動指示
  │                  └─ 一定間隔で tryAdjustOptics（フォーカス試行）
  └─ 次フレームへ
```

### overlay canvas（検出位置のハイライト）

- `index.html` 上では `<video>` と `<canvas id="overlay">` を `.video-wrap` 内に重ねている。
  両者とも `object-fit: cover` で同じクロップを受けるため、cornerPoints をそのまま描画して位置が合う。
- overlay の内部解像度は `videoWidth × videoHeight` に同期（`loadedmetadata` と `syncOverlay()` で）。
- 内蔵カメラ等で video が `scaleX(-1)` で鏡像表示される場合、overlay にも同じ transform を当てて
  座標変換を不要にしている（`Scanner.isMirrored()` を main.ts から参照）。
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
