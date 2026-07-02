// レポート生成（六本木第20で磨き込んだ標準テンプレ）------------------------
// metrics(parse-records) + 最寄り競合(Parkopedia優先) + 夜間最大(自前クローラ)
// + 現行料金 → お客様提示用HTML。外部CDN不使用・データ埋め込み。
//
// 文言・構成ルール（お客様フィードバック反映済み）:
//  - 「セッション」→「回駐車」/ 見出しに(コンサル提言)等の括弧書きは付けない
//  - KPI・タイトルは改行させない（nowrap / h1+サブ行）/ 出典・注記は最小限
//  - 未払いは車室別ではなくナンバー分析（常習・支払い履歴）
//  - 曜日レバー（空く曜日は据え置き）を提言に反映

const yen = (n) => (n == null ? "—" : "¥" + Number(n).toLocaleString("ja-JP"));
const median = (a) => { a = a.filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };

export function buildRecommendations(metrics, nightComps, nearest, current) {
  const mRev = metrics.revenueMonthly ?? metrics.revenue;
  const uAmt = metrics.unpaid.amountMonthly ?? metrics.unpaid.amount;
  const nightMed = median(nightComps.map((c) => c.nightMax));
  const dayMedComp = median(nightComps.map((c) => c.dayMax));
  const nearestYphMed = median(nearest.filter((c) => !c.self).map((c) => c.yph));
  const recs = [];
  const peakFullRate = metrics.peak.fullNights / Math.max(1, metrics.peak.nights);
  const peakFull = peakFullRate >= 0.5;

  // 曜日レバー: 夜ピークが実効の85%未満の曜日
  const slackDays = (metrics.dow ?? []).filter((d) => d.nightPeak != null && d.nightPeak < metrics.capacity.effective * 0.85).map((d) => d.day);

  // ① 夜間値上げ
  if (current.nightMax && peakFull) {
    const target = nightMed && nightMed > current.nightMax ? Math.round(nightMed / 100) * 100 : Math.round(current.nightMax * 1.2 / 100) * 100;
    const up = Math.round((100 * (target - current.nightMax)) / current.nightMax);
    let d = `夜間は実効満車（キャパ上限）。供給を増やせない以上、価格が唯一のレバー。売上の主軸である最大料金階層を段階的に引き上げる。`;
    if (nightMed && current.nightMax < nightMed) d = `夜間は実効満車かつ周辺で最安クラス（周辺中央値 約${yen(nightMed)}）。${d}`;
    if (slackDays.length && slackDays.length < 7) d += `<b>曜日別では${slackDays.join("・")}曜夜のみ空きがある</b>ため、値上げは他曜日に適用し${slackDays.join("・")}曜夜は据え置きが安全。`;
    const upRate = (target - current.nightMax) / current.nightMax;
    recs.push({ kind: "g", t: "夜間の時間帯最大を引き上げる", d,
      move: { old: `夜間最大 ${yen(current.nightMax)}`, new: yen(target), pill: `+${up}%` }, target,
      effect: { lo: Math.round(mRev * 0.7 * upRate * 0.7), hi: Math.round(mRev * 0.7 * upRate) },
      effectNote: "最大料金階層への反映（稼働減を織込み）" });
  }
  // ② 日中値下げ
  const dayAvg = metrics.dayCurve.find((x) => x.label === "2-3h")?.avgFee ?? metrics.dayCurve.at(-1)?.avgFee;
  const selfYph = current.dayHour1 ?? null;
  if ((selfYph && nearestYphMed && selfYph > nearestYphMed) || (dayAvg && dayMedComp && dayAvg > dayMedComp)) {
    let d = "日中は割高で稼働が低い。短時間単価と日中最大を周辺並みに下げ、流出している日中需要を取り込む。";
    if (selfYph && nearestYphMed) d = `当駐車場の${yen(selfYph)}/時は近隣最高水準（周辺中央値 約${yen(nearestYphMed)}/時）。` + d;
    recs.push({ kind: "a", t: "日中を値下げして空き時間を埋める", d,
      move: dayMedComp ? { old: `日中 約${yen(dayAvg)}`, new: `約${yen(dayMedComp)}` } : null,
      effect: null, effectNote: "稼働改善は検証型のため試算外（上振れ要因）" });
  }
  // 価格レバーが発火しない場合は「料金設定は健全（現状維持）」を明示
  if (!recs.length) {
    const parts = [];
    if (peakFullRate === 0) parts.push("満車となる時間帯が無く、値上げは稼働低下リスクが上回る");
    if (selfYph && nearestYphMed && selfYph <= nearestYphMed) parts.push(`単価${yen(selfYph)}/時は周辺中央値（約${yen(nearestYphMed)}/時）を下回る水準で、割高感による流出懸念もない`);
    if (nightMed && current.nightMax && current.nightMax <= nightMed) parts.push("夜間最大も周辺最安圏");
    recs.push({ kind: "g", t: "料金設定は健全（現状維持を推奨）",
      d: `現行料金は需要と釣り合っている。${parts.join("。")}。値上げ・値下げとも積極的な変更は推奨しない。日中ピークの稼働が恒常的に9割を超えるようになった時点で、日中最大の引き上げを検討する。`,
      effect: null, effectNote: "現状維持（試算対象外）" });
  }

  // ③ 未払い是正（ナンバーベース）
  const P = metrics.plates;
  if (metrics.unpaid.count > 0) {
    let d = `未払い${metrics.unpaid.rate}%・月約${yen(uAmt)}は増収余地。`;
    if (P?.repeats?.length) d += `<b>常習${P.repeats.length}台で金額の${Math.round(100 * P.repeatAmount / Math.max(1, metrics.unpaid.amount))}%</b>＝ナンバー特定済みで督促・警告の最優先対象。`;
    if (P?.paidElsewhere) d += `<b>支払い実績のある${P.paidElsewhere}台</b>は回収余地あり。`;
    d += "加えて深夜〜早朝出庫の取りはぐれ対策。";
    recs.push({ kind: "a", t: "未払い（未回収）の是正", d,
      move: { new: `未回収 月約${yen(uAmt)} の圧縮` },
      steps: [
        "駐車場全体に「カメラによる未払い監視中」の掲示を増設（全体への抑止）",
        "未払いの多い車両のナンバー（下4桁）を場内に警告表示",
        "常習車両をブラックリストに登録し、入庫したタイミングでフロントガラスに警告書面を掲出",
        "運輸局へ登録事項等証明書を請求して所有者を特定し、直接支払いを依頼",
      ],
      effect: { lo: Math.round(uAmt * 0.5), hi: uAmt },
      effectNote: "回収率50〜100%想定" });
  }

  // 増収試算（施策別の期待効果と合計）
  let rows = recs.map((r) => ({ t: r.t, lo: r.effect?.lo ?? null, hi: r.effect?.hi ?? null, note: r.effectNote ?? "" }));
  let totalLo = rows.reduce((s, r) => s + (r.lo ?? 0), 0);
  let totalHi = rows.reduce((s, r) => s + (r.hi ?? 0), 0);
  // 増収余地が売上比5%未満なら、増収提案はしない（現状維持のみ）
  let outRecs = recs;
  const suppressed = !!mRev && totalHi / mRev < 0.05;
  if (suppressed) {
    outRecs = recs.filter((r) => r.t.startsWith("料金設定は健全"));
    if (!outRecs.length) outRecs = [{ kind: "g", t: "料金設定は健全（現状維持を推奨）",
      d: "想定される増収余地が売上比5%未満と小さいため、積極的な料金変更・追加施策は提案しない。現行運用の継続を推奨する。",
      effect: null, effectNote: "現状維持" }];
    rows = []; totalLo = 0; totalHi = 0;
  }
  const impact = { rows, lo: totalLo, hi: totalHi, suppressed,
    pct: mRev ? [Math.round(100 * totalLo / mRev), Math.round(100 * totalHi / mRev)] : [0, 0] };
  const r1 = outRecs.find((r) => r.target);
  return { recs: outRecs, impact, nightMed, nightTarget: r1?.target ?? null };
}

