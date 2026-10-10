// The certificate scene: the real clearance certificate of the farmer's field (its PDF page, as a
// picture) and the public page its QR code opens, lit up to narration lines c1 and c2.
//
//   FFMPEG=… node app/tools/film/cert.mjs <web app url> <certificate id>
//
// Before running: mark the field cleared on the live API, download the certificate PDF and save
// its page as app/.film/cert/cert.png (any PDF-to-image tool). Writes app/.film/cut/055-certificate.mp4 + .json.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FPS, launch } from "./engine.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", ".film");
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const [BASE, CERT] = process.argv.slice(2);
if (!BASE || !CERT) { console.log("usage: node cert.mjs <web app url> <certificate id>"); process.exit(1); }
const work = join(OUT, "cert");
if (!existsSync(join(work, "cert.png"))) { console.log("missing", join(work, "cert.png")); process.exit(1); }
const NAME = "055-certificate";
const DUR = JSON.parse(readFileSync(join(OUT, "voice", "durations.json"), "utf8"));
const TEXT = Object.fromEntries(JSON.parse(readFileSync(join(HERE, "narration.json"), "utf8")).map((l) => [l.id, l.text]));
const LEAD = 0.3;
const beats = [{ id: "c1", at: LEAD }, { id: "c2", at: LEAD + DUR.c1 }].map((b) => ({ ...b, dur: DUR[b.id], text: TEXT[b.id] }));
const total = LEAD + DUR.c1 + DUR.c2 + 0.9;

