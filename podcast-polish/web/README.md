# Podcast Polish (web)

A single-page tool: drop in a recording, get a clean, level MP3. All processing happens in the browser, so no audio is uploaded anywhere and there's no server to run.

## Run it

Browsers won't start the audio worker from a `file://` address, so serve the folder:

```
cd podcast-polish/web
python3 -m http.server 8000
```

Then open http://localhost:8000. To put it online, upload the `web/` folder to any static host (Cloudflare Pages, Netlify, GitHub Pages). It is kept out of `site/` on purpose, so it won't appear on the music website unless you decide to move it there.

## What it does to the audio

| Step | Purpose |
|---|---|
| Rumble filter (80 Hz) | Removes desk thumps and low hum |
| Noise reduction | Learns the room's noise from the pauses between sentences, then lowers it. A strength slider from Gentle to Strong |
| Speaker leveler | Lifts a quieter speaker toward the louder one (up to 8 dB) without lifting room noise in the pauses |
| Compressor | Catches only the loud syllables (2:1, 3:1 or 4:1 by preset) |
| De-esser | Softens harsh "s" and "sh" sounds (5-9 kHz), at most 6 dB, only when they stand out from the rest of the voice |
| Loudness | Sets integrated loudness to -16 LUFS (ITU-R BS.1770) |
| Peak limiter | 5 ms look-ahead, keeps true peak under -1.5 dBTP after MP3 encoding |
| MP3 | 44.1 kHz, 64-192 kbps, optional mono |

## Tested results

On a synthetic two-speaker recording (eSpeak voices, one 9 dB quieter, with pink noise and 60 Hz hum), measured with ffmpeg:

- Loudness: -29.4 LUFS in, -16.0 to -16.1 LUFS out
- Speaker gap: 8.2 dB in, 0.9 dB out
- Voice-to-noise gap: about 9 dB wider on Standard, about 13 dB wider on Strong
- True peak: -1.7 dBFS or lower

Speed is roughly 30x real time (45 seconds of audio in about 1.5 seconds on the test machine).

## Limits

- **Formats** are whatever the browser can decode. Chrome, Edge, Safari and Firefox all handle WAV, MP3, FLAC, OGG and M4A/AAC. AIFF works in Safari only. If a file won't open, convert it to WAV first.
- **Length.** The whole file is held in memory as decoded audio (about 10 MB per minute per channel). Episodes up to an hour or so are fine on a laptop; much longer may run out of memory, especially on phones. Mono mode halves it.
- **What it can't fix:** echo, music under speech, other people talking in the background, clipped (distorted) recordings. Stationary noise (hiss, fans, hum) is what it removes.
- If the slider near Strong makes a voice sound thin or watery, move it back toward the middle. Heavy noise reduction on a quiet recording is where artifacts come from.

## Files

- `index.html`, `style.css`, `app.js`: the page
- `worker.js`: runs the processing off the main thread
- `dsp.js`: the audio engine (no dependencies; also runs in Node)
- `vendor/lame.min.js`: lamejs 1.2.1 MP3 encoder from npm (LGPL, license in `vendor/LAMEJS-LICENSE.txt`). SHA-256 `15d285e2587b3bdbfd18a68de6ce07cc074f7480a82c3815da2dc1c348ec6df4`
