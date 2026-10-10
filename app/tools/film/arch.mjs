// The architecture scene: an animated map of the AWS services StrawLink runs on, lit up in the
// order the narration (lines a1…a5) walks through them. Only services the deployed stack uses.
//
//   FFMPEG=… node app/tools/film/arch.mjs        → app/.film/cut/075-aws.mp4 + .json
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FPS, launch } from "./engine.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", ".film");
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const NAME = "075-aws";
const DUR = JSON.parse(readFileSync(join(OUT, "voice", "durations.json"), "utf8"));
const TEXT = Object.fromEntries(JSON.parse(readFileSync(join(HERE, "narration.json"), "utf8")).map((l) => [l.id, l.text]));

// narration beats: when each line starts (seconds) and how long it is
const LEAD = 0.5, GAP = 0;
let t = LEAD;
const beats = ["a1", "a2", "a3", "a4"].map((id) => { const b = { id, at: t, dur: DUR[id], text: TEXT[id] }; t += DUR[id] + GAP; return b; });
const total = t + 2.0;
const B = Object.fromEntries(beats.map((b) => [b.id, b.at]));

// kind: aws | ai | out (outside AWS).  on: the moment the box lights up.
const X = [128, 372, 616, 860, 1108], Y = [160, 318, 476];
const d1 = DUR.a1, d2 = DUR.a2, d3 = DUR.a3;
const NODES = [
  { id: "sat", x: X[0], y: Y[0], kind: "out", name: "Sentinel-2", sub: "satellite images", on: B.a1 + d1 * 0.3 },
  { id: "s3", x: X[1], y: Y[0], kind: "aws", name: "S3", sub: "forecasts · certificates", on: B.a1 + d1 * 0.5 },
  { id: "load", x: X[2], y: Y[0], kind: "aws", name: "Lambda", sub: "loader", on: B.a1 + d1 * 0.7 },
  { id: "ddb", x: X[3], y: Y[0], kind: "aws", name: "DynamoDB", sub: "fields · plans · messages", on: B.a1 + d1 * 0.9 },
  { id: "eb", x: X[0], y: Y[1], kind: "aws", name: "EventBridge", sub: "every day, 06:00", on: B.a2 },
  { id: "plan", x: X[1], y: Y[1], kind: "aws", name: "Lambda", sub: "planner · OR-Tools", on: B.a2 + d2 * 0.4 },
  { id: "api", x: X[3], y: Y[1], kind: "aws", name: "Lambda", sub: "API · FastAPI", on: B.a4 },
  { id: "amp", x: X[4], y: (Y[0] + Y[1]) / 2, kind: "aws", name: "Amplify Hosting", sub: "the officer's map", on: B.a4 + 0.5 },
  { id: "farmer", x: X[0], y: Y[2], kind: "out", name: "Farmer", sub: "WhatsApp · Twilio", on: B.a3 },
  { id: "gw", x: X[1], y: Y[2], kind: "aws", name: "API Gateway", sub: "webhook · API", on: B.a3 + d3 * 0.2 },
  { id: "work", x: X[2], y: Y[2], kind: "aws", name: "Lambda", sub: "message worker", on: B.a3 + d3 * 0.35 },
  { id: "tr", x: X[3], y: Y[2], kind: "ai", name: "Transcribe", sub: "voice note → text", on: B.a3 + d3 * 0.55 },
  { id: "br", x: X[4], y: Y[2], kind: "ai", name: "Bedrock", sub: "Nova Pro · Strands agent", on: B.a3 + d3 * 0.8 },
];
const EDGES = [
  ["sat", "s3", B.a1 + d1 * 0.4], ["s3", "load", B.a1 + d1 * 0.6], ["load", "ddb", B.a1 + d1 * 0.8],
  ["eb", "plan", B.a2 + d2 * 0.2], ["plan", "ddb", B.a2 + d2 * 0.65],
  ["farmer", "gw", B.a3 + d3 * 0.1], ["gw", "work", B.a3 + d3 * 0.28], ["work", "tr", B.a3 + d3 * 0.45], ["tr", "br", B.a3 + d3 * 0.68],
  ["work", "plan", B.a3 + d3 * 0.95], ["work", "farmer", B.a4 - 0.3, true],
  ["ddb", "api", B.a4 - 0.1], ["api", "amp", B.a4 + 0.3],
].map(([from, to, on, bend]) => ({ from, to, on, bend: !!bend }));

