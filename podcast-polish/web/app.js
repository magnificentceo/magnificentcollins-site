(function () {
  'use strict';
  var RATE = 44100;
  var $ = function (id) { return document.getElementById(id); };
  var file = null, worker = null, urls = [], busyNow = false;

  var drop = $('drop'), input = $('file'), go = $('go'), cancel = $('cancel');

  function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
  function lufs(v) { return isFinite(v) ? v.toFixed(1) + ' LUFS' : 'n/a'; }
  function db(v) { return isFinite(v) ? v.toFixed(1) + ' dB' : 'n/a'; }

  function showError(msg) { var e = $('error'); e.textContent = msg; e.hidden = !msg; }

  function setFile(f) {
    file = f;
    showError('');
    $('result').hidden = true;
    $('dropMain').textContent = f.name;
    $('dropSub').textContent = fmtSize(f.size) + ' (click to change)';
    drop.classList.add('has-file');
    run(); // start right away; no extra click needed
  }

  drop.addEventListener('click', function () { input.click(); });
  drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', function () { if (input.files[0]) setFile(input.files[0]); });
  ['dragenter', 'dragover'].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) { if (e.dataTransfer.files[0] && !busyNow) setFile(e.dataTransfer.files[0]); });

  // Dropping anywhere on the page works, and a missed drop never makes the browser open the file.
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    if (e.target.closest && e.target.closest('#drop')) return;
    if (e.dataTransfer.files[0] && !busyNow) setFile(e.dataTransfer.files[0]);
  });

  function progress(stage, frac) {
    $('stage').textContent = stage;
    $('barFill').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
  }

  function setBusy(busy) {
    busyNow = busy;
    go.hidden = busy || !file;
    go.textContent = 'Run again with these settings';
    cancel.hidden = !busy;
    $('progress').hidden = !busy;
    drop.style.pointerEvents = busy ? 'none' : '';
  }

  function decode(arrayBuffer) {
    // An offline context at 44.1 kHz makes the browser resample for us.
    var ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, 1, RATE);
    return new Promise(function (resolve, reject) {
      var p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && p.catch) p.catch(reject);
    });
  }

  function run() {
    if (!file) return;
    showError('');
    $('result').hidden = true;
    urls.forEach(URL.revokeObjectURL); urls = [];
    setBusy(true);
    progress('Reading file', 0.01);

    var preset = document.querySelector('input[name=preset]:checked').value;
    var mono = $('mono').checked, kbps = parseInt($('kbps').value, 10);

    file.arrayBuffer().then(function (ab) {
      progress('Decoding audio', 0.03);
      return decode(ab);
    }).then(function (buf) {
      var n = Math.min(2, buf.numberOfChannels), chs = [];
      for (var c = 0; c < n; c++) chs.push(buf.getChannelData(c).slice());
      if (buf.numberOfChannels > 2) { // fold extra channels into the front pair
        for (var k = 2; k < buf.numberOfChannels; k++) {
          var extra = buf.getChannelData(k);
          for (var i = 0; i < extra.length; i++) chs[k % 2][i] += extra[i] * 0.5;
        }
      }
      worker = new Worker('worker.js');
      worker.onmessage = function (e) {
        var m = e.data;
        if (m.type === 'progress') progress(m.stage, m.frac);
        else if (m.type === 'done') { finish(m); }
        else if (m.type === 'error') { fail(m.message); }
      };
      worker.onerror = function () { fail('The audio engine failed to start. Try reloading the page.'); };
      worker.postMessage({ channels: chs, rate: RATE, opts: { preset: preset, mono: mono, kbps: kbps } },
                         chs.map(function (c) { return c.buffer; }));
    }).catch(function () {
      fail('This browser could not read that file. Try WAV, MP3, M4A, FLAC or OGG (or open the page in Chrome, Edge or Safari for the widest format support).');
    });
  }

  function endWorker() { if (worker) { worker.terminate(); worker = null; } }
  function fail(msg) { endWorker(); setBusy(false); showError(msg); }

  function finish(m) {
    endWorker();
    var blob = new Blob(m.parts, { type: 'audio/mpeg' });
    var cleanUrl = URL.createObjectURL(blob), origUrl = URL.createObjectURL(file);
    urls.push(cleanUrl, origUrl);
    $('origAudio').src = origUrl;
    $('cleanAudio').src = cleanUrl;
    $('lufsB').textContent = lufs(m.before.lufs); $('lufsA').textContent = lufs(m.after.lufs);
    $('snrB').textContent = db(m.before.snrDb); $('snrA').textContent = db(m.after.snrDb);
    $('peakB').textContent = db(m.before.peakDb); $('peakA').textContent = db(m.after.peakDb);
    var a = $('download');
    a.href = cleanUrl;
    a.download = file.name.replace(/\.[^.]+$/, '') + '.clean.mp3';
    $('size').textContent = '(' + fmtSize(blob.size) + ')';
    setBusy(false);
    $('result').hidden = false;
    $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  go.addEventListener('click', run);
  cancel.addEventListener('click', function () { endWorker(); setBusy(false); showError('Cancelled.'); });
})();
