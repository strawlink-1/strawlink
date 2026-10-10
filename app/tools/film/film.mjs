// The demo film, shot by shot. Each scene drives the real web app (no mock-ups), frame by frame,
// and is written to app/.film/scenes/<name>.mp4 with the frame at which each narration line starts.
//
//   node app/tools/film/film.mjs <web app url> [scene names…]      (needs FFMPEG, or ffmpeg on PATH)
//   node app/tools/film/assemble.mjs                                 (joins scenes, adds the voice)
//
// Scene 5 (the farmer) is a camera take (clip.mjs), 055 the certificate (cert.mjs), 075 the AWS diagram (arch.mjs).
// Nothing here writes to the API. Run one scene per process: the map's WebGL context does not survive many loads.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FPS, H, W, launch } from "./engine.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", ".film");
const [BASE, ...ONLY] = process.argv.slice(2);
if (!BASE) { console.log("usage: node film.mjs <web app url> [scene…]"); process.exit(1); }
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const API = process.env.API_URL || "https://u1feqhbpaa.execute-api.ap-south-1.amazonaws.com";
const STEP = 1000 / FPS;
const OVERLAY = readFileSync(join(HERE, "overlay.js"), "utf8");
const TEXT = Object.fromEntries(JSON.parse(readFileSync(join(HERE, "narration.json"), "utf8")).map((l) => [l.id, l.text]));
const DUR = JSON.parse(readFileSync(join(OUT, "voice", "durations.json"), "utf8"));
mkdirSync(join(OUT, "cut"), { recursive: true });

