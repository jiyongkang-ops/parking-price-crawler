// レポート生成 -------------------------------------------------------------
// metrics(parse-records) + competitors + 現行料金 → お客様提示用HTMLを生成。
// グラフはデータ埋め込み＋インラインJSでSVG描画（外部CDN不使用）。

const yen = (n) => (n == null ? "—" : "¥" + Number(n).toLocaleString("ja-JP"));
const median = (a) => { a = a.filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };

// ルールベースの提言と増収試算を組み立てる
export function buildRecommendations(metrics, comps, current) {
  const nightComps = comps.map((c) => c.nightMax).filter(Boolean);
  const nightMed = median(nightComps);
  const dayComps = comps.map((c) => c.dayMax).filter(Boolean);
  const recs = [];
  const peakFull = metrics.peak.fullNights / Math.max(1, metrics.peak.nights) >= 0.5;

  // ① 夜間値上げ（満車＋周辺より安い場合）
  if (current.nightMax && nightMed && current.nightMax < nightMed && peakFull) {
    const target = Math.round(nightMed / 100) * 100;
    const up = Math.round((100 * (target - current.nightMax)) / current.nightMax);
    recs.push({ kind: "g", t: "夜間の時間帯最大を引き上げる（満車＆周辺最安のため正当）",
      d: `夜間は実効満車かつ周辺で最安クラス。周辺中央値（約${yen(nightMed)}）まで上げても競争力を保てる。`,
      move: { old: `夜間最大 ${yen(current.nightMax)}`, new: `${yen(target)}`, pill: `+${up}%` }, target });
  }
  // ② 日中値下げ（割高＋低稼働）
  const dayAvg = metrics.dayCurve.find((d) => d.label === "2-3h")?.avgFee ?? metrics.dayCurve.at(-1)?.avgFee;
  const dayMedComp = median(dayComps);
  if (dayAvg && dayMedComp && dayAvg > dayMedComp) {
    recs.push({ kind: "a", t: "日中を値下げして空き時間を埋める",
      d: `日中は割高で稼働が低い。日中最大を周辺並み（約${yen(dayMedComp)}）に下げ、流出している日中需要を取り込む。`,
      move: { old: `日中 約${yen(dayAvg)}`, new: `約${yen(dayMedComp)}` } });
  }
  // ③ 未払い是正
  if (metrics.unpaid.count > 0) {
    recs.push({ kind: "a", t: "未払い（未回収）の是正",
      d: `未払い${metrics.unpaid.rate}%・月約${yen(metrics.unpaid.amount)}は、事前精算の徹底・アプリ決済誘導・督促フローの整備で回収率を高める。`,
      move: { new: `未回収 月約${yen(metrics.unpaid.amount)} の圧縮` } });
  }

  // 増収試算（夜間値上げ＝最大料金到達層への反映 ＋ 未払い是正）
  let lo = 0, hi = 0;
  const r1 = recs.find((r) => r.target);
  if (r1) {
    const share = 0.7; // 最大料金到達層の売上シェア目安
    const upRate = (r1.target - current.nightMax) / current.nightMax;
    lo += Math.round(metrics.revenue * share * upRate * 0.7);
    hi += Math.round(metrics.revenue * share * upRate);
  }
  const impact = { lo: lo, hi: hi, unpaid: metrics.unpaid.amount,
    pct: metrics.revenue ? [Math.round(100 * lo / metrics.revenue), Math.round(100 * hi / metrics.revenue)] : [0, 0] };
  return { recs, impact, nightMed, dayMedComp };
}

