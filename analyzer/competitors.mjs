// 周辺競合の料金取得 -------------------------------------------------------
// (1) 自前クローラの蓄積データ(data/prices*.jsonl)を緯度経度で半径検索（無料・詳細な昼夜最大あり）
// (2) Parkopedia API（環境変数に認証情報がある場合のみ・クロール対象外の事業者も補完）
// (3) 周辺の「最近の料金変更」を時系列(changedFromPrev)から抽出
// 認証情報は環境変数から：PK_HOST, PK_CID, PK_SECRET, PK_UID

import fs from "node:fs";
import path from "node:path";
import { normalizeFees } from "../src/normalize.js";

const OP_LABEL = { npc: "NPC", repark: "三井のリパーク", times: "タイムズ", mkp: "名鉄協商", navipark: "ナビパーク", ecolo: "エコロパーク", thepark: "ザ・パーク" };

function haversine(aLat, aLng, bLat, bLng) {
  const R = 6371000, toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(bLat - aLat), dLng = toR(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)));
}

// data/prices*.jsonl の最新スナップショットを読む
function loadLatest(dataDir) {
  const latest = new Map();
  for (const f of fs.readdirSync(dataDir).filter((f) => /^prices.*\.jsonl$/.test(f))) {
    for (const line of fs.readFileSync(path.join(dataDir, f), "utf8").split("\n").filter(Boolean)) {
      try {
        const r = JSON.parse(line);
        const k = `${r.operator}:${r.parkId}`;
        const p = latest.get(k);
        if (!p || new Date(r.fetchedAt) >= new Date(p.fetchedAt)) latest.set(k, r);
      } catch { /* skip */ }
    }
  }
  return [...latest.values()];
}

// 自前クローラから半径内競合を返す（昼夜最大つき）
export function crawlerCompetitors({ lat, lng, radiusM = 400, dataDir = "data" }) {
  return loadLatest(dataDir)
    .filter((r) => r.lat && r.lng)
    .map((r) => ({ ...r, dist: haversine(lat, lng, r.lat, r.lng) }))
    .filter((r) => r.dist <= radiusM)
    .map((r) => {
      const fee = normalizeFees(r);
      const night = fee.max.find((m) => m.type === "night")?.amountYen ?? null;
      const day = fee.max.find((m) => m.type === "daytime")?.amountYen
        ?? fee.max.find((m) => m.type === "d24h")?.amountYen ?? null;
      const u0 = (r.unitCharges ?? [])[0];
      return {
        source: "crawler", operator: r.operator, opLabel: OP_LABEL[r.operator] ?? r.operator,
        name: r.name, address: r.address, dist: r.dist, lat: r.lat, lng: r.lng,
        unit: u0 ? `${u0.perMinutes}分${u0.amountYen}円` : null,
        yph: fee.yph, nightMax: night, dayMax: day,
      };
    })
    .sort((a, b) => a.dist - b.dist);
}

// 周辺の最近の料金変更（時系列 changedFromPrev）
export function recentPriceChanges({ lat, lng, radiusM = 500, dataDir = "data", limit = 20 }) {
  const changes = [];
  for (const f of fs.readdirSync(dataDir).filter((f) => /^prices.*\.jsonl$/.test(f))) {
    for (const line of fs.readFileSync(path.join(dataDir, f), "utf8").split("\n").filter(Boolean)) {
      try {
        const r = JSON.parse(line);
        if (!r.changedFromPrev || !r.lat || !r.lng) continue;
        const dist = haversine(lat, lng, r.lat, r.lng);
        if (dist <= radiusM) changes.push({ operator: r.operator, opLabel: OP_LABEL[r.operator] ?? r.operator, name: r.name, dist, at: r.fetchedAt, fee: normalizeFees(r) });
      } catch { /* skip */ }
    }
  }
  return changes.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);
}

// Parkopedia（環境変数に認証がある場合のみ）。近接の事業者名・単価を補完。
export async function parkopediaCompetitors({ lat, lng, radiusM = 400 }) {
  const { PK_HOST, PK_CID, PK_SECRET, PK_UID, PK_APIVER = "52" } = process.env;
  if (!PK_HOST || !PK_CID || !PK_SECRET) return { available: false, items: [] };
  try {
    const tok = await (await fetch(`https://${PK_HOST}/api/tokens?apiver=${PK_APIVER}&cid=${PK_CID}${PK_UID ? `&uid=${PK_UID}` : ""}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: PK_CID, client_secret: PK_SECRET }),
    })).json();
    const at = tok.result?.access_token ?? tok.access_token;
    if (!at) return { available: false, items: [], error: "token" };
    const q = new URLSearchParams({ apiver: PK_APIVER, cid: PK_CID, lat, lng, radius: String(radiusM), pk_type: "OFF_STREET" });
    if (PK_UID) q.set("uid", PK_UID);
    const r = await (await fetch(`https://${PK_HOST}/api/parking/locations?${q}`, { headers: { Authorization: `Bearer ${at}` } })).json();
    const feats = r.result?.features ?? [];
    // PT12M / PT1H → 分
    const ptMin = (v) => { const m = String(v || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?/); return m ? (+(m[1] || 0)) * 60 + (+(m[2] || 0)) : null; };
    // geometry(GeometryCollection or Point) から座標
    const coordOf = (g) => {
      if (!g) return null;
      if (g.type === "Point") return g.coordinates;
      if (g.type === "GeometryCollection") { const p = (g.geometries || []).find((x) => x.type === "Point"); return p?.coordinates ?? null; }
      return null;
    };
    const items = feats.map((f) => {
      const s = f.properties?.static ?? {};
      const unit = (s.rate_tables?.rate_table?.[0]?.rates ?? []).find((x) => x.type === "DURATION");
      const mins = unit ? ptMin(unit.value) : null;
      const c = coordOf(f.geometry);
      return {
        source: "parkopedia", operator: s.operator ?? "", opLabel: s.operator ?? "（その他）",
        name: (s.name || s.address?.street?.formatted || s.operator || "").trim(),
        address: s.address?.street?.formatted ?? "",
        dist: s.distance ?? null, capacity: s.capacity ?? null,
        lat: c ? c[1] : null, lng: c ? c[0] : null,
        unit: unit && mins ? `${mins}分${unit.price}円` : null,
        yph: unit && mins ? Math.round(unit.price * 60 / mins) : null,
      };
    }).sort((a, b) => (a.dist ?? 9e9) - (b.dist ?? 9e9));
    return { available: true, count: feats.length, items };
  } catch (e) {
    return { available: false, items: [], error: e.message };
  }
}
