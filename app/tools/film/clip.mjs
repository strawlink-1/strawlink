// The farmer scene: Shambhvi's own camera take, with the messages her phone received shown beside
// it (the English copies, word for word as the app sent them) and captions of what she says.
//
//   FFMPEG=… node app/tools/film/clip.mjs <camera clip.mp4>
//
// Writes app/.film/scenes/05-farmer.mp4, its sound as 05-farmer.wav and 05-farmer.json.
// The take is mirrored (front camera), so it is flipped back. Two waits are cut out; KEEP lists
// the stretches of the clip that stay. Caption times are clip times, from Amazon Transcribe.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FPS, launch } from "./engine.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", ".film");
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const SRC = process.argv[2];
if (!SRC) { console.log("usage: node clip.mjs <camera clip.mp4>"); process.exit(1); }

const KEEP = [[0.3, 14.4], [16.4, 36.7]];
/** Clip time → film time (the cut-out waits removed). */
const at = (t) => { let out = 0; for (const [a, b] of KEEP) { if (t <= a) break; out += Math.min(t, b) - a; } return out; };
const total = at(1e9);

const SUBS = [
  [0.7, 2.4, "The farmer needs no app."],
  [2.8, 10.3, "Before his harvest, a WhatsApp message in Punjabi and English tells him when his field should be ready."],
  [11.6, 14.3, "Voice note: “मेनू कल हार्वेस्ट करना है” (I will harvest tomorrow)"],
  [16.8, 23.2, "When he cuts, he says so in a voice note, which gets registered in our app,"],
  [23.6, 30.4, "and afterwards the plan changes around him. A machine is on its way."],
  [30.7, 36.4, "Afterwards he gets his certificate, and no one is ever reported or fined."],
].map(([a, b, text]) => ({ a: at(a), b: at(b), text }));

// What arrived on the phone during the take (10 Oct 2026, 17:55), from the app's message log.
const ITEMS = [
  { t: 4.3, cls: "in", html: `<b>StrawLink</b> field F0104 (Ranike). Satellite images suggest your paddy will be ready to harvest between 24-10-2026 and 28-10-2026. When you harvest, send a voice note or the date, and we will send a machine for the straw.` },
  { t: 13.9, cls: "out", html: `<span class="mic"></span><span class="wave"></span><span class="len">0:03</span>` },
  { t: 16.6, cls: "in", html: `<b>StrawLink</b> Heard: “मेनू कल हार्वेस्ट करना है”<br>Thank you. Harvest on 25-10-2026 recorded for field F0104. We will send your slot.` },
  { t: 23.9, cls: "chip", html: `Harvest date recorded · the planner runs again with it` },
  { t: 30.9, cls: "chip", html: `After clearing: a certificate · never a report or a fine` },
].map((m) => ({ ...m, t: at(m.t) }));

const work = join(OUT, "clip");
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, "frames"), { recursive: true });
const run = (args) => { const r = spawnSync(FFMPEG, ["-y", "-loglevel", "error", ...args], { stdio: "inherit" }); if (r.status !== 0) process.exit(r.status ?? 1); };
const sel = KEEP.map(([a, b]) => `between(t,${a},${b})`).join("+");
run(["-i", SRC, "-vf", `select='${sel}',setpts=N/FRAME_RATE/TB,hflip,fps=${FPS}`, "-q:v", "2", join(work, "frames", "%05d.jpg")]);
run(["-i", SRC, "-vn", "-af", `aselect='${sel}',asetpts=N/SR/TB,highpass=f=70,loudnorm=I=-17:TP=-2:LRA=9`, "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", join(OUT, "cut", "05-farmer.wav")]);
const shots = readdirSync(join(work, "frames")).sort();
const N = Math.min(shots.length, Math.round(total * FPS));