const b = await launch();
try {
  // 1 · the page the QR code opens, photographed from the live site
  await b.goto(`${BASE}/verify/${CERT}`);
  let rect = null;
  for (let i = 0; i < 200 && !rect; i++) {
    await b.sleep(120);
    await b.js(`window.__film && __film.step(120); 0`).catch(() => 0);
    rect = await b.js(`(() => { const e = document.querySelector(".cert"); if (!e || !e.querySelector("dl")) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`).catch(() => null);
  }
  if (!rect) throw new Error("the verify page did not load");
  for (let i = 0; i < 12; i++) { await b.js(`__film.step(100); 0`); await b.sleep(60); }
  const shot = await b.send("Page.captureScreenshot", { format: "png", clip: { ...rect, scale: 1 } });
  writeFileSync(join(work, "verify.png"), Buffer.from(shot.result.data, "base64"));
  const ratio = rect.height / rect.width;

  // 2 · the scene
  const W2 = 470, H2 = Math.min(560, Math.round(W2 * ratio));
  const html = `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; font-family: Inter, "Segoe UI", system-ui, sans-serif;
      background: radial-gradient(1200px 700px at 50% 40%, #24362c, #121b16); color: #f6f7f2; }
    #paper { position: absolute; left: 158px; top: 18px; width: 409px; height: 580px; background: #fff; border-radius: 6px; box-shadow: 0 30px 90px rgba(0,0,0,.55); overflow: hidden; transform-origin: 50% 60%; }
    #paper img { width: 100%; height: 100%; display: block; }
    #qr { position: absolute; left: 431px; top: 439px; width: 96px; height: 96px; border: 3px solid #f2b632; border-radius: 12px; box-shadow: 0 0 0 5px rgba(242,182,50,.28); opacity: 0; }
    #tag1, #tag2 { position: absolute; font-size: 14px; font-weight: 600; background: rgba(13,20,16,.86); border: 1px solid #3a4d42; border-radius: 999px; padding: 6px 14px; opacity: 0; }
    #tag1 { left: 158px; top: 612px; } #tag2 { left: 700px; top: 612px; }
    #tag1 i, #tag2 i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #f2b632; margin-right: 8px; }
    #page { position: absolute; left: 700px; top: ${Math.round(330 - H2 / 2)}px; width: ${W2}px; height: ${H2}px; border-radius: 14px; overflow: hidden; box-shadow: 0 30px 90px rgba(0,0,0,.55), 0 0 0 1.5px #3a4d42; opacity: 0; background: #f3f5f0; }
    #page img { width: 100%; display: block; }
    svg { position: absolute; inset: 0; pointer-events: none; }
    #sub { position: absolute; left: 0; right: 0; bottom: 14px; display: flex; justify-content: center; opacity: 0; }
    #sub span { max-width: 1060px; background: rgba(13,20,16,.94); color: #fff; font-size: 22px; font-weight: 500; line-height: 1.35; padding: 9px 20px; border-radius: 12px; text-align: center; }
  </style>
  <div id="paper"><img src="${pathToFileURL(join(work, "cert.png")).href}"></div>
  <svg viewBox="0 0 1280 720"><path id="wire" d="M 536 487 C 620 487, 620 330, 696 330" fill="none" stroke="#f2b632" stroke-width="2.5" stroke-dasharray="6 7" opacity="0"/></svg>
  <div id="qr"></div>
  <div id="page"><img src="${pathToFileURL(join(work, "verify.png")).href}"></div>
  <div id="tag1"><i></i>The certificate issued for field F0104 (its real PDF)</div>
  <div id="tag2"><i></i>What the code opens: a public page on the live site</div>
  <div id="sub"><span></span></div>
  <script>
    const BEATS = ${JSON.stringify(beats)};
    const clamp = (v) => Math.max(0, Math.min(1, v)), ease = (u) => 1 - Math.pow(1 - clamp(u), 3);
    let last = "";
    window.__cert = (t) => {
      const a = ease((t - 0.05) / 0.6), c2 = BEATS[1].at;
      const paper = document.getElementById("paper");
      paper.style.opacity = a; paper.style.transform = "translateY(" + (1 - a) * 26 + "px) rotate(" + (-1.4 * a) + "deg)";
      document.getElementById("tag1").style.opacity = ease((t - 0.5) / 0.4);
      const q = ease((t - c2 - 0.1) / 0.35), pulse = 0.5 + 0.5 * Math.sin((t - c2) * 7);
      const qr = document.getElementById("qr");
      qr.style.opacity = q; qr.style.transform = "scale(" + (1 + 0.05 * pulse * q) + ")";
      document.getElementById("wire").setAttribute("opacity", ease((t - c2 - 0.45) / 0.35));
      const p = ease((t - c2 - 0.65) / 0.5), page = document.getElementById("page");
      page.style.opacity = p; page.style.transform = "translateX(" + (1 - p) * 30 + "px)";
      document.getElementById("tag2").style.opacity = ease((t - c2 - 0.9) / 0.4);
      const s = BEATS.find((x) => t >= x.at && t <= x.at + x.dur + 0.1), sub = document.getElementById("sub");
      sub.style.opacity = s ? Math.min(1, (t - s.at) / 0.15, (s.at + s.dur + 0.1 - t) / 0.15) : 0;
      if (s && s.text !== last) { last = s.text; sub.firstElementChild.textContent = s.text; }
      return true;
    };
  </script>`;
  writeFileSync(join(work, "page.html"), html);
  await b.goto(pathToFileURL(join(work, "page.html")).href);
  for (let i = 0; i < 100; i++) { await b.sleep(100); if (await b.js(`typeof __cert === "function" && [...document.images].every((i) => i.complete)`).catch(() => false)) break; }
  const N = Math.round(total * FPS);
  const ff = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "15", "-pix_fmt", "yuv420p", "-r", String(FPS), join(OUT, "cut", `${NAME}.mp4`)], { stdio: ["pipe", "inherit", "inherit"] });
  for (let i = 0; i < N; i++) {
    await b.js(`__cert(${i / FPS})`);
    const jpg = await b.grab();
    if (!ff.stdin.write(jpg)) await once(ff.stdin, "drain");
  }
  ff.stdin.end(); await once(ff, "close");
  writeFileSync(join(OUT, "cut", `${NAME}.json`), JSON.stringify({ frames: N, marks: beats.map((x) => ({ id: x.id, frame: Math.round(x.at * FPS) })) }, null, 1));
  console.log(`${NAME}: ${N} frames = ${(N / FPS).toFixed(1)} s`);
} finally {
  b.close();
}
