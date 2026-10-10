"""Voice-over from a person's own recording, cut into the film's narration lines.

    FFMPEG=/path/to/ffmpeg python app/tools/film/uservoice.py

Reads app/tools/film/voice-cuts.json: the recording, and for every narration line the stretch of
the recording that says it (seconds; the word times came from Amazon Transcribe). Writes
app/.film/voice/<id>.wav (24 kHz mono) and durations.json, the same files voice.py makes from Polly.

Every cut is moved to the nearest film frame (1/30 s). Lines that follow one another in the
recording share their cut point, so when the film plays them back to back the sound is the
original recording, sample for sample; only the ends of a spoken paragraph get a short fade.
"""

from __future__ import annotations

import array
import json
import os
import pathlib
import subprocess
import tempfile
import wave

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[2]
OUT = HERE.parents[1] / ".film" / "voice"
RATE, FPS = 24000, 30
PER_FRAME = RATE // FPS


def ffmpeg() -> str:
    if os.environ.get("FFMPEG"):
        return os.environ["FFMPEG"]
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return "ffmpeg"


def fade(a: array.array, n: int, start: bool) -> None:
    n = min(n, len(a))
    for i in range(n):
        k = i / n
        j = i if start else len(a) - 1 - i
        a[j] = int(a[j] * k)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    spec = json.loads((HERE / "voice-cuts.json").read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory() as tmp:
        whole = pathlib.Path(tmp) / "voice.wav"
        # one pass over the whole recording, so every line gets the same level and tone
        subprocess.run([ffmpeg(), "-y", "-loglevel", "error", "-i", str(REPO / spec["source"]), "-vn",
                        "-af", "highpass=f=70,loudnorm=I=-17:TP=-2:LRA=9", "-ar", str(RATE), "-ac", "1",
                        "-c:a", "pcm_s16le", str(whole)], check=False)
        with wave.open(str(whole), "rb") as w:
            pcm = array.array("h")
            pcm.frombytes(w.readframes(w.getnframes()))
    durations = {}
    ids = list(spec["lines"])
    for n, lid in enumerate(ids):
        a, b = (round(t * FPS) * PER_FRAME for t in spec["lines"][lid])
        piece = array.array("h", pcm[a:b])
        joined_before = n > 0 and spec["lines"][ids[n - 1]][1] == spec["lines"][lid][0]
        joined_after = n + 1 < len(ids) and spec["lines"][ids[n + 1]][0] == spec["lines"][lid][1]
        if not joined_before:
            fade(piece, RATE // 50, True)
        if not joined_after:
            fade(piece, RATE // 16, False)
        with wave.open(str(OUT / f"{lid}.wav"), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
            w.writeframes(piece.tobytes())
        durations[lid] = round(len(piece) / RATE, 4)
    (OUT / "durations.json").write_text(json.dumps(durations, indent=1), encoding="utf-8")
    print(f"{len(durations)} lines, {sum(durations.values()):.1f} s of speech")


if __name__ == "__main__":
    main()
