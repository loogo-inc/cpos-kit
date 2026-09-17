# GLOSSARY — 用語

介護の言葉と、画面・コードの言葉の対応。迷ったらここに足す。

| 言葉 | 意味 | コードでは |
|---|---|---|
| 事業所 | サービスを提供する拠点。データは必ずこの単位 | `facilityId` |
| 利用者 | サービスを受ける本人 | `cpos.masterUsers` (`MasterUser`: 一意キーは `masterUserId`、公的な番号は `insuredNumber`) |
| 職員 | 働く人。ログインアカウントを持つ | `cpos.staffAccounts` (CPOS の API 名は `/api/platform/users` で紛らわしい) |
| 被保険者番号 | 利用者の公的な番号 | `insuredNumber` |
| 要介護度 | 要支援1〜要介護5 | `careLevel` |
| AppData | このアプリ専用の保存場所 (CPOS 内) | `cpos.appData('{{appId}}')` |
