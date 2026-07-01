// 利用状況レポートCSV → 分析指標 -------------------------------------------
// エコロパーク等の「利用状況レポート」CSV（Shift-JIS）を読み、
// 時間帯別稼働・入庫、車室別稼働（封鎖検知）、料金階層、未払い、日中実効料金を算出。
// 依存なし（Node標準の TextDecoder で SJIS を復号）。

import fs from "node:fs";

function decode(buf) {
  // BOM/UTF-8 か Shift-JIS かを簡易判定して復号
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (utf8.includes("利用明細") || utf8.includes("入庫時間")) return utf8;
  return new TextDecoder("shift_jis").decode(buf);
}

function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur); return out;
}

const parseDate = (s) => {
  const m = s && s.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
};
const durMin = (s) => { const m = s && s.match(/(\d+):(\d+)/); return m ? +m[1] * 60 + +m[2] : 0; };

export function parseRecords(csvPath, { capacity = null } = {}) {
  const raw = decode(fs.readFileSync(csvPath)).split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(raw[0]).map((h) => h.replace(/^﻿/, ""));
  const ix = (n) => header.indexOf(n);
  const col = { space: ix("車室名"), in: ix("入庫時間"), out: ix("出庫時間"), dur: ix("駐車時間"), fee: ix("利用料金"), paid: ix("決済金額"), status: ix("ステータス"), name: ix("駐車場名") };

  const recs = raw.slice(1).map(parseCsvLine).map((a) => ({
    space: +a[col.space] || 0,
    in: parseDate(a[col.in]), out: parseDate(a[col.out]),
    durM: durMin(a[col.dur]), fee: +a[col.fee] || 0, paid: +a[col.paid] || 0,
    status: a[col.status] || "",
  })).filter((r) => r.in);

  const parkName = raw[1] ? parseCsvLine(raw[1])[col.name] : "";
  let minD = null, maxD = null;
  recs.forEach((r) => { if (!minD || r.in < minD) minD = r.in; if (!maxD || r.in > maxD) maxD = r.in; });
  const days = Math.max(1, Math.round((maxD - minD) / 864e5) + 1);

  // 車室別利用（封鎖=0回を検知）
  const spaceUse = {};
  recs.forEach((r) => { if (r.space) spaceUse[r.space] = (spaceUse[r.space] || 0) + 1; });
  const usedSpaces = Object.keys(spaceUse).map(Number).sort((a, b) => a - b);
  const maxSpaceNo = usedSpaces.length ? Math.max(...usedSpaces) : 0;
  const nominalCapacity = capacity ?? maxSpaceNo; // 指定が無ければ最大車室番号
  const blocked = [];
  for (let n = 1; n <= nominalCapacity; n++) if (!spaceUse[n]) blocked.push(n);
  const effectiveCapacity = nominalCapacity - blocked.length;

  const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
  const hourlyEntries = (filt) => {
    const h = Array(24).fill(0), dset = new Set();
    recs.forEach((r) => { if (filt(r.in)) { h[r.in.getHours()]++; dset.add(r.in.toDateString()); } });
    const nd = Math.max(1, dset.size);
    return h.map((v) => +(v / nd).toFixed(2));
  };
  const hourlyOcc = (filt) => {
    const sum = Array(24).fill(0), cnt = Array(24).fill(0);
    for (let t = new Date(minD.getFullYear(), minD.getMonth(), minD.getDate()); t <= maxD; t = new Date(t.getTime() + 3600e3)) {
      if (!filt(t)) continue;
      const hr = t.getHours(); let occ = 0;
      for (const r of recs) if (r.out && r.in <= t && t < r.out) occ++;
      sum[hr] += occ; cnt[hr]++;
    }
    return sum.map((s, i) => (cnt[i] ? +(s / cnt[i]).toFixed(2) : 0));
  };

  // 夜間ピーク（20-23時）の各夜の最大同時稼働
  const nightlyPeak = {};
  for (let t = new Date(minD.getFullYear(), minD.getMonth(), minD.getDate()); t <= maxD; t = new Date(t.getTime() + 3600e3)) {
    const hr = t.getHours(); if (hr < 20 || hr > 23) continue;
    let occ = 0; for (const r of recs) if (r.out && r.in <= t && t < r.out) occ++;
    const day = t.toDateString(); nightlyPeak[day] = Math.max(nightlyPeak[day] || 0, occ);
  }
  const peaks = Object.values(nightlyPeak).sort((a, b) => a - b);
  const peakMax = peaks.length ? Math.max(...peaks) : 0;
  const fullNights = peaks.filter((p) => p >= effectiveCapacity).length;

  // 料金階層
  const feeCount = {}; recs.forEach((r) => { feeCount[r.fee] = (feeCount[r.fee] || 0) + 1; });
  const maxTierCount = recs.filter((r) => r.fee > 0 && r.durM >= 120).length; // 目安：最大到達層
  // 未払い
  const unpaid = recs.filter((r) => /未払|未収|未決済/.test(r.status));
  const unpaidAmt = unpaid.reduce((s, r) => s + r.fee, 0);
  const collected = recs.reduce((s, r) => s + r.paid, 0);

  // 日中実効料金（入庫8-16時・同日20時前出庫）
  const dayS = recs.filter((r) => r.out && r.in.getHours() >= 8 && r.in.getHours() <= 16 && r.out.getHours() < 20 && r.out.getDate() === r.in.getDate() && r.fee > 0);
  const dayCurve = [[0, 60, "〜1h"], [60, 120, "1-2h"], [120, 180, "2-3h"], [180, 999, "3h+"]].map(([lo, hi, lbl]) => {
    const g = dayS.filter((r) => r.durM >= lo && r.durM < hi);
    return { label: lbl, count: g.length, avgFee: g.length ? Math.round(g.reduce((s, r) => s + r.fee, 0) / g.length) : null };
  });

  return {
    parkName, period: { from: minD, to: maxD, days },
    sessions: recs.length,
    revenue: collected,
    avgDurationMin: Math.round(recs.filter((r) => r.durM).reduce((s, r) => s + r.durM, 0) / Math.max(1, recs.filter((r) => r.durM).length)),
    unpaid: { count: unpaid.length, amount: unpaidAmt, rate: +(100 * unpaid.length / recs.length).toFixed(1) },
    capacity: { nominal: nominalCapacity, effective: effectiveCapacity, blocked },
    peak: { max: peakMax, fullNights, nights: peaks.length },
    spaceUse,
    hourly: {
      occWeekday: hourlyOcc((d) => !isWeekend(d)),
      occWeekend: hourlyOcc((d) => isWeekend(d)),
      entWeekday: hourlyEntries((d) => !isWeekend(d)),
    },
    feeTiers: Object.entries(feeCount).map(([f, c]) => ({ fee: +f, count: c })).sort((a, b) => a.fee - b.fee),
    maxTierCount,
    dayCurve,
  };
}
