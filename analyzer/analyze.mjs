// 駐車場 料金分析 CLI ------------------------------------------------------
// 使い方: node analyzer/analyze.mjs <config.json> [--pdf]
// config: { csv, lat, lng, address, capacity, radiusM, current:{unit,nightMax,dayMax,dayHour1}, out }
// Parkopedia を使う場合は環境変数 PK_HOST/PK_CID/PK_SECRET/PK_UID を設定。

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseRecords } from "./parse-records.mjs";
import { crawlerCompetitors, parkopediaCompetitors, recentPriceChanges } from "./competitors.mjs";
import { renderReport } from "./report.mjs";

const cfgPath = process.argv[2];
if (!cfgPath) { console.error("使い方: node analyzer/analyze.mjs <config.json> [--pdf]"); process.exit(1); }
const wantPdf = process.argv.includes("--pdf");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

const metrics = parseRecords(cfg.csv, { capacity: cfg.capacity ?? null });
console.log(`[分析] ${metrics.parkName} / ${metrics.sessions}件 / 実効${metrics.capacity.effective}台 / 未払い${metrics.unpaid.rate}%`);

const radiusM = cfg.radiusM ?? 400;
const comps = crawlerCompetitors({ lat: cfg.lat, lng: cfg.lng, radiusM });
console.log(`[競合] 自前クローラ 半径${radiusM}m: ${comps.length}件`);
const pk = await parkopediaCompetitors({ lat: cfg.lat, lng: cfg.lng, radiusM });
console.log(`[競合] Parkopedia: ${pk.available ? pk.count + "件" : "未使用/失敗"}`);
const changes = recentPriceChanges({ lat: cfg.lat, lng: cfg.lng, radiusM: radiusM + 200 });
console.log(`[変更] 周辺の最近の料金変更: ${changes.length}件`);

const html = renderReport(metrics, comps, cfg.current ?? {}, { address: cfg.address, genAt: new Date().toISOString(), changes });
const out = path.resolve(cfg.out ?? `reports/${(metrics.parkName || "report").replace(/[\/\\]/g, "_")}.html`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`[出力] ${out}`);

if (wantPdf) {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const pdf = out.replace(/\.html$/, ".pdf");
  try {
    execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer",
      "--virtual-time-budget=4000", `--print-to-pdf=${pdf}`, `file://${out}`], { stdio: "ignore" });
    console.log(`[PDF] ${pdf}`);
  } catch (e) { console.error("PDF生成に失敗（Chrome未検出?）:", e.message); }
}
