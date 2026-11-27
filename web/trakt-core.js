"use strict";
/*
 * Trakt-motor voor Bingr Track: sessie met verversen, een blijvende wachtrij voor schrijfacties en periodiek ophalen.
 * Geen DOM, geen netwerk of opslag van zichzelf: alles komt binnen via `deps`, zodat het in Node te testen is.
 *
 * Regels (uit het Bingr-onderzoek naar Trakt):
 * - Een token wordt pas ververst als het minder dan ~1 uur geldig is, of na een 401; altijd één verversing tegelijk.
 * - Refresh-tokens werken één keer: de nieuwe sessie wordt bewaard vóór ze gebruikt wordt.
 * - Een mislukte verversing wordt NOOIT als uitloggen bewaard: de sessie blijft staan, alleen `needsRelink` gaat aan
 *   (bij een geweigerd refresh-token), zodat één storing of één ander apparaat niemand uitlogt.
 * - Schrijfacties gaan eerst in een wachtrij die in de kluis bewaard wordt, met `watched_at`, en worden op de
 *   achtergrond verstuurd (opnieuw proberen bij netwerkfout, 429 en 5xx).
 */
(function (root) {
  const HOUR = 3600 * 1000;
  const REFRESH_WINDOW = HOUR;          // verversen als het token korter dan dit geldig is
  const PULL_EVERY = 15 * 60 * 1000;    // periodiek ophalen en versturen
  const MAX_QUEUE = 500;
  const MAX_AGE = 14 * 24 * HOUR;       // wachtrij-items ouder dan dit worden weggegooid
  const BACKOFF = [30, 60, 120, 300, 600, 900].map(s => s * 1000);

  function createEngine(deps) {
    const now = deps.now || (() => Date.now());
    const timers = deps.timers || {setTimeout, clearTimeout};
    const listeners = new Set();
    let session = null;      // {access_token, refresh_token, expiresAt, clientID}
    let needsRelink = false;
    let queue = [];
    let loaded = false;
    let refreshing = null, flushing = null, pulling = null;
    let flushTimer = null, interval = null, kick = null;
    let lastSync = 0, lastError = "", lastActivities = null;
    let pausedUntil = 0;
    const watched = {movies: new Set(), episodes: new Set(), shows: new Set()};
    const ratings = new Map();   // "m:tmdb:1" → 1-10
    const watchlist = new Set();
    let scope = null;

    const emit = () => { const s = status(); for (const f of listeners) { try { f(s); } catch {} } };
    const on = f => { listeners.add(f); return () => listeners.delete(f); };
    const store = () => deps.store;
    const qKey = () => "queue";
    const sKey = () => "session";

    function status() {
      return {linked: Boolean(session), needsRelink, pending: queue.length, lastSync, lastError, busy: Boolean(flushing || pulling)};
    }

    async function load(newScope) {
      scope = newScope; loaded = false; queue = []; session = null; needsRelink = false; lastActivities = null; lastSync = 0;
      watched.movies.clear(); watched.episodes.clear(); watched.shows.clear(); ratings.clear(); watchlist.clear();
      if (!scope) { emit(); return; }
      try {
        const raw = await store().read(sKey());
        const value = raw && JSON.parse(raw);
        if (value && value.access_token) session = value;
      } catch {}
      try {
        const raw = await store().read(qKey());
        const value = raw && JSON.parse(raw);
        if (Array.isArray(value)) queue = value.filter(x => x && x.path && now() - (x.at || 0) < MAX_AGE).slice(-MAX_QUEUE);
      } catch {}
      loaded = true;
      emit();
    }
    async function persistQueue() {
      if (!scope) return;
      while (queue.length > 1 && JSON.stringify(queue).length > 60000) queue.shift();   // de kluis neemt maximaal 64 kB
      try { if (queue.length) await store().write(qKey(), JSON.stringify(queue)); else await store().clear(qKey()); } catch {}
    }
    async function persistSession() {
      if (!scope || !session) return;
      try { await store().write(sKey(), JSON.stringify(session)); } catch {}
    }

    // ---- sessie ----
    async function setSession(result, clientID) {
      const lifetime = Number(result.expires_in) > 0 ? Number(result.expires_in) * 1000 : 24 * HOUR;
      const created = Number(result.created_at) > 0 ? Number(result.created_at) * 1000 : now();
      session = {access_token: result.access_token, refresh_token: result.refresh_token || session?.refresh_token || "",
        expiresAt: created + lifetime, clientID: clientID || session?.clientID || ""};
      needsRelink = false; lastError = "";
      await persistSession();
      emit();
    }
    async function unlink() {
      session = null; needsRelink = false; queue = [];
      if (scope) { try { await store().clear(sKey()); await store().clear(qKey()); } catch {} }
      emit();
    }
    const linked = () => Boolean(session);

    function refresh() {
      if (refreshing) return refreshing;
      const creds = deps.getClient();
      if (!session?.refresh_token || !creds?.id || !creds?.secret) { return Promise.resolve(false); }
      const used = session.refresh_token;
      refreshing = (async () => {
        let response;
        try {
          response = await deps.http("https://api.trakt.tv/oauth/token", {refresh_token: used, client_id: creds.id,
            client_secret: creds.secret, redirect_uri: "urn:ietf:wg:oauth:2.0:oob", grant_type: "refresh_token"}, {}, "POST");
        } catch { return false; }   // netwerk: sessie blijft, later opnieuw
        if (response.status === 200 && response.data?.access_token) {
          await setSessionQuiet(response.data, creds.id);
          return true;
        }
        if ([400, 401].includes(response.status) && session?.refresh_token === used) {
          // refresh-token geweigerd (al gebruikt of ingetrokken): sessie NIET wissen, wel opnieuw koppelen vragen
          needsRelink = true; lastError = "Koppel Trakt opnieuw."; emit();
        }
        return false;
      })().finally(() => { refreshing = null; });
      return refreshing;
    }
    async function setSessionQuiet(result, clientID) {
      const lifetime = Number(result.expires_in) > 0 ? Number(result.expires_in) * 1000 : 24 * HOUR;
      const created = Number(result.created_at) > 0 ? Number(result.created_at) * 1000 : now();
      session = {access_token: result.access_token, refresh_token: result.refresh_token || session?.refresh_token || "",
        expiresAt: created + lifetime, clientID};
      needsRelink = false;
      await persistSession();
      emit();
    }
    /** Geeft een bruikbaar access-token of null (niet gekoppeld, of opnieuw koppelen nodig). */
    async function token(force = false) {
      if (!session) return null;
      const left = session.expiresAt - now();
      if (force || left < REFRESH_WINDOW) {
        await refresh();
        if (session && session.expiresAt <= now() && !needsRelink && !session.refresh_token) { needsRelink = true; lastError = "Koppel Trakt opnieuw."; emit(); }
      }
      return session && session.expiresAt > now() ? session.access_token : null;
    }

    // ---- API ----
    /** Eén Trakt-verzoek. Gooit nooit bij HTTP-fouten; geeft {status, data}. status 0 = geen netwerk. */
    async function api(path, opts = {}) {
      const creds = deps.getClient();
      const headers = {"trakt-api-version": "2", "trakt-api-key": creds?.id || session?.clientID || ""};
      const method = opts.method || (opts.body == null ? "GET" : "POST");
      const run = async force => {
        if (opts.auth === false) return deps.http("https://api.trakt.tv" + path, opts.body ?? null, headers, method);
        const t = await token(force);
        if (!t) return {status: 401, data: null, relink: needsRelink};
        return deps.http("https://api.trakt.tv" + path, opts.body ?? null, {...headers, Authorization: "Bearer " + t}, method);
      };
      let response;
      try { response = await run(false); } catch { return {status: 0, data: null}; }
      if (response.status === 401 && opts.auth !== false && !response.relink) {
        try { response = await run(true); } catch { return {status: 0, data: null}; }
      }
      return response;
    }

    // ---- wachtrij ----
    const idsOf = ids => {
      const out = {};
      for (const k of ["trakt", "tmdb", "imdb", "tvdb", "slug"]) if (ids && ids[k] != null && ids[k] !== "") out[k] = ids[k];
      return out;
    };
    const mediaKey = (type, ids) => type + ":" + (ids?.trakt ? "t" + ids.trakt : ids?.tmdb ? "m" + ids.tmdb : ids?.imdb || "?");

    /** @param op {path, method?, type:'movies'|'shows'|'episodes', ids, fields?, key?} */
    function enqueue(op) {
      const body = op.body || {[op.type]: [{ids: idsOf(op.ids), ...(op.fields || {})}]};
      const entry = {id: now().toString(36) + Math.random().toString(36).slice(2, 8), path: op.path, method: op.method || "POST",
        body, key: op.key || (op.path + "|" + mediaKey(op.type, op.ids)), at: now(), tries: 0, nextAt: 0};
      // een nieuwere actie op hetzelfde ding vervangt de oudere (bijv. watchlist toevoegen en weer weghalen)
      queue = queue.filter(x => x.key !== entry.key);
      if (op.cancels) queue = queue.filter(x => x.key !== op.cancels);
      queue.push(entry);
      if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
      void persistQueue();
      emit();
      if (kick) timers.clearTimeout(kick);
      kick = timers.setTimeout(() => { kick = null; void flush(); }, 1500);   // korte wachttijd: snel wisselen telt als één actie
      return entry.id;
    }
    const classify = response => {
      const s = response.status;
      if (s >= 200 && s < 300) return "ok";
      if (s === 0 || s >= 500) return "retry";
      if (s === 401) return "auth";
      if (s === 429) return "limit";
      if (s === 420 || s === 423) return "pause";
      if (s === 409) return "ok";           // bijv. check-in loopt al: niets meer te doen
      return "drop";                        // 400, 404, 405, 422: dit verzoek lukt nooit
    };
    function mergeable(a, b) {
      return a && b && a.path === b.path && a.method === "POST" && b.method === "POST" && a.path.startsWith("/sync/") &&
        a.tries === 0 && b.tries === 0 && Object.keys(a.body).every(k => Array.isArray(a.body[k])) &&
        Object.keys(b.body).every(k => Array.isArray(b.body[k]));
    }
    function nextBatch() {
      const t = now();
      const first = queue.find(x => x.nextAt <= t);
      if (!first) return null;
      const group = [first];
      for (const x of queue) if (x !== first && x.nextAt <= t && mergeable(first, x) && group.length < 50) group.push(x);
      return group;
    }
    function flush() {
      if (flushing) return flushing;
      if (!session || needsRelink || now() < pausedUntil) { return Promise.resolve(false); }
      flushing = (async () => {
        let progress = false;
        emit();
        while (queue.length && session && !needsRelink) {
          const group = nextBatch();
          if (!group) break;
          let body = group[0].body;
          if (group.length > 1) {
            body = {};
            for (const x of group) for (const [k, v] of Object.entries(x.body)) body[k] = (body[k] || []).concat(v);
          }
          const response = await api(group[0].path, {method: group[0].method, body});
          const verdict = classify(response);
          if (verdict === "ok" || verdict === "drop") {
            if (verdict === "drop") lastError = "Een wijziging kon niet naar Trakt (" + response.status + ").";
            const nf = response.data?.not_found;
            if (nf && Object.values(nf).some(rows => Array.isArray(rows) && rows.length)) lastError = "Trakt kende een titel niet.";
            queue = queue.filter(x => !group.includes(x));
            progress = true;
            await persistQueue();
            emit();
            continue;
          }
          if (verdict === "auth") {
            if (needsRelink) { lastError = "Koppel Trakt opnieuw."; break; }
            for (const x of group) { x.tries += 1; x.nextAt = now() + BACKOFF[Math.min(x.tries - 1, BACKOFF.length - 1)]; }
          } else if (verdict === "limit") {
            const wait = Math.max(5, Number(response.headers?.["retry-after"]) || 60) * 1000;
            for (const x of group) x.nextAt = now() + wait;
          } else if (verdict === "pause") {
            pausedUntil = now() + HOUR; lastError = "Trakt accepteert nu geen wijzigingen."; await persistQueue(); break;
          } else {
            for (const x of group) { x.tries += 1; x.nextAt = now() + BACKOFF[Math.min(x.tries - 1, BACKOFF.length - 1)]; }
          }
          await persistQueue();
          break;   // volgorde bewaren: bij een fout stoppen en later verder
        }
        if (queue.length) scheduleFlush();
        return progress;
      })().finally(() => { flushing = null; emit(); });
      return flushing;
    }
    function scheduleFlush() {
      if (flushTimer) timers.clearTimeout(flushTimer);
      const next = Math.min(...queue.map(x => x.nextAt || 0));
      const delay = Math.max(5000, next - now());
      flushTimer = timers.setTimeout(() => { flushTimer = null; void flush(); }, Math.min(delay, 15 * 60 * 1000));
    }

    // ---- ophalen ----
    /** Haalt last_activities op en meldt welke onderdelen veranderd zijn. */
    async function pull(force = false) {
      if (pulling) return pulling;
      if (!session || needsRelink) return {changed: false, sections: []};
      pulling = (async () => {
        const response = await api("/sync/last_activities");
        if (response.status !== 200 || !response.data) { if (response.status !== 401) lastError = response.status ? "Trakt is niet bereikbaar." : ""; return {changed: false, sections: []}; }
        const next = response.data;
        const sections = [];
        for (const group of ["movies", "episodes", "shows", "seasons", "lists", "watchlist"]) {
          const a = JSON.stringify(next[group] || null), b = JSON.stringify(lastActivities?.[group] ?? null);
          if (force || a !== b) sections.push(group);
        }
        lastActivities = next; lastSync = now(); lastError = "";
        if (sections.some(x => ["movies", "episodes", "shows", "seasons"].includes(x))) await loadWatched();
        emit();
        return {changed: sections.length > 0, sections};
      })().finally(() => { pulling = null; });
      return pulling;
    }
    const idKeys = (type, ids) => {
      const out = [];
      if (ids?.trakt) out.push(type + ":t" + ids.trakt);
      if (ids?.tmdb) out.push(type + ":m" + ids.tmdb);
      if (ids?.imdb) out.push(type + ":" + ids.imdb);
      return out;
    };
    async function loadWatched() {
      const [movies, shows, rated, list] = await Promise.all([api("/sync/watched/movies"), api("/sync/watched/shows"),
        api("/sync/ratings"), api("/sync/watchlist")]);
      if (movies.status === 200 && Array.isArray(movies.data)) {
        watched.movies.clear();
        for (const row of movies.data) for (const k of idKeys("movie", row.movie?.ids)) watched.movies.add(k);
      }
      if (shows.status === 200 && Array.isArray(shows.data)) {
        watched.shows.clear(); watched.episodes.clear();
        for (const row of shows.data) {
          for (const k of idKeys("show", row.show?.ids)) watched.shows.add(k);
          for (const season of row.seasons || []) for (const ep of season.episodes || [])
            for (const k of idKeys("show", row.show?.ids)) watched.episodes.add(k + ":" + season.number + "x" + ep.number);
        }
      }
      if (rated.status === 200 && Array.isArray(rated.data)) {
        ratings.clear();
        for (const row of rated.data) { const media = row.movie || row.show || row.episode; const type = row.movie ? "movie" : row.show ? "show" : "";
          if (type) for (const k of idKeys(type, media?.ids)) ratings.set(k, row.rating); }
      }
      if (list.status === 200 && Array.isArray(list.data)) {
        watchlist.clear();
        for (const row of list.data) { const media = row.movie || row.show; const type = row.movie ? "movie" : "show";
          for (const k of idKeys(type, media?.ids)) watchlist.add(k); }
      }
    }
    const typeName = type => (type === "movie" || type === "movies") ? "movie" : "show";
    const isWatched = (type, ids) => idKeys(typeName(type), ids).some(k => type === "movie" || type === "movies" ?
      watched.movies.has(k) : watched.shows.has(k));
    const isEpisodeWatched = (showIds, season, number) => idKeys("show", showIds).some(k => watched.episodes.has(k + ":" + season + "x" + number));
    const isListed = (type, ids) => idKeys(typeName(type), ids).some(k => watchlist.has(k));
    const ratingOf = (type, ids) => { for (const k of idKeys(typeName(type), ids)) if (ratings.has(k)) return ratings.get(k); return 0; };

    // ---- acties (alles via de wachtrij; lokale stand meteen bijgewerkt) ----
    function markWatched(type, ids, on = true, at = new Date(), episode) {
      const set = type === "movies" ? watched.movies : watched.shows;
      const tname = type === "movies" ? "movie" : "show";
      if (episode) { for (const k of idKeys("show", ids)) { const e = k + ":" + episode.season + "x" + episode.number; on ? watched.episodes.add(e) : watched.episodes.delete(e); } }
      else for (const k of idKeys(tname, ids)) on ? set.add(k) : set.delete(k);
      const body = episode
        ? {shows: [{ids: idsOf(ids), seasons: [{number: episode.season, episodes: [{number: episode.number, ...(on ? {watched_at: at.toISOString()} : {})}]}]}]}
        : {[type]: [{ids: idsOf(ids), ...(on ? {watched_at: at.toISOString()} : {})}]};
      return enqueue({path: on ? "/sync/history" : "/sync/history/remove", type, ids, body,
        key: "h|" + (episode ? mediaKey("show", ids) + ":" + episode.season + "x" + episode.number : mediaKey(type, ids))});
    }
    function setWatchlist(type, ids, on = true) {
      const tname = type === "movies" ? "movie" : "show";
      for (const k of idKeys(tname, ids)) on ? watchlist.add(k) : watchlist.delete(k);
      return enqueue({path: on ? "/sync/watchlist" : "/sync/watchlist/remove", type, ids, key: "w|" + mediaKey(type, ids)});
    }
    function setRating(type, ids, value) {
      const tname = type === "movies" ? "movie" : "show";
      for (const k of idKeys(tname, ids)) value ? ratings.set(k, value) : ratings.delete(k);
      return enqueue({path: value ? "/sync/ratings" : "/sync/ratings/remove", type, ids, fields: value ? {rating: value, rated_at: new Date().toISOString()} : {}, key: "r|" + mediaKey(type, ids)});
    }
    function addToList(listID, type, ids) {
      return enqueue({path: "/users/me/lists/" + encodeURIComponent(listID) + "/items", type, ids, key: "l|" + listID + "|" + mediaKey(type, ids)});
    }

    // ---- achtergrond ----
    async function tick() {
      if (!session) return;
      await flush();
      const result = await pull();
      if (result.changed) for (const f of listeners) { try { f({...status(), changed: result.sections}); } catch {} }
    }
    function start() {
      stop();
      interval = timers.setTimeout(function loop() { void tick().finally(() => { interval = timers.setTimeout(loop, PULL_EVERY); }); }, 2000);
    }
    function stop() { if (interval) timers.clearTimeout(interval); if (flushTimer) timers.clearTimeout(flushTimer); interval = flushTimer = null; }

    return {load, setSession, unlink, linked, token, api, enqueue, flush, pull, tick, start, stop, status, on,
      markWatched, setWatchlist, setRating, addToList, isWatched, isEpisodeWatched, isListed, ratingOf,
      get needsRelink() { return needsRelink; }, get queue() { return queue.slice(); }};
  }
  const api = {createEngine, REFRESH_WINDOW, BACKOFF};
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.TraktCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
