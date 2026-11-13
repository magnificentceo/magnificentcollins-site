/* podcast-polish audio engine. No dependencies; runs in a Web Worker or Node.
 *
 * Chain: rumble filter -> spectral noise reduction -> speaker leveler ->
 *        compressor -> loudness normalize (-16 LUFS) -> peak limiter -> MP3.
 *
 * Audio arrives as an array of Float32Array channels (already 44.1 kHz) and is
 * modified in place to save memory.
 */
(function (root) {
  'use strict';

  var PRESETS = {
    //          noise cut limit, subtraction strength, compressor ratio
    light:    { floorDb: -10, alpha: 1.0, ratio: 2.0 },
    standard: { floorDb: -16, alpha: 1.4, ratio: 3.0 },
    strong:   { floorDb: -24, alpha: 2.0, ratio: 4.0 }
  };
  // Strength runs 0..1 (the slider). Presets are just named positions on it.
  var STRENGTH = { light: 0.2, standard: 0.5, strong: 0.85 };
  function paramsFor(opts) {
    var s = typeof opts.strength === 'number' ? opts.strength : (STRENGTH[opts.preset] || STRENGTH.standard);
    s = Math.max(0, Math.min(1, s));
    return { floorDb: -6 - 22 * s, alpha: 0.8 + 1.4 * s, ratio: 1.5 + 2.5 * s };
  }
  var TARGET_LUFS = -16;
  var CEILING_DB = -2.5; // sample-peak ceiling; keeps true peak under -1.5 dBTP after MP3 encoding

  function dbToLin(d) { return Math.pow(10, d / 20); }

  /* ---------- filters ---------- */

  function highpassCoefs(fc, fs, Q) {
    var w = 2 * Math.PI * fc / fs, cw = Math.cos(w), al = Math.sin(w) / (2 * Q), a0 = 1 + al;
    return { b0: (1 + cw) / 2 / a0, b1: -(1 + cw) / a0, b2: (1 + cw) / 2 / a0,
             a1: -2 * cw / a0, a2: (1 - al) / a0 };
  }

  function applyBiquad(x, c) {
    var z1 = 0, z2 = 0, b0 = c.b0, b1 = c.b1, b2 = c.b2, a1 = c.a1, a2 = c.a2;
    for (var i = 0; i < x.length; i++) {
      var v = x[i], y = b0 * v + z1;
      z1 = b1 * v - a1 * y + z2;
      z2 = b2 * v - a2 * y;
      x[i] = y;
    }
  }

  /* ---------- FFT (radix-2, in place) ---------- */

  function makeFFT(n) {
    var cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), rev = new Uint32Array(n), i, bits = Math.log2(n) | 0;
    for (i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
    for (i = 0; i < n; i++) {
      var r = 0, v = i;
      for (var b = 0; b < bits; b++) { r = (r << 1) | (v & 1); v >>= 1; }
      rev[i] = r;
    }
    return function (re, im) {
      var j, t;
      for (i = 0; i < n; i++) {
        j = rev[i];
        if (j > i) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (var size = 2; size <= n; size <<= 1) {
        var half = size >> 1, step = n / size;
        for (var s = 0; s < n; s += size) {
          for (var k = 0, p = s; k < half; k++, p++) {
            var q = p + half, c = cos[k * step], sn = sin[k * step];
            var tr = re[q] * c + im[q] * sn, ti = -re[q] * sn + im[q] * c;
            re[q] = re[p] - tr; im[q] = im[p] - ti;
            re[p] += tr; im[p] += ti;
          }
        }
      }
    };
  }

  /* ---------- noise reduction ---------- */

  var N = 2048, HOP = 512, BINS = N / 2 + 1;

  function sqrtHann() {
    var w = new Float64Array(N);
    for (var i = 0; i < N; i++) w[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    return w;
  }

  // Power spectrum of one frame starting at `start`, lightly smoothed across frequency.
  function framePower(x, start, win, fft, re, im, out) {
    var i, v, len = x.length;
    for (i = 0; i < N; i++) { v = start + i; re[i] = (v >= 0 && v < len) ? x[v] * win[i] : 0; im[i] = 0; }
    fft(re, im);
    var prev = re[0] * re[0] + im[0] * im[0], cur = prev, next;
    for (var k = 0; k < BINS; k++) {
      next = k + 1 < BINS ? re[k + 1] * re[k + 1] + im[k + 1] * im[k + 1] : cur;
      out[k] = 0.25 * prev + 0.5 * cur + 0.25 * next;
      prev = cur; cur = next;
    }
  }

  // Noise profile = average spectrum of the quietest frames (the pauses between sentences).
  function estimateNoise(x, fs, win, fft) {
    var re = new Float64Array(N), im = new Float64Array(N), tmp = new Float32Array(BINS);
    var count = Math.min(1500, Math.max(8, Math.floor((x.length - N) / HOP)));
    var stride = Math.max(1, Math.floor((x.length - N) / count));
    var spectra = new Float32Array(count * BINS), energy = new Float64Array(count);
    var lo = Math.floor(100 / (fs / N)), hi = Math.min(BINS - 1, Math.floor(8000 / (fs / N)));
    var f, k;
    for (f = 0; f < count; f++) {
      framePower(x, f * stride, win, fft, re, im, tmp);
      var e = 0;
      for (k = 0; k < BINS; k++) { spectra[f * BINS + k] = tmp[k]; if (k >= lo && k <= hi) e += tmp[k]; }
      energy[f] = e;
    }
    var order = Array.prototype.slice.call(new Uint32Array(count).map(function (_, i) { return i; }));
    order.sort(function (a, b) { return energy[a] - energy[b]; });
    var take = Math.max(4, Math.floor(count * 0.08)), noise = new Float64Array(BINS);
    for (var t = 0; t < take; t++) for (k = 0; k < BINS; k++) noise[k] += spectra[order[t] * BINS + k] / take;
    return noise;
  }

  function denoise(x, fs, preset, onProgress) {
    if (x.length < N * 8) return; // too short to learn a noise profile
    var fft = makeFFT(N), win = sqrtHann();
    var noise = estimateNoise(x, fs, win, fft);
    var re = new Float64Array(N), im = new Float64Array(N), pw = new Float32Array(BINS);
    var ptime = new Float32Array(BINS), gPrev = new Float32Array(BINS).fill(1), g = new Float32Array(BINS);
    var out = new Float32Array(x.length);
    var floor2 = Math.pow(10, preset.floorDb / 10), alpha = preset.alpha;
    var release = dbToLin(-3), len = x.length, i, k, v;
    var first = -(N - HOP), nFrames = Math.ceil((len - first) / HOP), frame = 0;

    for (var start = first; start < len; start += HOP, frame++) {
      framePower(x, start, win, fft, re, im, pw); // also leaves the complex spectrum in re/im
      for (k = 0; k < BINS; k++) {
        ptime[k] = 0.5 * ptime[k] + 0.5 * pw[k];
        var g2 = 1 - alpha * noise[k] / (ptime[k] + 1e-20);
        if (g2 < floor2) g2 = floor2;
        var gk = Math.sqrt(g2), slow = gPrev[k] * release;
        if (gk < slow) gk = slow; // speech opens instantly, closes gently
        g[k] = gPrev[k] = gk;
      }
      for (k = 0; k < BINS; k++) {
        re[k] *= g[k]; im[k] *= g[k];
        if (k > 0 && k < BINS - 1) { re[N - k] *= g[k]; im[N - k] *= g[k]; }
      }
      fft(im, re); // inverse via swapped arguments
      for (i = 0; i < N; i++) {
        v = start + i;
        if (v >= 0 && v < len) out[v] += re[i] * win[i] / N / 2;
      }
      if (onProgress && (frame & 1023) === 0) onProgress(frame / nFrames);
    }
    x.set(out);
  }

  /* ---------- loudness (ITU-R BS.1770 / EBU R128) ---------- */

  function kWeighting(fs) {
    var K = Math.tan(Math.PI * 1681.9744509555319 / fs), Q = 0.7071752369554196;
    var Vh = Math.pow(10, 3.999843853973347 / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    var a0 = 1 + K / Q + K * K;
    var shelf = { b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q + K * K) / a0,
                  a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
    K = Math.tan(Math.PI * 38.13547087613982 / fs); Q = 0.5003270373238773;
    a0 = 1 + K / Q + K * K;
    var hp = { b0: 1 / a0, b1: -2 / a0, b2: 1 / a0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
    return [shelf, hp];
  }

  function integratedLoudness(chs, fs) {
    var seg = Math.round(fs * 0.1), n = chs[0].length, nSeg = Math.floor(n / seg);
    if (nSeg < 4) return -Infinity;
    var energy = new Float64Array(nSeg), filters = kWeighting(fs), c, f, i;
    for (c = 0; c < chs.length; c++) {
      var x = chs[c], st = [[0, 0], [0, 0]];
      for (var s = 0; s < nSeg; s++) {
        var sum = 0;
        for (i = s * seg; i < (s + 1) * seg; i++) {
          var v = x[i];
          for (f = 0; f < 2; f++) {
            var co = filters[f], z = st[f], y = co.b0 * v + z[0];
            z[0] = co.b1 * v - co.a1 * y + z[1];
            z[1] = co.b2 * v - co.a2 * y;
            v = y;
          }
          sum += v * v;
        }
        energy[s] += sum / seg; // channel gains are 1.0 for L/R
      }
    }
    var blocks = [], b, e;
    for (b = 0; b + 4 <= nSeg; b++) {
      e = (energy[b] + energy[b + 1] + energy[b + 2] + energy[b + 3]) / 4;
      blocks.push(e);
    }
    var lufs = function (e) { return -0.691 + 10 * Math.log10(e); };
    var kept = blocks.filter(function (e) { return lufs(e) > -70; });
    if (!kept.length) return -Infinity;
    var mean = kept.reduce(function (a, e) { return a + e; }, 0) / kept.length;
    var gate = lufs(mean) - 10;
    kept = kept.filter(function (e) { return lufs(e) > gate; });
    if (!kept.length) return -Infinity;
    return lufs(kept.reduce(function (a, e) { return a + e; }, 0) / kept.length);
  }

  function samplePeakDb(chs) {
    var p = 0;
    for (var c = 0; c < chs.length; c++) { var x = chs[c]; for (var i = 0; i < x.length; i++) { var a = Math.abs(x[i]); if (a > p) p = a; } }
    return 20 * Math.log10(Math.max(p, 1e-9));
  }

  // Speech level (loud 10%) vs noise floor (quiet 10%) in 50 ms blocks.
  function levelStats(chs, fs) {
    var hop = Math.round(fs * 0.05), nb = Math.floor(chs[0].length / hop), db = new Float64Array(nb);
    for (var b = 0; b < nb; b++) {
      var s = 0;
      for (var c = 0; c < chs.length; c++) { var x = chs[c]; for (var i = b * hop; i < (b + 1) * hop; i++) s += x[i] * x[i]; }
      db[b] = 10 * Math.log10(s / (hop * chs.length) + 1e-12);
    }
    var sorted = Array.prototype.slice.call(db).sort(function (a, b) { return a - b; });
    var noise = sorted[Math.floor(nb * 0.1)], speech = sorted[Math.floor(nb * 0.9)];
    return { noiseDb: noise, speechDb: speech, snrDb: speech - noise };
  }

  /* ---------- leveler: evens out speakers who sit at different distances from the mic ---------- */

  function leveler(chs, fs) {
    var n = chs[0].length, hop = Math.round(fs * 0.02), nb = Math.ceil(n / hop), db = new Float32Array(nb), b, c, i;
    for (b = 0; b < nb; b++) {
      var s = 0, end = Math.min(n, (b + 1) * hop), cnt = end - b * hop;
      for (c = 0; c < chs.length; c++) { var x = chs[c]; for (i = b * hop; i < end; i++) s += x[i] * x[i]; }
      db[b] = 10 * Math.log10(s / (cnt * chs.length) + 1e-12);
    }
    var sorted = Array.prototype.slice.call(db).sort(function (a, b) { return a - b; });
    var gate = sorted[Math.floor(nb * 0.9)] - 20, speech = new Uint8Array(nb), cntS = 0;
    for (b = 0; b < nb; b++) if (db[b] > gate) { speech[b] = 1; cntS++; }
    if (cntS < 10) { var ref = sorted[Math.floor(nb * 0.9)]; return { targetDb: ref, thresholdDb: ref }; }
    var k = 1 - Math.exp(-0.02 / 1.0), lv = new Float32Array(nb), state = 0;
    for (b = 0; b < nb; b++) if (speech[b]) { state = db[b]; break; }
    for (b = 0; b < nb; b++) { if (speech[b]) state += (db[b] - state) * k; lv[b] = state; }
    state = lv[nb - 1];
    for (b = nb - 1; b >= 0; b--) { state += (lv[b] - state) * k; lv[b] = state; } // smoothed both ways, so no lag
    // Aim at the louder speakers: quiet voices come up toward them, loud ones are left alone.
    var slow = [];
    for (b = 0; b < nb; b++) if (speech[b]) slow.push(lv[b]);
    slow.sort(function (a, b) { return a - b; });
    var target = slow[Math.floor(slow.length * 0.75)];
    // Distance (in blocks) from each block to the nearest speech, so the boost can fade out in pauses
    // instead of lifting the room noise along with the voice.
    var dist = new Float32Array(nb), far = 1e9, FADE = 15;
    for (b = 0; b < nb; b++) { far = speech[b] ? 0 : far + 1; dist[b] = far; }
    far = 1e9;
    for (b = nb - 1; b >= 0; b--) { far = speech[b] ? 0 : far + 1; if (far < dist[b]) dist[b] = far; }
    var lin = new Float32Array(nb + 1), leveled = [];
    for (b = 0; b < nb; b++) {
      var gDb = Math.max(-3, Math.min(8, target - lv[b])) * Math.max(0, 1 - dist[b] / FADE);
      lin[b] = dbToLin(gDb);
      if (speech[b]) leveled.push(db[b] + gDb);
    }
    // The compressor should only touch the loud syllables, so set its threshold
    // at the 75th percentile of the leveled speech rather than at the average.
    leveled.sort(function (a, b) { return a - b; });
    var threshold = leveled[Math.floor(leveled.length * 0.75)];
    lin[nb] = lin[nb - 1];
    for (c = 0; c < chs.length; c++) {
      var y = chs[c];
      for (b = 0; b < nb; b++) {
        var g0 = lin[b], step = (lin[b + 1] - g0) / hop, end2 = Math.min(n, (b + 1) * hop);
        for (i = b * hop; i < end2; i++) y[i] *= g0 + step * (i - b * hop);
      }
    }
    return { targetDb: target, thresholdDb: threshold };
  }

  /* ---------- compressor ---------- */

  function compressor(chs, fs, thresholdDb, ratio) {
    var n = chs[0].length, nc = chs.length, kRms = 1 - Math.exp(-1 / (0.025 * fs));
    var att = Math.exp(-1 / (0.015 * fs)), rel = Math.exp(-1 / (0.2 * fs)), knee = 8;
    var p = 0, gr = 0, slope = 1 / ratio - 1, i, c;
    for (i = 0; i < n; i++) {
      var s = 0;
      for (c = 0; c < nc; c++) s += chs[c][i] * chs[c][i];
      p += (s / nc - p) * kRms;
      var over = 10 * Math.log10(p + 1e-12) - thresholdDb, target;
      if (2 * over < -knee) target = 0;
      else if (2 * Math.abs(over) <= knee) target = slope * (over + knee / 2) * (over + knee / 2) / (2 * knee);
      else target = slope * over;
      var coef = target < gr ? att : rel;
      gr = coef * gr + (1 - coef) * target;
      var g = Math.pow(10, gr / 20);
      for (c = 0; c < nc; c++) chs[c][i] *= g;
    }
  }

  /* ---------- de-esser: softens harsh "s" and "sh" sounds ---------- */

  function lowpassCoefs(fc, fs, Q) {
    var w = 2 * Math.PI * fc / fs, cw = Math.cos(w), al = Math.sin(w) / (2 * Q), a0 = 1 + al;
    return { b0: (1 - cw) / 2 / a0, b1: (1 - cw) / a0, b2: (1 - cw) / 2 / a0, a1: -2 * cw / a0, a2: (1 - al) / a0 };
  }

  function biquadStep(c, st, v) {
    var y = c.b0 * v + st[0];
    st[0] = c.b1 * v - c.a1 * y + st[1];
    st[1] = c.b2 * v - c.a2 * y;
    return y;
  }

  // Works only on the 5-9 kHz band, and only when that band is unusually strong compared with the
  // whole voice. Reduction is capped at 6 dB, so it softens harshness without lisping.
  function deesser(chs, fs) {
    var n = chs[0].length, nc = chs.length, hp = highpassCoefs(5000, fs, Math.SQRT1_2), lp = lowpassCoefs(9000, fs, Math.SQRT1_2);
    var hop = Math.round(fs * 0.01), nb = Math.floor(n / hop), c, i, b;
    // Pass 1: how much of the energy is sibilant, per 10 ms block? Pick a threshold from the speech itself.
    var ratio = new Float32Array(nb), loud = new Float32Array(nb), st = [];
    for (c = 0; c < nc; c++) st.push([[0, 0], [0, 0]]);
    for (b = 0; b < nb; b++) {
      var full = 0, band = 0;
      for (i = b * hop; i < (b + 1) * hop; i++) for (c = 0; c < nc; c++) {
        var v = chs[c][i], y = biquadStep(lp, st[c][1], biquadStep(hp, st[c][0], v));
        full += v * v; band += y * y;
      }
      loud[b] = full; ratio[b] = band / (full + 1e-12);
    }
    var order = Array.prototype.slice.call(loud).sort(function (a, b) { return a - b; });
    var gate = order[Math.floor(nb * 0.9)] * 0.01, r = [];
    for (b = 0; b < nb; b++) if (loud[b] > gate) r.push(ratio[b]);
    if (r.length < 20) return;
    r.sort(function (a, b) { return a - b; });
    var T = Math.max(0.02, r[Math.floor(r.length * 0.8)]);
    // Pass 2: smooth gain on the band, then subtract the reduced part of it from the signal.
    var kA = 1 - Math.exp(-1 / (0.001 * fs)), kR = 1 - Math.exp(-1 / (0.03 * fs));
    var pf = 0, pb = 0, g = 1, minG = dbToLin(-6), bands = new Float64Array(nc);
    for (c = 0; c < nc; c++) st[c] = [[0, 0], [0, 0]];
    for (i = 0; i < n; i++) {
      var f2 = 0, b2 = 0;
      for (c = 0; c < nc; c++) {
        var v2 = chs[c][i], y2 = biquadStep(lp, st[c][1], biquadStep(hp, st[c][0], v2));
        bands[c] = y2; f2 += v2 * v2; b2 += y2 * y2;
      }
      pf += (f2 - pf) * kR; pb += (b2 - pb) * (b2 > pb ? kA : kR);
      var rr = pb / (pf + 1e-12), target = rr > T ? Math.pow(T / rr, 0.6) : 1;
      if (target < minG) target = minG;
      g += (target - g) * (target < g ? kA : kR);
      var cut = 1 - g;
      if (cut > 0.001) for (c = 0; c < nc; c++) chs[c][i] -= bands[c] * cut;
    }
  }

  /* ---------- look-ahead peak limiter ---------- */

  function limiter(chs, fs, ceilingLin) {
    var W = Math.max(2, Math.round(fs * 0.005)), n = chs[0].length, CH = 1 << 20, nc = chs.length;
    for (var a = 0; a < n; a += CH) {
      var b = Math.min(n, a + CH), lo = Math.max(0, a - 2 * W), hi = Math.min(n, b + 2 * W), L = hi - lo;
      var req = new Float32Array(L), m = new Float32Array(L), i, c, need = false;
      for (i = 0; i < L; i++) {
        var pk = 0;
        for (c = 0; c < nc; c++) { var v = Math.abs(chs[c][lo + i]); if (v > pk) pk = v; }
        if (pk > ceilingLin) { req[i] = ceilingLin / pk; need = true; } else req[i] = 1;
      }
      if (!need) continue;
      // m[i] = min(req[i .. i+W-1]) via monotonic deque, scanning backwards
      var dq = new Int32Array(L), head = 0, tail = 0;
      for (i = L - 1; i >= 0; i--) {
        while (tail > head && req[dq[tail - 1]] >= req[i]) tail--;
        dq[tail++] = i;
        while (dq[head] > i + W - 1) head++;
        m[i] = req[dq[head]];
      }
      // gain[i] = mean(m[i-W+1 .. i]); never exceeds req[i] because each window includes i
      var run = 0, cnt = 0;
      for (i = 0; i < L; i++) {
        run += m[i]; cnt++;
        if (cnt > W) { run -= m[i - W]; cnt--; }
        var pos = lo + i;
        if (pos >= a && pos < b) {
          var g = run / cnt;
          for (c = 0; c < nc; c++) chs[c][pos] *= g;
        }
      }
    }
  }

  /* ---------- encode ---------- */

  function toInt16(x, from, to) {
    var o = new Int16Array(to - from);
    for (var i = from; i < to; i++) {
      var v = x[i] * 32767;
      o[i - from] = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
    }
    return o;
  }

  function encodeMp3(chs, fs, kbps, Lame) {
    var enc = new Lame.Mp3Encoder(chs.length, fs, kbps), parts = [], n = chs[0].length, BS = 1152 * 32, buf;
    for (var i = 0; i < n; i += BS) {
      var end = Math.min(n, i + BS);
      buf = chs.length > 1 ? enc.encodeBuffer(toInt16(chs[0], i, end), toInt16(chs[1], i, end))
                           : enc.encodeBuffer(toInt16(chs[0], i, end));
      if (buf.length) parts.push(new Uint8Array(buf));
    }
    buf = enc.flush();
    if (buf.length) parts.push(new Uint8Array(buf));
    return parts;
  }

  /* ---------- the whole chain ---------- */

  function mixDown(chs) {
    if (chs.length < 2) return chs;
    var a = chs[0], b = chs[1];
    for (var i = 0; i < a.length; i++) a[i] = 0.5 * (a[i] + b[i]);
    return [a];
  }

  function process(chs, fs, opts, report) {
    opts = opts || {};
    report = report || function () {};
    var preset = paramsFor(opts), target = opts.targetLufs || TARGET_LUFS;
    if (opts.mono) chs = mixDown(chs);
    var before = { lufs: integratedLoudness(chs, fs), peakDb: samplePeakDb(chs) };
    var ls = levelStats(chs, fs); before.snrDb = ls.snrDb; before.noiseDb = ls.noiseDb; before.speechDb = ls.speechDb;
    if (!isFinite(before.lufs) || before.peakDb < -80) throw new Error('This file looks silent.');

    report('Removing rumble', 0.02);
    var hp = highpassCoefs(opts.highpass || 80, fs, Math.SQRT1_2), c;
    for (c = 0; c < chs.length; c++) { applyBiquad(chs[c], hp); applyBiquad(chs[c], hp); }

    for (c = 0; c < chs.length; c++) {
      (function (c) {
        denoise(chs[c], fs, preset, function (f) { report('Reducing noise', 0.05 + 0.6 * (c + f) / chs.length); });
      })(c);
    }

    report('Balancing levels', 0.68);
    var lv = leveler(chs, fs);
    report('Smoothing dynamics', 0.76);
    compressor(chs, fs, lv.thresholdDb, preset.ratio);

    report('Softening harsh S sounds', 0.80);
    deesser(chs, fs);

    report('Setting loudness', 0.85);
    var ceiling = dbToLin(CEILING_DB), applied = 0, after = -Infinity;
    for (var pass = 0; pass < 3; pass++) {
      var cur = integratedLoudness(chs, fs);
      if (!isFinite(cur)) throw new Error('This file looks silent.');
      var gain = target - cur;
      if (pass > 0 && Math.abs(gain) < 0.15) break;
      if (pass > 0) gain = Math.min(gain, 3);
      var lin = dbToLin(gain);
      for (c = 0; c < chs.length; c++) { var x = chs[c]; for (var i = 0; i < x.length; i++) x[i] *= lin; }
      limiter(chs, fs, ceiling);
      applied += gain;
    }
    after = integratedLoudness(chs, fs);
    var as = levelStats(chs, fs);
    return {
      channels: chs,
      before: before,
      after: { lufs: after, peakDb: samplePeakDb(chs), snrDb: as.snrDb, noiseDb: as.noiseDb, speechDb: as.speechDb }
    };
  }

  var api = { process: process, encodeMp3: encodeMp3, integratedLoudness: integratedLoudness,
              levelStats: levelStats, deesser: deesser, samplePeakDb: samplePeakDb, PRESETS: PRESETS, TARGET_LUFS: TARGET_LUFS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PodcastDSP = api;
})(typeof self !== 'undefined' ? self : this);
