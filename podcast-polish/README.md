# podcast-polish

One command turns raw podcast audio into a clean, level-balanced MP3 ready to upload.

Needs Python 3.8+ and [ffmpeg](https://ffmpeg.org/download.html). No pip installs.

```
python3 polish.py episode.wav                 # writes episode.clean.mp3 next to it
python3 polish.py *.m4a --outdir ready/       # batch, results in ./ready
python3 polish.py host.flac --mono --bitrate 96k
python3 polish.py noisy.wav --preset strong -o final.mp3
```

Input can be anything ffmpeg reads: WAV, FLAC, M4A/AAC, OGG, AIFF, MP3, even video files (the audio is extracted).

## What happens to the audio

1. Cuts rumble below 80 Hz.
2. Light noise reduction (hiss, fan noise).
3. Compression so loud and quiet moments sit closer together.
4. Two-pass loudness normalization to -16 LUFS with a -1.5 dBTP ceiling. That's the common target for Spotify, Apple Podcasts and YouTube, and the true-peak margin stops MP3 encoding from clipping.
5. MP3 at 44.1 kHz, constant bitrate.

The loudness pass is linear (a straight gain change, no extra squashing), which is why it doesn't add distortion.

## Options

| Flag | Default | Notes |
|---|---|---|
| `--preset` | `speech` | `gentle` for good recordings, `strong` for noisy rooms |
| `--bitrate` | `128k` | `64k`-`96k` is plenty for mono speech |
| `--mono` | off | Halves file size; right for single-mic shows |
| `--highpass` | `80` | Rumble cutoff in Hz |
| `--rate` | `44100` | Sample rate |
| `--outdir` | next to input | Folder for results |

If two inputs share a name (`ep.wav`, `ep.flac`), the second becomes `ep-flac.clean.mp3` so nothing is overwritten. A bad or silent file is reported and skipped; the rest of the batch still runs.

## Limits

This is a clean-up tool, not a restoration suite. It won't remove echo, music under speech, or a loud barking dog. Steady hum at 50 or 60 Hz is only partly reduced by the rumble filter. If a file sounds worse after `--preset strong`, drop back to `speech` or `gentle`; heavy denoising on a quiet voice is where artifacts come from.
