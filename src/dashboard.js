// ダッシュボード生成 -------------------------------------------------------
// data/*.jsonl を読み、自己完結HTML（外部CDN不使用・データ埋め込み）を出力する。
// クロールのたびに再生成して dashboard.html を開けば最新の集計が見られる。
//
//   node src/dashboard.js   →  dashboard.html

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const DATA_FILES = ["data/prices.jsonl", "data/prices-times.jsonl"];
const OUT = "dashboard.html";

const OPERATOR_LABEL = { npc: "NPC", repark: "三井のリパーク", times: "タイムズ" };

function loadRecords() {
  const recs = [];
  for (const f of DATA_FILES) {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) continue;
    for (const line of fs.readFileSync(abs, "utf8").split("\n").filter(Boolean)) {
      try { recs.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return recs;
}

// 円/時に正規化（代表として最初の時間帯単価を使う）
function yenPerHour(rec) {
  const u = (rec.unitCharges ?? [])[0];
  if (!u || !u.perMinutes) return null;
  return Math.round((u.amountYen / u.perMinutes) * 60);
}

// 代表的な最大料金（最安区分＝多くは24時間 or 夜間上限の最小値）
function repMaxFee(rec) {
  const fees = (rec.maxFees ?? []).map((m) => m.amountYen).filter((n) => n > 0);
  return fees.length ? Math.min(...fees) : null;
}

function prefOf(rec) {
  const m = (rec.address ?? "").match(/^(.+?[都道府県])/);
  return m ? m[1] : "不明";
}

function main() {
  const all = loadRecords();

  // 最新スナップショット（operator:parkId ごとに fetchedAt 最大）
  const latest = new Map();
  for (const r of all) {
    const k = `${r.operator}:${r.parkId}`;
    const prev = latest.get(k);
    if (!prev || new Date(r.fetchedAt) >= new Date(prev.fetchedAt)) latest.set(k, r);
  }
  const lots = [...latest.values()];

  // 価格変動レコード（changedFromPrev）を日付ごとに
  const changes = all
    .filter((r) => r.changedFromPrev)
    .sort((a, b) => new Date(b.fetchedAt) - new Date(a.fetchedAt));

  // 各物件の集計用スリムデータ
  const slim = lots.map((r) => ({
    op: r.operator,
    name: r.name,
    pref: prefOf(r),
    yph: yenPerHour(r),
    max: repMaxFee(r),
    lat: r.lat,
    lng: r.lng,
  }));

  const lastUpdated = all.reduce(
    (m, r) => (r.fetchedAt > m ? r.fetchedAt : m), ""
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    lastUpdated,
    operatorLabel: OPERATOR_LABEL,
    lots: slim,
    changes: changes.map((r) => ({
      op: r.operator, name: r.name, pref: prefOf(r),
      yph: yenPerHour(r), max: repMaxFee(r), at: r.fetchedAt,
    })),
  };

  const html = render(payload);
  fs.writeFileSync(path.resolve(OUT), html);
  console.log(
    `dashboard 生成: ${OUT} | 物件${lots.length}件 / 変動${changes.length}件 / 最終更新 ${lastUpdated || "—"}`
  );
}

function render(payload) {
  // データを埋め込み、ブラウザ側の vanilla JS で SVG チャートを描画する。
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>駐車場料金ダッシュボード</title>
<style>
  :root { --bg:#0f1419; --card:#1a2129; --fg:#e6edf3; --muted:#8b949e;
          --npc:#3fb950; --repark:#58a6ff; --times:#f78166; --grid:#30363d; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif; }
  header { padding:24px 28px 12px; }
  h1 { margin:0; font-size:20px; }
  .sub { color:var(--muted); font-size:13px; margin-top:4px; }
  .wrap { padding:12px 28px 48px; display:grid; gap:20px;
          grid-template-columns:repeat(12,1fr); }
  .card { background:var(--card); border:1px solid var(--grid); border-radius:12px;
          padding:18px 20px; }
  .card h2 { margin:0 0 14px; font-size:14px; font-weight:600; color:var(--fg); }
  .col-12{grid-column:span 12} .col-8{grid-column:span 8} .col-6{grid-column:span 6}
  .col-4{grid-column:span 4} .col-3{grid-column:span 3}
  @media(max-width:880px){ .wrap>*{grid-column:span 12 !important} }
  .kpis { display:flex; gap:18px; flex-wrap:wrap; }
  .kpi { flex:1; min-width:120px; }
  .kpi .n { font-size:28px; font-weight:700; }
  .kpi .l { font-size:12px; color:var(--muted); margin-top:2px; }
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .legend{font-size:12px;color:var(--muted);display:flex;gap:16px;margin-bottom:8px;flex-wrap:wrap}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--grid)}
  th{color:var(--muted);font-weight:600}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .empty{color:var(--muted);font-size:13px;padding:8px 0}
  svg{display:block;width:100%;height:auto;overflow:visible}
  .bar-label{font-size:11px;fill:var(--muted)}
  input{background:#0d1117;border:1px solid var(--grid);color:var(--fg);
        border-radius:7px;padding:7px 10px;font-size:13px;width:220px}
</style></head><body>
<header>
  <h1>🅿️ 駐車場料金ダッシュボード</h1>
  <div class="sub" id="sub"></div>
</header>
<div class="wrap">
  <div class="card col-12"><div class="kpis" id="kpis"></div></div>
  <div class="card col-6"><h2>事業者別 料金水準（中央値）</h2><div id="opcompare"></div></div>
  <div class="card col-6"><h2>時間単価の分布（円/時）</h2>
    <div class="legend" id="leg1"></div><div id="hist-yph"></div></div>
  <div class="card col-6"><h2>最大料金の分布（円・最安区分）</h2>
    <div class="legend" id="leg2"></div><div id="hist-max"></div></div>
  <div class="card col-6"><h2>都道府県別 物件数（上位15）</h2><div id="pref"></div></div>
  <div class="card col-6"><h2>地理分布（経度×緯度）</h2>
    <div class="legend" id="leg3"></div><div id="geo"></div></div>
  <div class="card col-6"><h2>最近の料金変動</h2><div id="changes"></div></div>
  <div class="card col-12"><h2>物件一覧（検索）</h2>
    <input id="q" placeholder="物件名・都道府県で絞り込み"><div id="tbl"></div></div>
</div>
<script id="data" type="application/json">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const COL = {npc:'var(--npc)',repark:'var(--repark)',times:'var(--times)'};
const LBL = D.operatorLabel;
const ops = [...new Set(D.lots.map(l=>l.op))];
const fmt = n => n==null?'—':n.toLocaleString('ja-JP');
const jst = s => s? new Date(s).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
const median = a => { if(!a.length)return null; const s=[...a].sort((x,y)=>x-y); const m=s.length>>1; return s.length%2?s[m]:Math.round((s[m-1]+s[m])/2); };

document.getElementById('sub').textContent =
  '最終更新 ' + jst(D.lastUpdated) + '（JST） / 生成 ' + jst(D.generatedAt);

// KPI
const kpiEl = document.getElementById('kpis');
kpiEl.innerHTML =
  '<div class="kpi"><div class="n">'+fmt(D.lots.length)+'</div><div class="l">総物件数</div></div>' +
  ops.map(op=>'<div class="kpi"><div class="n" style="color:'+COL[op]+'">'+
    fmt(D.lots.filter(l=>l.op===op).length)+'</div><div class="l">'+LBL[op]+'</div></div>').join('') +
  '<div class="kpi"><div class="n">'+fmt(D.changes.length)+'</div><div class="l">料金変動（累計）</div></div>';

function legend(el){ el.innerHTML = ops.map(op=>'<span><span class="dot" style="background:'+COL[op]+'"></span>'+LBL[op]+'</span>').join(''); }
legend(document.getElementById('leg1')); legend(document.getElementById('leg2')); legend(document.getElementById('leg3'));

// 事業者比較（中央値 円/時 と 最大料金）
(function(){
  const rows = ops.map(op=>{
    const ls = D.lots.filter(l=>l.op===op);
    return {op, yph:median(ls.map(l=>l.yph).filter(Boolean)), max:median(ls.map(l=>l.max).filter(Boolean))};
  });
  const maxY = Math.max(...rows.map(r=>r.yph||0),1);
  const maxM = Math.max(...rows.map(r=>r.max||0),1);
  let h='<table><tr><th>事業者</th><th class="num">円/時(中央値)</th><th class="num">最大料金(中央値)</th></tr>';
  rows.forEach(r=>{ h+='<tr><td><span class="dot" style="background:'+COL[r.op]+'"></span>'+LBL[r.op]+
    '</td><td class="num">'+fmt(r.yph)+'</td><td class="num">'+fmt(r.max)+'</td></tr>'; });
  h+='</table>';
  document.getElementById('opcompare').innerHTML=h;
})();

// ヒストグラム（操作別の積み上げ）
function histogram(elId, field, binSize, maxVal){
  const el=document.getElementById(elId);
  const vals = D.lots.map(l=>({op:l.op,v:l[field]})).filter(o=>o.v!=null && o.v<=maxVal);
  if(!vals.length){ el.innerHTML='<div class="empty">データなし</div>'; return; }
  const nbins = Math.ceil(maxVal/binSize);
  const bins = Array.from({length:nbins},()=>({}));
  vals.forEach(o=>{ const b=Math.min(nbins-1,Math.floor(o.v/binSize)); bins[b][o.op]=(bins[b][o.op]||0)+1; });
  const peak = Math.max(...bins.map(b=>Object.values(b).reduce((a,c)=>a+c,0)),1);
  const W=440,H=180,padL=34,padB=24,bw=(W-padL)/nbins;
  let s='<svg viewBox="0 0 '+W+' '+H+'">';
  for(let g=0; g<=4; g++){ const y=10+(H-padB-10)*(1-g/4); const v=Math.round(peak*g/4);
    s+='<line x1="'+padL+'" y1="'+y+'" x2="'+W+'" y2="'+y+'" stroke="var(--grid)"/>';
    s+='<text x="'+(padL-6)+'" y="'+(y+3)+'" text-anchor="end" class="bar-label">'+v+'</text>'; }
  bins.forEach((b,i)=>{ let yacc=0; const x=padL+i*bw;
    ops.forEach(op=>{ const c=b[op]||0; if(!c)return; const hgt=(H-padB-10)*c/peak;
      const y=10+(H-padB-10)-yacc-hgt; yacc+=hgt;
      s+='<rect x="'+(x+1)+'" y="'+y+'" width="'+(bw-2)+'" height="'+hgt+'" fill="'+COL[op]+'"/>'; });
    if(i%Math.ceil(nbins/6)===0) s+='<text x="'+(x+bw/2)+'" y="'+(H-8)+'" text-anchor="middle" class="bar-label">'+(i*binSize)+'</text>';
  });
  s+='</svg>'; el.innerHTML=s;
}
histogram('hist-yph','yph',100,2000);
histogram('hist-max','max',300,5000);

// 都道府県別 上位15
(function(){
  const cnt={}; D.lots.forEach(l=>cnt[l.pref]=(cnt[l.pref]||0)+1);
  const rows=Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,15);
  const max=Math.max(...rows.map(r=>r[1]),1);
  let h='';
  rows.forEach(([p,c])=>{ h+='<div style="display:flex;align-items:center;gap:8px;margin:3px 0;font-size:12px">'+
    '<div style="width:78px;color:var(--muted)">'+p+'</div>'+
    '<div style="flex:1;background:#0d1117;border-radius:4px"><div style="width:'+(100*c/max)+'%;background:var(--repark);height:14px;border-radius:4px"></div></div>'+
    '<div class="num" style="width:46px">'+fmt(c)+'</div></div>'; });
  document.getElementById('pref').innerHTML=h;
})();

// 地理分布 scatter（経度x, 緯度y）
(function(){
  const pts=D.lots.filter(l=>l.lat&&l.lng);
  const el=document.getElementById('geo');
  if(!pts.length){ el.innerHTML='<div class="empty">座標を持つ物件がありません（タイムズは座標なし）</div>'; return; }
  const W=440,H=300, lo=124,hi=146, la0=26,la1=46; // 日本のおおよその範囲
  const X=lng=>(lng-lo)/(hi-lo)*W, Y=lat=>H-(lat-la0)/(la1-la0)*H;
  let s='<svg viewBox="0 0 '+W+' '+H+'" style="background:#0d1117;border-radius:8px">';
  pts.forEach(p=>{ s+='<circle cx="'+X(p.lng).toFixed(1)+'" cy="'+Y(p.lat).toFixed(1)+'" r="1.6" fill="'+COL[p.op]+'" opacity="0.7"/>'; });
  s+='</svg>'; el.innerHTML=s;
})();

// 最近の料金変動
(function(){
  const el=document.getElementById('changes');
  if(!D.changes.length){ el.innerHTML='<div class="empty">まだ料金変動は検知されていません（収集が一巡すると差分が出ます）</div>'; return; }
  let h='<table><tr><th>日時</th><th>事業者</th><th>物件</th><th class="num">円/時</th><th class="num">最大</th></tr>';
  D.changes.slice(0,30).forEach(c=>{ h+='<tr><td>'+jst(c.at)+'</td><td><span class="dot" style="background:'+COL[c.op]+'"></span>'+LBL[c.op]+
    '</td><td>'+(c.name||'')+'</td><td class="num">'+fmt(c.yph)+'</td><td class="num">'+fmt(c.max)+'</td></tr>'; });
  h+='</table>'; el.innerHTML=h;
})();

// 物件一覧（検索）
(function(){
  const tbl=document.getElementById('tbl'), q=document.getElementById('q');
  function draw(f){
    const ls=D.lots.filter(l=>!f || (l.name||'').includes(f) || (l.pref||'').includes(f)).slice(0,300);
    let h='<table><tr><th>事業者</th><th>都道府県</th><th>物件</th><th class="num">円/時</th><th class="num">最大料金</th></tr>';
    ls.forEach(l=>{ h+='<tr><td><span class="dot" style="background:'+COL[l.op]+'"></span>'+LBL[l.op]+
      '</td><td>'+l.pref+'</td><td>'+(l.name||'')+'</td><td class="num">'+fmt(l.yph)+'</td><td class="num">'+fmt(l.max)+'</td></tr>'; });
    h+='</table>'; if(D.lots.length>300) h+='<div class="empty">※先頭300件のみ表示。検索で絞り込めます</div>';
    tbl.innerHTML=h;
  }
  q.addEventListener('input',e=>draw(e.target.value.trim()));
  draw('');
})();
</script>
</body></html>`;
}

main();
