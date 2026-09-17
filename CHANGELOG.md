# Changelog

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)。バージョンは [SemVer](https://semver.org/lang/ja/)。
v1 の間は API の削除をしない (deprecated の印だけ)。

## [Unreleased]

### Added
- `docs` — CPOS の API 一覧を Redoc の画面で見る (kit が持つ OpenAPI の写し。ログイン不要)。

### Changed
- **原則はステージング。** `create` が接続先 (staging / mock) を聞き、staging なら URL とトークンをその場で `.env` に書いて疎通を確かめる。`npm run dev` は `.env` の接続先に従い (https = ステージング、127.0.0.1 = 模擬)、`npm run dev:mock` は常に模擬サーバ。起動ログに「接続先:」を出す。接続先が無ければ案内して止まる。

### Fixed
- `help`: 一覧に `connect` を載せ、廃止した `ask` の選択肢 (`--markdown` `--append` `--json`) を消した。公開 README の CLI 一覧 (`find` `ask` が残っていた) と ADOPT.md の adopt の出力例を実物に合わせた。
- `npm test` (kit 自身) が bash の環境変数書式 (`CPOS_KIT_MAINTAINER=1 node …`) で PowerShell / cmd では動かなかった → テスト側で立てる。
- `update`: 自前の同名スキル (`.claude/skills/cpos/SKILL.md` に `@cpos/kit` が無い) を上書きしていた → kit 所有の印 (`@cpos/kit`) があるものだけ更新し、自前は「触らない」と出す。書き先が symlink でプロジェクトの外を指すときも書かない。
- `adopt`: スキルに `<appId>` `<APP>` を埋めていなかった (create / update は埋める) ため、adopt 直後の `update --check` が赤になった → 埋める。
- `adopt`: ルートに手書きの `SKILLS.md` (スキルの索引) があって cpos の行が無ければ知らせる (索引は kit が書かない)。

- `tickets`: 台帳が「入っている」かを `docs/tickets/` フォルダの有無で見ていたため、自前の `docs/tickets/` (JIRA-101.md 等) と自前の `docs/TICKETS.md` を持つ既存プロジェクトで `npx cpos-kit tickets` が自前の索引を黙って上書きした。init が書く `docs/tickets/README.md` で判定する。`tickets init` は kit のものでない `docs/TICKETS.md` の上には入らず、`TK-###.md` でないファイルは名指しで知らせる。
- `adopt`: 既にある同名ファイル (`.claude/skills/cpos/SKILL.md`、`docs/cpos/README.md` 等) の中身が kit のものと違うときにそう言う (`--show <パス>` で kit が書く中身を出して見比べる)。既存の `CLAUDE.md` に `@AGENTS.md` の 1 行が無ければ末尾に足す (今までは「自分で足してください」)。`help` に adopt を載せた。 `--apply --replace <パス>` で、見比べた上でそのファイルだけ kit のもので置き換える (同名の自前 `cpos` スキルが kit のスキルを隠すとき。kit のスキルを新しい版に上げるときも同じ)。
- `adopt`: `CLAUDE.md` が `AGENTS.md` への symlink のとき `@AGENTS.md` を足していた (自分自身を指す 1 行になる) → 同じファイルなら足さない。書き先が symlink でプロジェクトの外 (共有スキル置き場) に抜けるときは書かない (`--replace` でも)。旧式の `.claude/commands/cpos.md` があれば `/cpos` の名前が被ると知らせる。`.cursor/` があるプロジェクトには create と同じ `.cursor/rules/cpos.mdc` を足す (今までは create だけが書いていた)。

## [0.1.0] - 2026-09-14

最初の公開。生成元: CPOS OpenAPI 1.0.0 (revision 00201-58l、1,372 operations)。

### Added
- `@cpos/kit/client` — CPOS を呼ぶ薄いクライアント。手書きの 5 系統 (platform / facilities / masterUsers / staffAccounts / appData) に加え、CPOS の公式 OpenAPI に載る全 operation を `cpos.app.*` (App Token) / `cpos.session.*` (セッション Cookie) のメソッドとして機械生成 (1 operation = 1 メソッド)。事業所境界とスコープ不足を日本語のエラーで返す。
- `@cpos/kit/fake` — KIT 模擬サーバ (TCP と in-process)。スコープ検査、本物と同じ失敗応答。
- `@cpos/kit/manifest` — `cpos.manifest.json` の検証 (JSON Schema)。
- `@cpos/kit/testing` — テスト用の補助 (`pickFacilities`、`cposForTests`)。
- `@cpos/kit/app-kit` — CPOS のログインを引き継ぐゲートウェイ。
- CLI `cpos-kit` — `create` / `adopt` / `fake` / `validate` / `guide` / `token` / `connect` / `doctor` (kit と接続先 CPOS の API の版を比べる) / `tickets` (後から入れるチケット台帳。`tickets init --apply` まで何も動かない)。
- 雛形 — docs の型、Node と Fastify の見本、作業規律 (AGENTS.md + Claude Code の Stop hook)。
- `skills/cpos` — Agent Skills 形式のレシピ。

### CPOS 2026-09-14 の変更への追随 (公開前に取り込み)
- manifest: `resources[].schema` (data の形の宣言。type / properties / required / items / enum / additionalProperties / description / format のみ)、`tokenDelivery.secretManager`、`isPublic` は初回登録時のみ。`apps:admin` は App Token に付けられないので validate がエラーにする。雛形の notes に schema の見本。
- KIT 模擬サーバ: manifest の schema に合わない data の作成・更新を 400 (`issues` 付き。本物は既定で報告のみ)。事業所限定トークンが facilityId 無しで一覧を呼ぶと 400 `facility-id-required` (本物と同じ形)。
- client: `CposApiError.body` に CPOS の応答 JSON。`tokenResolver()` (Secret Manager の mount ファイルを 60 秒ごとに読み直す。CPOS 側のトークン入替に追随)。雛形はこれを使う。
- app-kit: OAuth の既定 scope を `facilities:read` に (省略すると MCP の読み取り全部の同意になるため)。失効は access と refresh の両方。429 を日本語のエラーに。`oauth.revoke: false` で失効を省ける。
- CLI: `scopes` が管理者 PAT 専用 (`apps:admin`) を区別する。`token` の案内に manager の発行条件 (事業所限定・ワイルドカード不可)。
- skills: manifest の schema、取込の 5 秒制限、tokenDelivery、MCP の PHI ツール、404 の調べ方を更新。