// metrics: parseRecords の結果 / data: { nearest[], nearestSource, nightComps[], map, changes }
export function renderReport(metrics, data, current = {}, opts = {}) {
  const nearest = data.nearest ?? [];
  const nightComps = data.nightComps ?? [];
  const { recs, impact, nightTarget } = buildRecommendations(metrics, nightComps, nearest, current);
  const fmtDate = (d) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;

  const nightRows = nightComps.filter((c) => c.nightMax)
    .map((c) => ({ n: (c.name || c.opLabel).replace(/駐車場$/, "").slice(0, 24), v: c.nightMax, self: false }));
  if (current.nightMax) nightRows.push({ n: `当駐車場（${metrics.parkName}）`, v: current.nightMax, self: true });

  const payload = {
    park: metrics.parkName, address: opts.address ?? "",
    period: `${fmtDate(metrics.period.from)}–${fmtDate(metrics.period.to)}`,
    sessions: metrics.sessions, revenue: metrics.revenue, avgDur: metrics.avgDurationMin,
    cap: metrics.capacity, peak: metrics.peak, unpaid: metrics.unpaid,
    current, impact, nightTarget,
    occ: metrics.hourly.occWeekday, ent: metrics.hourly.entWeekday,
    spaceUse: metrics.spaceUse, maxTierCount: metrics.maxTierCount,
    revBands: metrics.revenueBands, nightWindow: metrics.nightWindow, dow: metrics.dow, weekly: metrics.weekly, monthly: metrics.monthly, monthsSpan: metrics.monthsSpan, revenueMonthly: metrics.revenueMonthly,
    plates: metrics.plates,
    nearest: nearest.map((c) => ({ name: c.name, op: c.opLabel, dist: c.dist, unit: c.unit, yph: c.yph })),
    nearestSource: data.nearestSource ?? "",
    nightRows, recs,
    map: data.map?.dataUri ? { dataUri: data.map.dataUri, legend: data.map.legend ?? [] } : null,
  };
  return TEMPLATE.replace("/*__PAYLOAD__*/", JSON.stringify(payload).replace(/</g, "\\u003c"));
}

