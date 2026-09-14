# 頼み方と、AI がどう動くか

kit を入れたアプリを AI ツール (Claude Code / Cursor / Codex / Copilot) で開くと、CPOS の呼び方と約束は読み込まれている。
ここでは「何をどう頼むか」と「AI が何を返してくるか」を場面ごとに書く。依頼は普通の日本語でよい (`/cpos` は付けなくても動く。Claude Code / Codex で CPOS のレシピを確実に読ませたいときだけ、先頭に `/cpos` (Codex は `$cpos`) を付ける)。

依頼に入れると迷いが減るもの: **誰が使うか / 事業所単位か組織全体か / CPOS のどのデータか / 書き込みが要るか / ログインを引き継ぐか / 本物で確かめるか**。

## 1. 新しく作る

### 例 1: 利用者ごとのメモ (最小)

```
事業所を選ぶと、その事業所の利用者一覧が出る画面。利用者ごとにメモを保存できる。テストも書いて。
```

AI がやること: `cpos.facilities.list()` で事業所、`cpos.masterUsers.list({ facilityId })` で利用者、メモは AppData (`appData('<appId>').upsertBy(...)`、利用者 1 人に 1 件) に保存。`cpos.manifest.json` の `resources` に `notes` を宣言し、`apiTokenScopes` に `master-users:read` と `app-data:<appId>:read/write`。模擬サーバで `npm test` を緑にして終わる。

返ってくる報告の例:

> 利用者一覧とメモ保存を作りました。事業所は画面で選びます (事業所 ID を固定していません)。AppData の resource `notes` を manifest に宣言し、`schema` で `text` を必須にしました。テスト 6 本、模擬サーバで緑。本物で確かめるには `npx github:loogo-inc/cpos-kit connect` でステージングの URL とトークンを入れてください。

### 例 2: 職員の査定 (ログイン必須)

```
Fastify で、CPOS にログインした人だけが使える画面。その人が見てよい事業所の職員を職種別に集計して一覧にし、クリックで査定 (5 段階とコメント) を入力できる。査定は AppData に保存。テストとステージング検証も。
```

AI がやること: `--sample fastify` の見本にある `fastifyLoginGate` をそのまま使い (自作しない)、職員は `cpos.app.platform.getFacilityStaff({ facilityId })` (職種は `profession`)、査定は AppData。`facility-staff:read` を manifest に足す。`scripts/verify-staging.mjs` を拡張して、本物で件数と 作る→取る→消す を確かめる。

> ログインは雛形の `fastifyLoginGate` を使いました。職員は `facility-staff` (職種あり) で、ログインアカウント (`staffAccounts`) とは別物なので使っていません。manifest に `facility-staff:read` を足したので、**再登録と App Token の再発行が要ります** (RESUME.md に書きました)。

### 例 3: 送迎表

```
送迎計画を日付で一覧にして、車両ごとに並べる。CPOS の送迎 (transport) のデータを使う。自分でデータは持たない。
```

AI がやること: `api.d.ts` を検索して `cpos.app.transport.getPlans({ facilityId, serviceDate })` と `getVehicles` を見つける。JSDoc に「実測 200 (日付) 応答の項目: …」があればその項目名だけを使い、無ければ生の JSON を `<pre>` で出す画面にして止まる。

> `transport.getPlans` は本物で 200 を確認済みで、応答の項目名は api.d.ts にあります。ただし模擬サーバには応答が無い (501) ので、手元では「CPOS 接続待ち」の表示になり、テストもそれを確かめる形です。`transport:read` を manifest に足しました。実物の表示はステージングにつないで確かめます。

## 2. 既存のアプリに機能を足す

`npx github:loogo-inc/cpos-kit adopt --apply` 済みのプロジェクトで。既存のコードの流儀は AI がそちらに合わせる (kit が優先するのは CPOS の安全に関わる 5 つだけ)。

### 例 4: 列を足す

```
利用者一覧に生年月日と年齢の列を足して。テストも。
```

> `masterUsers.list()` の応答に `birthDate` があります (本物で確認済みの項目)。年齢は保存値ではなく表示時に計算します。列とテストを足し、`npm test` 6 本緑。RESUME.md を更新しました。

### 例 5: 別のデータを表示する

```
画面の上に、その事業所の未対応アラートの件数を出して。
```