// The app sits in the frame like a window, leaving a band underneath for subtitles.
const HOME = { s: 0.86, x: (W - W * 0.86) / 2, y: 12 };
const BAND = 84;
const fresh = () => ({
  cam: { ...HOME },
  ring: { x: 0, y: 0, w: 0, h: 0, o: 0, dim: false, pad: 6 },
  note: { text: "", x: 0, y: 0, o: 0 },
  cur: { x: 640, y: 430, o: 0, press: 0 },
  card: { html: "", cls: "", o: 0, bg: 1, k: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  sub: { text: "", o: 0 },
});
const S = fresh();

let b, ff, F = 0, marks = [], tweens = [], hooks = [], subOff = -1;
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
/** Glide some numbers of `obj` to new values over n frames. A later glide of the same number wins. */
function tw(obj, to, n = 18) {
  for (const t of tweens) if (t.obj === obj) for (const k of Object.keys(to)) delete t.to[k];
  tweens.push({ obj, to: { ...to }, from: Object.fromEntries(Object.keys(to).map((k) => [k, obj[k]])), n: Math.max(1, n), i: 0 });
}
/** Run fn(i, n) once per frame for the next n frames (mouse drags, date sweeps). */
const hook = (n, fn) => hooks.push({ n, i: 0, fn });
const js = (e) => b.js(e);

async function frame() {
  for (const t of tweens) { t.i++; const u = ease(Math.min(1, t.i / t.n)); for (const k of Object.keys(t.to)) t.obj[k] = t.from[k] + (t.to[k] - t.from[k]) * u; }
  tweens = tweens.filter((t) => t.i < t.n);
  for (const h of hooks) { await h.fn(h.i, h.n); h.i++; }
  hooks = hooks.filter((h) => h.i < h.n);
  if (subOff >= 0 && F >= subOff) { tw(S.sub, { o: 0 }, 6); subOff = -1; }
  await js(`__ov.apply(${JSON.stringify(S)}); __film.step(${STEP}); 0`);
  const jpg = await b.grab();
  if (!ff.stdin.write(jpg)) await once(ff.stdin, "drain");
  F++;
}
const frames = async (n) => { for (let i = 0; i < n; i++) await frame(); };
/** Let the app's clock run without filming (loading, or a cut). */
async function skip(ms) { for (let t = 0; t < ms; t += 50) { await js(`__film.step(50); 0`); await b.sleep(6); } }
async function until(expr, { max = 120000, label = expr } = {}) {
  for (let t = 0; t < max; t += 100) { if (await js(expr).catch(() => false)) return true; await skip(100); }
  console.log("  ! timed out off camera:", label.slice(0, 90));
  return false;
}
async function waitOn(expr, maxFrames = 300) {
  for (let i = 0; i < maxFrames; i++) { if (await js(expr)) return true; await frame(); }
  console.log("  ! timed out on camera:", expr.slice(0, 90));
  return false;
}

const MAP_LOST = `(() => { const c = document.querySelector("#stage canvas"), g = c && (c.getContext("webgl2") || c.getContext("webgl")); return !g || g.isContextLost() || document.body.innerText.includes("could not be drawn"); })()`;
async function load(path, ready) {
  // The satellite ground is heavy on the graphics card; now and then headless Chrome drops the
  // map's WebGL context while it loads. Loading the page again (tiles now cached) gets it back.
  for (let attempt = 1; attempt <= 8; attempt++) {
    // the simulator is entered through another page's tab: opened directly, its map is the one that drops out
    const viaTab = path === "/simulator";
    await b.goto(BASE + (viaTab ? "/forecast" : path));
    for (let i = 0; i < 300; i++) {
      await b.sleep(100);
      if (await js(`document.readyState !== "loading" && !!document.getElementById("root") && typeof __film === "object"`).catch(() => false)) break;
    }
    await js(OVERLAY);
    await js(`__ov.apply(${JSON.stringify(S)}); 0`);
    await until(`!!document.getElementById("side-inner")?.innerText`, { label: "app shell" });
    if (viaTab) {
      for (let i = 0; i < 30; i++) { await js(`__film.step(50); 0`); await b.sleep(90); }
      await js(`__ov.q("#tabs a", "Simulator").click(); 0`);
    }
    if (ready) await until(ready);
    // the satellite ground arrives in real time, not film time: give it a few real seconds
    for (let i = 0; i < 45; i++) { await js(`__film.step(50); 0`); await b.sleep(90); }
    if (!(await js(MAP_LOST))) return;
    console.log(`  ! the 3D map lost its graphics context (attempt ${attempt}); loading again`);
    await b.goto("about:blank"); await b.sleep(5000);
  }
  throw new Error("the 3D map would not start");
}

/** A narration line: note where it starts, show it as a subtitle, run the shot, and stay at least as long as the voice. */
async function say(id, shot, { gap = 0, sub = true, lead = 0 } = {}) {
  if (lead) await frames(lead);
  // voice files are whole frames long, and lines that follow one another must not drift apart
  const start = F, need = Math.round((DUR[id] + gap) * FPS);
  marks.push({ id, frame: F });
  if (sub) { S.sub.text = TEXT[id]; tw(S.sub, { o: 1 }, 5); subOff = start + Math.ceil(DUR[id] * FPS) + 3; }
  if (shot) await shot(need);
  if (F - start > need) console.log(`  ! the shot for ${id} ran ${F - start - need} frames past its line`);
  if (F - start < need) await frames(need - (F - start));
}

// ---------------------------------------------------------------- camera, ring, cursor
const rectOf = (expr) => js(`__ov.rect(${expr})`);
/** Camera that fills the frame with a box (app-layout pixels), keeping the subtitle band clear. */
function camFor(r, { pad = 22, max = 1.9, cover = false } = {}) {
  if (cover) { // the box fills the whole frame, edges cropped: a backdrop for cards
    const s = Math.max(W / r.w, H / r.h);
    return { s, x: W / 2 - (r.x + r.w / 2) * s, y: H / 2 - (r.y + r.h / 2) * s };
  }
  const availH = H - BAND;
  const s = Math.max(1, Math.min(W / (r.w + 2 * pad), availH / (r.h + 2 * pad), max));
  let x = W / 2 - (r.x + r.w / 2) * s, y = availH / 2 - (r.y + r.h / 2) * s;
  x = Math.min(0, Math.max(W - W * s, x)); // never show past the app's own edges
  y = Math.min(0, Math.max(H - H * s, y));
  return { s, x, y };
}
const zoom = (cam, n = 26) => tw(S.cam, cam, n);
const home = (n = 26) => tw(S.cam, { ...HOME }, n);
async function ringOn(expr, { dim = false, pad = 6, n = 8 } = {}) {
  const r = await js(`(() => { const e = ${expr}; return e && e.__r ? e.__r : __ov.rect(e); })()`);
  if (!r) { console.log("  ! nothing to ring:", expr.slice(0, 70)); return; }
  Object.assign(S.ring, { x: r.x, y: r.y, w: r.w, h: r.h, dim, pad });
  tw(S.ring, { o: 1 }, n);
}
const ringOff = (n = 8) => tw(S.ring, { o: 0 }, n);
function noteAt(text, x, y, n = 8) { Object.assign(S.note, { text, x, y }); tw(S.note, { o: 1 }, n); }
const noteOff = (n = 8) => tw(S.note, { o: 0 }, n);

async function point(expr, n = 16) {
  const r = await rectOf(expr);
  const p = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  if (S.cur.o < 0.5) { S.cur.x = p.x + 130; S.cur.y = p.y + 95; }
  tw(S.cur, { ...p, o: 1 }, n);
  await frames(n);
  return p;
}
async function press() { tw(S.cur, { press: 1 }, 3); await frames(3); tw(S.cur, { press: 0 }, 4); }
async function click(expr, n = 16) { await point(expr, n); await press(); await js(`(${expr}).click(); 0`); await frames(3); }
const hideCursor = (n = 8) => tw(S.cur, { o: 0 }, n);

/** Drag one of the simulator's sliders to a value, with the cursor on the thumb. */
async function drag(label, to, n = 22) {
  const e = `__ov.slider(${JSON.stringify(label)})`;
  const t = await js(`__ov.thumb(${e})`);
  const xOf = (v) => t.x0 + ((t.x1 - t.x0) * (v - t.min)) / (t.max - t.min);
  if (S.cur.o < 0.5) { S.cur.x = xOf(t.value) + 110; S.cur.y = t.y + 85; }
  tw(S.cur, { x: xOf(t.value), y: t.y, o: 1 }, 14);
  await frames(14);
  tw(S.cur, { press: 1 }, 3);
  await frames(3);
  let last = t.value;
  for (let i = 1; i <= n; i++) {
    const v = t.value + (to - t.value) * ease(i / n), whole = Math.round(v);
    S.cur.x = xOf(v);
    if (whole !== last) { last = whole; await js(`__ov.set(${e}, ${whole}); 0`); }
    await frame();
  }
  tw(S.cur, { press: 0 }, 4);
  await frames(4);
}

// real mouse events, for the 3D map (turning it, zooming it, clicking a field)
const toScreen = (p) => ({ x: p.x * S.cam.s + S.cam.x, y: p.y * S.cam.s + S.cam.y });
const mouse = (type, p, down = false) => b.send("Input.dispatchMouseEvent", {
  type, ...toScreen(p), button: type === "mouseMoved" ? (down ? "left" : "none") : "left", buttons: down || type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1,
});
async function stageCentre() { const r = await rectOf(`document.getElementById("stage")`); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }
async function orbit(dx, dy, n) {
  const c = await stageCentre();
  await mouse("mouseMoved", c); await mouse("mousePressed", c);
  hook(n, async (i, total) => {
    const u = ease((i + 1) / total);
    await mouse("mouseMoved", { x: c.x + dx * u, y: c.y + dy * u }, true);
    if (i === total - 1) await mouse("mouseReleased", { x: c.x + dx, y: c.y + dy });
  });
}
async function wheel(total, n) {
  const c = toScreen(await stageCentre());
  hook(n, async (i, N) => { await b.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: c.x, y: c.y, deltaX: 0, deltaY: total * (ease((i + 1) / N) - ease(i / N)) }); });
}
async function tapMap(p) { await mouse("mouseMoved", p); await mouse("mousePressed", p); await mouse("mouseReleased", p); }
/** Move the 3D camera in or out off camera (negative = closer). */
async function wheelNow(total) {
  const c = toScreen(await stageCentre());
  for (let i = 0; i < 6; i++) { await b.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: c.x, y: c.y, deltaX: 0, deltaY: total / 6 }); await skip(60); }
  await skip(700);
}
/** Scroll the side panel smoothly so an element sits near its top. */
async function scrollSide(expr, n = 24, offset = 70) {
  const top = await js(`(() => { const s = document.getElementById("side"), e = ${expr}; return e ? Math.max(0, s.scrollTop + e.getBoundingClientRect().top - s.getBoundingClientRect().top - ${offset}) : s.scrollTop; })()`);
  const from = await js(`document.getElementById("side").scrollTop`);
  hook(n, async (i, N) => { await js(`document.getElementById("side").scrollTop = ${from + (top - from) * ease((i + 1) / N)}; 0`); });
}

