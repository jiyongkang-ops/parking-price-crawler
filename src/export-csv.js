// 統一料金CSVの書き出し ---------------------------------------------------
// data/*.jsonl の最新スナップショットを、事業者横断の統一スキーマで
// data/parking-latest.csv に出力する（Excel等で横比較するため）。
//
//   node src/export-csv.js

import fs from "node:fs";
import path from "node:path";
import { normalizeFees } from "./normalize.js";

const DATA_FILES = ["data/prices.jsonl", "data/prices-times.jsonl"];
const OUT = "data/parking-latest.csv";

const OP = { npc: "NPC", repark: "三井のリパーク", times: "タイムズ" };

function loadLatest() {
  const latest = new Map();
  for (const f of DATA_FILES) {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) continue;
    for (const line of fs.readFileSync(abs, "utf8").split("\n").filter(Boolean)) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      const k = `${r.operator}:${r.parkId}`;
      const prev = latest.get(k);
      if (!prev || new Date(r.fetchedAt) >= new Date(prev.fetchedAt)) latest.set(k, r);
    }
  }
  return [...latest.values()];
}

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function main() {
  const lots = loadLatest();
  const header = [
    "事業者", "物件名", "都道府県", "住所", "収容台数",
    "円per時", "最大料金_24時間", "最大料金_夜間",
    "緯度", "経度", "取得日時", "URL",
  ];
  const rows = lots.map((r) => {
    const f = r.fee ?? normalizeFees(r);
    const pref = (r.address ?? "").match(/^(.+?[都道府県])/)?.[1] ?? "";
    return [
      OP[r.operator] ?? r.operator, r.name, pref, r.address, r.capacity,
      f.yph, f.max24h, f.maxNight,
      r.lat, r.lng, r.fetchedAt, r.sourceUrl,
    ].map(csvCell).join(",");
  });
  // Excel 用に BOM 付き UTF-8
  const csv = "﻿" + [header.join(","), ...rows].join("\n") + "\n";
  fs.writeFileSync(path.resolve(OUT), csv);
  console.log(`CSV書き出し: ${OUT} | ${lots.length}物件`);
}

main();
