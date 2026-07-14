# shimi-sync

単一HTMLアプリ群（語彙ラボ・栞・AI Journal など）のための、**同期コード方式**のデータ同期API。
Cloudflare Workers + KV で動く。ログイン・アカウント登録なし。

## 仕組み

- アプリ側で推測不能なランダムの**同期コード**（例: `XXXX-XXXX-XXXX-XXXX-XXXX`、約99bit）を発行する
- 別の端末で同じコードを入力すると、同じ保存領域（KVキー = `アプリ名:コード`）を共有する
- コードそのものが合鍵。コードを知らない相手はデータを読めない

## API

| メソッド | パス | 動作 |
|---|---|---|
| GET | `/v1/:app/:code` | 保存されたblob `{updatedAt, data}` を返す（なければ404） |
| PUT | `/v1/:app/:code` | body `{baseUpdatedAt, updatedAt, data}` を保存 |

PUT は楽観ロック付き: サーバーの `updatedAt` が `baseUpdatedAt` と一致しないとき
**409 + 現在のblob** を返す。クライアントはそれをローカルとマージして再送する。
これで「古い端末が新しいデータを黙って上書きする」事故を防ぐ。

- blob上限: 2MB（超えると413）
- コード形式: `[A-HJ-NP-Z2-9]{4}` ×5ブロック（紛らわしい I/L/O/0/1 は不使用）

## デプロイ

```sh
npx wrangler kv namespace create SYNC   # 表示された id を wrangler.toml に貼る
npx wrangler deploy
```

本番URL: https://shimi-sync.shimi-works.workers.dev

## 各アプリでの同期対象

- **語彙ラボ**: 語彙帳・メモ・XP・実績・設定（GeminiのAPIキーは同期しない）
- **栞**: 本棚・しおり・読書ログ・設定（APIキーは同期しない）
- **AI Journal**: 日記本文・設定（APIキーは同期しない。**画像はIndexedDB保存のため同期対象外**）

## 制限（v1）

- マージは「単語/エントリ/キー単位の統合＋新しい方優先」。**片方の端末で削除したものが、もう片方に残っていると復活することがある**
- 日記の画像は同期されない（本文のみ）