// ---------------------------------------------------------------- the app's own controls
const SIM_READY = `(() => { const s = document.querySelector(".status"); return !!s && !s.classList.contains("busy") && !s.textContent.startsWith("Waiting"); })()`;
const SIM_BUSY = `!!document.querySelector(".status.busy")`;
const TIME = `document.querySelector('input[aria-label="Time of day"]')`;
const DAY = `document.querySelector('input[aria-label="Day"]')`;
const setTime = async (mins) => { await js(`__ov.set(${TIME}, ${mins}); 0`); await skip(260); };
/** Playback speed in plan-minutes per second (the slider is logarithmic, 1–60). */
const setSpeed = (perSec) => js(`__ov.set(document.getElementById("speed"), ${(Math.log(perSec) / Math.log(60)) * 100}); 0`);
const playing = () => js(`document.querySelector(".run")?.textContent.includes("Pause") ?? false`);
const play = async (on = true) => { if ((await playing()) !== on) await js(`document.querySelector(".run").click(); 0`); await skip(60); };
const follow = (name) => js(`(() => { const x = __ov.q(".machines button", ${JSON.stringify(name)}); if (x && x.getAttribute("aria-pressed") !== "true") x.click(); return !!x; })()`);
const unfollow = () => js(`(() => { const x = document.querySelector('.machines button[aria-pressed="true"]'); x && x.click(); return !!x; })()`);
/** The first time of day at which some machine's status line passes the test. Leaves the clock there, paused. */
async function findMoment(test, { from = 8 * 60 + 30, to = 17 * 60, by = 10 } = {}) {
  await play(false);
  for (let t = from; t <= to; t += by) {
    await setTime(t);
    const hit = (await js(`__ov.machines()`)).find(([name, text]) => test(name, text));
    if (hit) return { t, name: hit[0] };
  }
  console.log("  ! no such moment in the plan");
  return null;
}
const resetDemo = () => fetch(`${API}/demo/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.ok).catch(() => false);

// ---------------------------------------------------------------- cards
/** A card of words: a headline, a line under it, and small print. */
const words = (big, mid = "", small = "") => `<div class="in">${big ? `<div data-k="0" class="big">${big}</div>` : ""}${mid ? `<div data-k="1" class="mid">${mid}</div>` : ""}${small ? `<div data-k="2" class="small">${small}</div>` : ""}</div>`;
const CARD = {
  title: `<div class="in"><div data-k="0" class="logo"><span class="mark"></span>StrawLink</div><div data-k="1" class="mid" style="max-width:none">Anticipates the need, before it becomes a fire.</div></div>`,
  idea: `<div class="in"><div data-k="0" class="eyebrow">StrawLink</div><div class="chips" style="flex-direction:column;align-items:flex-start;margin-top:0"><span data-k="1" class="chip">knows which fields will be ready</span><span data-k="2" class="chip">plans a machine for each one</span><span data-k="3" class="chip">tells the farmer exactly when</span></div><div data-k="4" class="mid">So he does not have to burn.</div></div>`,
  impact: `<div class="in"><div data-k="0" class="eyebrow">One block · 200 fields · 1,452 tonnes of straw</div><div data-k="1" class="num">up to 9.5 t</div><div data-k="2" class="mid">of fine particles (PM2.5) kept out of the air this season.</div><div data-k="3" class="small">Upper estimate: assumes every field would otherwise be burned. Emission factors: Andreae 2019, IPCC 2006.</div></div>`,
  adapt: `<div class="in"><div data-k="0" class="big">Adapts to any data.</div><div class="chips"><span data-k="1" class="chip">another block's fields</span><span data-k="2" class="chip">its machines</span><span data-k="3" class="chip">its plants</span></div><div data-k="4" class="small">The machines and plants shown in this film are examples, labelled synthetic in the app.</div></div>`,
  aws: `<div class="in"><div data-k="0" class="eyebrow">Running on AWS today</div><div class="chips">${["Amplify Hosting", "API Gateway", "Lambda", "DynamoDB", "S3", "Bedrock", "Transcribe", "EventBridge"].map((s, i) => `<span data-k="${i + 1}" class="chip plain">${s}</span>`).join("")}</div></div>`,
  end: `<div class="in" style="text-align:center"><div data-k="0" class="logo" style="justify-content:center"><span class="mark"></span>StrawLink</div><div data-k="1" class="mid" style="max-width:none">Every field picked up in time, so no one has to burn.</div></div>`,
  thanks: `<div class="in" style="text-align:center"><div data-k="0" class="big" style="font-size:92px">Thank you.</div><div data-k="1" class="logo" style="justify-content:center;font-size:54px;letter-spacing:-1.5px;margin-top:30px;gap:14px"><span class="mark" style="width:50px;height:50px;border-radius:12px"></span>StrawLink</div><div data-k="2" class="mid" style="max-width:none;margin-top:10px">Shambhvi and Yash</div><div data-k="3" class="small" style="font-size:26px;color:#f2b632;margin-top:26px">github.com/strawlink-1/strawlink</div><div data-k="4" class="small" style="margin-top:10px">Live: main.d16side0ke5w9y.amplifyapp.com · AWS Environmental Hacks 2026</div></div>`,
};
const zeros = () => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
function setCard(html, cls = "") { S.card.html = html; S.card.cls = cls; S.card.k = zeros(); }
const show = (i, n = 10) => tw(S.card.k, { [i]: 1 }, n);
const hideAll = (n = 8) => tw(S.card.k, Object.fromEntries(S.card.k.map((_, i) => [i, 0])), n);
/** Swap to a card of words and bring its lines in one after another. */
async function wordsIn(big, mid, small, cls = "left") {
  hideAll(6); await frames(7);
  setCard(words(big, mid, small), cls);
  show(0); await frames(12); show(1); await frames(6); show(2, 16);
}
const need = (...ids) => ids.reduce((n, id) => n + Math.round(DUR[id] * FPS), 0);
/** Sweep the season slider from one day to another over n frames. */
function sweep(from, to, n) {
  let last = from;
  hook(n, async (i, N) => { const d = Math.round(from + (to - from) * ease(Math.min(1, (i + 1) / N))); if (d !== last) { last = d; await js(`__ov.set(${DAY}, ${d}); 0`); } });
}