const TEMPLATE = `<title>駐車場 料金診断</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root{--bg:#F5F7F6;--card:#FFF;--ink:#1B1E1C;--grey:#63685F;--faint:#9AA096;--line:rgba(0,0,0,.10);--line-soft:rgba(0,0,0,.05);--brand:#009B3E;--brand-dark:#00622A;--brand-light:#E5F5EC;--amber:#D98200;--amber-bg:#FBF1E1;--red:#D0433A;--font:"Hiragino Kaku Gothic ProN","Hiragino Sans","Yu Gothic Medium","Noto Sans JP","Meiryo",system-ui,sans-serif;}
  *{box-sizing:border-box;} body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font);font-size:15px;line-height:1.65;-webkit-font-smoothing:antialiased;}
  .tnum{font-variant-numeric:tabular-nums;} .wrap{max-width:940px;margin:0 auto;padding:0 20px 56px;}
  header{color:#fff;padding:32px 0 28px;margin-bottom:24px;background:linear-gradient(135deg,#00622A,#009B3E);}
  header .wrap{padding-bottom:0;} header h1{font-size:25px;font-weight:800;margin:0;letter-spacing:-.01em;line-height:1.25;}
  .logo{margin-bottom:16px;} .logo svg{height:18px;width:auto;display:block;} .logo path,.logo polygon{fill:#fff;} .logo .lg2{fill:rgba(255,255,255,.82);}
  .ic{width:14px;height:14px;flex:0 0 14px;stroke:#fff;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}
  .em svg{width:20px;height:20px;stroke:var(--brand-dark);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;} header .meta{font-size:13px;opacity:.92;display:flex;gap:18px;flex-wrap:wrap;margin-top:12px;} header .meta b{font-weight:700;} header .meta>span{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;}
  .section{margin-top:20px;} .sec-h{display:flex;align-items:baseline;gap:12px;margin:0 0 4px;} .sec-h .no{color:var(--brand);font-weight:800;font-size:14px;} .sec-h h2{font-size:19px;font-weight:800;margin:0;}
  .sec-sub{color:var(--grey);font-size:13.5px;margin:2px 0 16px;padding-left:26px;}
  .card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:15px 18px;box-shadow:0 1px 2px rgba(0,0,0,.03);}
  .grid{display:grid;gap:12px;} .k4{grid-template-columns:repeat(4,1fr);} .k2{grid-template-columns:1fr 1fr;}
  @media(max-width:720px){.k4{grid-template-columns:1fr 1fr;}.k2{grid-template-columns:1fr;}}
  .kpi-wrap{display:grid;grid-template-columns:3fr 2fr;gap:16px;margin-bottom:16px;}
  @media(max-width:880px){.kpi-wrap{grid-template-columns:1fr;}}
  .kpi-glabel{font-size:12.5px;font-weight:800;letter-spacing:.05em;color:var(--grey);margin-bottom:8px;}
  .kpi-glabel.est{color:var(--brand-dark);}
  .k3{grid-template-columns:repeat(3,1fr);} .k2e{grid-template-columns:repeat(2,1fr);}
  .kpi.est{background:var(--brand-light);border-color:#B7E3C7;}
  .concl{background:var(--brand-light);border-left:3px solid var(--brand);border-radius:6px;padding:8px 12px;font-size:13px;margin:4px 0 10px;color:var(--ink);}
  .concl b{color:var(--brand-dark);}
  .kpi{display:flex;flex-direction:column;} .kpi .lbl{font-size:11.5px;color:var(--grey);font-weight:700;white-space:nowrap;} .kpi .val{font-size:24px;font-weight:800;margin-top:5px;white-space:nowrap;letter-spacing:-.01em;} .kpi .val small{font-size:13px;color:var(--grey);font-weight:700;} .kpi .sub{font-size:11.5px;color:var(--faint);margin-top:auto;padding-top:6px;} .kpi.accent{border-left:3px solid var(--brand);}
  .chart-t{font-weight:700;font-size:14px;margin:0 0 3px;} .chart-c{color:var(--grey);font-size:12px;margin:0 0 10px;}
  .legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--grey);margin-top:10px;} .legend span{display:inline-flex;align-items:center;gap:6px;} .dot{width:11px;height:11px;border-radius:3px;display:inline-block;}
  table{border-collapse:collapse;width:100%;font-size:13px;} th,td{padding:9px 11px;border-bottom:1px solid var(--line-soft);text-align:left;} th{font-size:11.5px;color:var(--grey);font-weight:700;background:#F0F2F0;} td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;} tr.hot td{background:var(--amber-bg);}
  .tag{font-size:11px;font-weight:700;padding:2px 8px;border-radius:5px;background:#EEF1EE;color:#3d7a1f;white-space:nowrap;}
  .rec{display:flex;gap:16px;align-items:flex-start;padding:16px 0;border-bottom:1px solid var(--line-soft);} .rec:last-child{border-bottom:none;} .rec .n{flex:0 0 30px;height:30px;border-radius:6px;color:#fff;display:grid;place-items:center;font-weight:800;} .rec .n.g{background:var(--brand);} .rec .n.a{background:var(--amber);} .rec .t{font-weight:700;font-size:15px;} .rec .d{color:var(--grey);font-size:13px;margin-top:3px;}
  .move{margin-top:6px;font-weight:800;font-variant-numeric:tabular-nums;} .move .old{color:var(--faint);text-decoration:line-through;} .move .new{color:var(--brand-dark);} .move .pill{background:var(--brand-light);color:var(--brand-dark);border-radius:4px;padding:1px 8px;font-size:12px;margin-left:6px;}
  .callout{background:var(--brand-light);border:1px solid #B7E3C7;border-radius:8px;padding:18px 20px;margin-top:16px;} .callout .big{font-size:26px;font-weight:800;color:var(--brand-dark);}
  .flag{background:var(--brand-light);border:1px solid #B7E3C7;border-radius:8px;padding:16px 20px;margin-bottom:16px;display:flex;gap:14px;} .flag .em{font-size:22px;} .flag .t{font-weight:800;font-size:15px;color:var(--brand-dark);} .flag .d{font-size:13px;color:var(--brand-dark);margin-top:2px;}
  .unpaid-card{border-left:3px solid var(--amber);} .unpaid-card .chart-t{color:#9A5B00;}
  .hbar{display:flex;align-items:center;gap:8px;margin:3px 0;font-size:12px;} .hbar .l{width:92px;color:var(--grey);} .hbar .track{flex:1;background:#EEF1EE;border-radius:4px;} .hbar .fill{height:14px;border-radius:4px;} .hbar .v{width:150px;text-align:right;font-variant-numeric:tabular-nums;}
  svg{display:block;width:100%;height:auto;overflow:visible;}
  @media print{*{-webkit-print-color-adjust:exact;print-color-adjust:exact;}body{background:#fff;}.card,.kpi,.callout,.flag,.rec{break-inside:avoid;}.section{break-inside:avoid-page;}}
</style>
<header><div class="wrap"><div class="logo"><svg viewBox="0 0 463.09 58.97" xmlns="http://www.w3.org/2000/svg" aria-label="AIMO Parking"><path d="M119.47,47.76l-2.12-5.66h-14.04l-2.24,5.66h-11.74l16.61-38.05h8.66l16.61,38.05h-11.74ZM110.55,24.14l-4.1,10.15h7.95l-3.85-10.15Z"/><path d="M138.52,47.76V9.71h11.22v38.05h-11.22Z"/><path d="M192.08,47.76v-18.22l-6.48,9.41h-7.18l-6.48-9.41v18.22h-11.22V9.71h11.03l10.26,16.78,10.26-16.78h11.03v38.05h-11.22Z"/><path d="M243.23,43.81c-3.33,2.78-7.18,4.28-12.76,4.28s-9.43-1.5-12.76-4.28c-4.81-4.01-4.62-9.35-4.62-15.07s-.19-11.06,4.62-15.07c3.33-2.78,7.18-4.28,12.76-4.28s9.43,1.5,12.76,4.28c4.81,4.01,4.62,9.35,4.62,15.07s.19,11.06-4.62,15.07ZM234.96,19.38c-.83-.91-2.44-1.66-4.49-1.66s-3.66.75-4.49,1.66c-1.03,1.12-1.67,2.41-1.67,9.35s.64,8.18,1.67,9.3c.83.91,2.44,1.71,4.49,1.71s3.66-.8,4.49-1.71c1.03-1.12,1.67-2.35,1.67-9.3s-.64-8.23-1.67-9.35Z"/><polygon points="80.79 57.47 0 57.47 0 0 80.37 0 80.37 9.71 9.71 9.71 9.71 47.76 80.79 47.76 80.79 57.47"/><path d="M57.44,28.52c0,8.07-6.55,14.62-14.62,14.62s-14.62-6.55-14.62-14.62,6.55-14.62,14.62-14.62,14.62,6.55,14.62,14.62ZM41.92,25.94v-5.42c0-.67-.55-1.23-1.23-1.23h-5.42c-.67,0-1.23.55-1.23,1.23v5.42c0,.67.55,1.23,1.23,1.23h5.42c.67,0,1.23-.55,1.23-1.23Z"/><path class="lg2" d="M272.61,48.08c-.34,0-.57-.23-.57-.57V10.08c0-.34.23-.57.57-.57h15.42c9.41,0,14.29,5.33,14.29,12.82s-4.93,12.87-14.29,12.87h-5.67c-.23,0-.34.11-.34.34v11.97c0,.34-.23.57-.57.57h-8.85ZM292.35,22.33c0-2.66-1.76-4.37-4.87-4.37h-5.1c-.23,0-.34.11-.34.34v8.11c0,.23.11.34.34.34h5.1c3.12,0,4.87-1.76,4.87-4.42Z"/><path class="lg2" d="M321.44,48.08c-.34,0-.57-.23-.57-.57v-1.59h-.06c-1.47,1.7-3.8,2.84-7.43,2.84-4.71,0-8.96-2.55-8.96-8.51s4.87-9.07,11.74-9.07h4.37c.23,0,.34-.11.34-.34v-.74c0-2.04-1.08-2.89-5.33-2.89-2.49,0-4.65.68-5.95,1.59-.29.17-.57.17-.74-.17l-2.95-5.22c-.17-.4-.11-.68.17-.91,2.49-1.7,6.18-2.72,10.72-2.72,9.64,0,13.04,3.23,13.04,10.32v17.41c0,.34-.23.57-.57.57h-7.83ZM320.87,39.01v-1.7c0-.23-.11-.34-.34-.34h-3.35c-2.55,0-3.86.91-3.86,2.61,0,1.53,1.08,2.38,3.23,2.38,2.95,0,4.31-.96,4.31-2.95Z"/><path class="lg2" d="M336.24,48.08c-.34,0-.57-.23-.57-.57v-26.48c0-.34.23-.57.57-.57h8.39c.34,0,.57.23.57.57v2.44h.06c1.3-2.44,3.91-3.69,7.15-3.69,1.53,0,2.95.4,3.8,1.08.34.17.4.34.29.74l-3.23,8c-.23.28-.45.23-.79.06-1.36-.85-2.72-1.25-4.02-1.08-2.21.17-3.23,1.87-3.23,4.82v14.12c0,.34-.23.57-.57.57h-8.39Z"/><path class="lg2" d="M377.75,48.08c-.4,0-.68-.17-.85-.57l-5.39-10.66-2.04,2.72v7.94c0,.34-.23.57-.57.57h-8.33c-.34,0-.57-.23-.57-.57V10.08c0-.34.23-.57.57-.57h8.33c.34,0,.57.23.57.57v19.4l6.47-8.45c.34-.4.62-.57,1.08-.57h8.68c.34,0,.45.34.23.57l-8.11,9.41,9.24,17.07c.17.28.06.57-.28.57h-9.02Z"/><path class="lg2" d="M391.19,16.89c-.34,0-.57-.23-.57-.57v-6.24c0-.34.23-.57.57-.57h8.39c.34,0,.57.23.57.57v6.24c0,.34-.23.57-.57.57h-8.39ZM391.19,48.08c-.34,0-.57-.23-.57-.57v-26.48c0-.34.23-.57.57-.57h8.39c.34,0,.57.23.57.57v26.48c0,.34-.23.57-.57.57h-8.39Z"/><path class="lg2" d="M423,48.08c-.34,0-.56-.23-.56-.57v-15.76c0-2.44-1.08-4.03-3.35-4.03s-3.4,1.53-3.4,4.03v15.76c0,.34-.23.57-.57.57h-8.39c-.34,0-.57-.23-.57-.57v-26.48c0-.34.23-.57.57-.57h8.39c.34,0,.57.23.57.57v1.99h.06c1.25-1.81,3.63-3.23,7.09-3.23,6.3,0,9.13,4.25,9.13,10.32v17.41c0,.34-.23.57-.57.57h-8.39Z"/><path class="lg2" d="M437.57,54.66c-.23-.28-.17-.57.06-.85l4.76-4.88c.29-.28.57-.28.85,0,1.64,1.36,3.29,2.21,5.44,2.21,3.4,0,4.88-1.76,4.88-5.61v-2.1h-.06c-1.19,1.99-3.63,3.23-7.03,3.23-4.54,0-7.65-2.27-9.07-6.63-.62-1.87-.91-3.91-.91-6.81s.29-4.88.91-6.81c1.42-4.31,4.54-6.63,9.07-6.63,3.4,0,5.84,1.3,7.03,3.29h.06v-2.04c0-.34.23-.57.57-.57h8.39c.34,0,.57.23.57.57v22.8c0,10.66-5.1,15.14-14.69,15.14-4.37,0-8.91-1.98-10.83-4.31ZM453.17,36.45c.23-.79.4-1.65.4-3.23s-.17-2.44-.4-3.23c-.51-1.59-1.53-2.38-3.34-2.38s-2.78.79-3.29,2.38c-.28.79-.4,1.7-.4,3.23s.11,2.44.4,3.23c.51,1.65,1.53,2.44,3.29,2.44s2.84-.79,3.34-2.44Z"/></svg></div><h1 id="h1"></h1><div class="meta" id="meta"></div></div></header>
<div class="wrap">
  <div class="kpi-wrap">
    <div><div class="kpi-glabel" id="kpi-actual-label">実績</div><div class="grid k3" id="kpis-actual"></div></div>
    <div><div class="kpi-glabel est">料金設計 反映後（推定）</div><div class="grid k2e" id="kpis-est"></div></div>
  </div>
  <div class="flag" id="flag" style="display:none;"></div>

  <div class="section">
    <div class="sec-h"><span class="no">01</span><h2>いつ混み、いつ空くか</h2></div>
    <div class="concl" id="concl-1"></div>
    <div class="card"><p class="chart-t">時間帯別 稼働台数（平日・平均同時利用）</p><div id="c-occ"></div>
      <div class="legend"><span><span class="dot" style="background:var(--brand)"></span>稼働台数</span><span><span class="dot" style="background:var(--amber)"></span>入庫数</span></div></div>
    <div class="card" style="margin-top:12px;" id="weekly-card"><p class="chart-t">期間中の推移（週次）</p><p class="chart-c" id="weekly-c"></p><div id="c-weekly"></div>
      <div class="legend"><span><span class="dot" style="background:#009B3E"></span>売上</span><span><span class="dot" style="background:#D98200"></span>日次ピーク稼働の平均（台）</span></div></div>
    <div class="grid k2" style="margin-top:12px;">
      <div class="card" id="space-card"><p class="chart-t">車室別 利用回数</p><div id="c-space"></div></div>
      <div class="card" id="fee-card"><p class="chart-t">料金階層の内訳</p><div id="c-fee"></div></div>
    </div>
    <div class="grid k2" style="margin-top:12px;">
      <div class="card"><p class="chart-t">時間帯別 売上構成（入庫時刻ベース）</p><p class="chart-c" id="revband-c"></p><div id="c-revband"></div></div>
      <div class="card"><p class="chart-t">曜日別 売上シェアと夜間ピーク稼働</p><p class="chart-c" id="dow-c"></p><div id="c-dow"></div></div>
    </div>
    <div class="section" id="unpaid-wrap" style="display:none;"><div class="card unpaid-card" id="unpaid-card"></div></div>
  </div>

  <div class="section">
    <div class="sec-h"><span class="no">02</span><h2>混雑時／閑散時、周辺より高いか安いか</h2></div>
    <div class="concl" id="concl-2"></div>
    <p class="sec-sub" id="sec2-sub">事業者を問わず、当駐車場から最寄りの駐車場を距離順に比較（公開料金を調査）。</p>
    <div class="card" id="map-card" style="display:none;margin-bottom:16px;"><p class="chart-t">周辺マップ（当駐車場と最寄り競合の位置）</p><div id="map-img"></div><div class="legend" id="map-legend" style="margin-top:10px;"></div></div>
    <div class="card" id="nearest-card" style="display:none;overflow-x:auto;"><p class="chart-t">最寄りの周辺駐車場（距離順・全事業者）— 料金比較</p><p class="chart-c" id="nearest-c"></p>
      <table><thead><tr><th class="num">距離</th><th>駐車場</th><th>運営</th><th class="num">単価</th><th class="num">円/時</th></tr></thead><tbody id="tbl-nearest"></tbody></table></div>
    <div class="card" id="night-card" style="display:none;margin-top:16px;"><p class="chart-t">夜間 最大料金の比較（周辺の主要事業者）</p><p class="chart-c" id="night-c"></p><div id="c-night"></div>
      <div class="legend"><span><span class="dot" style="background:#D98200"></span>当駐車場</span><span><span class="dot" style="background:#B7DEC6"></span>周辺競合</span></div></div>
  </div>

  <div class="section">
    <div class="sec-h"><span class="no">03</span><h2>売上最大化の料金設計</h2></div>
    <div class="concl" id="concl-3"></div>
    <p class="sec-sub" id="sec3-sub"></p>
    <div class="card" id="recs"></div>
    <div class="callout" id="impact"></div>
  </div>
</div>
<script id="d" type="application/json">/*__PAYLOAD__*/</script>
<script>
const D=JSON.parse(document.getElementById("d").textContent);
const yen=n=>n==null?"—":"¥"+Number(n).toLocaleString("ja-JP");
const esc=s=>(s==null?"":String(s)).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const EFF=D.cap.effective;
const IC={
 pin:'<svg class="ic" viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
 car:'<svg class="ic" viewBox="0 0 24 24"><path d="M5 16l1.6-5.4A2 2 0 0 1 8.5 9h7a2 2 0 0 1 1.9 1.6L19 16"/><rect x="4" y="15" width="16" height="4" rx="1.5"/><circle cx="8" cy="19" r="1"/><circle cx="16" cy="19" r="1"/></svg>',
 cal:'<svg class="ic" viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/></svg>',
 card:'<svg class="ic" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/></svg>',
};
document.getElementById("h1").textContent=D.park;
document.getElementById("meta").innerHTML=[
 D.address&&IC.pin+"<b>"+esc(D.address)+"</b>",
 IC.car+"<b>実効"+EFF+"車室"+(D.cap.blocked.length?"（"+D.cap.blocked.join("・")+"は封鎖）":"")+"</b>",
 IC.cal+"<b>"+D.period+"</b>（"+D.sessions.toLocaleString()+"回駐車）",
 D.current.unit&&IC.card+"現行 <b>"+esc(D.current.unit)+(D.current.nightMax?" / 夜間最大"+yen(D.current.nightMax):"")+"</b>",
].filter(Boolean).map(v=>"<span>"+v+"</span>").join("");
// KPI（実績 / 推定 を分離）
const up=D.impact.pct;
const kpiCard=k=>'<div class="kpi card '+k[3]+'"><div class="lbl">'+k[0]+'</div><div class="val tnum">'+k[1]+'</div><div class="sub">'+k[2]+'</div></div>';
document.getElementById("kpi-actual-label").textContent="実績（"+D.period+"）";
const multiM=(D.monthsSpan||1)>1.5;const mRev=D.revenueMonthly??D.revenue;
if(D.impact.suppressed){const w=document.querySelector(".kpi-wrap");if(w){w.style.gridTemplateColumns="1fr";w.children[1].style.display="none";}}
document.getElementById("kpis-actual").innerHTML=[
 multiM?["月平均売上",yen(mRev),"期間計 "+yen(D.revenue)+"・"+D.sessions.toLocaleString()+"件",""]:["月間売上",yen(D.revenue),D.sessions+"件・平均"+D.avgDur+"分",""],
 ["実効車室数",EFF+"<small>台</small>",D.cap.blocked.length?"車室"+D.cap.blocked.join("・")+"は封鎖":"全"+D.cap.nominal+"車室",""],
 ["夜間ピーク稼働",D.peak.max+"<small>/"+EFF+"台</small>",D.peak.nights+"夜中"+D.peak.fullNights+"夜が満車",""],
].map(kpiCard).join("");
document.getElementById("kpis-est").innerHTML=[
 ["推定 月間売上",yen(mRev+D.impact.lo)+"<small>〜"+yen(mRev+D.impact.hi).replace("¥","")+"</small>","施策反映後の推定レンジ","est"],
 ["増収余地","+"+up[0]+"–"+up[1]+"<small>%</small>","月 +"+yen(D.impact.lo)+"–"+yen(D.impact.hi).replace("¥",""),"est"],
].map(kpiCard).join("");
// flag
if(D.cap.blocked.length&&D.peak.fullNights/Math.max(1,D.peak.nights)>=0.5){
  const f=document.getElementById("flag");f.style.display="";
  f.innerHTML='<div class="em"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5"/><path d="M12 15.8h.01"/></svg></div><div><div class="t">前提：車室'+D.cap.blocked.join("・")+'は封鎖。実効キャパ'+EFF+'台が上限。</div><div class="d"><b>'+EFF+'台がフル稼働の上限</b>。夜間ピークは'+D.peak.nights+'夜中'+D.peak.fullNights+'夜が満車。供給を増やせない以上、ピーク時に売上を伸ばす手段は<b>価格</b>。</div></div>';
}
// 稼働×入庫
(function(){const O=D.occ,E=D.ent,W=880,H=210,pL=34,pB=24,pT=8,pw=W-pL-20,ph=H-pB-pT;
const x=i=>pL+i*(pw/24)+(pw/24)/2,yO=v=>pT+ph*(1-v/EFF);const mE=Math.max(...E,1),yE=v=>pT+ph*(1-v/mE);
let s='<svg viewBox="0 0 '+W+' '+H+'">';
for(let g=0;g<=EFF;g+=Math.max(1,Math.ceil(EFF/3))){const gy=yO(g);s+='<line x1="'+pL+'" y1="'+gy+'" x2="'+(W-20)+'" y2="'+gy+'" stroke="rgba(0,0,0,.06)"/><text x="'+(pL-6)+'" y="'+(gy+4)+'" text-anchor="end" font-size="10" fill="#9AA096">'+g+'</text>';}
const bw=pw/24*.6;O.forEach((v,i)=>{const h=ph*Math.min(1,v/EFF);s+='<rect x="'+(x(i)-bw/2)+'" y="'+(pT+ph-h)+'" width="'+bw+'" height="'+h+'" rx="2" fill="#009B3E" opacity="'+((i>=19||i<2)?.95:.5)+'"/>';});
s+='<polyline points="'+E.map((v,i)=>x(i)+","+yE(v)).join(" ")+'" fill="none" stroke="#D98200" stroke-width="2.2"/>';
for(let i=0;i<24;i+=2)s+='<text x="'+x(i)+'" y="'+(H-8)+'" text-anchor="middle" font-size="10" fill="#9AA096">'+i+'時</text>';
document.getElementById("c-occ").innerHTML=s+"</svg>";})();
// 期間中の推移（週次: 売上バー + ピーク稼働ライン）
(function(){
const useMonthly=(D.monthly||[]).filter(m=>m.days>=(m.fullDays||28)*0.8).length>=3;
const Wk=useMonthly?(D.monthly||[]).filter(m=>m.days>=(m.fullDays||28)*0.8):(D.weekly||[]);const card=document.getElementById("weekly-card");
if(Wk.length<2){if(card)card.style.display="none";return;}
card.querySelector(".chart-t").textContent=useMonthly?"導入後の売上推移（月次）":"期間中の推移（週次）";
const isFull=w=>useMonthly?w.days>=(w.fullDays||28)*0.8:w.days>=6;
const fulls=Wk.filter(isFull);
let trend="";
if(fulls.length>=2){const a=fulls[0].revenue,b=fulls[fulls.length-1].revenue;const g=a?Math.round(100*(b-a)/a):0;
 trend=(g>=10?"<b>"+(useMonthly?"導入後、利用は拡大傾向":"利用は拡大傾向")+"</b>（"+fulls[0].label+"→"+fulls[fulls.length-1].label+"で売上+"+g+"%）。":(g<=-10?"<b>直近は減速傾向</b>（"+fulls[0].label+"→"+fulls[fulls.length-1].label+"で売上"+g+"%）。":"<b>売上はおおむね横ばいで安定</b>（週次±10%以内）。"));}
document.getElementById("weekly-c").innerHTML=trend;
const W=880,H=200,pL=56,pR=44,pB=24,pT=14,pw=W-pL-pR,ph=H-pB-pT;
const maxR=Math.max(...Wk.map(w=>w.revenue),1);const cw=pw/Wk.length;const bx=i=>pL+i*cw+cw*0.15,bw=cw*0.7;
let s2='<svg viewBox="0 0 '+W+' '+H+'">';
for(let g=0;g<=3;g++){const gy=pT+ph*(1-g/3);s2+='<line x1="'+pL+'" y1="'+gy+'" x2="'+(W-pR)+'" y2="'+gy+'" stroke="rgba(0,0,0,.06)"/>';}
Wk.forEach((w,i)=>{const h=ph*(w.revenue/maxR);
 s2+='<rect x="'+bx(i)+'" y="'+(pT+ph-h)+'" width="'+bw+'" height="'+h+'" rx="2" fill="#009B3E" opacity="'+(isFull(w)?0.9:0.45)+'"/>';
 s2+='<text x="'+(bx(i)+bw/2)+'" y="'+(pT+ph-h-5)+'" text-anchor="middle" font-size="9.5" font-weight="700" fill="#1B1E1C">'+(useMonthly?Math.round(w.revenue/1000)+"k":yen(w.revenue))+'</text>';
 s2+='<text x="'+(bx(i)+bw/2)+'" y="'+(H-8)+'" text-anchor="middle" font-size="10" fill="#9AA096">'+w.label+(isFull(w)?"":"*")+'</text>';});
const py=v=>pT+ph*(1-Math.min(1,v/EFF));
s2+='<polyline points="'+Wk.map((w,i)=>(bx(i)+bw/2)+","+py(w.peakAvg||0)).join(" ")+'" fill="none" stroke="#D98200" stroke-width="2.2"/>';
Wk.forEach((w,i)=>{s2+='<circle cx="'+(bx(i)+bw/2)+'" cy="'+py(w.peakAvg||0)+'" r="3" fill="#D98200"/><text x="'+(bx(i)+bw/2+7)+'" y="'+(py(w.peakAvg||0)-6)+'" font-size="10" fill="#D98200" font-weight="700">'+(w.peakAvg==null?"":w.peakAvg+"台")+'</text>';});
document.getElementById("c-weekly").innerHTML=s2+"</svg>";
})();
// 車室別（車室単位の記録がない場合＝ゲート式等は非表示）
(function(){
if(D.cap.spaceTracking===false){document.getElementById("space-card").style.display="none";document.getElementById("fee-card").style.gridColumn="span 2";return;}
const all=[];for(let n=1;n<=D.cap.nominal;n++)all.push([n,D.spaceUse[n]||0]);
const max=Math.max(...all.map(a=>a[1]),1);const W=440,bh=11,gap=3,pL=44,pT=4,H=pT+all.length*(bh+gap);
let s='<svg viewBox="0 0 '+W+' '+H+'">';
all.forEach(([k,v],i)=>{const y=pT+i*(bh+gap);const dead=v===0;
 s+='<text x="'+(pL-6)+'" y="'+(y+bh-2)+'" text-anchor="end" font-size="10" fill="'+(dead?"#8a7a55":"#9AA096")+'">車室'+k+'</text>';
 if(dead)s+='<rect x="'+pL+'" y="'+y+'" width="'+(W-pL-40)+'" height="'+bh+'" rx="2" fill="#F0EEE9"/><text x="'+(pL+6)+'" y="'+(y+bh-2)+'" font-size="10" fill="#8a7a55" font-weight="700">封鎖（0回）</text>';
 else{const w=(W-pL-40)*(v/max);s+='<rect x="'+pL+'" y="'+y+'" width="'+w+'" height="'+bh+'" rx="2" fill="#B7DEC6"/><text x="'+(pL+w+4)+'" y="'+(y+bh-2)+'" font-size="10" fill="#63685F">'+v+'</text>';}});
document.getElementById("c-space").innerHTML=s+"</svg>";})();
// 料金階層
(function(){const mt=D.maxTierCount,tot=D.sessions,rows=[["最大料金 到達層",mt,"#009B3E"],["単価・短時間ほか",tot-mt,"#B7DEC6"]];
let s='<div style="display:flex;flex-direction:column;gap:12px;margin-top:6px;">';
rows.forEach(([l,n,c])=>{const p=Math.round(100*n/tot);s+='<div><div style="display:flex;justify-content:space-between;font-size:12px;"><span>'+l+'</span><span style="font-weight:700">'+n+'件・'+p+'%</span></div><div style="background:#EEF1EE;border-radius:5px;height:12px;margin-top:3px;"><div style="width:'+p+'%;height:12px;border-radius:5px;background:'+c+'"></div></div></div>';});
document.getElementById("c-fee").innerHTML=s+"</div>";})();
// 時間帯別 売上構成
(function(){const rb=D.revBands||[];if(!rb.length)return;
const maxp=Math.max(...rb.map(b=>b.pct),1);
document.getElementById("revband-c").innerHTML="<b>夜間最大の適用窓（20時〜翌8時）に滞在がかかる駐車は"+D.nightWindow.count+"件・売上の"+D.nightWindow.share+"%（約"+yen(D.nightWindow.revenue)+"）</b>。夜間最大の改定が効く土台。";
const order=["日中(8-17時)","夜間(17-24時)","深夜(0-5時)","早朝(5-8時)"];
let s="";order.forEach(lbl=>{const b=rb.find(x=>x.label===lbl);if(!b)return;const night=/夜間|深夜/.test(lbl);
 s+='<div class="hbar"><div class="l">'+lbl+'</div><div class="track"><div class="fill" style="width:'+Math.round(100*b.pct/maxp)+'%;background:'+(night?"#009B3E":"#B7DEC6")+'"></div></div><div class="v">'+yen(b.revenue)+'・'+b.pct+'%</div></div>';});
document.getElementById("c-revband").innerHTML=s;})();
// 曜日別
(function(){const dw=D.dow||[];if(!dw.length)return;
const slack=dw.filter(d=>d.nightPeak!=null&&d.nightPeak<EFF*0.85).map(d=>d.day);
const fullDays=dw.filter(d=>d.nightPeak!=null&&d.nightPeak>=EFF*0.95).map(d=>d.day);
document.getElementById("dow-c").innerHTML=(slack.length&&slack.length<7)
 ?("<b>"+(fullDays.length>=5?"ほとんどの曜日の夜が実効満車":"夜間満車の曜日が多い")+"</b>。唯一<b>"+slack.join("・")+"曜夜のみ空きがある</b>（オレンジ）。→ 夜間値上げは他曜日に適用し、"+slack.join("・")+"曜夜は据え置きとする曜日レバーが有効。")
 :"全曜日で夜間の稼働が高い。";
const maxp=Math.max(...dw.map(d=>d.pct),1);let s="";
dw.forEach(d=>{const slackD=d.nightPeak!=null&&d.nightPeak<EFF*0.85;
 s+='<div class="hbar"><div class="l">'+d.day+'曜</div><div class="track"><div class="fill" style="width:'+Math.round(100*d.pct/maxp)+'%;background:'+(slackD?"#D98200":"#009B3E")+'"></div></div><div class="v">'+d.pct+'%・夜ピーク'+(d.nightPeak??"—")+'台</div></div>';});
document.getElementById("c-dow").innerHTML=s;})();
// 未払い（ナンバー分析）
(function(){if(!D.unpaid.count)return;const P=D.plates||{};const el=document.getElementById("unpaid-card");
document.getElementById("unpaid-wrap").style.display="";
let h='<p class="chart-t">未回収（未払い）が月 約'+yen(D.unpaid.amountMonthly??D.unpaid.amount)+(P.repeats&&P.repeats.length?' — ナンバー分析で当て先が明確':'')+'</p>';
h+='<p class="chart-c">未払い'+D.unpaid.count+'件＝<b>'+(P.uniqueVehicles||"?")+'台</b>。';
if(P.repeats&&P.repeats.length)h+='うち<b>常習'+P.repeats.length+'台で'+P.repeatIncidents+'件（'+Math.round(100*P.repeatIncidents/D.unpaid.count)+'%）・約'+yen(P.repeatAmount)+'（金額の'+Math.round(100*P.repeatAmount/Math.max(1,D.unpaid.amount))+'%）</b>を占める。ナンバーは特定済みのため、施策の当て先が絞れる。';
h+='</p><div class="grid k2"><div>';
if(P.repeats&&P.repeats.length){
 h+='<p class="chart-t" style="font-size:13px;">複数回未払いの車両（'+P.repeats.length+'台）</p><table style="font-size:12px;"><tr><th>ナンバー</th><th class="num">回数</th><th class="num">金額</th><th>時期</th></tr>';
 P.repeats.slice(0,12).forEach(r=>{h+='<tr><td style="font-variant-numeric:tabular-nums">'+esc(r.plate)+'</td><td class="num">'+r.count+'回</td><td class="num">'+yen(r.amount)+'</td><td style="color:var(--grey);font-size:11px">'+esc(r.period)+'</td></tr>';});
 h+='</table>'+(P.repeats.length>12?'<div style="font-size:11px;color:var(--faint);margin-top:4px">ほか'+(P.repeats.length-12)+'台</div>':'');
}else h+='<p class="chart-c">複数回未払いの車両はなし。</p>';
h+='</div><div><p class="chart-t" style="font-size:13px;">未払い車両の支払い履歴（期間内）</p><table style="font-size:12px;"><tr><th>区分</th><th class="num">台数</th><th>示唆</th></tr>';
h+='<tr><td><b>別の来場で支払い実績あり</b></td><td class="num">'+(P.paidElsewhere||0)+'台</td><td style="font-size:11.5px;color:var(--grey)">支払える客のうっかり/機会的スキップ'+(P.example?'（例: '+esc(P.example.plate.split(" ")[0])+'…は来場'+P.example.visits+'回中'+P.example.paid+'回支払い）':'')+'</td></tr>';
h+='<tr><td>期間内の支払い履歴なし</td><td class="num">'+(P.neverPaid||0)+'台</td><td style="font-size:11.5px;color:var(--grey)">うち'+(P.onceOnly||0)+'台は来場1回のみ（一見）。常習車両は<b>督促・警告の最優先対象</b></td></tr></table></div></div>';
el.innerHTML=h;})();
// 周辺マップ
if(D.map&&D.map.dataUri){const el=document.getElementById("map-card");el.style.display="";
 document.getElementById("map-img").innerHTML='<img src="'+D.map.dataUri+'" style="width:100%;border-radius:6px;border:1px solid var(--line);display:block" alt="周辺マップ">';
 document.getElementById("map-legend").innerHTML='<span><span class="dot" style="background:#009B3E"></span><b>P</b> 当駐車場</span>'+D.map.legend.map(l=>'<span><b>'+l.no+'.</b> '+esc(l.name)+(l.yph?'（'+yen(l.yph)+'/時）':'')+'</span>').join("");}
// 最寄り比較
(function(){const N=D.nearest||[];if(!N.length)return;
document.getElementById("nearest-card").style.display="";
const selfY=D.current.dayHour1;
const med=(a=>{a=a.filter(x=>x!=null).sort((x,y)=>x-y);return a.length?a[a.length>>1]:null})(N.map(c=>c.yph));
const pos=med==null||selfY==null?"":(selfY>med?"high":(selfY<med?"low":"mid"));
document.getElementById("nearest-c").innerHTML=selfY?('当駐車場の<b>'+yen(selfY)+'/時は'+(pos==="high"?'近隣で最高水準':pos==="low"?'近隣で安い水準':'近隣中央値並み')+'</b>（周辺中央値 約'+yen(med)+'/時）。'):'';
let rows='';
if(selfY)rows+='<tr class="hot"><td class="num">—</td><td style="font-weight:800">当駐車場（'+esc(D.park)+'）</td><td><span class="tag">自駐車場</span></td><td class="num">'+esc(D.current.unit||"")+'</td><td class="num" style="font-weight:800;color:'+(pos==="high"?"#D0433A":"#00622A")+'">'+yen(selfY)+(pos==="high"?'（最高）':'')+'</td></tr>';
N.forEach(c=>{rows+='<tr><td class="num">'+(c.dist!=null?c.dist+'m':'—')+'</td><td>'+esc(c.name)+'</td><td><span class="tag">'+esc(c.op)+'</span></td><td class="num">'+esc(c.unit||"—")+'</td><td class="num">'+yen(c.yph)+'</td></tr>';});
document.getElementById("tbl-nearest").innerHTML=rows;})();
// 夜間最大比較
(function(){const rows=[...(D.nightRows||[])].sort((a,b)=>b.v-a.v);if(rows.length<2)return;
document.getElementById("night-card").style.display="";
const selfRow=rows.find(r=>r.self);
document.getElementById("night-c").innerHTML=selfRow?('夜間最大料金では当駐車場の<b>'+yen(selfRow.v)+(rows[rows.length-1].self?'が周辺で最安':'')+'</b>。実効満車のため夜間は値上げ余地が大きい。<span style="color:var(--faint)">※夜間最大は追跡対象の主要事業者の近隣物件から。単価の最寄り比較は上表。</span>'):'';
const W=900,bh=26,gap=10,pL=250,pT=6,H=pT+rows.length*(bh+gap);
const max=Math.max(...rows.map(r=>r.v))*1.1,sc=(W-pL-70)/max;
let s='<svg viewBox="0 0 '+W+' '+H+'">';
rows.forEach((d,i)=>{const y=pT+i*(bh+gap),w=d.v*sc;
 s+='<text x="'+(pL-8)+'" y="'+(y+bh/2+4)+'" text-anchor="end" font-size="10.5" fill="'+(d.self?"#00622A":"#63685F")+'" font-weight="'+(d.self?800:500)+'">'+esc(d.n)+'</text><rect x="'+pL+'" y="'+y+'" width="'+w+'" height="'+bh+'" rx="3" fill="'+(d.self?"#D98200":"#B7DEC6")+'"/><text x="'+(pL+w+6)+'" y="'+(y+bh/2+4)+'" font-size="11.5" font-weight="800">'+yen(d.v)+'</text>';});
if(D.nightTarget){const rx=pL+D.nightTarget*sc;s+='<line x1="'+rx+'" y1="0" x2="'+rx+'" y2="'+H+'" stroke="#009B3E" stroke-width="1.5" stroke-dasharray="4 3"/><text x="'+rx+'" y="'+(H-1)+'" text-anchor="middle" font-size="10" fill="#009B3E" font-weight="700">推奨 '+yen(D.nightTarget)+'</text>';}
document.getElementById("c-night").innerHTML=s+"</svg>";})();
// 提言
document.getElementById("sec3-sub").textContent=D.impact.suppressed?"現行の料金・運用が需要と釣り合っており、変更の必要はない。":(D.peak.fullNights/Math.max(1,D.peak.nights)>=0.5)
 ?("車室"+EFF+"台"+(D.cap.blocked.length?"は物理上限で増やせない":"")+"。「夜は満車・日中は空きで割高」という構造に対する、価格のピークロード型レバー＋未回収の是正。")
 :"満車帯が無いため価格レバーは限定的。未回収の是正を主レバーとし、稼働改善は検証しながら進める。";
const CIRC=["①","②","③","④","⑤","⑥"];
document.getElementById("recs").innerHTML=D.recs.map((r,i)=>'<div class="rec"><div class="n '+r.kind+'">'+(i+1)+'</div><div><div class="t">'+r.t+'</div><div class="d">'+r.d+'</div>'+(r.steps?'<div style="margin-top:8px;font-size:12.5px;"><div style="font-weight:700;color:var(--ink);margin-bottom:3px;">段階的な対応（推奨順）</div>'+r.steps.map((st,j)=>'<div style="margin:3px 0;color:var(--grey);"><b style="color:var(--amber);">'+CIRC[j]+'</b> '+esc(st)+'</div>').join("")+'</div>':'')+(r.move?'<div class="move">'+(r.move.old?'<span class="old">'+esc(r.move.old)+'</span> → ':'')+'<span class="new">'+esc(r.move.new)+'</span>'+(r.move.pill?'<span class="pill">'+esc(r.move.pill)+'</span>':'')+'</div>':'')+'</div></div>').join("");
// 推定インパクト（施策別の期待効果＋合計）
(function(){
const rows=D.impact.rows||[];
if(D.impact.suppressed){document.getElementById("impact").style.display="none";return;}
let h='<div style="font-size:12px;font-weight:700;color:var(--brand-dark)">推定インパクト（月間・施策別）</div>';
h+='<table style="margin-top:10px;background:transparent;"><thead><tr><th style="background:rgba(0,98,42,.08);">施策</th><th class="num" style="background:rgba(0,98,42,.08);">期待効果（月）</th><th style="background:rgba(0,98,42,.08);">前提</th></tr></thead><tbody>';
rows.forEach((r,i)=>{h+='<tr><td>'+(i+1)+'. '+r.t+'</td><td class="num" style="font-weight:700;">'+(r.lo!=null?('+'+yen(r.lo)+'〜'+yen(r.hi)):'—')+'</td><td style="font-size:11.5px;color:var(--brand-dark);opacity:.8;">'+esc(r.note)+'</td></tr>';});
h+='<tr><td style="font-weight:800;border-top:2px solid #B7E3C7;">合計</td><td class="num" style="font-weight:800;border-top:2px solid #B7E3C7;color:var(--brand-dark);">+'+yen(D.impact.lo)+'〜'+yen(D.impact.hi)+'</td><td style="border-top:2px solid #B7E3C7;font-weight:700;color:var(--brand-dark);">売上比 +'+up[0]+'〜'+up[1]+'%</td></tr></tbody></table>';
h+='<div class="big" style="margin-top:10px;">月間売上 +'+yen(D.impact.lo)+'〜'+yen(D.impact.hi)+'（+'+up[0]+'〜'+up[1]+'%）</div>';
document.getElementById("impact").innerHTML=h;
})();
// 各セクションの結論（見出し直下）
(function(){
const full=D.peak.fullNights/Math.max(1,D.peak.nights);
// 01
let c1;
if(full>=0.5){c1='<b>結論：夜間はほぼ満車（'+D.peak.nights+'夜中'+D.peak.fullNights+'夜）で、空きは日中にある。</b>夜間帯にかかる駐車が売上の'+D.nightWindow.share+'%を占め、夜間の料金設定が売上を左右する。';}
else{c1='<b>結論：満車になる時間帯はなく、稼働に余裕がある。</b>ピークでも'+D.peak.max+'/'+EFF+'台で、料金よりも集客・回収が論点。';}
document.getElementById("concl-1").innerHTML=c1;
// 02
const N=D.nearest||[];const selfY=D.current.dayHour1;
const med=(a=>{a=a.filter(x=>x!=null).sort((x,y)=>x-y);return a.length?a[a.length>>1]:null})(N.map(c=>c.yph));
let c2parts=[];
if(selfY&&med)c2parts.push(selfY>med?'単価'+yen(selfY)+'/時は<b>近隣で最高水準</b>（中央値 約'+yen(med)+'/時）':selfY<med?'単価'+yen(selfY)+'/時は<b>周辺より安い水準</b>（中央値 約'+yen(med)+'/時）':'単価は周辺中央値並み');
const nr=D.nightRows||[];const selfN=nr.find(r=>r.self);
if(selfN&&nr.length>1){const others=nr.filter(r=>!r.self).map(r=>r.v);if(selfN.v<=Math.min(...others))c2parts.push('夜間最大'+yen(selfN.v)+'は<b>周辺最安</b>');else if(selfN.v>=Math.max(...others))c2parts.push('夜間最大'+yen(selfN.v)+'は周辺最高');}
document.getElementById("concl-2").innerHTML='<b>結論：</b>'+(c2parts.length?c2parts.join("。")+"。":"周辺比較は下表参照。");
// 03
const first=(D.recs[0]||{}).t||"";
document.getElementById("concl-3").innerHTML=D.impact.suppressed?'<b>結論：料金設定は健全（現状維持を推奨）。</b>増収余地は売上比5%未満で、積極的な変更は不要。':'<b>結論：'+first+(D.recs.length>1?'（ほか'+(D.recs.length-1)+'施策）':'')+'。</b>合計で月 +'+yen(D.impact.lo)+'〜'+yen(D.impact.hi)+'（+'+up[0]+'〜'+up[1]+'%）の増収余地。';
})();
</script>`;
