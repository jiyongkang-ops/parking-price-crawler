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
      effect: { lo: Math.round(metrics.revenue * 0.7 * upRate * 0.7), hi: Math.round(metrics.revenue * 0.7 * upRate) },
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
    let d = `未払い${metrics.unpaid.rate}%・月約${yen(metrics.unpaid.amount)}は、料金改定と同規模の増収余地。`;
    if (P?.repeats?.length) d += `<b>常習${P.repeats.length}台で金額の${Math.round(100 * P.repeatAmount / Math.max(1, metrics.unpaid.amount))}%（約${yen(P.repeatAmount)}）</b>＝ナンバー特定済みで督促・警告の最優先対象。`;
    if (P?.paidElsewhere) d += `<b>支払い実績のある${P.paidElsewhere}台</b>は回収余地あり。`;
    d += "加えて深夜〜早朝出庫の取りはぐれ対策。";
    recs.push({ kind: "a", t: "未払い（未回収）の是正", d,
      move: { new: `未回収 月約${yen(metrics.unpaid.amount)} の圧縮` },
      steps: [
        "駐車場全体に「カメラによる未払い監視中」の掲示を増設（全体への抑止）",
        "未払いの多い車両のナンバー（下4桁）を場内に警告表示",
        "常習車両をブラックリストに登録し、入庫したタイミングでフロントガラスに警告書面を掲出",
        "運輸局へ登録事項等証明書を請求して所有者を特定し、直接支払いを依頼",
      ],
      effect: { lo: Math.round(metrics.unpaid.amount * 0.5), hi: metrics.unpaid.amount },
      effectNote: "回収率50〜100%想定" });
  }

  // 増収試算（施策別の期待効果と合計）
  const rows = recs.map((r) => ({ t: r.t, lo: r.effect?.lo ?? null, hi: r.effect?.hi ?? null, note: r.effectNote ?? "" }));
  const totalLo = rows.reduce((s, r) => s + (r.lo ?? 0), 0);
  const totalHi = rows.reduce((s, r) => s + (r.hi ?? 0), 0);
  const impact = { rows, lo: totalLo, hi: totalHi,
    pct: metrics.revenue ? [Math.round(100 * totalLo / metrics.revenue), Math.round(100 * totalHi / metrics.revenue)] : [0, 0] };
  const r1 = recs.find((r) => r.target);
  return { recs, impact, nightMed, nightTarget: r1?.target ?? null };
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
    revBands: metrics.revenueBands, nightWindow: metrics.nightWindow, dow: metrics.dow,
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
  .h1sub{font-size:16px;font-weight:700;opacity:.92;margin:4px 0 0;} header .meta{font-size:13px;opacity:.92;display:flex;gap:18px;flex-wrap:wrap;margin-top:12px;} header .meta b{font-weight:700;}
  .section{margin-top:28px;} .sec-h{display:flex;align-items:baseline;gap:12px;margin:0 0 4px;} .sec-h .no{color:var(--brand);font-weight:800;font-size:14px;} .sec-h h2{font-size:19px;font-weight:800;margin:0;}
  .sec-sub{color:var(--grey);font-size:13.5px;margin:2px 0 16px;padding-left:26px;}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px 22px;box-shadow:0 1px 2px rgba(0,0,0,.03);}
  .grid{display:grid;gap:16px;} .k4{grid-template-columns:repeat(4,1fr);} .k2{grid-template-columns:1fr 1fr;}
  @media(max-width:720px){.k4{grid-template-columns:1fr 1fr;}.k2{grid-template-columns:1fr;}}
  .kpi{display:flex;flex-direction:column;} .kpi .lbl{font-size:11.5px;color:var(--grey);font-weight:700;white-space:nowrap;} .kpi .val{font-size:24px;font-weight:800;margin-top:5px;white-space:nowrap;letter-spacing:-.01em;} .kpi .val small{font-size:13px;color:var(--grey);font-weight:700;} .kpi .sub{font-size:11.5px;color:var(--faint);margin-top:auto;padding-top:6px;} .kpi.accent{border-left:3px solid var(--brand);}
  .chart-t{font-weight:700;font-size:14px;margin:0 0 3px;} .chart-c{color:var(--grey);font-size:12px;margin:0 0 14px;}
  .legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--grey);margin-top:10px;} .legend span{display:inline-flex;align-items:center;gap:6px;} .dot{width:11px;height:11px;border-radius:3px;display:inline-block;}
  table{border-collapse:collapse;width:100%;font-size:13px;} th,td{padding:9px 11px;border-bottom:1px solid var(--line-soft);text-align:left;} th{font-size:11.5px;color:var(--grey);font-weight:700;background:#F0F2F0;} td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;} tr.hot td{background:var(--amber-bg);}
  .tag{font-size:11px;font-weight:700;padding:2px 8px;border-radius:5px;background:#EEF1EE;color:#3d7a1f;white-space:nowrap;}
  .rec{display:flex;gap:16px;align-items:flex-start;padding:16px 0;border-bottom:1px solid var(--line-soft);} .rec:last-child{border-bottom:none;} .rec .n{flex:0 0 30px;height:30px;border-radius:8px;color:#fff;display:grid;place-items:center;font-weight:800;} .rec .n.g{background:var(--brand);} .rec .n.a{background:var(--amber);} .rec .t{font-weight:700;font-size:15px;} .rec .d{color:var(--grey);font-size:13px;margin-top:3px;}
  .move{margin-top:6px;font-weight:800;font-variant-numeric:tabular-nums;} .move .old{color:var(--faint);text-decoration:line-through;} .move .new{color:var(--brand-dark);} .move .pill{background:var(--brand-light);color:var(--brand-dark);border-radius:999px;padding:1px 9px;font-size:12px;margin-left:6px;}
  .callout{background:var(--brand-light);border:1px solid #B7E3C7;border-radius:12px;padding:18px 20px;margin-top:16px;} .callout .big{font-size:26px;font-weight:800;color:var(--brand-dark);}
  .flag{background:var(--brand-light);border:1px solid #B7E3C7;border-radius:12px;padding:16px 20px;margin-bottom:16px;display:flex;gap:14px;} .flag .em{font-size:22px;} .flag .t{font-weight:800;font-size:15px;color:var(--brand-dark);} .flag .d{font-size:13px;color:var(--brand-dark);margin-top:2px;}
  .unpaid-card{border-left:3px solid var(--amber);} .unpaid-card .chart-t{color:#9A5B00;}
  .hbar{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:12px;} .hbar .l{width:92px;color:var(--grey);} .hbar .track{flex:1;background:#EEF1EE;border-radius:4px;} .hbar .fill{height:14px;border-radius:4px;} .hbar .v{width:150px;text-align:right;font-variant-numeric:tabular-nums;}
  svg{display:block;width:100%;height:auto;overflow:visible;}
  @media print{*{-webkit-print-color-adjust:exact;print-color-adjust:exact;}body{background:#fff;}.card,.kpi,.callout,.flag,.rec{break-inside:avoid;}.section{break-inside:avoid-page;}}
</style>
<header><div class="wrap"><h1 id="h1"></h1><div class="h1sub">売上最大化のための料金診断</div><div class="meta" id="meta"></div></div></header>
<div class="wrap">
  <div class="grid k4" style="margin-bottom:16px;" id="kpis"></div>
  <div class="flag" id="flag" style="display:none;"></div>

  <div class="section">
    <div class="sec-h"><span class="no">01</span><h2>いつ混み、いつ空くか</h2></div>
    <div class="card"><p class="chart-t">時間帯別 稼働台数（平日・平均同時利用）</p><div id="c-occ"></div>
      <div class="legend"><span><span class="dot" style="background:var(--brand)"></span>稼働台数</span><span><span class="dot" style="background:var(--amber)"></span>入庫数</span></div></div>
    <div class="grid k2" style="margin-top:16px;">
      <div class="card" id="space-card"><p class="chart-t">車室別 利用回数</p><div id="c-space"></div></div>
      <div class="card" id="fee-card"><p class="chart-t">料金階層の内訳</p><div id="c-fee"></div></div>
    </div>
    <div class="grid k2" style="margin-top:16px;">
      <div class="card"><p class="chart-t">時間帯別 売上構成（入庫時刻ベース）</p><p class="chart-c" id="revband-c"></p><div id="c-revband"></div></div>
      <div class="card"><p class="chart-t">曜日別 売上シェアと夜間ピーク稼働</p><p class="chart-c" id="dow-c"></p><div id="c-dow"></div></div>
    </div>
    <div class="section" id="unpaid-wrap" style="display:none;"><div class="card unpaid-card" id="unpaid-card"></div></div>
  </div>

  <div class="section">
    <div class="sec-h"><span class="no">02</span><h2>混雑時／閑散時、周辺より高いか安いか</h2></div>
    <p class="sec-sub" id="sec2-sub">事業者を問わず、当駐車場から最寄りの駐車場を距離順に比較（公開料金を調査）。</p>
    <div class="card" id="map-card" style="display:none;margin-bottom:16px;"><p class="chart-t">周辺マップ（当駐車場と最寄り競合の位置）</p><div id="map-img"></div><div class="legend" id="map-legend" style="margin-top:10px;"></div></div>
    <div class="card" id="nearest-card" style="display:none;overflow-x:auto;"><p class="chart-t">最寄りの周辺駐車場（距離順・全事業者）— 料金比較</p><p class="chart-c" id="nearest-c"></p>
      <table><thead><tr><th class="num">距離</th><th>駐車場</th><th>運営</th><th class="num">単価</th><th class="num">円/時</th></tr></thead><tbody id="tbl-nearest"></tbody></table></div>
    <div class="card" id="night-card" style="display:none;margin-top:16px;"><p class="chart-t">夜間 最大料金の比較（周辺の主要事業者）</p><p class="chart-c" id="night-c"></p><div id="c-night"></div>
      <div class="legend"><span><span class="dot" style="background:#D98200"></span>当駐車場</span><span><span class="dot" style="background:#B7DEC6"></span>周辺競合</span></div></div>
  </div>

  <div class="section">
    <div class="sec-h"><span class="no">03</span><h2>売上最大化の料金設計</h2></div>
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
document.getElementById("h1").textContent=D.park;
document.getElementById("meta").innerHTML=[
 D.address&&"📍 <b>"+esc(D.address)+"</b>",
 "🚗 <b>実効"+EFF+"車室"+(D.cap.blocked.length?"（"+D.cap.blocked.join("・")+"は封鎖）":"")+"</b>",
 "📅 <b>"+D.period+"</b>（"+D.sessions.toLocaleString()+"回駐車）",
 D.current.unit&&"💳 現行 <b>"+esc(D.current.unit)+(D.current.nightMax?" / 夜間最大"+yen(D.current.nightMax):"")+"</b>",
].filter(Boolean).join("");
// KPI
const up=D.impact.pct;
document.getElementById("kpis").innerHTML=[
 ["月間売上（実績）",yen(D.revenue),D.sessions+"件・平均"+D.avgDur+"分",""],
 ["実効車室数（上限）",EFF+"<small>台</small>",D.cap.blocked.length?"車室"+D.cap.blocked.join("・")+"は封鎖":"全"+D.cap.nominal+"車室",""],
 ["夜間ピーク稼働",D.peak.max+"<small>/"+EFF+"台</small>",D.peak.nights+"夜中"+D.peak.fullNights+"夜が満車","accent"],
 ["推定 増収余地","+"+up[0]+"–"+up[1]+"<small>%</small>","月 +"+yen(D.impact.lo)+"–"+yen(D.impact.hi).replace("¥",""),"accent"],
].map(k=>'<div class="kpi card '+k[3]+'"><div class="lbl">'+k[0]+'</div><div class="val tnum">'+k[1]+'</div><div class="sub">'+k[2]+'</div></div>').join("");
// flag
if(D.cap.blocked.length&&D.peak.fullNights/Math.max(1,D.peak.nights)>=0.5){
  const f=document.getElementById("flag");f.style.display="";
  f.innerHTML='<div class="em">📌</div><div><div class="t">前提：車室'+D.cap.blocked.join("・")+'は封鎖。実効キャパ'+EFF+'台が上限。</div><div class="d"><b>'+EFF+'台がフル稼働の上限</b>。夜間ピークは'+D.peak.nights+'夜中'+D.peak.fullNights+'夜が満車。供給を増やせない以上、ピーク時に売上を伸ばす手段は<b>価格</b>。</div></div>';
}
// 稼働×入庫
(function(){const O=D.occ,E=D.ent,W=880,H=240,pL=34,pB=26,pT=10,pw=W-pL-20,ph=H-pB-pT;
const x=i=>pL+i*(pw/24)+(pw/24)/2,yO=v=>pT+ph*(1-v/EFF);const mE=Math.max(...E,1),yE=v=>pT+ph*(1-v/mE);
let s='<svg viewBox="0 0 '+W+' '+H+'">';
for(let g=0;g<=EFF;g+=Math.max(1,Math.ceil(EFF/3))){const gy=yO(g);s+='<line x1="'+pL+'" y1="'+gy+'" x2="'+(W-20)+'" y2="'+gy+'" stroke="rgba(0,0,0,.06)"/><text x="'+(pL-6)+'" y="'+(gy+4)+'" text-anchor="end" font-size="10" fill="#9AA096">'+g+'</text>';}
const bw=pw/24*.6;O.forEach((v,i)=>{const h=ph*Math.min(1,v/EFF);s+='<rect x="'+(x(i)-bw/2)+'" y="'+(pT+ph-h)+'" width="'+bw+'" height="'+h+'" rx="2" fill="#009B3E" opacity="'+((i>=19||i<2)?.95:.5)+'"/>';});
s+='<polyline points="'+E.map((v,i)=>x(i)+","+yE(v)).join(" ")+'" fill="none" stroke="#D98200" stroke-width="2.2"/>';
for(let i=0;i<24;i+=2)s+='<text x="'+x(i)+'" y="'+(H-8)+'" text-anchor="middle" font-size="10" fill="#9AA096">'+i+'時</text>';
document.getElementById("c-occ").innerHTML=s+"</svg>";})();
// 車室別（車室単位の記録がない場合＝ゲート式等は非表示）
(function(){
if(D.cap.spaceTracking===false){document.getElementById("space-card").style.display="none";document.getElementById("fee-card").style.gridColumn="span 2";return;}
const all=[];for(let n=1;n<=D.cap.nominal;n++)all.push([n,D.spaceUse[n]||0]);
const max=Math.max(...all.map(a=>a[1]),1);const W=440,bh=13,gap=4,pL=44,pT=4,H=pT+all.length*(bh+gap);
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
let h='<p class="chart-t">未回収（未払い）が月 約'+yen(D.unpaid.amount)+(P.repeats&&P.repeats.length?' — ナンバー分析で当て先が明確':'')+'</p>';
h+='<p class="chart-c">未払い'+D.unpaid.count+'件＝<b>'+(P.uniqueVehicles||"?")+'台</b>。';
if(P.repeats&&P.repeats.length)h+='うち<b>常習'+P.repeats.length+'台で'+P.repeatIncidents+'件（'+Math.round(100*P.repeatIncidents/D.unpaid.count)+'%）・約'+yen(P.repeatAmount)+'（金額の'+Math.round(100*P.repeatAmount/Math.max(1,D.unpaid.amount))+'%）</b>を占める。ナンバーは特定済みのため、施策の当て先が絞れる。';
h+='</p><div class="grid k2"><div>';
if(P.repeats&&P.repeats.length){
 h+='<p class="chart-t" style="font-size:13px;">複数回未払いの車両（'+P.repeats.length+'台）</p><table style="font-size:12px;"><tr><th>ナンバー</th><th class="num">回数</th><th class="num">金額</th><th>時期</th></tr>';
 P.repeats.forEach(r=>{h+='<tr><td style="font-variant-numeric:tabular-nums">'+esc(r.plate)+'</td><td class="num">'+r.count+'回</td><td class="num">'+yen(r.amount)+'</td><td style="color:var(--grey);font-size:11px">'+esc(r.period)+'</td></tr>';});
 h+='</table>';
}else h+='<p class="chart-c">複数回未払いの車両はなし。</p>';
h+='</div><div><p class="chart-t" style="font-size:13px;">未払い車両の支払い履歴（期間内）</p><table style="font-size:12px;"><tr><th>区分</th><th class="num">台数</th><th>示唆</th></tr>';
h+='<tr><td><b>別の来場で支払い実績あり</b></td><td class="num">'+(P.paidElsewhere||0)+'台</td><td style="font-size:11.5px;color:var(--grey)">支払える客のうっかり/機会的スキップ'+(P.example?'（例: '+esc(P.example.plate.split(" ")[0])+'…は来場'+P.example.visits+'回中'+P.example.paid+'回支払い）':'')+'</td></tr>';
h+='<tr><td>期間内の支払い履歴なし</td><td class="num">'+(P.neverPaid||0)+'台</td><td style="font-size:11.5px;color:var(--grey)">うち'+(P.onceOnly||0)+'台は来場1回のみ（一見）。常習車両は<b>督促・警告の最優先対象</b></td></tr></table></div></div>';
el.innerHTML=h;})();
// 周辺マップ
if(D.map&&D.map.dataUri){const el=document.getElementById("map-card");el.style.display="";
 document.getElementById("map-img").innerHTML='<img src="'+D.map.dataUri+'" style="width:100%;border-radius:8px;border:1px solid var(--line);display:block" alt="周辺マップ">';
 document.getElementById("map-legend").innerHTML='<span><span class="dot" style="background:#009B3E"></span><b>P</b> 当駐車場</span>'+D.map.legend.map(l=>'<span><b>'+l.no+'.</b> '+esc(l.name)+(l.yph?'（'+yen(l.yph)+'/時）':'')+'</span>').join("");}
// 最寄り比較
(function(){const N=D.nearest||[];if(!N.length)return;
document.getElementById("nearest-card").style.display="";
const selfY=D.current.dayHour1;
const med=(a=>{a=a.filter(x=>x!=null).sort((x,y)=>x-y);return a.length?a[a.length>>1]:null})(N.map(c=>c.yph));
const pos=med==null||selfY==null?"":(selfY>med?"high":(selfY<med?"low":"mid"));
document.getElementById("nearest-c").innerHTML=selfY?('当駐車場の<b>'+yen(selfY)+'/時は'+(pos==="high"?'近隣で最高水準':pos==="low"?'近隣で安い水準':'近隣中央値並み')+'</b>（周辺中央値 約'+yen(med)+'/時）。'):'';
let rows='';
if(selfY)rows+='<tr class="hot"><td class="num">—</td><td style="font-weight:800">当駐車場（'+esc(D.park)+'）</td><td><span class="tag">自駐車場</span></td><td class="num">'+esc(D.current.unit||"")+'</td><td class="num" style="font-weight:800;color:'+(pos==="high"?"#D0433A":"#00622A")+'">'+yen(selfY)+(pos==="high"?' ⚠最高':'')+'</td></tr>';
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
document.getElementById("sec3-sub").textContent=(D.peak.fullNights/Math.max(1,D.peak.nights)>=0.5)
 ?("車室"+EFF+"台"+(D.cap.blocked.length?"は物理上限で増やせない":"")+"。「夜は満車・日中は空きで割高」という構造に対する、価格のピークロード型レバー＋未回収の是正。")
 :"満車帯が無いため価格レバーは限定的。未回収の是正を主レバーとし、稼働改善は検証しながら進める。";
const CIRC=["①","②","③","④","⑤","⑥"];
document.getElementById("recs").innerHTML=D.recs.map((r,i)=>'<div class="rec"><div class="n '+r.kind+'">'+(i+1)+'</div><div><div class="t">'+r.t+'</div><div class="d">'+r.d+'</div>'+(r.steps?'<div style="margin-top:8px;font-size:12.5px;"><div style="font-weight:700;color:var(--ink);margin-bottom:3px;">段階的な対応（推奨順）</div>'+r.steps.map((st,j)=>'<div style="margin:3px 0;color:var(--grey);"><b style="color:var(--amber);">'+CIRC[j]+'</b> '+esc(st)+'</div>').join("")+'</div>':'')+(r.move?'<div class="move">'+(r.move.old?'<span class="old">'+esc(r.move.old)+'</span> → ':'')+'<span class="new">'+esc(r.move.new)+'</span>'+(r.move.pill?'<span class="pill">'+esc(r.move.pill)+'</span>':'')+'</div>':'')+'</div></div>').join("");
// 推定インパクト（施策別の期待効果＋合計）
(function(){
const rows=D.impact.rows||[];
let h='<div style="font-size:12px;font-weight:700;color:var(--brand-dark)">推定インパクト（月間・施策別）</div>';
h+='<table style="margin-top:10px;background:transparent;"><thead><tr><th style="background:rgba(0,98,42,.08);">施策</th><th class="num" style="background:rgba(0,98,42,.08);">期待効果（月）</th><th style="background:rgba(0,98,42,.08);">前提</th></tr></thead><tbody>';
rows.forEach((r,i)=>{h+='<tr><td>'+(i+1)+'. '+r.t+'</td><td class="num" style="font-weight:700;">'+(r.lo!=null?('+'+yen(r.lo)+'〜'+yen(r.hi)):'—')+'</td><td style="font-size:11.5px;color:var(--brand-dark);opacity:.8;">'+esc(r.note)+'</td></tr>';});
h+='<tr><td style="font-weight:800;border-top:2px solid #B7E3C7;">合計</td><td class="num" style="font-weight:800;border-top:2px solid #B7E3C7;color:var(--brand-dark);">+'+yen(D.impact.lo)+'〜'+yen(D.impact.hi)+'</td><td style="border-top:2px solid #B7E3C7;font-weight:700;color:var(--brand-dark);">売上比 +'+up[0]+'〜'+up[1]+'%</td></tr></tbody></table>';
h+='<div class="big" style="margin-top:10px;">月間売上 +'+yen(D.impact.lo)+'〜'+yen(D.impact.hi)+'（+'+up[0]+'〜'+up[1]+'%）</div>';
document.getElementById("impact").innerHTML=h;
})();
</script>`;
