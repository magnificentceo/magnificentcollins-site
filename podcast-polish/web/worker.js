/* Runs the audio work off the main thread so the page stays responsive. */
importScripts('dsp.js', 'vendor/lame.min.js');

self.onmessage = function (e) {
  var d = e.data;
  try {
    var res = PodcastDSP.process(d.channels, d.rate, d.opts, function (stage, frac) {
      self.postMessage({ type: 'progress', stage: stage, frac: frac });
    });
    self.postMessage({ type: 'progress', stage: 'Encoding MP3', frac: 0.95 });
    var parts = PodcastDSP.encodeMp3(res.channels, d.rate, d.opts.kbps, lamejs);
    self.postMessage({ type: 'done', parts: parts, before: res.before, after: res.after },
                     parts.map(function (p) { return p.buffer; }));
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
