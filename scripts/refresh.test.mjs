import { test } from "node:test";
import assert from "node:assert/strict";
import { norm, pickAppleMatch, pickDeezerMatch, pickSpotifyMatch, buildLinksFile, isDue, lookupAll } from "./refresh.mjs";

test("norm drops case and accents but keeps version tags, so remixes stay distinct", () => {
  assert.equal(norm("WAKA (Remix)"), "waka remix");
  assert.equal(norm("Café & Friends"), "cafe and friends");
  assert.equal(norm("Magnificent  Collins"), "magnificent collins");
});

test("Apple match needs an Austrian storefront URL and exact title and artist", () => {
  const results = [
    { wrapperType: "track", artistName: "Magnificent Collins", trackName: "WAKA (Remix)", trackViewUrl: "https://music.apple.com/at/album/x/1?i=2" },
    { wrapperType: "track", artistName: "Magnificent Collins", trackName: "WAKA", trackViewUrl: "https://music.apple.com/us/album/x/1?i=3" },
    { wrapperType: "track", artistName: "Magnificent Collins", trackName: "WAKA", trackViewUrl: "https://music.apple.com/at/album/x/1?i=4" }
  ];
  assert.equal(pickAppleMatch(results, "WAKA"), "https://music.apple.com/at/album/x/1?i=4");
  assert.equal(pickAppleMatch([results[1]], "WAKA"), null);
});

test("Deezer and Spotify matches check the artist too", () => {
  assert.equal(pickDeezerMatch([{ title: "I Dey", artist: { name: "Someone Else" }, link: "https://www.deezer.com/track/1" }], "I Dey"), null);
  assert.equal(pickDeezerMatch([{ title: "I Dey", artist: { name: "Magnificent Collins" }, link: "https://www.deezer.com/track/1" }], "I Dey"), "https://www.deezer.com/track/1");
  const sp = [{ name: "I Dey", artists: [{ name: "Magnificent Collins" }], external_urls: { spotify: "https://open.spotify.com/track/abc" } }];
  assert.equal(pickSpotifyMatch(sp, "I Dey"), "https://open.spotify.com/track/abc");
  assert.equal(pickSpotifyMatch(sp, "I Dey Live"), null);
});

test("links file is a window assignment with a generated stamp", () => {
  const out = buildLinksFile({ "waka": { "Apple Music": { url: "https://music.apple.com/at/x" } } }, "2026-11-23T06:00:00.000Z");
  assert.match(out, /window\.SITE_LINKS = \{/);
  assert.match(out, /"generated": "2026-11-23T06:00:00.000Z"/);
});

test("runs every 13 days, not sooner", () => {
  const now = Date.parse("2026-12-07T06:00:00Z");
  assert.equal(isDue(null, now), true);
  assert.equal(isDue("2026-11-23T06:00:00Z", now), true);  // 14 days
  assert.equal(isDue("2026-12-01T06:00:00Z", now), false); // 6 days
});

test("lookupAll collects links from fake Apple and Deezer responses and skips a failing service", async () => {
  const fetchFn = async (url) => {
    if (url.startsWith("https://itunes.apple.com")) {
      return { ok: true, json: async () => ({ results: [{ wrapperType: "track", artistName: "Magnificent Collins", trackName: "I Dey", trackViewUrl: "https://music.apple.com/at/album/i-dey/1?i=9" }] }) };
    }
    return { ok: false, status: 503, json: async () => ({}) };
  };
  const found = await lookupAll({ id: "i-dey", title: "I Dey" }, { fetchFn, spotifyToken: null });
  assert.deepEqual(found, { "Apple Music": "https://music.apple.com/at/album/i-dey/1?i=9" });
});

test("a failed lookup is reported so the caller can keep the old link", async () => {
  const failed = [];
  const fetchFn = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await lookupAll({ id: "waka", title: "WAKA" }, { fetchFn, spotifyToken: null, failed });
  assert.deepEqual(failed, ["Apple Music", "Deezer"]);
});