const html = `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; font-family: Inter, "Segoe UI", system-ui, sans-serif;
    background: radial-gradient(1100px 620px at 50% 38%, #f6f8f3, #dfe7de); color: #17231c; }
  #head { position: absolute; left: 56px; top: 34px; }
  #head .eye { font-size: 14px; font-weight: 700; letter-spacing: 3px; text-transform: uppercase; color: #1f7a4d; }
  #head h1 { margin: 4px 0 0; font-size: 34px; letter-spacing: -0.8px; }
  #count { position: absolute; right: 56px; top: 34px; text-align: right; }
  #count b { display: block; font-size: 58px; line-height: 1; letter-spacing: -2px; color: #1f7a4d; }
  #count span { font-size: 14px; font-weight: 600; color: #5d7366; }
  svg { position: absolute; inset: 0; }
  .lab { position: absolute; width: 220px; margin-left: -110px; text-align: center; }
  .lab b { display: block; font-size: 18px; letter-spacing: -0.2px; }
  .lab span { display: block; font-family: "Cascadia Mono", Consolas, monospace; font-size: 12.5px; color: #5d7366; margin-top: 1px; }
  #also { position: absolute; left: 0; right: 0; top: 598px; text-align: center; font-size: 15px; font-weight: 600; color: #3a4d42; opacity: 0; }
  #also i { font-style: normal; display: inline-block; border: 1.5px solid #9fb3a6; border-radius: 999px; padding: 4px 13px; margin: 0 4px; background: rgba(255,255,255,.6); }
  #sub { position: absolute; left: 0; right: 0; bottom: 16px; display: flex; justify-content: center; opacity: 0; }
  #sub span { max-width: 1060px; background: rgba(13,20,16,.92); color: #fff; font-size: 22px; font-weight: 500; line-height: 1.35; padding: 9px 20px; border-radius: 12px; text-align: center; }
</style>
<div id="head"><div class="eye">How it is built</div><h1>Serverless on AWS · Mumbai region</h1></div>
<div id="count"><b>0</b><span>AWS services in use</span></div>
<svg viewBox="0 0 1280 720" id="art"></svg>
<div id="labels"></div>
<div id="also">also in the stack <i>Systems Manager · secrets</i><i>CloudFormation · SAM</i><i>CloudWatch · logs</i></div>
<div id="sub"><span></span></div>
<script>
  const NODES = ${JSON.stringify(NODES)}, EDGES = ${JSON.stringify(EDGES)}, BEATS = ${JSON.stringify(beats)}, END = ${total};
  const KIND = { aws: ["#eef2ea", "#c9d3c8", "#aebbad", "#1f7a4d"], ai: ["#e6defa", "#bcaeea", "#9f8fd6", "#5b3fb3"], out: ["#f6dfd2", "#e3b9a3", "#cf9c84", "#a4502c"] };
  const NS = "http://www.w3.org/2000/svg", art = document.getElementById("art"), byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
  const mk = (tag, attrs, parent = art) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.appendChild(e); return e; };
  const S = 36;
  // edges first, so boxes sit on top of them
  for (const e of EDGES) {
    const a = byId[e.from], b = byId[e.to];
    const d = e.bend ? "M" + a.x + " " + (a.y + 76) + " Q " + (a.x + b.x) / 2 + " " + (a.y + 128) + " " + b.x + " " + (b.y + 76) : "M" + a.x + " " + (a.y - 4) + " L " + b.x + " " + (b.y - 4);
    e.base = mk("path", { d, fill: "none", stroke: "#b9c5ba", "stroke-width": 1.6, "stroke-dasharray": e.bend ? "5 6" : "" });
    e.hot = mk("path", { d, fill: "none", stroke: "#1f7a4d", "stroke-width": 2.6, "stroke-linecap": "round" });
    e.len = e.hot.getTotalLength();
    e.hot.setAttribute("stroke-dasharray", e.len); e.hot.setAttribute("stroke-dashoffset", e.len);
    e.dots = [0, 1, 2].map(() => mk("circle", { r: 4.6, fill: "#e8623d", opacity: 0 }));
  }
  for (const n of NODES) {
    const [top, left, right, ink] = KIND[n.kind], g = mk("g", {});
    const p = (dx, dy) => (n.x + dx) + "," + (n.y + dy);
    mk("ellipse", { cx: n.x, cy: n.y + 34, rx: 44, ry: 12, fill: "rgba(23,35,28,.13)" }, g);
    mk("polygon", { points: [p(-S, -22), p(0, -6), p(0, 32), p(-S, 16)].join(" "), fill: left }, g);
    mk("polygon", { points: [p(S, -22), p(0, -6), p(0, 32), p(S, 16)].join(" "), fill: right }, g);
    mk("polygon", { points: [p(0, -38), p(S, -22), p(0, -6), p(-S, -22)].join(" "), fill: top, stroke: "rgba(255,255,255,.7)", "stroke-width": 1 }, g);
    n.glow = mk("polygon", { points: [p(0, -38), p(S, -22), p(S, 16), p(0, 32), p(-S, 16), p(-S, -22)].join(" "), fill: "none", stroke: ink, "stroke-width": 3, "stroke-linejoin": "round", opacity: 0 }, g);
    n.g = g;
    const lab = document.createElement("div");
    lab.className = "lab"; lab.style.left = n.x + "px"; lab.style.top = (n.y + 40) + "px";
    lab.innerHTML = "<b style='color:" + (n.kind === "aws" ? "#17231c" : ink) + "'>" + n.name + "</b><span>" + n.sub + "</span>";
    document.getElementById("labels").appendChild(lab); n.lab = lab;
  }
  const clamp = (v) => Math.max(0, Math.min(1, v)), ease = (u) => 1 - Math.pow(1 - clamp(u), 3);
  const AWS = ["s3", "load", "ddb", "eb", "plan", "gw", "work", "tr", "br", "api", "amp"]; // distinct services are counted below
  const SERVICE = { s3: "S3", load: "Lambda", ddb: "DynamoDB", eb: "EventBridge", plan: "Lambda", gw: "API Gateway", work: "Lambda", tr: "Transcribe", br: "Bedrock", api: "Lambda", amp: "Amplify" };
  let last = "";
  window.__arch = (t) => {
    const intro = ease((t - 0.2) / 0.8);
    for (const n of NODES) {
      const k = NODES.indexOf(n), seen = ease((t - 0.35 - k * 0.07) / 0.5), lit = ease((t - n.on) / 0.45), pulse = Math.max(0, 1 - Math.abs(t - n.on - 0.25) / 0.5);
      n.g.setAttribute("opacity", seen * (0.42 + 0.58 * lit));
      n.g.setAttribute("transform", "translate(" + n.x + " " + n.y + ") scale(" + (0.9 + 0.1 * seen + 0.09 * pulse) + ") translate(" + -n.x + " " + -n.y + ")");
      n.glow.setAttribute("opacity", lit * (0.55 + 0.45 * pulse));
      n.lab.style.opacity = seen * (0.45 + 0.55 * lit);
    }
    for (const e of EDGES) {
      const u = ease((t - e.on) / 0.7);
      e.base.setAttribute("opacity", intro * 0.9);
      e.hot.setAttribute("stroke-dashoffset", e.len * (1 - u));
      e.dots.forEach((d, i) => {
        if (t < e.on) return d.setAttribute("opacity", 0);
        const f = ((t - e.on) * 0.42 + i / 3) % 1, pt = e.hot.getPointAtLength(e.len * f);
        d.setAttribute("cx", pt.x); d.setAttribute("cy", pt.y); d.setAttribute("opacity", Math.min(1, f * 6, (1 - f) * 6) * u);
      });
    }
    // the counter: distinct AWS services lit so far, plus the three listed underneath at the end
    const also = ease((t - (END - 2.6)) / 0.5);
    const litNow = new Set(NODES.filter((n) => SERVICE[n.id] && t >= n.on).map((n) => SERVICE[n.id])).size + (also > 0.5 ? 3 : 0);
    document.querySelector("#count b").textContent = litNow;
    document.getElementById("count").style.opacity = intro;
    document.getElementById("head").style.opacity = intro;
    document.getElementById("also").style.opacity = also;
    const s = BEATS.find((b) => t >= b.at && t <= b.at + b.dur + 0.15), sub = document.getElementById("sub");
    sub.style.opacity = s ? Math.min(1, (t - s.at) / 0.15, (s.at + s.dur + 0.15 - t) / 0.15) : 0;
    if (s && s.text !== last) { last = s.text; sub.firstElementChild.textContent = s.text; }
    return true;
  };
</script>`;
mkdirSync(join(OUT, "arch"), { recursive: true });
writeFileSync(join(OUT, "arch", "page.html"), html);

const N = Math.round(total * FPS);
const b = await launch();
try {
  await b.goto(pathToFileURL(join(OUT, "arch", "page.html")).href);
  for (let i = 0; i < 100; i++) { await b.sleep(100); if (await b.js(`typeof __arch === "function"`).catch(() => false)) break; }
  const ff = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "15", "-pix_fmt", "yuv420p", "-r", String(FPS), join(OUT, "cut", `${NAME}.mp4`)], { stdio: ["pipe", "inherit", "inherit"] });
  for (let i = 0; i < N; i++) {
    await b.js(`__arch(${i / FPS})`);
    const jpg = await b.grab();
    if (!ff.stdin.write(jpg)) await once(ff.stdin, "drain");
  }
  ff.stdin.end(); await once(ff, "close");
  writeFileSync(join(OUT, "cut", `${NAME}.json`), JSON.stringify({ frames: N, marks: beats.map((x) => ({ id: x.id, frame: Math.round(x.at * FPS) })) }, null, 1));
  console.log(`${NAME}: ${N} frames = ${(N / FPS).toFixed(1)} s`);
} finally {
  b.close();
}