export function renderReport(metrics, comps, current = {}, opts = {}) {
  const changes = opts.changes ?? [];
  const { recs, impact, nightMed } = buildRecommendations(metrics, comps, current);
  const cap = metrics.capacity;
  const fmtDate = (d) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  // 夜間比較データ（当駐車場＋競合、nightMaxを持つもの）
  const nightRows = comps.filter((c) => c.nightMax).map((c) => ({ n: (c.name || c.opLabel).replace(/駐車場$/, "").slice(0, 22), v: c.nightMax, self: false }));
  if (current.nightMax) nightRows.push({ n: `当駐車場（${metrics.parkName}）`, v: current.nightMax, self: true });
  // 日中比較（1h/3h：当駐車場＝dayCurve、競合＝unit・dayMax概算）
  const dayRows = [{ n: `当駐車場（${metrics.parkName}）`, self: true,
    h1: current.dayHour1 ?? metrics.dayCurve[0]?.avgFee, h3: current.dayMax ?? metrics.dayCurve.at(-1)?.avgFee }]
    .concat(comps.filter((c) => c.yph || c.dayMax).slice(0, 7).map((c) => ({ n: (c.name || c.opLabel).replace(/駐車場$/, "").slice(0, 18), self: false, h1: c.yph, h3: c.dayMax })));

  const payload = {
    park: metrics.parkName, address: opts.address ?? "", period: `${fmtDate(metrics.period.from)}–${fmtDate(metrics.period.to)}`,
    sessions: metrics.sessions, revenue: metrics.revenue, avgDur: metrics.avgDurationMin,
    cap, peak: metrics.peak, unpaid: metrics.unpaid,
    current, impact, nightMed,
    occ: metrics.hourly.occWeekday, ent: metrics.hourly.entWeekday,
    spaceUse: metrics.spaceUse, feeTiers: metrics.feeTiers, maxTierCount: metrics.maxTierCount,
    nightRows, dayRows, recs,
    changes: changes.map((c) => ({ op: c.opLabel, name: c.name, dist: c.dist, at: c.at, night: c.fee?.max24h ?? null })),
    genAt: opts.genAt ?? "",
  };
  return TEMPLATE.replace("/*__PAYLOAD__*/", JSON.stringify(payload).replace(/</g, "\\u003c"));
}

