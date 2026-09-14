# 貢献のしかた

## 始める

```
git clone https://github.com/loogo-inc/cpos-kit.git
cd cpos-kit
npm test          # 依存ゼロ。node --test で 1 分以内
```

直したら、雛形から生成したアプリでも通ることを確かめる (コミット済みの内容だけが入る):

```
git commit -am "..."
node kit/bin/cpos-kit.mjs create ../try --yes --kit-dep "git+file://$(pwd)"
cd ../try && npm install && npm test
```

## PR に書くこと

- 何を直したか、どう確かめたか (実行したコマンドと出力)。
- `spec/cpos-api.yaml` に API を **足す** PR は、本物の CPOS で形を確かめた証拠 (応答の項目名と日付。値は書かない) を添える。
  載せるかどうかは所有者が決める。載せると v1 の間は消せない。
- CPOS 本体の内部構造 (ファイル名・行番号)、ステージングの URL、トークンを書かない。`npm test` の no-internal-leak が落ちる。

## 守ること

- v1 内は追加のみ。削除は `deprecated` と CHANGELOG。
- 依存を足さない (Node 組込みだけ)。bash 前提のスクリプトを書かない (PowerShell の人がいる)。
- docs より動くレシピ (コード + テスト)。

## ライセンス

貢献は MPL-2.0 の下で受け付ける。別の合意書 (CLA) は無い。
