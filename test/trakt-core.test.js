"use strict";
const test = require("node:test");
const assert = require("node:assert");
const {createEngine} = require("../web/trakt-core.js");

function setup(handler, opts = {}) {
  const files = new Map(); const calls = []; let t = opts.start || 1_000_000_000_000;
  const deps = {
    now: () => t,
    timers: {setTimeout: () => 0, clearTimeout() {}},
    getClient: () => ({id: "cid", secret: "sec"}),
    store: {read: async k => files.get(k) ?? null, write: async (k, v) => { files.set(k, v); }, clear: async k => { files.delete(k); }},
    http: async (url, body, headers, method) => { calls.push({url, body, headers, method}); return handler({url, body, headers, method, calls}); },
  };
  const engine = createEngine(deps);
  return {engine, files, calls, advance: ms => { t += ms; }, now: () => t};
}
const ok = data => ({status: 200, data});
const fresh = (s, left = 20 * 3600) => ({access_token: "A1", refresh_token: "R1", expires_in: left, created_at: Math.floor(s.now() / 1000)});

test("token met genoeg looptijd wordt niet ververst", async () => {
  const s = setup(() => ok({}));
  await s.engine.load("u1"); await s.engine.setSession(fresh(s), "cid");
  assert.equal(await s.engine.token(), "A1");
  assert.equal(s.calls.filter(c => c.url.endsWith("/oauth/token")).length, 0);
});

test("minder dan een uur: één verversing, ook bij gelijktijdige aanroepen, en nieuwe sessie bewaard", async () => {
  const s = setup(({url}) => url.endsWith("/oauth/token") ? ok({access_token: "A2", refresh_token: "R2", expires_in: 86400, created_at: Math.floor(1_000_000_000_000 / 1000)}) : ok([]));
  await s.engine.load("u1"); await s.engine.setSession(fresh(s, 1800), "cid");
  s.calls.length = 0;
  const [a, b, c] = await Promise.all([s.engine.token(), s.engine.token(), s.engine.token()]);
  assert.deepEqual([a, b, c], ["A2", "A2", "A2"]);
  assert.equal(s.calls.filter(x => x.url.endsWith("/oauth/token")).length, 1);
  assert.equal(JSON.parse(s.files.get("session")).refresh_token, "R2");
});

test("mislukte verversing (netwerk) wist de sessie niet", async () => {
  const s = setup(({url}) => { if (url.endsWith("/oauth/token")) throw new Error("offline"); return ok([]); });
  await s.engine.load("u1"); await s.engine.setSession(fresh(s, 1800), "cid");
  await s.engine.token();
  assert.equal(s.engine.linked(), true);
  assert.ok(s.files.get("session"));
});

test("geweigerd refresh-token: sessie blijft, needsRelink gaat aan, wachtrij blijft", async () => {
  const s = setup(({url}) => url.endsWith("/oauth/token") ? {status: 400, data: {error: "invalid_grant"}} : {status: 401, data: null});
  await s.engine.load("u1"); await s.engine.setSession(fresh(s, 1800), "cid");
  s.engine.markWatched("movies", {tmdb: 603});
  await s.engine.flush();
  assert.equal(s.engine.needsRelink, true);
  assert.equal(s.engine.linked(), true);
  assert.equal(s.engine.queue.length, 1);
  assert.ok(s.files.get("session"));
});

test("401 op een verzoek: één verversing en één nieuwe poging", async () => {
  let n = 0;
  const s = setup(({url, headers}) => {
    if (url.endsWith("/oauth/token")) return ok({access_token: "A2", refresh_token: "R2", expires_in: 86400, created_at: Math.floor(1_000_000_000_000 / 1000)});
    n++; return headers.Authorization === "Bearer A2" ? ok({ok: 1}) : {status: 401, data: null};
  });
  await s.engine.load("u1"); await s.engine.setSession(fresh(s), "cid");
  const r = await s.engine.api("/sync/last_activities");
  assert.equal(r.status, 200); assert.equal(n, 2);
});

test("kijkactie komt in de wachtrij met watched_at en gaat weg na succes", async () => {
  const s = setup(() => ok({added: {movies: 1}}));
  await s.engine.load("u1"); await s.engine.setSession(fresh(s), "cid");
  s.engine.markWatched("movies", {tmdb: 603, imdb: "tt0133093"}, true, new Date("2026-11-27T10:00:00Z"));
  await s.engine.flush();
  const post = s.calls.find(c => c.url.endsWith("/sync/history"));
  assert.equal(post.body.movies[0].watched_at, "2026-11-27T10:00:00.000Z");
  assert.deepEqual(post.body.movies[0].ids, {tmdb: 603, imdb: "tt0133093"});
  assert.equal(s.engine.queue.length, 0);
  assert.equal(s.files.has("queue"), false);
});