const html = `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; font-family: Inter, "Segoe UI", system-ui, "Nirmala UI", sans-serif;
    background: radial-gradient(1200px 700px at 50% 40%, #24362c, #121b16); color: #f6f7f2; }
  #cam { position: absolute; left: 34px; top: 44px; width: 804px; height: 536px; border-radius: 16px; overflow: hidden; box-shadow: 0 30px 90px rgba(0,0,0,.5); background: #000; }
  #cam img { width: 100%; height: 100%; object-fit: cover; display: block; }
  #tag { position: absolute; left: 50px; top: 58px; background: rgba(13,20,16,.82); border: 1px solid #3a4d42; border-radius: 999px; padding: 6px 14px; font-size: 14px; font-weight: 600; }
  #tag i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #f2b632; margin-right: 8px; }
  #side { position: absolute; left: 866px; top: 44px; width: 380px; height: 536px; }
  #side h3 { margin: 0 0 4px; font-size: 13px; letter-spacing: 2.5px; text-transform: uppercase; color: #f2b632; }
  #side p.sm { margin: 0 0 14px; font-size: 13.5px; line-height: 1.35; color: #a9bcb0; }
  .b { opacity: 0; margin-bottom: 11px; padding: 10px 13px; border-radius: 12px; font-size: 15.5px; line-height: 1.38; max-width: 340px; box-sizing: border-box; }
  .b b { display: block; font-size: 12.5px; letter-spacing: .4px; color: #7fd3a4; margin-bottom: 2px; }
  .in { background: #f6f7f2; color: #17231c; border-top-left-radius: 3px; } .in b { color: #1f7a4d; }
  .out { background: #d7f5c6; color: #17231c; margin-left: auto; width: 210px; border-top-right-radius: 3px; display: flex; align-items: center; gap: 10px; }
  .mic { width: 30px; height: 30px; border-radius: 50%; background: #1f7a4d; flex: none; position: relative; }
  .mic::after { content: ""; position: absolute; left: 11px; top: 6px; width: 8px; height: 13px; border-radius: 4px; background: #fff; box-shadow: 0 8px 0 -3px #fff; }
  .wave { flex: 1; height: 22px; background: repeating-linear-gradient(90deg, #5a8f6f 0 3px, transparent 3px 6px); -webkit-mask: linear-gradient(180deg, transparent 0 20%, #000 20% 80%, transparent 80%); border-radius: 3px; }
  .len { font-size: 12.5px; color: #4c5f54; }
  .chip { background: rgba(23,35,28,.75); border: 2px solid #f2b632; color: #f2b632; font-weight: 600; font-size: 15px; border-radius: 12px; }
  #sub { position: absolute; left: 0; right: 0; bottom: 16px; display: flex; justify-content: center; opacity: 0; }
  #sub span { max-width: 1060px; background: rgba(13,20,16,.92); color: #fff; font-size: 22px; font-weight: 500; line-height: 1.35; padding: 9px 20px; border-radius: 12px; text-align: center; }
  #foot { position: absolute; left: 34px; top: 592px; font-size: 13.5px; color: #a9bcb0; }
</style>
<div id="cam"><img id="shot"></div>
<div id="tag"><i></i>Real messages, sent live by StrawLink on AWS</div>
<div id="side"><h3>On her phone</h3><p class="sm">English copies as sent; each also arrives in Punjabi. Field F0104 is an example field.</p>
${ITEMS.map((m, i) => `<div class="b ${m.cls}" id="m${i}">${m.html}</div>`).join("")}</div>
<div id="foot">Demo day in the app: 24 October 2026, mid-harvest. Two waits of about two seconds are cut.</div>
<div id="sub"><span></span></div>
<script>
  const ITEMS = ${JSON.stringify(ITEMS.map((m) => m.t))}, SUBS = ${JSON.stringify(SUBS)}, DIR = ${JSON.stringify(pathToFileURL(join(work, "frames")).href + "/")};
  const fade = (t, a, b = 1e9, d = 0.3) => Math.max(0, Math.min(1, (t - a) / d, (b - t) / d));
  let last = "";
  window.__clip = async (name, t) => {
    const img = document.getElementById("shot");
    img.src = DIR + name;
    await img.decode();
    ITEMS.forEach((at, i) => { const e = document.getElementById("m" + i), o = fade(t, at); e.style.opacity = o; e.style.transform = "translateY(" + (1 - o) * 10 + "px)"; });
    const s = SUBS.find((x) => t >= x.a - 0.05 && t <= x.b + 0.25), sub = document.getElementById("sub");
    sub.style.opacity = s ? fade(t, s.a - 0.05, s.b + 0.25, 0.18) : 0;
    if (s && s.text !== last) { last = s.text; sub.firstElementChild.textContent = s.text; }
    return true;
  };
</script>`;
writeFileSync(join(work, "page.html"), html);

const b = await launch();
try {
  await b.goto(pathToFileURL(join(work, "page.html")).href);
  for (let i = 0; i < 100; i++) { await b.sleep(100); if (await b.js(`typeof __clip === "function"`).catch(() => false)) break; }
  const ff = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "15", "-pix_fmt", "yuv420p", "-r", String(FPS), join(OUT, "cut", "05-farmer.mp4")], { stdio: ["pipe", "inherit", "inherit"] });
  for (let i = 0; i < N; i++) {
    await b.js(`__clip(${JSON.stringify(shots[i])}, ${i / FPS})`);
    const jpg = await b.grab();
    if (!ff.stdin.write(jpg)) await once(ff.stdin, "drain");
  }
  ff.stdin.end(); await once(ff, "close");
  writeFileSync(join(OUT, "cut", "05-farmer.json"), JSON.stringify({ frames: N, marks: [], audio: "05-farmer.wav" }, null, 1));
  console.log(`05-farmer: ${N} frames = ${(N / FPS).toFixed(1)} s`);
} finally {
  b.close();
}
