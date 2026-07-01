# parking-price-crawler

駐車場主要プレイヤーの料金を **節度をもって** 定期収集し、変動を検知するクローラ。
PIT PORT のサブリース物件の周辺相場把握を目的とした競合分析用。

## 現状（全国対応）

- 対応事業者と取得単位:
  - **NPC（日本パーキング）** — 公式 JSON API。**全国 約1,700件を bbox API で1リクエスト一括取得**（`mode:"nationwide"`）。市区町村単位（`cityId`）も可。満空状況も取得
  - **三井のリパーク** — サーバ描画の静的HTML（JSON-LD + DOM）。一括API無しのため、個別 `parkId` 単位 or **全国16,000件超を sitemap からローリング巡回**（`mode:"nationwide"`、数日で1巡）
  - **タイムズ（Park24）** — サーバ描画の静的HTML。**全国 約21,700件を sitemap からローリング巡回**（`mode:"nationwide"`）。⚠️ 先方が robots.txt で商用ボットを名指しブロックしているため、間隔を長め（既定6秒）にし、別ワークフロー（`crawl-times.yml`）・別出力（`prices-times.jsonl`）で実行
  - **名鉄協商（mkp.jp）** — サーバ描画の静的HTML（JSON-LD + `.box_price` テーブル）。**全国 約2,553件を sitemap からローリング巡回**（`mode:"nationwide"`）。別ワークフロー（`crawl-others.yml`）・別出力（`prices-others.jsonl`）で実行
- 取得項目: 物件名 / 住所 / 緯度経度 / 収容台数 / 営業時間 / **時間帯別単価** / **最大料金**（NPCは加えて満空 `fullEmptyStatus`）
- 出力: `data/prices.jsonl`（共通スキーマ）。全国規模に備え `appendOnlyChanges:true` で**新規・変動のみ追記**（＝変化点の時系列）
- アーキテクチャ: 事業者差は `src/<operator>.js` に分離。`run.js` が共通処理（節度ある取得・差分検知・追記）

### 全国規模の現実（重要）

| 事業者 | 全国件数 | 一括取得 | 1巡コスト |
|---|---|---|---|
| NPC | 約1,700 | ✅ bbox API 1発 | 数秒 |
| リパーク | 約16,000 | ❌ 1物件=1ページ(4秒) | **約18時間** |
| タイムズ | 約21,700 | ❌ 1物件=1ページ(6秒) | **約36時間** |

リパーク／タイムズは一括APIが無く、全件を1日数回取得するのは「節度ある収集」と両立しない。
→ **ローリング巡回**（毎回 `*RollingPerRun` 件ずつ、最終取得が古い順に取得）で
数日かけて全国を1巡する設計。巡回状態は `data/*-crawl-state.json` に保持。

### robots.txt とタイムズの扱い

- NPC / リパーク: robots.txt でクローラをブロックしておらず、汎用UAでの収集が可能。
- タイムズ: robots.txt の `User-agent: *` は料金ページを許可（PDFのみ Disallow）だが、
  GPTBot・bingbot・DataForSeoBot 等の商用ボットを**名指しで全面ブロック**している。
  自動収集を歓迎していない意図に配慮し、間隔を長め（6秒）・別ワークフローで低頻度運用する。

## 節度ある収集の5原則（実装済み）

1. **robots.txt 遵守** — 実行ごとに取得・解釈し Disallow パスは踏まない（`src/polite-fetch.js`）
2. **アクセス間隔** — 1リクエストごとに最低 4 秒スリープ・**直列**（並列ゼロ）
3. **頻度上限** — 6時間ページキャッシュで短時間の再取得を防止／定期実行は1日3回
4. **正体を明かす** — User-Agent に用途と連絡先を明記
5. **取りすぎない** — `config.targets` の登録物件・必要項目のみ

設定はすべて `config.js` に集約。

## 使い方

```bash
npm install
npm run crawl     # config.targets を順に取得し data/prices.jsonl に追記
```

対象を増やす場合は `config.js` の `targets` に `{ operator, parkId, label }` を追加。
parkId は詳細ページ URL `?park=REP00xxxxx` の値。

## 料金データの持ち方（生データ保持）

料金は**正規化せず、取得したままの生データ**で保持する（円/時への変換や最大料金の統一はしない）。
各レコードは以下を原文のまま持ち、後から自由に計算できる：

- `unitCharges[]` … `{ scope?, timeRange, perMinutes, amountYen }`（例: 20分220円、08:00-20:00 など）
- `maxFees[]` … `{ scope, condition, amountYen }`（条件は「入庫後24時間以内」「20:00～8:00以内」等の原文）

`src/normalize.js` は**任意の後計算ヘルパー**（円/時・24時間最大などへの換算）。保存には使わない。
必要になったときに読み込んで使う。

```bash
npm run export   # 最新スナップショットを data/parking-latest.csv に出力（Excel用・BOM付き）
```

CSV 列: 事業者 / 物件名 / 都道府県 / 住所 / 収容台数 / **時間帯料金(生)** / **最大料金(生)** / 営業時間 / 満空 / 緯度 / 経度 / 取得日時 / URL
（料金列は原文テキスト。計算は Excel 等で後から行う）

## ダッシュボード（可視化）

```bash
npm run dashboard   # data/*.jsonl を集計して dashboard.html を生成
```

`dashboard.html` は**自己完結（外部CDN不使用・データ埋め込み）**。ブラウザで直接開くだけで見られる。
料金は正規化せず**生データのまま表示**する。内容:

- KPI（総物件数・事業者別・累計変動数）
- 都道府県別 物件数（上位15）
- 地理分布（経度×緯度の散布図。NPC/リパークは座標あり、タイムズは座標なし）
- 最近の料金変動（収集が一巡すると差分が出る。時間帯料金・最大料金を生データで表示）
- 物件一覧（名称・都道府県で検索。時間帯料金・最大料金を取得したままのテキストで表示）

クラウド実行では本体ワークフローが毎回 `dashboard.html` を再生成してコミットするため、
リポジトリの最新版が常に最新データになる（GitHub Pages を有効にすればそのまま公開可）。

## クラウド定期実行

`.github/workflows/crawl.yml` で GitHub Actions により 1日3回（JST 9/15/21時）実行し、
料金に変動があれば `data/prices.jsonl` を自動コミットする。

## 今後（Phase 3 以降）

- Phase 3: 変動の可視化（グラフ／変動アラート通知）
- Phase 4: 自社物件の緯度経度から半径検索 → 競合比較ダッシュボード
  （NPC は `/api/parking/location.json?latitude=..&northLat=..&limit=` のバウンディングボックス検索が使える）
- タイムズ: robots.txt でボットを明確に排除しているため、スクレイピングではなく
  公式IR・料金改定リリース等の正規ルートを検討（[調査メモ参照]）

> ⚠️ タイムズは robots.txt で GPTBot/bingbot 等を Disallow、料金データも Googlebot 遮断の
> AJAX 裏にあり「自動収集を拒否」の姿勢。リパーク/NPC は比較的おおらか。本ツールは
> robots.txt 遵守を徹底するため、タイムズは対象に含めない設計。