test("netwerkfout: item blijft bewaard met uitstel; nieuwe engine leest wachtrij uit de kluis", async () => {
  const s = setup(({url}) => { if (url.includes("/sync/")) throw new Error("offline"); return ok({}); });
  await s.engine.load("u1"); await s.engine.setSession(fresh(s), "cid");
  s.engine.markWatched("movies", {tmdb: 1});
  await s.engine.flush();
  assert.equal(s.engine.queue.length, 1);
  assert.equal(s.engine.queue[0].tries, 1);
  const again = createEngine({now: () => s.now(), timers: {setTimeout: () => 0, clearTimeout() {}}, getClient: () => null,
    store: {read: async k => s.files.get(k) ?? null, write: async () => {}, clear: async () => {}}, http: async () => ok({})});
  await again.load("u1");
  assert.equal(again.queue.length, 1);
});

test("watchlist aan en weer uit voor het versturen: laatste actie wint", async () => {
  const s = setup(() => ok({}));
  await s.engine.load("u1");   // niet gekoppeld: alles blijft in de wachtrij
  await s.engine.setSession(fresh(s), "cid");
  s.engine.setWatchlist("movies", {tmdb: 5}, true);
  s.engine.setWatchlist("movies", {tmdb: 5}, false);
  await s.engine.flush();
  const paths = s.calls.map(c => c.url.replace("https://api.trakt.tv", ""));
  assert.ok(!paths.includes("/sync/watchlist"));
});

test("400 laat het item vallen (lukt nooit), 429 wacht, wachtrij loopt niet vast", async () => {
  let mode = 400;
  const s = setup(() => ({status: mode, data: null, headers: {"retry-after": "30"}}));
  await s.engine.load("u1"); await s.engine.setSession(fresh(s), "cid");
  s.engine.setRating("movies", {tmdb: 9}, 8);
  await s.engine.flush();
  assert.equal(s.engine.queue.length, 0);
  mode = 429;
  s.engine.setRating("movies", {tmdb: 9}, 7);
  await s.engine.flush();
  assert.equal(s.engine.queue.length, 1);
  assert.ok(s.engine.queue[0].nextAt > s.now());
});

test("ophalen: gezien, beoordeeld en watchlist worden herkend op tmdb/imdb/trakt-id", async () => {
  const s = setup(({url}) => {
    if (url.endsWith("/sync/last_activities")) return ok({movies: {watched_at: "x"}, episodes: {}, shows: {}, seasons: {}, lists: {}, watchlist: {}});
    if (url.endsWith("/sync/watched/movies")) return ok([{movie: {ids: {trakt: 1, tmdb: 603, imdb: "tt0133093"}}}]);
    if (url.endsWith("/sync/watched/shows")) return ok([{show: {ids: {trakt: 2, tmdb: 1396}}, seasons: [{number: 1, episodes: [{number: 1}]}]}]);
    if (url.endsWith("/sync/ratings")) return ok([{rating: 9, movie: {ids: {tmdb: 603}}}]);
    if (url.endsWith("/sync/watchlist")) return ok([{show: {ids: {tmdb: 1399}}}]);
    return ok([]);
  });
  await s.engine.load("u1"); await s.engine.setSession(fresh(s), "cid");
  const r = await s.engine.pull(true);
  assert.equal(r.changed, true);
  assert.equal(s.engine.isWatched("movies", {imdb: "tt0133093"}), true);
  assert.equal(s.engine.isWatched("movies", {tmdb: 999}), false);
  assert.equal(s.engine.isEpisodeWatched({tmdb: 1396}, 1, 1), true);
  assert.equal(s.engine.isEpisodeWatched({tmdb: 1396}, 1, 2), false);
  assert.equal(s.engine.ratingOf("movies", {tmdb: 603}), 9);
  assert.equal(s.engine.isListed("shows", {tmdb: 1399}), true);
});

test("ontkoppelen wist sessie en wachtrij", async () => {
  const s = setup(() => ok({}));
  await s.engine.load("u1"); await s.engine.setSession(fresh(s), "cid");
  await s.engine.unlink();
  assert.equal(s.engine.linked(), false);
  assert.equal(s.files.size, 0);
});