> `cpos.app.alerts.get({ facilityId, status })` があります (本物で 200 を確認済み)。必要スコープ `alerts:read` が manifest に無いので足しました。**再登録と App Token の再発行が要ります** (`npx github:loogo-inc/cpos-kit scopes --used` でも「足りない」と出ます)。足すまで本物では 403 になります。

### 例 6: 書き込みを足す

```
利用者のメモに「対応済み」のチェックを付けられるようにして。
```

> AppData の `notes` に `done: boolean` を足し、manifest の `schema` にも宣言しました (宣言と合わない書き込みは模擬サーバが 400 にします)。既存のメモは `done` 無しのまま読めます。

## 3. 関連する API が無い・呼べないとき

AI は無い API を推測で叩かず、写しも作らない。CPOS に無い機能は、メモ (`docs/cpos/asks.md` = CPOS 側に頼みたいことの一覧。担当者が読んで CPOS の担当に頼む) に残して、その画面だけ「準備中」にする。ほかは作り切る。最後に「この機能はどうしますか (アプリで持つ / CPOS 側に頼む)」と人に聞く。

### 例 7: CPOS に無い

```
利用者の家族の連絡先を一覧に出して。
```

> `api.d.ts` を「家族」「連絡先」「family」「contact」で検索しましたが、利用者マスタの応答にも他の API にも見つかりません。`docs/cpos/asks.md` に「利用者の家族連絡先が CPOS にあるか確認してほしい」と書き、画面はその列を「CPOS 接続待ち」にして進めました。CPOS に無いと分かったら、AppData にアプリ側で持つ形に切り替えます。

### 例 8: あるが App Token では呼べない (管理画面専用)

```
登録アプリの一覧を画面に出して。
```

> `GET /api/apps` は公式 OpenAPI では管理画面のセッション Cookie 専用 (`cpos.session.apps.get`) なので、kit は cookie 無しでは呼ばせません。方法は 2 つ: (a) ログインを引き継ぐアプリにして `createCposClient({ cookie })` で呼ぶ、(b) `asks.md` に「App Token でも呼べるようにしてほしい」と書く。どちらにしますか。

### 例 9: 模擬サーバに無い (501)

```
請求マスタの地域加算率を表示して。
```

> `cpos.app.billingMasters.getAreaRates()` は本物で 200 を確認済みですが、模擬サーバには応答がありません (501)。テストは「501 なら CPOS 接続待ちの表示になる」ことを確かめる形にし、実物はステージングで確かめます。トークンをファイルに置いてパスを教えてください。

## 4. AI が止まって聞いてくること (答え方)

| AI の問い | 何が起きているか | 答え方 |
|---|---|---|
| `npm install` が「correct access rights and the repository exists」で落ちる | kit のタグが GitHub に無い (鍵の問題ではない) | kit 側にタグの push を頼む。つなぎは `npm install github:loogo-inc/cpos-kit#main` |
| 「ステージングの URL とトークンをください」 | 本物で確かめる段階。値はチャットに貼らせない | ファイルに置き、パスを伝える。`npx github:loogo-inc/cpos-kit connect` でも入る |
| 「manifest にスコープを足しました。再登録と再発行が要ります」 | 使う API が増えた | CPOS の管理者に登録し直しとトークン再発行を頼む (`npx github:loogo-inc/cpos-kit scopes --used` で足りない分が分かる) |
| 「403 スコープ不足」 | 発行済みトークンにそのスコープが無い | 同上。発行時に「一覧に無いスコープ」欄が要るのは `app-data:<appId>:*` の雛形だけ |
| 「事業所 ID が無いので止めました」 | 事業所単位の API を事業所なしで呼んだ | 画面で事業所を選ばせる設計にする (固定しない) |
| 「応答の形が未確認なので生の JSON を出します」 | OpenAPI に応答の形が無い API | 実物を見て、列を決めてから整形を頼む |
| 「CPOS に無いので asks.md に書きました」 | 該当する API が無い | CPOS 側に確認する。無ければ AppData で持つと決める |

## 5. 頼まない方がいいこと

- 「CPOS のデータをうちの DB にコピーして」: 写しは作らない。CPOS にあるものは毎回 CPOS から取る。
- 「トークンはコードに書いていい」: 書かない。`.env` と Secret Manager だけ。
- 「事業所は `fac_sakura` 固定で」: 固定しない。本物では存在しない ID になり、テストが二度と本物で流せない。