// ---------------------------------------------------------------- scenes
async function scene(name, run) {
  if (ONLY.length && !ONLY.includes(name)) return;
  console.log("scene", name);
  F = 0; marks = []; tweens = []; hooks = []; subOff = -1;
  Object.assign(S, fresh());
  const t0 = Date.now();
  ff = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "15", "-pix_fmt", "yuv420p", "-r", String(FPS), join(OUT, "cut", `${name}.mp4`)], { stdio: ["pipe", "inherit", "inherit"] });
  try { await run(); } finally { ff.stdin.end(); await once(ff, "close"); }
  writeFileSync(join(OUT, "cut", `${name}.json`), JSON.stringify({ frames: F, marks }, null, 1));
  console.log(`  ${F} frames = ${(F / FPS).toFixed(1)} s of film, shot in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

/** Real seconds for the map's satellite ground (and other network things) to arrive, off camera. */
async function settle(steps = 30) { for (let i = 0; i < steps; i++) { await js(`__film.step(50); 0`); await b.sleep(90); } }

b = await launch();
try {
  // 1 · the problem, told over the real 2025 season on this block (fields darken as they burn)
  await scene("01-problem", async () => {
    await load("/results", `+(${DAY}?.max ?? 0) > 20`);
    const max = await js(`+${DAY}.max`);
    await js(`__ov.set(${DAY}, 0); 0`);
    await skip(1500);
    Object.assign(S.cam, camFor(await rectOf(`document.getElementById("stage")`), { cover: true }));
    setCard("", "left");
    Object.assign(S.card, { o: 1, bg: 1 });
    await frames(5);
    tw(S.card, { bg: 0.66 }, 26);
    sweep(0, max, need("p1", "p2", "p3") + 10);
    await say("p1", () => wordsIn("October in Punjab.", "Rice is harvested. Three weeks to sow wheat.", "Behind: the 2025 season on this block, read from satellite images."), { lead: 8 });
    await say("p2", () => wordsIn("The straw is in the way."));
    await say("p3", () => wordsIn("Not picked up in time<br>means burned.", "", "Dark fields: burned in 2025, as seen in the imagery."));
    await frames(6);
  });

  // 2 · the idea: knows, plans, tells
  await scene("02-idea", async () => {
    await load("/forecast", `+(${DAY}?.max ?? 0) > 10`);
    setCard(CARD.title);
    Object.assign(S.card, { o: 1, bg: 1 });
    await frames(4);
    await say("i1", async (n) => { show(0, 14); await frames(40); show(1, 14); await frames(Math.max(1, n - 40 - 9)); hideAll(); });
    setCard(CARD.idea);
    await say("i2", async (n) => { show(0); await frames(4); show(1); await frames(Math.round(n * 0.39) - 4); show(2); await frames(Math.round(n * 0.22)); show(3); });
    show(4, 12);
    await frames(20);
  });

  // 3 · how it knows: the forecast season, then the morning plan setting off
  await scene("03-knows", async () => {
    await load("/forecast", `+(${DAY}?.max ?? 0) > 10`);
    const max = await js(`+${DAY}.max`);
    const planDay = await js(`(() => { const m = [...document.querySelectorAll(".scrub-marks span")].find((e) => e.textContent.includes("plan")); return m ? Math.round(parseFloat(m.style.left) / 100 * ${max}) : Math.round(${max} * 0.6); })()`);
    await js(`__ov.set(${DAY}, 0); 0`);
    await skip(1500);
    await frames(6);
    sweep(0, planDay + 2, need("k1") - 40);
    await say("k1", async (n) => { await wheel(-420, 50); await frames(Math.max(10, n - 70)); await ringOn(`document.querySelector(".stat")`); await frames(50); ringOff(6); });
    // cut to the simulator at the start of the working day (her sentence runs on, so no frame is added here)
    await js(`__ov.q("#tabs a", "Simulator").click(); 0`);
    await until(SIM_READY);
    await settle();
    await setTime(Math.max(await js(`+${TIME}.min`), 7 * 60 + 30));
    await setSpeed(8);
    S.ring.o = 0;
    await say("k2", async () => { await frames(8); await click(`document.querySelector(".run")`, 14); hideCursor(); });
    await frames(18);
  });

  // 4 · where the straw goes: close-ups of a baler, a truck and a Super Seeder at work, then the plants' own view
  await scene("04-straw", async () => {
    await load("/simulator", SIM_READY);
    await skip(2000);
    const closeUp = async (test, speed = 9) => {
      const m = await findMoment(test);
      if (m) { await unfollow(); await follow(m.name); await setSpeed(speed); await skip(1900); await wheelNow(-900); await play(true); }
    };
    await closeUp((n, t) => n.startsWith("Baler") && t.startsWith("baling"));
    await frames(4);
    await say("g1", async (n) => {
      await frames(Math.round(n * 0.42));
      await closeUp((nm, t) => nm.startsWith("Truck") && t.startsWith("carrying")); // a cut: nothing is filmed while the camera moves
    });
    await closeUp((n, t) => n.startsWith("Seeder") && t.startsWith("sowing"));
    await say("g2");
    await play(false); await unfollow();
    await js(`__ov.q("#tabs a", "Plants").click(); 0`);
    await until(`document.querySelectorAll(".plant").length > 0`, { label: "plants page" });
    await settle(24);
    await say("s1", async () => {
      await frames(16);
      await scrollSide(`__ov.q(".group h2", "Plants")`, 18, 40);
      await frames(20);
      zoom(camFor({ x: 0, y: 60, w: 760, h: 420 }, { pad: 0, max: 1.6 }), 20);
      await frames(22);
      await ringOn(`document.querySelector(".plant .alert")?.closest(".plant") ?? document.querySelector(".plant")`, { pad: 4 });
    });
    await frames(8);
  });

  // 6 · the officer: the scoreboard, the sliders asking the planner, rain on one village, and one field's card
  // (scene 5 is the camera take, clip.mjs; 055 is the certificate, cert.mjs).
  // The planner's thinking time (a few seconds per what-if) is cut: the film waits for it off camera.
  await scene("06-officer", async () => {
    await load("/simulator", SIM_READY);
    await skip(1500);
    await setTime(11 * 60 + 20);
    console.log("  verdict on screen:", await js(`document.querySelector(".verdict")?.innerText ?? ""`));
    const planned = async () => { await until(SIM_BUSY, { max: 2500, label: "planner starts" }); await until(SIM_READY, { max: 400000 }); await skip(600); await until(SIM_READY, { max: 400000 }); await skip(150); };
    await frames(6);
    await say("o1", async () => {
      zoom(camFor(await rectOf(`document.getElementById("above")`), { pad: 26, max: 1.6 }), 18);
      await frames(28);
      await ringOn(`document.querySelector(".tile")`);
      await frames(22);
      await ringOn(`document.querySelector(".verdict")`);
      await frames(24);
      ringOff(5);
      zoom(camFor({ x: 0, y: 50, w: 965, h: 480 }, { pad: 0, max: 1.4 }), 16);
    });
    await say("o2", async () => {
      await drag("Baler sets", 6, 14);
      await planned();
      hideCursor();
      await ringOn(`document.getElementById("toast") ?? document.querySelector(".note.limit") ?? document.querySelector(".tile")`);
    });
    ringOff(4);
    await say("o3", async () => {
      await drag("Trucks", 6, 10);
      await drag("Super Seeders", 6, 10);
      await planned();
      hideCursor();
      await ringOn(`document.getElementById("toast") ?? document.querySelector(".tile")`);
      await frames(34);
      await ringOn(`document.querySelector(".tile")`);
    });
    console.log("  scoreboard after:", await js(`document.querySelector(".tile")?.innerText.replace(/\\n/g, " ") ?? ""`));
    const WHERE = `document.querySelector('select[aria-label="Where it rains"]')`;
    await say("r1", async () => {
      ringOff(4);
      zoom(camFor({ x: 0, y: 150, w: 965, h: 480 }, { pad: 0, max: 1.4 }), 14);
      await point(WHERE, 16);
      await press();
      const village = await js(`(() => { const e = ${WHERE}; const o = [...e.options].filter((x) => x.value && !/whole/i.test(x.textContent))[2] ?? e.options[1]; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(e, o.value); e.dispatchEvent(new Event("change", { bubbles: true })); return o.textContent; })()`);
      console.log("  rain over:", village);
      await frames(8);
      await drag("Rain", 15, 12);
      await planned();
      hideCursor();
      await ringOn(`document.getElementById("toast") ?? document.querySelector(".tile")`);
    });
    console.log("  after rain:", await js(`(document.getElementById("toast")?.innerText ?? "") + " | " + (document.querySelector(".tile")?.innerText.replace(/\\n/g, " ") ?? "")`));
    // off camera: back to the saved plan, find a baler at work and a spot on the field it is working
    S.ring.o = 0; S.cur.o = 0;
    await js(`__ov.q("#side-inner button.link", "Reset")?.click(); 0`);
    await skip(500); await until(SIM_READY, { max: 400000 }); await skip(600); await until(SIM_READY, { max: 400000 });
    tweens = tweens.filter((t) => t.obj !== S.cam);
    Object.assign(S.cam, HOME);
    await js(`__ov.apply(${JSON.stringify(S)}); 0`);
    const m = await findMoment((n, t) => n.startsWith("Baler") && t.startsWith("baling"), { from: 9 * 60 });
    await follow(m?.name ?? "Baler 1");
    await skip(2200);
    const c = await stageCentre();
    let spot = null;
    for (const [dx, dy] of [[30, 8], [-30, 8], [24, 24], [-26, -10], [38, -4], [0, 30], [44, 20], [-40, 22]]) {
      await tapMap({ x: c.x + dx, y: c.y + dy });
      await skip(500);
      if (await js(`!!document.getElementById("fieldcard")`)) { spot = { x: c.x + dx, y: c.y + dy }; break; }
    }
    if (!spot) console.log("  ! could not select the field under the machine");
    await js(`document.querySelector("#fieldcard .x")?.click(); 0`);
    await skip(400);
    await say("f1", async () => {
      if (!spot) return;
      S.cur.x = spot.x + 150; S.cur.y = spot.y + 110;
      tw(S.cur, { ...spot, o: 1 }, 16); await frames(16);
      await press(); await tapMap(spot);
      await waitOn(`!!document.getElementById("fieldcard")`, 30);
      hideCursor();
      zoom(camFor(await rectOf(`document.getElementById("fieldcard")`), { pad: 110, max: 1.5 }), 22);
      await frames(24);
      await ringOn(`document.getElementById("fieldcard")`, { pad: 4 });
    });
    await frames(4);
    ringOff(); await frames(6);
  });

  // 6b · the Air page: where smoke from the fields with no machine would go this afternoon
  await scene("065-air", async () => {
    await load("/air", `!!document.querySelector(".compass") && !!document.querySelector(".rank")`);
    await skip(2500);
    console.log("  air page:", await js(`(document.querySelector(".stat-row")?.innerText ?? "").replace(/\\n/g, " ")`));
    await frames(6);
    await say("q1", async () => { await orbit(90, 0, 110); await frames(26); await ringOn(`document.querySelector(".legend li")`, { pad: 4 }); });
    await say("q2", async () => {
      const top = await rectOf(`document.querySelector(".compass")`), row = await rectOf(`document.querySelector(".stat-row")`);
      zoom(camFor({ x: 0, y: top.y - 14, w: 760, h: row.y + row.h - top.y + 250 }, { pad: 0, max: 1.5 }), 20);
      await frames(24);
      await ringOn(`document.querySelector(".stat-row")`, { pad: 4 });
    });
    await say("q3", async () => { await frames(14); await ringOn(`document.querySelector(".rank")`, { pad: 4 }); await frames(34); ringOff(6); home(20); });
    await frames(8);
  });

  // 7 · the 2025 replay
  await scene("07-test", async () => {
    await load("/results", `+(${DAY}?.max ?? 0) > 20`);
    const max = await js(`+${DAY}.max`);
    await js(`__ov.set(${DAY}, 0); 0`);
    await skip(1500);
    console.log("  bars on screen:", await js(`(document.querySelector(".bars")?.closest(".group")?.textContent ?? "").slice(0, 300)`));
    sweep(0, max, need("t1", "t2", "t3"));
    setCard("", "left");
    await frames(6);
    await say("t1");
    tw(S.card, { o: 1, bg: 0.7 }, 10);
    await say("t2", () => wordsIn("185 of 200", "fields burned in 2025.", "Seen in satellite images. Burn detection from imagery over-counts."));
    hideAll(6); tw(S.card, { o: 0 }, 10);
    await say("t3", async () => {
      const g = await rectOf(`document.querySelector(".bars").closest(".group")`);
      zoom(camFor(g, { pad: 16, max: 1.9 }), 22);
      await frames(28);
      await ringOn(`document.querySelector(".bars")`, { pad: 4 });
      noteAt("75 of the 185 = 40.5 % · first-come booking, same machines: 74 · burn detection from imagery, over-counts", g.x + 4, g.y + g.h + 10);
    });
    ringOff(); noteOff(); home(22);
    tw(S.card, { o: 1, bg: 0.7 }, 12);
    await say("t4", () => wordsIn("Within two days", "of harvest, most of the rest had burned."));
    await say("t5", () => wordsIn("StrawLink starts<br>before the harvest."));
    await frames(8);
  });

  // 8 · why it matters, any data, the close (the AWS scene, arch.mjs, comes just before this one)
  await scene("08-why", async () => {
    await load("/simulator", SIM_READY);
    await skip(1500);
    await setTime(8 * 60 + 20); await setSpeed(20); await play(true);
    Object.assign(S.cam, camFor(await rectOf(`document.getElementById("stage")`), { cover: true }));
    setCard(CARD.impact);
    Object.assign(S.card, { o: 1, bg: 0.84 });
    await frames(6);
    // her three sentences run on without a break, so each card leaves inside its own line
    await say("w1", async (n) => {
      const a = Math.round(n * 0.3), c = Math.round(n * 0.22), d = Math.round(n * 0.2);
      show(0); await frames(a); show(1, 14); await frames(c); show(2); await frames(d); show(3, 16);
      await frames(Math.max(1, n - a - c - d - 8)); hideAll(7);
    });
    setCard(CARD.adapt);
    await say("w2", async (n) => {
      const a = Math.round(n * 0.25), c = Math.round(n * 0.2);
      show(0); await frames(a); show(1); await frames(6); show(2); await frames(6); show(3); await frames(c); show(4, 12);
      await frames(Math.max(1, n - a - 12 - c - 9)); hideAll(8); tw(S.card, { bg: 1 }, 8);
    });
    setCard(CARD.end);
    await say("w3", async () => { show(0, 14); await frames(24); show(1, 14); });
    await frames(10);
    hideAll(8); await frames(9);
    setCard(CARD.thanks);
    await say("ty", async () => { show(0, 10); await frames(14); show(1, 12); await frames(8); show(2, 12); }, { sub: false });
    show(3, 12); await frames(8); show(4, 12);
    await frames(80); // the last frame stays: thank you, names, repository
  });
} finally {
  b.close();
}
