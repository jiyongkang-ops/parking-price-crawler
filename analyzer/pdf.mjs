// ページ番号つきPDF生成 -----------------------------------------------------
// Chrome CLI(--print-to-pdf)はフッター指定不可のため、CDP(DevTools Protocol)で
// Page.printToPDF を叩く。依存なし（Node 22 のネイティブ WebSocket を使用）。

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function printToPdf(htmlPath, pdfPath) {
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "pk-pdf-"));
  const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", "--remote-debugging-port=0",
    `--user-data-dir=${udd}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const wsUrl = await new Promise((res, rej) => {
      let buf = "";
      const onData = (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); };
      proc.stderr.on("data", onData); proc.stdout.on("data", onData);
      setTimeout(() => rej(new Error("Chrome起動タイムアウト")), 15000);
    });
    const ws = new WebSocket(wsUrl);
    let id = 0; const pending = new Map(); let onEvent = null;
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("WS接続失敗")); });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
      else if (onEvent) onEvent(m);
    };
    const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
      const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId }));
    });

    const { targetId } = await send("Target.createTarget", { url: "file://" + path.resolve(htmlPath) });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await new Promise((res) => { onEvent = (m) => { if (m.method === "Page.loadEventFired" && m.sessionId === sessionId) res(); }; setTimeout(res, 8000); });
    await new Promise((r) => setTimeout(r, 700)); // チャート描画の余裕

    const footer = '<div style="font-size:9px;color:#9AA096;width:100%;text-align:center;font-family:\'Hiragino Sans\',sans-serif;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>';
    const { data } = await send("Page.printToPDF", {
      printBackground: true, displayHeaderFooter: true,
      headerTemplate: "<span></span>", footerTemplate: footer,
      marginTop: 0.47, marginBottom: 0.6, marginLeft: 0.47, marginRight: 0.47,
      preferCSSPageSize: false,
    }, sessionId);
    fs.writeFileSync(pdfPath, Buffer.from(data, "base64"));
    ws.close();
  } finally {
    proc.kill();
    try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
