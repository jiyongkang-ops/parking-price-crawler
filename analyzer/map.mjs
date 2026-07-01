// Google Static Maps 画像生成 ---------------------------------------------
// 当駐車場＋周辺競合をマーカー表示した地図PNGを取得し、data URIで返す。
// キーは環境変数 GOOGLE_MAPS_KEY（コード・設定に書かない）。
// キーが無ければ null を返す（レポート側でマップ非表示にフォールバック）。

// competitors: [{lat,lng,name,...}] 座標のあるものだけマーカー化（最大 markerLimit 件）
export async function staticMapDataUri({ target, competitors = [], zoom = 16, size = "640x420", markerLimit = 9 }) {
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key || !target?.lat) return { dataUri: null, marked: [] };

  const marked = competitors.filter((c) => c.lat && c.lng).slice(0, markerLimit);
  const params = [
    `center=${target.lat},${target.lng}`, `zoom=${zoom}`, `size=${size}`, `scale=2`,
    `maptype=roadmap`, `language=ja`, `region=JP`,
  ];
  // 当駐車場（緑・ラベルP）
  params.push(`markers=${encodeURIComponent(`size:mid|color:0x009B3E|label:P|${target.lat},${target.lng}`)}`);
  // 競合（番号 1..N）
  marked.forEach((c, i) => {
    params.push(`markers=${encodeURIComponent(`size:small|color:0x3366CC|label:${i + 1}|${c.lat},${c.lng}`)}`);
  });
  params.push(`key=${key}`);
  const url = `https://maps.googleapis.com/maps/api/staticmap?${params.join("&")}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return { dataUri: null, marked, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` };
    const buf = Buffer.from(await res.arrayBuffer());
    return { dataUri: `data:image/png;base64,${buf.toString("base64")}`, marked };
  } catch (e) {
    return { dataUri: null, marked, error: e.message };
  }
}
