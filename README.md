# Stable QR Reader

Chrome ブラウザ上で動作する、安定して読み取れることを重視した QR コードリーダーです。
内蔵カメラの能力差を吸収しつつ、ユーザーに「いま何をすべきか」を明確に表示します。

## 特長

- **複数 QR の同時検出**（`BarcodeDetector` 利用時）— 勝手に処理を完了しない
- **3 段デコーダフォールバック** — `BarcodeDetector` → jsQR → ZXing の順に
  自動切り替え。プライマリで読めない状態が続いたらセカンダリも併用して読み取り精度を上げる
- **読み取り履歴**を重複排除して常時表示
- **カメラ能力の自動判定** — フォーカス／合焦距離／露出／ズーム／ライト／向きを表示
- **フォーカス自動試行** — `continuous` → `manual` の距離スイープで合焦を試みる
- **ハードウェアズーム自動オシレーション** — 対応カメラで広角 (0.5x) / 標準 (1x) /
  望遠 (2x) を巡回適用し、QR との距離マッチを探す
- **行動指示の自動表示** — 暗い／明るすぎる／レンズ汚れの可能性などを判別し、
  次にすべき操作を案内

## 必要環境

- Chrome（Windows / macOS / Linux）
- Node.js 18 以降

## セットアップ

```bash
npm install
```

## 開発サーバ起動

```bash
npm run dev
```

`https://localhost:5173/` を Chrome で開いてください。

### 自己署名証明書の警告について

初回アクセス時にプライバシー警告が表示されます。以下のいずれかで進めてください：

- 「詳細設定」 → 「localhost にアクセスする（安全ではありません）」
- ページ上で `thisisunsafe` と直接タイプ（Chrome の不可視ショートカット）

LAN 内の他デバイスから接続する場合は、`npm run dev` のログに表示される
`https://192.168.x.x:5173/` 等を使ってください。同様に証明書警告のバイパスが必要です。

## ビルド

```bash
npm run build      # dist/ に出力
npm run preview    # ビルド成果物をローカルプレビュー
```

## ディレクトリ構成

```
.
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts          HTTPS 化（@vitejs/plugin-basic-ssl）
└── src/
    ├── main.ts             UI 制御
    ├── scanner.ts          カメラ制御・能力判定・行動指示・光学系自動試行
    ├── decoder.ts          BarcodeDetector / jsQR / ZXing の 3 段フォールバック
    ├── history.ts          履歴管理（localStorage 永続化）
    └── styles.css
```

ZXing チャンクは動的 import で `dist/assets/zxing.js` に分離出力される（必要時のみ
ランタイム取得）。

## 技術スタック

| 用途 | 採用技術 |
|---|---|
| ビルド | Vite 5 |
| 言語 | TypeScript 5（strict + noUnusedLocals + noUnusedParameters） |
| QR デコード（プライマリ） | `BarcodeDetector` Web API（Chromium ベース・対応環境のみ） |
| QR デコード（セカンダリ） | [jsQR](https://github.com/cozmo/jsQR) ^1.4.0 |
| QR デコード（ターシャリ） | [@zxing/library](https://github.com/zxing-js/library) ^0.21.3（動的 import で別チャンク） |
| カメラ制御 | `getUserMedia` + `MediaTrackCapabilities` / `applyConstraints` |
| HTTPS（dev） | [@vitejs/plugin-basic-ssl](https://github.com/vitejs/vite-plugin-basic-ssl) ^1.2.0 |
| 履歴永続化 | localStorage |
| バンドル分割 | Vite `manualChunks`（ZXing を `assets/zxing.js` に固定名で切り出し） |

### デコーダの選び方

- 起動時に `BarcodeDetector` の有無を判定し、利用可能ならプライマリに採用
  （Chrome/Edge on Android・macOS、最近の Chrome on Windows 等）。
- 利用不能な環境（Firefox、Safari、一部の Windows Chrome 等）では jsQR をプライマリに採用。
- いずれの場合も、約 1 秒読み取りに失敗するとセカンダリデコーダ（プライマリが native
  なら jsQR、jsQR なら ZXing）を併用してリトライする。
- 画像ファイル読み込みは `BarcodeDetector → jsQR → ZXing` の順にチェインする。

## 商標について

QR コードは株式会社デンソーウェーブの登録商標です。
QR Code is a registered trademark of DENSO WAVE INCORPORATED.

## 既知の制約

- カメラを一度「ブロック」した後は、ブラウザ仕様により JavaScript からの再プロンプト不可。
  アドレスバー左の鍵アイコン → サイトの設定 → カメラを「許可」へ戻してから再試行する必要があります。
- jsQR / ZXing フォールバック時は単一 QR のみ検出されます（複数同時検出は `BarcodeDetector` 必須）。
- ライト（torch）対応はカメラのハードウェア次第です。PC 内蔵カメラは概ね非対応。
- ハードウェアズーム自動オシレーションは `MediaTrackCapabilities.zoom` を返すカメラ
  でのみ動作します。PC 内蔵カメラの多くは未対応で、その場合は CSS の 2倍ズームトグル
  （視覚のみ）だけが利用可能です。
