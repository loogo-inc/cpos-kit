# セキュリティ

## 報告のしかた

脆弱性、またはこのリポジトリに **秘密 (トークン・URL・個人情報) が混入している** のを見つけたら、公開 issue に書かず、
GitHub の [Private vulnerability reporting](https://github.com/loogo-inc/cpos-kit/security/advisories/new) から送ってください。

- 混入したトークンは、報告を待たずに失効させてください (rotate が先)。
- 3 営業日以内に受領を返します。

## 対象

- `kit/` (client / fake / app-kit / CLI / 雛形) と `spec/`。
- CPOS 本体の脆弱性は対象外。CPOS の提供元へ。

## 設計上の前提

- App Token / PAT はサーバ側の env か Secret Manager にだけ置く。kit はトークンをログ・エラー・ブラウザに出さない。
- `raw()` は CPOS の OpenAPI に載ったパスだけを通す (推測のパスは呼べない)。事業所単位の API は facilityId 無しでは呼べない。