// テンプレHTML（roppongi-proposal.html を汎用化）。__PAYLOAD__ にデータを注入。
const TEMPLATE = `<title>駐車場 料金ご提案</title>
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
  .tag{font-size:11px;font-weight:700;padding:2px 8px;border-radius:5px;background:#EEF1EE;color:#3d7a1f;}
  .rec{display:flex;gap:16px;align-items:flex-start;padding:16px 0;border-bottom:1px solid var(--line-soft);} .rec:last-child{border-bottom:none;} .rec .n{flex:0 0 30px;height:30px;border-radius:8px;color:#fff;display:grid;place-items:center;font-weight:800;} .rec .n.g{background:var(--brand);} .rec .n.a{background:var(--amber);} .rec .t{font-weight:700;font-size:15px;} .rec .d{color:var(--grey);font-size:13px;margin-top:3px;}
  .move{margin-top:6px;font-weight:800;font-variant-numeric:tabular-nums;} .move .old{color:var(--faint);text-decoration:line-through;} .move .new{color:var(--brand-dark);} .move .pill{background:var(--brand-light);color:var(--brand-dark);border-radius:999px;padding:1px 9px;font-size:12px;margin-left:6px;}
  .callout{background:var(--brand-light);border:1px solid #B7E3C7;border-radius:12px;padding:18px 20px;margin-top:16px;} .callout .big{font-size:26px;font-weight:800;color:var(--brand-dark);}
  .flag{background:var(--brand-light);border:1px solid #B7E3C7;border-radius:12px;padding:16px 20px;margin-bottom:16px;display:flex;gap:14px;} .flag .em{font-size:22px;} .flag .t{font-weight:800;font-size:15px;color:var(--brand-dark);} .flag .d{font-size:13px;color:var(--brand-dark);margin-top:2px;}
  svg{display:block;width:100%;height:auto;overflow:visible;}
  @page{margin:12mm;} @media print{*{-webkit-print-color-adjust:exact;print-color-adjust:exact;}body{background:#fff;}.card,.kpi,.callout,.flag,.rec{break-inside:avoid;}.section{break-inside:avoid-page;}}
</style>
<header><div class="wrap"><h1 id="h1"></h1><div class="h1sub">売上最大化のための料金診断</div><div class="meta" id="meta"></div></div></header>
<div class="wrap">
  <div class="grid k4" style="margin-bottom:16px;" id="kpis"></div>
  <div class="flag" id="flag" style="display:none;"></div>
  <div class="section"><div class="sec-h"><span class="no">01</span><h2>いつ混み、いつ空くか</h2></div>
    <div class="card"><p class="chart-t">時間帯別 稼働台数（平日・平均同時利用）</p><div id="c-occ"></div>
      <div class="legend"><span><span class="dot" style="background:var(--brand)"></span>稼働台数</span><span><span class="dot" style="background:var(--amber)"></span>入庫数</span></div></div>
    <div class="grid k2" style="margin-top:16px;"><div class="card"><p class="chart-t">車室別 利用回数</p><div id="c-space"></div></div>
      <div class="card"><p class="chart-t">料金階層の内訳</p><div id="c-fee"></div></div></div>
    <div class="section" id="unpaid-wrap" style="display:none;"><div class="card" style="border-left:3px solid var(--amber);"><p class="chart-t" id="unpaid-t" style="color:#9A5B00;"></p><p class="chart-c" id="unpaid-d"></p></div></div>
  </div>
  <div class="section"><div class="sec-h"><span class="no">02</span><h2>混雑時／閑散時、周辺より高いか安いか</h2></div>
    <p class="sec-sub">周辺駐車場（公開料金を調査）と、需要が高い夜間・低い日中で比較。</p>
    <div class="card"><p class="chart-t">夜間 最大料金の比較（当駐車場 vs 周辺）</p><div id="c-night"></div></div>
    <div class="card" style="margin-top:16px;overflow-x:auto;"><p class="chart-t">日中の料金比較</p><table><thead><tr><th>駐車場</th><th class="num">1時間</th><th class="num">3時間/日中最大</th></tr></thead><tbody id="tbl-day"></tbody></table></div>
  </div>
  <div class="section"><div class="sec-h"><span class="no">03</span><h2>周辺の最近の料金変更</h2></div><div class="card" id="changes-card"></div></div>
  <div class="section"><div class="sec-h"><span class="no">04</span><h2>売上最大化の料金設計</h2></div>
    <div class="card" id="recs"></div><div class="callout" id="impact"></div></div>
</div>
<script id="d" type="application/json">/*__PAYLOAD__*/</script>
<script>
const D=JSON.parse(document.getElementById("d").textContent);const yen=n=>n==null?"—":"¥"+Number(n).toLocaleString("ja-JP");
document.getElementById("h1").textContent=D.park;
document.getElementById("meta").innerHTML=[D.address&&"📍 <b>"+D.address+"</b>","🚗 <b>実効"+D.cap.effective+"車室"+(D.cap.blocked.length?"（"+D.cap.blocked.join("・")+"は封鎖）":"")+"</b>","📅 <b>"+D.period+"</b>（"+D.sessions.toLocaleString()+"回駐車）",D.current.unit&&"💳 現行 <b>"+D.current.unit+(D.current.nightMax?" / 夜間最大"+yen(D.current.nightMax):"")+"</b>"].filter(Boolean).join("");
// KPI
const upl=D.impact.pct;
document.getElementById("kpis").innerHTML=[
 ["月間売上（実績）",yen(D.revenue),D.sessions+"件・平均"+D.avgDur+"分",""],
 ["実効車室数（上限）",D.cap.effective+"<small>台</small>",D.cap.blocked.length?"車室"+D.cap.blocked.join("・")+"は封鎖":"",""],
 ["夜間ピーク稼働",D.peak.max+"<small>/"+D.cap.effective+"台</small>",D.peak.nights+"夜中"+D.peak.fullNights+"夜が満車","accent"],
 ["推定 増収余地","+"+upl[0]+"–"+upl[1]+"<small>%</small>","月 +"+yen(D.impact.lo)+"–"+yen(D.impact.hi).replace("¥",""),"accent"],
].map(k=>'<div class="kpi card '+k[3]+'"><div class="lbl">'+k[0]+'</div><div class="val tnum">'+k[1]+'</div><div class="sub">'+k[2]+'</div></div>').join("");
// flag（封鎖がある場合）
if(D.cap.blocked.length){const f=document.getElementById("flag");f.style.display="";f.innerHTML='<div class="em">📌</div><div><div class="t">前提：車室'+D.cap.blocked.join("・")+'は封鎖。実効キャパ'+D.cap.effective+'台が上限。</div><div class="d"><b>'+D.cap.effective+'台がフル稼働の上限</b>。夜間ピークは'+D.peak.nights+'夜中'+D.peak.fullNights+'夜が満車。供給を増やせない以上、ピーク時に売上を伸ばす手段は<b>価格</b>。</div></div>';}
// 稼働×入庫
(function(){const O=D.occ,E=D.ent,W=880,H=240,pL=34,pB=26,pT=10,pw=W-pL-20,ph=H-pB-pT;const x=i=>pL+i*(pw/24)+(pw/24)/2,yO=v=>pT+ph*(1-v/D.cap.effective);const mE=Math.max(...E,1),yE=v=>pT+ph*(1-v/mE);let s='<svg viewBox="0 0 '+W+' '+H+'">';for(let g=0;g<=D.cap.effective;g+=Math.ceil(D.cap.effective/3)){const gy=yO(g);s+='<line x1="'+pL+'" y1="'+gy+'" x2="'+(W-20)+'" y2="'+gy+'" stroke="rgba(0,0,0,.06)"/><text x="'+(pL-6)+'" y="'+(gy+4)+'" text-anchor="end" font-size="10" fill="#9AA096">'+g+'</text>';}const bw=pw/24*.6;O.forEach((v,i)=>{const h=ph*(v/D.cap.effective);s+='<rect x="'+(x(i)-bw/2)+'" y="'+(pT+ph-h)+'" width="'+bw+'" height="'+h+'" rx="2" fill="#009B3E" opacity="'+((i>=19||i<2)?.95:.5)+'"/>';});s+='<polyline points="'+E.map((v,i)=>x(i)+","+yE(v)).join(" ")+'" fill="none" stroke="#D98200" stroke-width="2.2"/>';for(let i=0;i<24;i+=2)s+='<text x="'+x(i)+'" y="'+(H-8)+'" text-anchor="middle" font-size="10" fill="#9AA096">'+i+'時</text>';document.getElementById("c-occ").innerHTML=s+"</svg>";})();
// 車室別
(function(){const keys=Object.keys(D.spaceUse).map(Number);const all=[];for(let n=1;n<=D.cap.nominal;n++)all.push([n,D.spaceUse[n]||0]);const max=Math.max(...all.map(a=>a[1]),1);const W=440,bh=13,gap=4,pL=44,pT=4,H=pT+all.length*(bh+gap);let s='<svg viewBox="0 0 '+W+' '+H+'">';all.forEach(([k,v],i)=>{const y=pT+i*(bh+gap);const dead=v===0;s+='<text x="'+(pL-6)+'" y="'+(y+bh-2)+'" text-anchor="end" font-size="10" fill="'+(dead?"#8a7a55":"#9AA096")+'">車室'+k+'</text>';if(dead)s+='<rect x="'+pL+'" y="'+y+'" width="'+(W-pL-40)+'" height="'+bh+'" rx="2" fill="#F0EEE9"/><text x="'+(pL+6)+'" y="'+(y+bh-2)+'" font-size="10" fill="#8a7a55" font-weight="700">封鎖（0回）</text>';else{const w=(W-pL-40)*(v/max);s+='<rect x="'+pL+'" y="'+y+'" width="'+w+'" height="'+bh+'" rx="2" fill="#B7DEC6"/><text x="'+(pL+w+4)+'" y="'+(y+bh-2)+'" font-size="10" fill="#63685F">'+v+'</text>';}});document.getElementById("c-space").innerHTML=s+"</svg>";})();
// 料金階層
(function(){const mt=D.maxTierCount,tot=D.sessions,other=tot-mt;const rows=[["最大料金 到達層",mt,"#009B3E"],["単価・短時間ほか",other,"#B7DEC6"]];let s='<div style="display:flex;flex-direction:column;gap:12px;margin-top:6px;">';rows.forEach(([l,n,c])=>{const p=Math.round(100*n/tot);s+='<div><div style="display:flex;justify-content:space-between;font-size:12px;"><span>'+l+'</span><span style="font-weight:700">'+n+'件・'+p+'%</span></div><div style="background:#EEF1EE;border-radius:5px;height:12px;margin-top:3px;"><div style="width:'+p+'%;height:12px;border-radius:5px;background:'+c+'"></div></div></div>';});document.getElementById("c-fee").innerHTML=s+"</div>";})();
// 未払い
if(D.unpaid.count>0){document.getElementById("unpaid-wrap").style.display="";document.getElementById("unpaid-t").textContent="未回収（未払い）が月 約"+yen(D.unpaid.amount);document.getElementById("unpaid-d").innerHTML=D.sessions+"件中 <b>"+D.unpaid.count+"件（"+D.unpaid.rate+"%）が未払い</b>。精算されない出庫が主因とみられ、料金改定と同規模の増収余地。";}
// 夜間比較
(function(){const rows=[...D.nightRows].sort((a,b)=>b.v-a.v);if(!rows.length){document.getElementById("c-night").innerHTML='<div style="color:#9AA096;font-size:12px">競合の夜間最大データが未取得です</div>';return;}const W=900,bh=26,gap=10,pL=250,pT=6,H=pT+rows.length*(bh+gap);const max=Math.max(...rows.map(r=>r.v))*1.1,sc=(W-pL-70)/max;let s='<svg viewBox="0 0 '+W+' '+H+'">';rows.forEach((d,i)=>{const y=pT+i*(bh+gap),w=d.v*sc;s+='<text x="'+(pL-8)+'" y="'+(y+bh/2+4)+'" text-anchor="end" font-size="10.5" fill="'+(d.self?"#00622A":"#63685F")+'" font-weight="'+(d.self?800:500)+'">'+d.n+'</text><rect x="'+pL+'" y="'+y+'" width="'+w+'" height="'+bh+'" rx="3" fill="'+(d.self?"#D98200":"#B7DEC6")+'"/><text x="'+(pL+w+6)+'" y="'+(y+bh/2+4)+'" font-size="11.5" font-weight="800">'+yen(d.v)+'</text>';});if(D.nightMed){const rx=pL+D.nightMed*sc;s+='<line x1="'+rx+'" y1="0" x2="'+rx+'" y2="'+H+'" stroke="#009B3E" stroke-width="1.5" stroke-dasharray="4 3"/>';}document.getElementById("c-night").innerHTML=s+"</svg>";})();
// 日中テーブル
document.getElementById("tbl-day").innerHTML=D.dayRows.map(d=>'<tr class="'+(d.self?"hot":"")+'"><td'+(d.self?' style="font-weight:800"':'')+'>'+d.n+'</td><td class="num">'+yen(d.h1)+(d.self?" ⚠":"")+'</td><td class="num">'+yen(d.h3)+'</td></tr>').join("");
// 提言
document.getElementById("recs").innerHTML=D.recs.map((r,i)=>'<div class="rec"><div class="n '+r.kind+'">'+(i+1)+'</div><div><div class="t">'+r.t+'</div><div class="d">'+r.d+'</div>'+(r.move?'<div class="move">'+(r.move.old?'<span class="old">'+r.move.old+'</span> → ':'')+'<span class="new">'+r.move.new+'</span>'+(r.move.pill?'<span class="pill">'+r.move.pill+'</span>':'')+'</div>':'')+'</div></div>').join("");
// インパクト
document.getElementById("impact").innerHTML='<div style="font-size:12px;font-weight:700;color:var(--brand-dark)">推定インパクト</div><div class="big">月間売上 +'+yen(D.impact.lo)+'〜'+yen(D.impact.hi)+'（+'+upl[0]+'〜'+upl[1]+'%）</div>'+(D.unpaid.amount?'<div style="font-size:13px;color:var(--brand-dark);margin-top:4px">加えて未払い是正で最大 +'+yen(D.unpaid.amount)+'/月 の回収余地。</div>':'');
// 周辺の最近の料金変更
(function(){const el=document.getElementById("changes-card");if(!D.changes.length){el.innerHTML='<div style="color:var(--grey);font-size:13px">現時点で周辺の料金変更は検知されていません。<span style="color:var(--faint)">（周辺料金の継続収集により、変更が起きると自動で反映されます）</span></div>';return;}el.innerHTML='<table><thead><tr><th>日時</th><th>駐車場</th><th class="num">距離</th></tr></thead><tbody>'+D.changes.map(c=>'<tr><td>'+new Date(c.at).toLocaleDateString("ja-JP")+'</td><td>'+c.op+' '+(c.name||"")+'</td><td class="num">'+c.dist+'m</td></tr>').join("")+'</tbody></table>';})();
</script>`;
