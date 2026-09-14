# {{name}}

CPOS の上で動くアプリ (appId: `{{appId}}`)。`npx github:loogo-inc/cpos-kit create` で作った。

## 最初の 30 分

{{firstSteps}}
4. AI ツール (Claude Code / Cursor / Codex / Copilot) でこのフォルダを開く。CPOS のことを頼むときは `/cpos` (Codex は `$cpos`) を付けると確実
5. 作りたいものを `docs/PRODUCT.md` に 1 段落書く。決めたことは `docs/DECISIONS.md` に追記する

## 接続先

`.env` の `{{APP}}_CPOS_BASE_URL` で決まる。https… = ステージング (原則。本物の応答)、127.0.0.1 = 模擬サーバ (架空データ)。`npm run dev` はそれに従い、`npm run dev:mock` は常に模擬。起動ログの「接続先:」で確かめる。切り替えは `npx github:loogo-inc/cpos-kit connect`。

## 本物の CPOS につなぐとき

{{authNote}}

1. 権限を持つ人 (CPOS の admin か app-publisher) に、アプリの URL を CPOS 管理画面で登録してもらい、App Token を発行してもらう (登録前でも、既存のトークンがあれば試せる)
2. `npx github:loogo-inc/cpos-kit connect` — URL とトークンを `.env` に書き、疎通とスコープを確かめる (本番は Secret Manager)
3. `npm run verify:staging` — 読み取りの件数と AppData の 作る→取る→消す。`npm run test:staging` で `.env` を読んでテストを本物に向ける
4. `npm start` — ログイン付きの見本なら、ブラウザで `http://127.0.0.1:3000` を開くと本物の Google ログインが一巡する

## この中で何がどこにあるか

| 場所 | 何 | 誰のもの |
|---|---|---|
| `cpos.manifest.json` | アプリの名札。CPOS が読む | あなた |
| `docs/` | 何を作るか、決めたこと、ルール、用語、仕様、引き継ぎ | あなた |
| `AGENTS.md` | AI への指示。上の標準ブロックは cpos-kit が更新する。下は自由 | 半分ずつ |
| `.claude/` `.agents/` `.cursor/` `.github/` | AI ツールごとの設定と CPOS のスキル。中身は同じ | cpos-kit |
| それ以外 | あなたのコード | あなた |

困ったら `docs/handoff/RESUME.md` を読む。次の人のために、終わるときに書く。
