// The farmer scene: Shambhvi's own camera take beside the screen recording of her phone, with
// captions of what she says.
//
//   FFMPEG=… node app/tools/film/clip.mjs <camera take.mp4> <phone screen recording.mp4>
//
// Writes app/.film/cut/05-farmer.mp4, its sound as 05-farmer.wav and 05-farmer.json.
// The camera take is mirrored (front camera), so it is flipped back, and one wait is cut out
// (KEEP lists what stays). The phone recording is a second run of the same exchange, made the
// same evening; PHONE maps moments of the take to moments of that recording, skipping its waits.
// Times are seconds in each clip; the words' times come from Amazon Transcribe.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FPS, launch } from "./engine.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", ".film");
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const [SRC, SCREEN] = process.argv.slice(2);
if (!SRC || !SCREEN) { console.log("usage: node clip.mjs <camera take.mp4> <phone screen recording.mp4>"); process.exit(1); }

const KEEP = [[1.0, 14.2], [16.7, 29.4]];
/** Camera-take time → film time (the cut-out wait removed). */
const at = (t) => { let out = 0; for (const [a, b] of KEEP) { if (t <= a) break; out += Math.min(t, b) - a; } return out; };
const total = at(1e9);

const SUBS = [
  [1.4, 3.1, "The farmer needs no app."],
  [3.4, 9.0, "Before his harvest, a WhatsApp message in Punjabi tells him his field should be ready."],
  [10.9, 13.5, "Voice note: “मेनू आज हार्वेस्ट करना है” (I am harvesting today)"],
  [17.0, 19.7, "When he cuts, he just says so in a voice note,"],
  [19.8, 21.8, "and the plan changes around him."],
  [22.3, 24.2, "A machine is on its way."],
  [24.3, 28.9, "Afterwards he gets a certificate, and no one is ever reported or fined."],
].map(([a, b, text]) => ({ a: at(a), b: at(b), text }));

// [camera-take time, phone-recording time]: between two rows the phone recording plays at whatever
// speed joins them; a jump (marked) skips a wait in the phone recording.
const PHONE = [
  [1.0, 1.2], [10.6, 8.6],            // the opening message is on the phone, in Punjabi and English
  [13.4, 13.5],                       // she records the voice note
  [17.1, 14.6], [19.6, 16.0],         // sent
  [19.7, 36.4, "jump"], [21.9, 38.8], // the app's answer: heard, harvest recorded
  [22.1, 51.5, "jump"], [24.1, 53.6], // the machine slot arrives
  [29.4, 58.7],
].map(([cam, phone, jump]) => ({ t: at(cam), phone, jump: !!jump }));
function phoneAt(t) {
  for (let i = PHONE.length - 1; i >= 0; i--) {
    const a = PHONE[i];
    if (t < a.t) continue;
    const b = PHONE[i + 1];
    if (!b || b.jump) return a.phone + (b ? Math.min(t - a.t, 0.6) * 0.5 : 0);
    return a.phone + ((b.phone - a.phone) * (t - a.t)) / Math.max(0.001, b.t - a.t);
  }
  return PHONE[0].phone;
}
const NOTES = [
  { t: at(19.9), text: "Amazon Transcribe heard the voice note · harvest recorded for today" },
  { t: at(22.4), text: "The planner ran again · Baler 3 will come 08:02 – 10:06" },
];

const work = join(OUT, "clip");
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, "cam"), { recursive: true });
mkdirSync(join(work, "phone"), { recursive: true });
const run = (args) => { const r = spawnSync(FFMPEG, ["-y", "-loglevel", "error", ...args], { stdio: "inherit" }); if (r.status !== 0) process.exit(r.status ?? 1); };
const sel = KEEP.map(([a, b]) => `between(t,${a},${b})`).join("+");
run(["-i", SRC, "-vf", `select='${sel}',setpts=N/FRAME_RATE/TB,hflip,fps=${FPS}`, "-q:v", "2", join(work, "cam", "%05d.jpg")]);
run(["-i", SRC, "-vn", "-af", `aselect='${sel}',asetpts=N/SR/TB,highpass=f=70,loudnorm=I=-17:TP=-2:LRA=9`, "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", join(OUT, "cut", "05-farmer.wav")]);
const PFPS = 15;
run(["-i", SCREEN, "-vf", `fps=${PFPS},scale=-2:1240`, "-q:v", "2", join(work, "phone", "%05d.jpg")]);
const cam = readdirSync(join(work, "cam")).sort(), phone = readdirSync(join(work, "phone")).sort();
const N = Math.min(cam.length, Math.round(total * FPS));

