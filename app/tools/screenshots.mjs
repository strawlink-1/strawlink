// Screenshots of every page and a few simulator scenarios, taken with headless Chrome over the
// DevTools protocol (Node 22+, no packages). Use it to see the 3D map when no browser window is
// available, and to refresh docs/img.
//   node app/tools/screenshots.mjs <base url> <out dir> [shot names…]
//   node app/tools/screenshots.mjs http://localhost:5173 docs/img-new sim-running air
// "farmers-chat" sends a real message; call POST /demo/reset afterwards.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [base, outDir, ...only] = process.argv.slice(2);
const PORT = 9333;
const chrome = [
  process.env.CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium",
].find((p) => p && existsSync(p));
if (!chrome) throw new Error("Chrome not found");
mkdirSync(outDir, { recursive: true });
const profile = join(tmpdir(), "strawlink-screenshots-profile"); // a throwaway profile, never the user's own

const proc = spawn(chrome, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars",
  "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--window-size=1440,810", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, nextId = 1;
const pending = new Map();
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
        return;
      }
    } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error("could not reach Chrome");
}
const send = (method, params = {}) => new Promise((res) => { const id = nextId++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};
const until = async (expression, ms = 60000, label = expression) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await js(expression)) return true; await sleep(400); }
  console.log("  timed out waiting for:", label.slice(0, 90));
  return false;
};
const size = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
const go = async (path) => { await send("Page.navigate", { url: base + path }); await until("document.readyState === 'complete' && !!document.getElementById('side-inner')?.innerText", 60000, "page load"); };
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.result.data, "base64"));
  console.log("saved", name);
};

// helpers that run in the page
const HELPERS = `
  window.__set = (el, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  window.__slider = (label, v) => { const box = [...document.querySelectorAll('.slider')].find((s) => s.querySelector('label')?.textContent.trim() === label); if (!box) return false; __set(box.querySelector('input[type=range]'), v); return true; };
  window.__time = (mins) => { const el = document.querySelector('input[aria-label="Time of day"]'); if (!el) return false; __set(el, mins); return true; };
  window.__click = (text) => { const b = [...document.querySelectorAll('button, a')].find((x) => x.textContent.trim().startsWith(text)); if (!b) return false; b.click(); return true; };
  window.__status = () => document.querySelector('.status')?.textContent ?? '';
  true`;
const planReady = () => until("(() => { const s = document.querySelector('.status'); return !!s && !s.classList.contains('busy') && !s.textContent.startsWith('Waiting'); })()", 90000, "plan ready");
const prep = async (path) => { await go(path); await js(HELPERS); };

const SHOTS = {
  "sim-start": async () => { await prep("/simulator"); await planReady(); await sleep(5000); await shot("sim-start"); },
  "sim-running": async () => { await prep("/simulator"); await planReady(); await sleep(2500); await js("__time(11 * 60 + 20)"); await sleep(4500); await shot("sim-running"); },
  "sim-follow": async () => {
    await prep("/simulator"); await planReady(); await sleep(2500); await js("__time(10 * 60 + 40)"); await sleep(1500);
    await js("(() => { const b = document.querySelector('.machines button'); b && b.click(); return !!b; })()"); await sleep(7000); await shot("sim-follow");
  },
  "field-card": async () => {
    // follow a machine so a field sits in the middle of the map, then click that field
    await prep("/simulator"); await planReady(); await sleep(2500); await js("__time(10 * 60 + 40)"); await sleep(1500);
    await js("(() => { const b = document.querySelector('.machines button'); b && b.click(); return !!b; })()"); await sleep(7000);
    const at = await js("(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.left + r.width / 2 + 41, y: r.top + r.height / 2 + 6 }; })()");
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 });
    await sleep(2500); await shot("field-card");
  },
  "sim-satellite": async () => {
    await prep("/simulator"); await planReady(); await sleep(1500);
    await js("(() => { const c = document.querySelector('#mapbar .check input'); if (c && !c.checked) c.click(); return !!c; })()");
    await sleep(9000); await js("__time(11 * 60 + 20)"); await sleep(4000); await shot("sim-satellite");
    await js("(() => { const b = document.querySelector('.machines button'); b && b.click(); return !!b; })()"); await sleep(7000); await shot("sim-satellite-close");
  },
  "sim-bigfleet": async () => {
    await prep("/simulator"); await planReady(); await sleep(1500);
    await js("__slider('Baler sets', 6)"); await js("__slider('Super Seeders', 6)"); await js("__slider('Trucks', 6)");
    await until("!!document.querySelector('.status.busy')", 8000, "planning starts"); await planReady(); await sleep(1500);
    await js("__time(11 * 60 + 20)"); await sleep(4500); await shot("sim-bigfleet");
  },
  "sim-rain": async () => {
    await prep("/simulator"); await planReady(); await sleep(1500); await js("__slider('Rain', 15)");
    await until("!!document.querySelector('.status.busy')", 8000, "planning starts"); await planReady(); await sleep(5000); await shot("sim-rain");
  },
  "sim-small": async () => { await size(962, 634); await prep("/simulator"); await planReady(); await sleep(2500); await js("__time(11 * 60 + 20)"); await sleep(4500); await shot("sim-small"); await size(1440, 810); },
  "forecast": async () => { await prep("/forecast"); await sleep(7000); await shot("forecast"); },
  "plants": async () => { await prep("/plants"); await until("document.querySelectorAll('.plant').length > 0", 40000, "plants"); await sleep(6000); await shot("plants"); },
  "farmers": async () => { await prep("/farmers"); await sleep(8000); await shot("farmers"); },
  "farmers-chat": async () => {
    await prep("/farmers"); await sleep(5000);
    await js("(() => { const b = [...document.querySelectorAll('.quick .chip')][2]; b && b.click(); return !!b; })()");
    await until("document.querySelectorAll('.thread .bubble.out:not(.quiet)').length >= 1", 60000, "assistant reply"); await sleep(2500); await shot("farmers-chat");
  },
  "air": async () => { await prep("/air"); await until("!!document.querySelector('.compass')", 60000, "wind"); await sleep(7000); await shot("air"); },
  "results": async () => {
    await prep("/results"); await until("+(document.querySelector('input[aria-label=\"Day\"]')?.max ?? 0) > 20", 60000, "replay"); await sleep(1500);
    await js("(() => { const el = document.querySelector('input[aria-label=\"Day\"]'); __set(el, Math.round(+el.max * 0.55)); return el.value; })()"); await sleep(7000); await shot("results");
  },
};

try {
  await connect();
  await send("Page.enable"); await send("Runtime.enable");
  await size(1440, 810);
  for (const [name, run] of Object.entries(SHOTS)) {
    if (only.length && !only.includes(name)) continue;
    try { await run(); } catch (e) { console.log("FAILED", name, String(e).slice(0, 300)); }
  }
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  proc.kill();
}
