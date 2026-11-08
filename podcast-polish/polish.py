#!/usr/bin/env python3
"""podcast-polish: clean, balance and convert podcast audio to MP3.

Needs Python 3.8+ and ffmpeg on your PATH. Nothing else.

    python3 polish.py episode.wav
    python3 polish.py *.m4a --mono --bitrate 96k
    python3 polish.py raw.flac -o final.mp3 --preset strong

What it does, in order:
  1. Rumble filter     cuts everything under 80 Hz (desk bumps, AC hum).
  2. Gentle denoise    FFT noise reduction, kept light so voices don't go watery.
  3. Compression       evens out loud and quiet speakers (3:1, slow-ish release).
  4. Loudness          two-pass normalize to -16 LUFS, -1.5 dBTP, the level
                       Spotify, Apple Podcasts and YouTube all play back well.
  5. MP3 encode        44.1 kHz, constant bitrate, no clipping.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

# Each preset is (denoise reduction in dB, compressor ratio).
# "gentle" is for already-decent recordings; "strong" for noisy rooms.
PRESETS = {
    "gentle": (8, 2.0),
    "speech": (12, 3.0),
    "strong": (18, 4.0),
}

TARGET_LUFS = -16.0
TARGET_TP = -1.5
TARGET_LRA = 11.0


class PolishError(Exception):
    pass


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def cleanup_chain(preset, highpass):
    """Filters applied before loudness normalization."""
    nr, ratio = PRESETS[preset]
    return ",".join([
        f"highpass=f={highpass}",
        # nt=w: white-noise model; tn=1 tracks changing noise over time.
        f"afftdn=nr={nr}:nf=-35:tn=1",
        # Slow attack keeps consonants crisp; makeup brings level back up.
        f"acompressor=threshold=-20dB:ratio={ratio}:attack=20:release=250:makeup=4dB",
    ])


def run_ffmpeg(args, capture=False):
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-y"] + args
    res = subprocess.run(cmd, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True)
    if res.returncode != 0:
        tail = "\n".join(res.stderr.strip().splitlines()[-3:])
        raise PolishError(tail)
    return res.stderr


def measure(src, chain):
    """Pass 1: measure loudness of the cleaned audio."""
    af = f"{chain},loudnorm=I={TARGET_LUFS}:TP={TARGET_TP}:LRA={TARGET_LRA}:print_format=json"
    err = run_ffmpeg(["-i", str(src), "-vn", "-af", af, "-f", "null", "-"])
    match = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", err, re.S)
    if not match:
        raise PolishError("could not read loudness measurements from ffmpeg")
    return json.loads(match.group(0))


def polish(src, dst, preset, highpass, bitrate, mono, rate):
    chain = cleanup_chain(preset, highpass)
    m = measure(src, chain)

    # Silent or near-silent file: loudnorm reports -inf and can't help.
    if m["input_i"] in ("-inf", "inf"):
        raise PolishError("file looks silent")

    norm = (
        f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TP}:LRA={TARGET_LRA}"
        f":measured_I={m['input_i']}:measured_TP={m['input_tp']}"
        f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}"
        f":offset={m['target_offset']}:linear=true"
    )
    # loudnorm resamples internally to 192 kHz, so resample back afterward.
    af = f"{chain},{norm},aresample={rate}"

    args = ["-i", str(src), "-vn", "-map_metadata", "0", "-af", af,
            "-c:a", "libmp3lame", "-b:a", bitrate, "-ar", str(rate)]
    if mono:
        args += ["-ac", "1"]
    args.append(str(dst))
    run_ffmpeg(args)
    return m


def main():
    p = argparse.ArgumentParser(description="Clean and convert podcast audio to MP3.")
    p.add_argument("files", nargs="+", type=Path, help="audio or video files, any format ffmpeg reads")
    p.add_argument("-o", "--output", type=Path, help="output path (single input only)")
    p.add_argument("--outdir", type=Path, help="put results in this folder instead of next to the input")
    p.add_argument("--preset", choices=PRESETS, default="speech")
    p.add_argument("--bitrate", default="128k", help="MP3 bitrate (default 128k; 64k-96k is fine for mono speech)")
    p.add_argument("--mono", action="store_true", help="downmix to mono (halves file size, ideal for one-mic shows)")
    p.add_argument("--rate", type=int, default=44100, help="sample rate (default 44100)")
    p.add_argument("--highpass", type=int, default=80, help="rumble cutoff in Hz (default 80)")
    a = p.parse_args()

    if not shutil.which("ffmpeg"):
        die("ffmpeg not found. Install it (brew install ffmpeg / apt install ffmpeg) and retry.")
    if a.output and len(a.files) > 1:
        die("-o only works with a single input file")

    if a.outdir:
        a.outdir.mkdir(parents=True, exist_ok=True)

    failed = 0
    used = set()
    for src in a.files:
        if not src.is_file():
            print(f"skip: {src} not found", file=sys.stderr)
            failed += 1
            continue
        if a.output:
            dst = a.output
        else:
            dst = (a.outdir or src.parent) / (src.stem + ".clean.mp3")
            if dst in used:  # episode.wav and episode.flac in one run
                dst = dst.with_name(f"{src.stem}-{src.suffix.lstrip('.')}.clean.mp3")
        used.add(dst)
        if dst.resolve() == src.resolve():
            print(f"skip: {src.name} (output would overwrite the input)", file=sys.stderr)
            failed += 1
            continue
        print(f"{src.name} -> {dst.name} ...", end=" ", flush=True)
        try:
            m = polish(src, dst, a.preset, a.highpass, a.bitrate, a.mono, a.rate)
        except PolishError as e:
            dst.unlink(missing_ok=True)
            print(f"FAILED\n  {e}", file=sys.stderr)
            failed += 1
            continue
        print(f"done (was {float(m['input_i']):.1f} LUFS, now {TARGET_LUFS:.0f})")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