const html = `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; font-family: Inter, "Segoe UI", system-ui, "Nirmala UI", sans-serif;
    background: radial-gradient(1200px 700px at 50% 40%, #24362c, #121b16); color: #f6f7f2; }
  #cam { position: absolute; left: 34px; top: 40px; width: 834px; height: 556px; border-radius: 16px; overflow: hidden; box-shadow: 0 30px 90px rgba(0,0,0,.5); background: #000; }
  #cam img { width: 100%; height: 100%; object-fit: cover; display: block; }
  #tag { position: absolute; left: 50px; top: 54px; background: rgba(13,20,16,.82); border: 1px solid #3a4d42; border-radius: 999px; padding: 6px 14px; font-size: 14px; font-weight: 600; }
  #tag i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #f2b632; margin-right: 8px; }
  #phone { position: absolute; left: 920px; top: 22px; width: 282px; height: 620px; border-radius: 30px; padding: 9px; background: #0c120e; box-shadow: 0 30px 90px rgba(0,0,0,.55), 0 0 0 1.5px #3a4d42; box-sizing: border-box; }
  #phone img { width: 100%; height: 100%; object-fit: cover; object-position: top; border-radius: 22px; display: block; }
  .note { position: absolute; left: 50px; opacity: 0; background: rgba(13,20,16,.88); border: 2px solid #f2b632; color: #f2b632; font-weight: 600; font-size: 16px; border-radius: 12px; padding: 8px 14px; }
  #n0 { top: 494px; } #n1 { top: 540px; }
  #foot { position: absolute; left: 34px; top: 606px; width: 840px; font-size: 13px; line-height: 1.35; color: #a9bcb0; }
  #sub { position: absolute; left: 0; right: 0; bottom: 14px; display: flex; justify-content: center; opacity: 0; }
  #sub span { max-width: 1060px; background: rgba(13,20,16,.94); color: #fff; font-size: 22px; font-weight: 500; line-height: 1.35; padding: 9px 20px; border-radius: 12px; text-align: center; }
</style>
<div id="cam"><img id="shot"></div>
<div id="tag"><i></i>Real messages, sent by StrawLink on AWS</div>
${NOTES.map((n, i) => `<div class="note" id="n${i}">${n.text}</div>`).join("")}
<div id="phone"><img id="screen"></div>
<div id="foot">Phone screen: a recording of the same exchange, made the same evening; waiting time is cut. Demo day in the app: 24 October 2026. Field F0104 and its operator are example data.</div>
<div id="sub"><span></span></div>
<script>
  const NOTES = ${JSON.stringify(NOTES.map((n) => n.t))}, SUBS = ${JSON.stringify(SUBS)};
  const CAM = ${JSON.stringify(pathToFileURL(join(work, "cam")).href + "/")}, PHONE = ${JSON.stringify(pathToFileURL(join(work, "phone")).href + "/")};
  const fade = (t, a, b = 1e9, d = 0.3) => Math.max(0, Math.min(1, (t - a) / d, (b - t) / d));
  let last = "", lastScreen = "";
  window.__clip = async (camName, screenName, t) => {
    const img = document.getElementById("shot");
    img.src = CAM + camName;
    const jobs = [img.decode()];
    if (screenName !== lastScreen) { lastScreen = screenName; const s = document.getElementById("screen"); s.src = PHONE + screenName; jobs.push(s.decode()); }
    await Promise.all(jobs);
    NOTES.forEach((at, i) => { const e = document.getElementById("n" + i), o = fade(t, at); e.style.opacity = o; e.style.transform = "translateY(" + (1 - o) * 10 + "px)"; });
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
    const t = i / FPS, p = Math.max(0, Math.min(phone.length - 1, Math.round(phoneAt(t) * PFPS)));
    await b.js(`__clip(${JSON.stringify(cam[i])}, ${JSON.stringify(phone[p])}, ${t})`);
    const jpg = await b.grab();
    if (!ff.stdin.write(jpg)) await once(ff.stdin, "drain");
  }
  ff.stdin.end(); await once(ff, "close");
  writeFileSync(join(OUT, "cut", "05-farmer.json"), JSON.stringify({ frames: N, marks: [], audio: "05-farmer.wav" }, null, 1));
  console.log(`05-farmer: ${N} frames = ${(N / FPS).toFixed(1)} s`);
} finally {
  b.close();
}
