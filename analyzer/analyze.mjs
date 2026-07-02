// 駐車場 料金分析 CLI ------------------------------------------------------
// 使い方: node analyzer/analyze.mjs <config.json> [--pdf]
// config: { csv, lat, lng, address, capacity, radiusM, nearestLimit, current:{unit,nightMax,dayMax,dayHour1}, out }
// 環境変数: PK_HOST/PK_CID/PK_SECRET/PK_UID (Parkopedia任意) / GOOGLE_MAPS_KEY (地図任意)
//
// データの役割分担（六本木第20で確立した型）:
//   最寄り比較(距離順・全事業者) = Parkopedia優先（不可時は自前クローラで代替）
//   夜間最大の比較              = 自前クローラ（夜間最大を明示する主要事業者）
//   周辺マップ                  = 最寄り競合の座標にマーカー

import fs from "node:fs";
import path from "node:path";
import { parseRecords } from "./parse-records.mjs";
import { crawlerCompetitors, parkopediaCompetitors, recentPriceChanges } from "./competitors.mjs";
import { renderReport } from "./report.mjs";
import { staticMapDataUri } from "./map.mjs";
import { printToPdf } from "./pdf.mjs";

const cfgPath = process.argv[2];
if (!cfgPath) { console.error("使い方: node analyzer/analyze.mjs <config.json> [--pdf]"); process.exit(1); }
const wantPdf = process.argv.includes("--pdf");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

const metrics = parseRecords(cfg.csv, { capacity: cfg.capacity ?? null });
console.log(`[分析] ${metrics.parkName} / ${metrics.sessions}件 / 実効${metrics.capacity.effective}台 / 未払い${metrics.unpaid.rate}%（常習${metrics.plates.repeats.length}台）`);

const radiusM = cfg.radiusM ?? 400;
const nearestLimit = cfg.nearestLimit ?? 12;

// 夜間最大（自前クローラ）
const nightComps = crawlerCompetitors({ lat: cfg.lat, lng: cfg.lng, radiusM: Math.max(radiusM, 500) });
console.log(`[夜間最大] 自前クローラ: ${nightComps.length}件（うち夜間最大あり ${nightComps.filter((c) => c.nightMax).length}件）`);

// 最寄り（Parkopedia優先 → 不可なら自前クローラ距離順で代替）
// 単価不明・異常値(100円/時未満)は比較対象から除外
const validFee = (c) => c.yph != null && c.yph >= 100;
let nearest = [], nearestSource = "", excluded = 0;
const pk = await parkopediaCompetitors({ lat: cfg.lat, lng: cfg.lng, radiusM });
if (pk.available && pk.items.length) {
  excluded = pk.items.length - pk.items.filter(validFee).length;
  nearest = pk.items.filter(validFee).slice(0, nearestLimit);
  nearestSource = "parkopedia";
} else {
  excluded = nightComps.length - nightComps.filter(validFee).length;
  nearest = nightComps.filter(validFee).slice(0, nearestLimit);
  nearestSource = "crawler(代替)";
}
console.log(`[最寄り] ${nearestSource}: ${nearest.length}件（単価不明/異常値 ${excluded}件を除外）${pk.error ? "（Parkopedia: " + pk.error + "）" : ""}`);

const changes = recentPriceChanges({ lat: cfg.lat, lng: cfg.lng, radiusM: radiusM + 200 });
console.log(`[変更] 周辺の最近の料金変更: ${changes.length}件`);

// 地図（最寄りの座標にマーカー）
const map = await staticMapDataUri({ target: { lat: cfg.lat, lng: cfg.lng }, competitors: nearest });
if (map.dataUri) map.legend = map.marked.map((c, i) => ({ no: i + 1, name: (c.name || c.opLabel || "").replace(/駐車場$/, "").slice(0, 16), yph: c.yph ?? null }));
console.log(`[地図] ${map.dataUri ? "生成OK（マーカー" + map.marked.length + "件）" : "スキップ（GOOGLE_MAPS_KEY未設定 or 失敗" + (map.error ? ": " + map.error : "") + "）"}`);

const html = renderReport(metrics, { nearest, nearestSource, nightComps, map, changes }, cfg.current ?? {}, { address: cfg.address });
const out = path.resolve(cfg.out ?? `reports/${(metrics.parkName || "report").replace(/[\/\\]/g, "_")}.html`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`[出力] ${out}`);

if (wantPdf) {
  const pdf = out.replace(/\.html$/, ".pdf");
  try {
    await printToPdf(out, pdf); // ページ番号つき（CDP経由）
    console.log(`[PDF] ${pdf}`);
  } catch (e) { console.error("PDF生成に失敗（Chrome未検出?）:", e.message); }
}
