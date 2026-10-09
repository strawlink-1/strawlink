// Frame-by-frame recorder for the web app: headless Chrome over the DevTools protocol, with the
// page's clocks replaced by one virtual clock, so every frame is rendered at an exact time and
// the result is smooth whatever the machine's speed. No packages; Node 22+.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FPS = 30;
export const W = 1280, H = 720, SCALE = 1.5; // CSS pixels × device scale = 1920 × 1080 frames

// Runs in the page before any of its scripts: timers, animation frames, CSS animations and the
// apparent duration of network requests all follow window.__film.step(ms).
const SHIM = `(() => {
  const realNow = performance.now.bind(performance), realTimeout = window.setTimeout.bind(window), realFetch = window.fetch.bind(window);
  const base = Date.now();
  let vt = 0, seq = 1, rafs = [];
  const timers = new Map();
  performance.now = () => vt;
  Date.now = () => base + vt;
  window.setTimeout = (fn, ms = 0, ...a) => { const id = seq++; timers.set(id, { at: vt + Math.max(0, +ms || 0), fn, a, every: 0 }); return id; };
  window.setInterval = (fn, ms = 0, ...a) => { const id = seq++; const e = Math.max(1, +ms || 0); timers.set(id, { at: vt + e, fn, a, every: e }); return id; };
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };
  window.requestAnimationFrame = (fn) => { const id = seq++; rafs.push({ id, fn }); return id; };
  window.cancelAnimationFrame = (id) => { rafs = rafs.filter((r) => r.id !== id); };
  const seen = new WeakMap();
  window.__film = {
    now: () => vt,
    step(ms) {
      const target = vt + ms;
      for (let guard = 0; guard < 5000; guard++) {
        let next = null, nid = 0;
        for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next.at)) { next = t; nid = id; }
        if (!next) break;
        vt = Math.max(vt, next.at);
        if (next.every) next.at += next.every; else timers.delete(nid);
        try { if (typeof next.fn === "function") next.fn(...next.a); } catch (e) { console.error(e); }
      }
      vt = target;
      const run = rafs; rafs = [];
      for (const r of run) { try { r.fn(vt); } catch (e) { console.error(e); } }
      for (const a of document.getAnimations()) {
        if (!seen.has(a)) { seen.set(a, vt - ms); try { a.pause(); } catch {} }
        const cur = vt - seen.get(a), end = a.effect?.getComputedTiming().endTime;
        try { if (Number.isFinite(end) && cur >= end) a.finish(); else a.currentTime = cur; } catch {}
      }
    },
  };
  // a response arrives when the virtual clock has run for as long as the request really took
  window.fetch = async (...args) => {
    const r0 = realNow(), v0 = vt;
    const res = await realFetch(...args);
    const took = realNow() - r0;
    await new Promise((ok) => { const check = () => (vt - v0 >= took ? ok() : realTimeout(check, 4)); check(); });
    return res;
  };
})();`;

export async function launch({ gpu = true, port = 9444 } = {}) {
  const chrome = [
    process.env.CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium",
  ].find((p) => p && existsSync(p));
  if (!chrome) throw new Error("Chrome not found; set CHROME");
  const profile = join(tmpdir(), "strawlink-film-profile");
  mkdirSync(profile, { recursive: true });
  const flags = ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars",
    "--mute-audio", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", `--window-size=${W},${H}`,
    ...(gpu ? ["--enable-gpu", "--ignore-gpu-blocklist"] : ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"]), "about:blank"];
  const proc = spawn(chrome, flags, { stdio: "ignore" });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let ws, nextId = 1;
  const pending = new Map();
  for (let i = 0; i < 80 && !ws; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
      if (page) {
        const sock = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
        sock.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
        ws = sock;
      }
    } catch { /* not up yet */ }
    if (!ws) await sleep(250);
  }
  if (!ws) { proc.kill(); throw new Error("could not reach Chrome"); }

  const send = (method, params = {}) => new Promise((res) => { const id = nextId++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const js = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`page error in: ${expression.slice(0, 120)} → ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails).slice(0, 400)}`);
    return r.result?.result?.value;
  };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: SHIM });

  return {
    send, js, sleep,
    goto: (url) => send("Page.navigate", { url }),
    /** Advance the page's clock by one frame (or `ms`) without taking a picture. */
    step: (ms = 1000 / FPS) => js(`window.__film && __film.step(${ms})`),
    /** One frame as JPEG bytes. */
    grab: async (quality = 92) => Buffer.from((await send("Page.captureScreenshot", { format: "jpeg", quality })).result.data, "base64"),
    close: () => { try { ws.close(); } catch { /* ignore */ } proc.kill(); },
  };
}
