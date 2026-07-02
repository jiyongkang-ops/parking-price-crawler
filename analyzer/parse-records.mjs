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

// csvPath は文字列 or 配列（複数ファイルをマージ。例: 本体＋別区画）
export function parseRecords(csvPath, { capacity = null } = {}) {
  const paths = Array.isArray(csvPath) ? csvPath : [csvPath];
  let recs = [];
  let parkName = "";
  for (const p of paths) {
    const raw = decode(fs.readFileSync(p)).split(/\r?\n/).filter(Boolean);
    const header = parseCsvLine(raw[0]).map((h) => h.replace(/^﻿/, ""));
    const ix = (n) => header.indexOf(n);
    const col = { space: ix("車室名"), in: ix("入庫時間"), out: ix("出庫時間"), dur: ix("駐車時間"), fee: ix("利用料金"), paid: ix("決済金額"), status: ix("ステータス"), name: ix("駐車場名") };
    const colPlate = ["地名", "分類番号", "判別文字", "登録番号"].map((n) => ix(n));
    recs = recs.concat(raw.slice(1).map(parseCsvLine).map((a) => ({
      space: +a[col.space] || 0,
      in: parseDate(a[col.in]), out: parseDate(a[col.out]),
      durM: durMin(a[col.dur]), fee: +a[col.fee] || 0, paid: +a[col.paid] || 0,
      status: a[col.status] || "",
      plate: colPlate.map((i) => (i >= 0 ? (a[i] || "").trim() : "")).join(" ").trim(),
    })).filter((r) => r.in));
    if (!parkName && raw[1]) parkName = parseCsvLine(raw[1])[col.name] || "";
  }
  parkName = (parkName || "").replace(/\s*\d+車室$/, ""); // 「◯◯ 2車室」→「◯◯」
  let minD = null, maxD = null;
  recs.forEach((r) => { if (!minD || r.in < minD) minD = r.in; if (!maxD || r.in > maxD) maxD = r.in; });
  const days = Math.max(1, Math.round((maxD - minD) / 864e5) + 1);

  // 車室別利用（封鎖=0回を検知）
  // ※ゲート式等で車室名が「-」の場合は車室単位の記録がない → 封鎖検知は行わない
  const spaceUse = {};
  recs.forEach((r) => { if (r.space) spaceUse[r.space] = (spaceUse[r.space] || 0) + 1; });
  const usedSpaces = Object.keys(spaceUse).map(Number).sort((a, b) => a - b);
  const maxSpaceNo = usedSpaces.length ? Math.max(...usedSpaces) : 0;
  const numericShare = recs.filter((r) => r.space > 0).length / Math.max(1, recs.length);
  const spaceTracking = numericShare >= 0.9 && usedSpaces.length >= 3;
  const nominalCapacity = capacity ?? maxSpaceNo; // 指定が無ければ最大車室番号
  const blocked = [];
  if (spaceTracking) for (let n = 1; n <= nominalCapacity; n++) if (!spaceUse[n]) blocked.push(n);
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

  // 売上の時間帯構成（入庫時刻ベースの4帯）＋夜間窓(20-翌8時)オーバーラップ
  const totalPaid = recs.reduce((s, r) => s + r.paid, 0);
  const bandsDef = [["深夜(0-5時)", 0, 5], ["早朝(5-8時)", 5, 8], ["日中(8-17時)", 8, 17], ["夜間(17-24時)", 17, 24]];
  const revenueBands = bandsDef.map(([label, lo, hi]) => {
    const g = recs.filter((r) => r.in.getHours() >= lo && r.in.getHours() < hi);
    const rev = g.reduce((s, r) => s + r.paid, 0);
    return { label, revenue: rev, count: g.length, pct: totalPaid ? +(100 * rev / totalPaid).toFixed(1) : 0 };
  });
  const overlapsNight = (r) => {
    if (!r.out) return false;
    for (let t = new Date(r.in); t < r.out; t = new Date(t.getTime() + 30 * 60e3)) {
      const hr = t.getHours(); if (hr >= 20 || hr < 8) return true;
    }
    return false;
  };
  const nw = recs.filter(overlapsNight);
  const nightWindow = {
    count: nw.length, revenue: nw.reduce((s, r) => s + r.paid, 0),
    share: totalPaid ? +(100 * nw.reduce((s, r) => s + r.paid, 0) / totalPaid).toFixed(1) : 0,
  };

  // 曜日別（売上シェア・夜間20-23時ピーク稼働の平均）
  const peakByDow = {}, cntByDow = {};
  for (const [k, v] of Object.entries(nightlyPeak)) {
    const d = new Date(k).getDay(); peakByDow[d] = (peakByDow[d] || 0) + v; cntByDow[d] = (cntByDow[d] || 0) + 1;
  }
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  const dow = [1, 2, 3, 4, 5, 6, 0].map((d) => {
    const g = recs.filter((r) => r.in.getDay() === d);
    const rev = g.reduce((s, r) => s + r.paid, 0);
    return { day: WD[d], pct: totalPaid ? +(100 * rev / totalPaid).toFixed(1) : 0,
      nightPeak: cntByDow[d] ? +(peakByDow[d] / cntByDow[d]).toFixed(1) : null };
  });

  // ナンバー分析（未払いの常習・支払い履歴）
  const byPlate = new Map();
  for (const r of recs) { if (r.plate.length > 3) { if (!byPlate.has(r.plate)) byPlate.set(r.plate, []); byPlate.get(r.plate).push(r); } }
  const unpaidRecs = recs.filter((r) => /未払|未収|未決済/.test(r.status) && r.plate.length > 3);
  const unPlates = new Map();
  for (const r of unpaidRecs) { if (!unPlates.has(r.plate)) unPlates.set(r.plate, []); unPlates.get(r.plate).push(r); }
  const fmtMD = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  const repeats = [...unPlates.entries()].filter(([, v]) => v.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([k, v]) => ({ plate: k, count: v.length, amount: v.reduce((s, r) => s + r.fee, 0),
      period: `${fmtMD(new Date(Math.min(...v.map((r) => r.in))))}〜${fmtMD(new Date(Math.max(...v.map((r) => r.in))))}` }));
  let paidElsewhere = 0, neverPaid = 0, onceOnly = 0, bestExample = null;
  for (const [k, v] of unPlates) {
    const all = byPlate.get(k);
    const paidN = all.filter((r) => !/未払|未収|未決済/.test(r.status) && r.paid > 0).length;
    if (paidN > 0) {
      paidElsewhere++;
      if (!bestExample || all.length > bestExample.visits) bestExample = { plate: k, visits: all.length, paid: paidN, un: v.length };
    } else { neverPaid++; if (all.length === 1) onceOnly++; }
  }
  const repeatIncidents = repeats.reduce((s, r) => s + r.count, 0);
  const repeatAmount = repeats.reduce((s, r) => s + r.amount, 0);
  const plates = { uniqueVehicles: unPlates.size, repeats, repeatIncidents, repeatAmount,
    paidElsewhere, neverPaid, onceOnly, example: bestExample };

  // 推移分析（週次・月次）: 日次ピーク稼働を一度だけ計算して共用
  const weekly = [], monthly = [];
  {
    const start = new Date(minD.getFullYear(), minD.getMonth(), minD.getDate());
    const dailyPeak = {};
    for (let t = new Date(start); t <= maxD; t = new Date(t.getTime() + 3600e3)) {
      let occ = 0; for (const r of recs) if (r.out && r.in <= t && t < r.out) occ++;
      const k = t.toDateString(); dailyPeak[k] = Math.max(dailyPeak[k] || 0, occ);
    }
    const peakAvgIn = (from, to) => {
      let sum = 0, cnt = 0;
      for (let d = new Date(from); d < to; d = new Date(d.getTime() + 864e5)) {
        const k = d.toDateString(); if (dailyPeak[k] != null) { sum += dailyPeak[k]; cnt++; }
      }
      return cnt ? +(sum / cnt).toFixed(1) : null;
    };
    // 週次（期間開始から7日刻み）
    for (let w = 0; ; w++) {
      const from = new Date(start.getTime() + w * 7 * 864e5);
      if (from > maxD) break;
      const to = new Date(Math.min(from.getTime() + 7 * 864e5, maxD.getTime() + 864e5));
      const g = recs.filter((r) => r.in >= from && r.in < to);
      weekly.push({ label: `${from.getMonth() + 1}/${from.getDate()}週`, days: Math.max(1, Math.round((to - from) / 864e5)),
        sessions: g.length, revenue: g.reduce((s2, r) => s2 + r.paid, 0), peakAvg: peakAvgIn(from, to) });
    }
    // 月次（暦月）
    for (let m = new Date(minD.getFullYear(), minD.getMonth(), 1); m <= maxD; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
      const from = new Date(Math.max(m.getTime(), start.getTime()));
      const monthEnd = new Date(m.getFullYear(), m.getMonth() + 1, 1);
      const to = new Date(Math.min(monthEnd.getTime(), maxD.getTime() + 864e5));
      const g = recs.filter((r) => r.in >= from && r.in < to);
      const dInM = Math.max(1, Math.round((to - from) / 864e5));
      monthly.push({ label: `${String(m.getFullYear()).slice(2)}/${m.getMonth() + 1}`, days: dInM,
        fullDays: Math.round((monthEnd - m) / 864e5),
        sessions: g.length, revenue: g.reduce((s2, r) => s2 + r.paid, 0), peakAvg: peakAvgIn(from, to) });
    }
  }
  // 月間換算（複数月CSVでも「月間」の数字を正しく出す）
  const monthsSpan = +(days / 30.44).toFixed(2);
  const revenueMonthly = Math.round(collected / Math.max(1, monthsSpan));
  const unpaidMonthly = Math.round(unpaidAmt / Math.max(1, monthsSpan));

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
    unpaid: { count: unpaid.length, amount: unpaidAmt, amountMonthly: unpaidMonthly, rate: +(100 * unpaid.length / recs.length).toFixed(1) },
    capacity: { nominal: nominalCapacity, effective: effectiveCapacity, blocked, spaceTracking },
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
    revenueBands, nightWindow, dow, plates, weekly, monthly, monthsSpan, revenueMonthly,
  };
}
