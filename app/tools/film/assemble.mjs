// Join the filmed scenes and lay the voice-over under them.
//   node app/tools/film/assemble.mjs [output.mp4]        (needs FFMPEG, or ffmpeg on PATH)
// Each scene's .json says at which frame every narration line starts; the voice files are placed
// at exactly those moments, so picture and voice cannot drift.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", ".film");
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const FPS = 30, RATE = 24000;
const target = resolve(process.argv[2] || join(HERE, "..", "..", "..", "docs", "video", "strawlink-demo.mp4"));
mkdirSync(dirname(target), { recursive: true });

const scenes = readdirSync(join(OUT, "scenes")).filter((f) => f.endsWith(".json")).sort().map((f) => f.replace(".json", ""));
let frames = 0;
const cues = [];
for (const name of scenes) {
  const s = JSON.parse(readFileSync(join(OUT, "scenes", `${name}.json`), "utf8"));
  for (const m of s.marks) cues.push({ id: m.id, at: (frames + m.frame) / FPS });
  console.log(`${name}: ${(s.frames / FPS).toFixed(1)} s`);
  frames += s.frames;
}
const total = frames / FPS;
console.log(`film: ${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, "0")} (${total.toFixed(1)} s), ${cues.length} narration lines`);

/** The samples of a 16-bit mono WAV file. */
function samples(file) {
  const buf = readFileSync(file);
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4), size = buf.readUInt32LE(p + 4);
    if (id === "data") return new Int16Array(buf.buffer, buf.byteOffset + p + 8, Math.floor(Math.min(size, buf.length - p - 8) / 2));
    p += 8 + size + (size % 2);
  }
  throw new Error(`no audio data in ${file}`);
}
const track = new Int16Array(Math.ceil((total + 0.5) * RATE));
let prevEnd = 0;
for (const c of cues) {
  const a = samples(join(OUT, "voice", `${c.id}.wav`)), at = Math.round(c.at * RATE);
  if (c.at < prevEnd - 0.02) console.log(`  ! ${c.id} starts ${(prevEnd - c.at).toFixed(2)} s before the previous line ends`);
  for (let i = 0; i < a.length && at + i < track.length; i++) track[at + i] = Math.max(-32768, Math.min(32767, track[at + i] + a[i]));
  prevEnd = c.at + a.length / RATE;
}
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + track.byteLength, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28);
header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(track.byteLength, 40);
const wav = join(OUT, "narration.wav");
writeFileSync(wav, Buffer.concat([header, Buffer.from(track.buffer, track.byteOffset, track.byteLength)]));

const list = join(OUT, "scenes.txt");
writeFileSync(list, scenes.map((n) => `file '${join(OUT, "scenes", `${n}.mp4`).replace(/\\/g, "/")}'`).join("\n"));
const r = spawnSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-i", wav,
  // frames were captured as full-range JPEG; convert once to the standard video range so every player shows the same colours
  "-vf", "scale=in_color_matrix=bt601:in_range=pc:out_color_matrix=bt709:out_range=tv,format=yuv420p",
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
  "-af", "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000", "-ac", "2", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", total.toFixed(3), target], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
writeFileSync(join(OUT, "cues.json"), JSON.stringify(cues, null, 1));
console.log("wrote", target);
