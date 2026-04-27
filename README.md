# Stable QR Reader

Chrome ブラウザ上で動作する、安定して読み取れることを重視した QR コードリーダーです。
内蔵カメラの能力差を吸収しつつ、ユーザーに「いま何をすべきか」を明確に表示します。

## 特長

- **複数 QR の同時検出**（`BarcodeDetector` 利用時）— 勝手に処理を完了しない
- **読み取り履歴**を重複排除して常時表示
- **カメラ能力の自動判定** — フォーカス／露出／ズーム／ライト／向きを表示
- **フォーカス自動試行** — `continuous` → `manual` の距離スイープで合焦を試みる
- **行動指示の自動表示** — 暗い／明るすぎる／検出できない等を判別し、次にすべき操作を案内

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
    ├── scanner.ts          カメラ制御・能力判定・行動指示
    ├── decoder.ts          BarcodeDetector / jsQR フォールバック
    ├── history.ts          履歴管理（localStorage 永続化）
    └── styles.css
```

## 技術スタック

| 用途 | 採用技術 |
|---|---|
| ビルド | Vite 5 |
| 言語 | TypeScript（strict） |
| QR デコード（主） | `BarcodeDetector` Web API |
| QR デコード（代替） | jsQR |
| HTTPS（dev） | @vitejs/plugin-basic-ssl |
| 履歴永続化 | localStorage |

## 既知の制約

- カメラを一度「ブロック」した後は、ブラウザ仕様により JavaScript からの再プロンプト不可。
  アドレスバー左の鍵アイコン → サイトの設定 → カメラを「許可」へ戻してから再試行する必要があります。
- jsQR フォールバック時は単一 QR のみ検出されます（複数同時検出は `BarcodeDetector` 必須）。
- ライト（torch）対応はカメラのハードウェア次第です。PC 内蔵カメラは概ね非対応。
