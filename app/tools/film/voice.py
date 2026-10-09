"""Voice-over for the demo film: one audio file per narration line, from Amazon Polly.

    python app/tools/film/voice.py            # synthesises lines that are new or changed
    AWS_PROFILE=strawlink FFMPEG=/path/to/ffmpeg python app/tools/film/voice.py

Writes app/.film/voice/<id>.wav (24 kHz mono) and durations.json. Lines are cached by their text,
so editing one line re-records only that line. Needs the AWS CLI (Polly) and ffmpeg.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parents[1] / ".film" / "voice"
VOICE = os.environ.get("POLLY_VOICE", "Kajal")      # Indian English
ENGINE = os.environ.get("POLLY_ENGINE", "generative")
REGION = os.environ.get("POLLY_REGION", "us-east-1")  # generative voices are not in every region
RATE = 24000
TEMPO = float(os.environ.get("VOICE_TEMPO", "1.05"))  # slightly brisker than Polly's default pace


def ffmpeg() -> str:
    if os.environ.get("FFMPEG"):
        return os.environ["FFMPEG"]
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return "ffmpeg"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    lines = json.loads((HERE / "narration.json").read_text(encoding="utf-8"))
    durations = {}
    for line in lines:
        say = line.get("say") or line["text"]
        key = hashlib.sha1(f"{VOICE}|{ENGINE}|{say}".encode()).hexdigest()[:10]
        mp3, wav = OUT / f"{line['id']}-{key}.mp3", OUT / f"{line['id']}.wav"
        if not mp3.exists():
            for old in OUT.glob(f"{line['id']}-*.mp3"):
                old.unlink()
            subprocess.run(["aws", "polly", "synthesize-speech", "--region", REGION, "--engine", ENGINE, "--voice-id", VOICE,
                            "--output-format", "mp3", "--sample-rate", str(RATE), "--text", say, str(mp3)],
                           check=True, stdout=subprocess.DEVNULL)
            print("recorded", line["id"])
        subprocess.run([ffmpeg(), "-y", "-loglevel", "error", "-i", str(mp3), "-filter:a", f"atempo={TEMPO}", "-ar", str(RATE), "-ac", "1",
                        "-map_metadata", "-1", "-bitexact", str(wav)], check=True)
        durations[line["id"]] = round((wav.stat().st_size - 44) / (RATE * 2), 3)
    (OUT / "durations.json").write_text(json.dumps(durations, indent=1), encoding="utf-8")
    total = sum(durations.values())
    print(f"{len(durations)} lines, {total:.1f} s of speech")
    if "--list" in sys.argv:
        for k, v in durations.items():
            print(f"  {k}: {v:.2f}")


if __name__ == "__main__":
    main()
