# 駐車場 料金分析ツール（analyzer）

利用状況レポートCSV＋住所（緯度経度）から、**お客様提示用の料金分析レポート（HTML/PDF）**を生成する。
需要分析・競合比較・未払い・料金提言までを自動で下書きする。

## 使い方

```bash
# 1) analyzer/targets/_template.json をコピーして編集
# 2) 実行（認証は analyzer/.pk-creds.sh から自動読込・PDFも生成）
analyzer/run.sh analyzer/targets/<name>.json
```

### 設定ファイル（例）

```json
{
  "csv": "/path/to/利用状況レポート_xxx.csv",
  "address": "東京都港区六本木3-12",
  "lat": 35.66246, "lng": 139.73570,
  "capacity": 15,
  "radiusM": 500,
  "current": { "unit": "12分440円", "nightMax": 1300, "dayMax": 2800, "dayHour1": 2200 },
  "out": "reports/roppongi20.html"
}
```

- `csv`：文字列 or **配列**（本体＋別区画など複数レポートをマージ可能）。
- `capacity`：名目車室数（省略時は最大車室番号）。**利用0回の車室は「封鎖」として実効キャパを自動算出**。ゲート式等で車室名が「-」の場合は自動判定して車室別分析をスキップ。
- `current`：当駐車場の現行料金（提言・比較の基準。分かる範囲でOK）。
- `lat/lng`：地図座標（住所からの自動変換は未対応。Google Map等で取得して指定）。

## 競合料金の取得元

1. **自前クローラの蓄積データ**（`data/prices*.jsonl`）を緯度経度で半径検索（昼夜最大つき・無料）。
2. **Parkopedia API**（環境変数がある場合のみ・クロール対象外の事業者も補完）。
3. **周辺の最近の料金変更**を時系列（`changedFromPrev`）から抽出（収集が蓄積するほど充実）。

### Parkopedia 認証情報（環境変数・コミット禁止）

```bash
export PK_HOST=api.parkopedia.com
export PK_CID=xxxxx
export PK_SECRET=xxxxx
export PK_UID=xxxxx      # アカウントで必須の場合
npm run analyze -- analyzer/targets/xxx.json --pdf
```

秘密情報はコードにも設定ファイルにも書かない。`analyzer/.pk-creds.sh`（gitignore対象）に `export ...` を書いて `source` する運用を推奨。

## 出力

- `reports/<name>.html` … 自己完結HTML（外部CDN不使用）
- `reports/<name>.pdf` … `--pdf` 指定時（Chromeヘッドレスで生成）

## 注意

- 提言・増収試算は**ルールベースの下書き**。競合レンジ（半径）や現行料金の入力で数値が動くため、最終提示前に内容を確認・調整すること。
- 車室封鎖の理由（物理/運用）など、データから判断できない前提は人が補うこと。
