"use strict";
const main = document.getElementById("main");
const nav = document.getElementById("nav");
const profileShortcut = document.getElementById("profile-shortcut");
const notice = document.getElementById("notice");
const tabs = [["Home","home"],["Ontdek","discover"],["Lijsten","lists"],["Profiel","person"],["Zoeken","search"]];
const parentTabs = {Kalender:"Home",Geschiedenis:"Home","Mijn lijst":"Lijsten"};
let listMode = "Watchlist";
const strokes = {
  home:"M3 10l9-7 9 7v10H3zM9 20v-6h6v6",
  discover:"M12 2c0 5-2 8-8 10 6 2 8 5 8 10 0-5 2-8 8-10-6-2-8-5-8-10Z",
  lists:"M8 5h13M8 12h13M8 19h13M3 5h.1M3 12h.1M3 19h.1",
  person:"M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v2z",
  search:"M20 20l-4.5-4.5M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z",
  arrow:"M9 5l7 7-7 7",
  back:"M15 5l-7 7 7 7",
  close:"M6 6l12 12M18 6 6 18",
  play:"M7 4v16l14-8Z",
  plus:"M12 5v14M5 12h14",
  check:"M5 12l4 4L19 6",
  collection:"M4 6h12v13H4zM8 3h12v13M7 12h6M10 9v6",
  thumb:"M7 21H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h3m0 12V9l5-6a2 2 0 0 1 2.2 2.8L13 9h6a2 2 0 0 1 2 2.4l-1.5 8A2 2 0 0 1 17.5 21H7Z"
};
function glyph(name,selected = false) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns,"svg");
  const path = document.createElementNS(ns,"path");
  svg.setAttribute("viewBox","0 0 24 24");
  svg.setAttribute("aria-hidden","true");
  svg.classList.add("ui-glyph");
  if (name === "down") svg.classList.add("glyph-down");
  path.setAttribute("d",strokes[name === "down" ? "thumb" : name]);
  path.setAttribute("fill",selected ? "currentColor" : "none");
  path.setAttribute("stroke","currentColor");
  path.setAttribute("stroke-width","1.75");
  path.setAttribute("stroke-linecap","round");
  path.setAttribute("stroke-linejoin","round");
  svg.append(path);
  return svg;
}
function iconButton(name,label,run,selected = false,compact = false) {
  const control = button("",run);
  control.className = compact ? "bingr-quick-action" : "bingr-circle-action";
  control.append(glyph(name,selected));
  if (compact) control.append(el("span",label));
  control.setAttribute("aria-label",label);
  control.title = label;
  return control;
}
let screenRevision = 0;
let bingrTrakt = null;
let traktConfigFailed = false;
let catalogMeta = null;
let collectionsState = {};
let accountWrite = Promise.resolve();
let traktLoading = false;
let connectedInTrack = null;
let bingrTraktExpired = false;
const traktLists = new Map();
const traktClient = () => trakt?.source === "bingr" ? bingrTrakt?.id : settings.trakt || bingrTrakt?.id;
const canLinkTrakt = () => Boolean(settings.trakt || bingrTrakt?.secret);
let sequence = 0, settings, session, profile, shared, trakt, pending, tab = tabs[0][0];
const waiting = new Map();
let faceIDEnabled = false;
let unlocking = false;
window.reply = (id, result) => {
  const job = waiting.get(id);
  if (!job) return;
  waiting.delete(id);
  clearTimeout(job.timer);
  if (result.error) job.reject(new Error(result.error));
  else job.resolve(result.value);
};
function native(action, data = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error("De aanvraag duurde te lang.")); }, 35000);
    waiting.set(id, {resolve, reject, timer});
    const message = {id, action, ...data};
    if (window.webkit?.messageHandlers?.track) window.webkit.messageHandlers.track.postMessage(message);
    else if (window.TrackNative) window.TrackNative.send(JSON.stringify(message));
    else window.reply(id, {error:"Open Bingr Track op je telefoon of tablet."});
  });
}
function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
let noticeTimer;
function error(e) {
  notice.textContent = e.message || String(e);
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notice.textContent = "", 7000);
}
function button(label, run, primary = false) {
  const b = el("button", label, primary ? "primary" : "");
  b.type = "button";
  b.onclick = async () => {
    b.disabled = true;
    try { await run(); } catch (e) { error(e); }
    finally { b.disabled = false; }
  };
  return b;
}
async function request(url, body, headers = {}, method = body == null ? "GET" : "POST") {
  const response = await native("request", {url, body, headers, method});
  if (response.status >= 200 && response.status < 300) return response.data;
  const err = new Error(response.status === 429 ? "Te veel verzoeken. Probeer het later opnieuw." :
    ({invalid_credentials:"Controleer je Bingr-e-mailadres en wachtwoord.", email_not_confirmed:"Bevestig eerst je Bingr-e-mailadres.", not_signed_in:"Je Bingr-sessie is verlopen. Log opnieuw in."})[response.data?.error_code ?? response.data?.code ?? response.data?.error] ||
    "De aanvraag is mislukt (" + response.status + ").");
  err.status = response.status;
  throw err;
}
function bingr(path, body, auth = false) {
  return request(settings.url + path, body, {
    apikey:settings.key, ...(auth ? {Authorization:"Bearer " + session.access_token} : {})
  });
}
let refreshing;
async function device(action, data = {}, expectedOwner) {
  const run = () => {
    if (expectedOwner && session?.user?.id !== expectedOwner) throw new Error("Je Bingr-account is gewijzigd.");
    return bingr("/functions/v1/device-auth", {action, ...data}, true);
  };
  try { return await run(); } catch (e) {
    if (e.status !== 401 || (expectedOwner && session?.user?.id !== expectedOwner)) throw e;
    if (!refreshing) refreshing = bingr("/auth/v1/token?grant_type=refresh_token", {refresh_token:session.refresh_token})
      .then(async value => {
        session = value;
        if (faceIDEnabled) await rememberRefreshToken();
        return value;
      }).finally(() => refreshing = null);
    try { await refreshing; } catch (refreshError) {
      if ([400,401].includes(refreshError.status)) {
        await clearFaceID();
        session = profile = shared = null;
        login();
      }
      throw refreshError;
    }
    return run();
  }
}
function screen(title, showNav = Boolean(profile)) {
  ++screenRevision;
  main.classList.remove("profile-screen");
  main.replaceChildren(el("h1",title));
  nav.hidden = !showNav;
  nav.replaceChildren();
  profileShortcut.hidden = !showNav || !profile;
  profileShortcut.replaceChildren();
  if (!profileShortcut.hidden) {
    const shortcut = button("",profiles);
    shortcut.className = "profile-shortcut-button";
    shortcut.setAttribute("aria-label","Wissel profiel, huidig profiel " + profile.name);
    shortcut.title = "Wissel profiel";
    shortcut.append(profileAvatar(profile));
    profileShortcut.append(shortcut);
  }
  if (showNav) for (const [name,icon] of tabs) {
    const b = button(name,() => render(name));
    b.prepend(glyph(icon));
    if ((parentTabs[tab] || tab) === name) b.setAttribute("aria-current","page");
    if (name === "Zoeken") b.classList.add("nav-search");
    nav.append(b);
  }
}
function field(form, label, type, autocomplete) {
  const wrapper = el("label",label);
  const input = el("input");
  input.type = type;
  input.autocomplete = autocomplete;
  input.required = true;
  wrapper.append(input);
  form.append(wrapper);
  return input;
}
function login() {
  screen("Inloggen bij Bingr", false);
  const form = el("form");
  const email = field(form, "E-mailadres", "email", "username");
  const password = field(form, "Wachtwoord", "password", "current-password");
  const submit = el("button","Inloggen","primary");
  form.append(submit);
  form.onsubmit = async event => {
    event.preventDefault();
    submit.disabled = true;
    try {
      if (!/^https:\/\/[a-z0-9.-]+$/i.test(settings.url) || !settings.key) throw new Error("Deze Track-build heeft geen geldige Bingr-configuratie.");
      const body = {email:email.value.trim(), password:password.value};
      try { session = await bingr("/functions/v1/login",body); }
      catch (e) {
        if (e.status !== 404) throw e;
        session = await bingr("/auth/v1/token?grant_type=password",body);
      }
      if (!session?.access_token || !session?.refresh_token) throw new Error("Bingr heeft geen geldige sessie teruggestuurd.");
      await clearFaceID();
      profilePhotos.clear();
      connectedInTrack = null;
      traktLists.clear();
      password.value = "";
      await profiles();
    } catch (e) { error(e); } finally { submit.disabled = false; }
  };
  main.append(form);
  if (faceIDEnabled) main.append(button("Ontgrendel met Face ID", unlockWithFaceID, true));
}
async function profiles() {
  profile = shared = trakt = pending = bingrTrakt = catalogMeta = null;
  collectionsState = {};
  traktLists.clear();
  screen("Wie kijkt er?", false);
  main.classList.add("profile-screen");
  let result;
  try { result = await device("get_profiles"); }
  catch (e) {
    if (session) main.append(button("Probeer profielen opnieuw te laden",profiles,true),button("Uitloggen",logout));
    throw new Error("Bingr-profielen konden niet worden geladen. " + e.message);
  }
  const items = (result.profiles || []).filter(p => !p.deleted && !p.deletedAt && p.id && p.name)
    .sort((a,b) => Number(b.isMain || false) - Number(a.isMain || false) || (a.order || 0) - (b.order || 0));
  if (!items.length) main.append(el("p","Open Bingr om je eerste profiel in te stellen."));
  const grid = el("div",null,"profile-grid");
  for (const p of items) {
    const card = button("", () => select(p));
    card.className = "profile-card";
    card.append(profileAvatar(p),el("span",p.name));
    grid.append(card);
  }
  main.append(grid, button("Uitloggen", logout));
}
async function logout() {
  try { if (session) await bingr("/auth/v1/logout?scope=local",{},true); }
  finally { await clearFaceID(); profilePhotos.clear(); connectedInTrack = null; traktLists.clear(); session = profile = shared = trakt = pending = bingrTrakt = catalogMeta = null;
  collectionsState = {}; login(); }
}
async function state(p) {
  const section = "profile." + p.id;
  const result = await device("get_state",{sections:[section,"catalogmeta","collections"]});
  return {data:result.sections?.[section]?.data || {},catalog:result.sections?.catalogmeta?.data || null,collections:result.sections?.collections?.data || {}};
}
function lockValue(data) { return JSON.stringify([data.pinHash ?? null,data.pin ?? null]); }
let unlocked;
const profilePhotos = new Map();
const avatarIcons = {"person.fill":"👤","person.crop.circle.fill":"👤","tv.fill":"📺","globe":"🌐","soccerball":"⚽","crown.fill":"👑","flame.fill":"🔥","gamecontroller.fill":"🎮","film.fill":"🎬","star.fill":"⭐","heart.fill":"♥","music.note":"♪","bolt.fill":"⚡","pawprint.fill":"🐾","cat.fill":"🐱","dog.fill":"🐶"};
function avatarFile(avatar) {
  const symbol = String(avatar.symbol || avatar.image || avatar.id || "").split("/").pop();
  const match = /^(?:kid|child)[_:-]?0*(\d{1,2})(?:\.png)?$/i.exec(symbol);
  const number = Number(match?.[1]);
  return number >= 1 && number <= 16 ? "avatars/kid" + String(number).padStart(2,"0") + ".png" : null;
}
function avatarImage(container, url) {
  const image = el("img");
  image.alt = "";
  image.onload = () => container.replaceChildren(image);
  image.src = url;
}
function profilePhoto(p) {
  const user = session?.user?.id, path = p.photo?.path;
  if (typeof user !== "string" || !/^[a-f0-9-]{36}$/i.test(user) ||
      typeof p.id !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(p.id) ||
      typeof path !== "string" || path.toLowerCase() !== (user + "/" + p.id + ".jpg").toLowerCase()) return null;
  const cacheKey = path + ":" + (p.photo.updated || "");
  if (!profilePhotos.has(cacheKey)) {
    const url = "/storage/v1/object/authenticated/avatars/" + path.split("/").map(encodeURIComponent).join("/");
    profilePhotos.set(cacheKey,bingr(url,null,true)
      .then(result => result?.jpeg && /^\/9j\/[a-z0-9+/=]+$/i.test(result.jpeg) ? "data:image/jpeg;base64," + result.jpeg : null)
      .catch(() => { profilePhotos.delete(cacheKey); return null; }));
  }
  return profilePhotos.get(cacheKey);
}
function profileAvatar(p) {
  const avatar = typeof p.avatar === "object" && p.avatar ? p.avatar : {symbol:p.avatar};
  const palette = Number.isInteger(avatar.colorIndex) ? ((avatar.colorIndex % 10) + 10) % 10 : 0;
  const icon = el("span",avatar.emoji || avatarIcons[avatar.symbol] || (p.kids ? "🙂" : "👤"),"profile-avatar avatar-" + palette);
  icon.setAttribute("aria-hidden","true");
  const photo = profilePhoto(p);
  const local = avatarFile(avatar);
  if (photo) void photo.then(url => { if (icon.isConnected && (url || local)) avatarImage(icon,url || local); });
  else if (local) avatarImage(icon,local);
  return icon;
}
async function select(p) {
  const revision = screenRevision;
  const {data,catalog,collections} = await state(p);
  if (revision !== screenRevision) return;
  if (data.pinHash || data.pin) {
    screen("Pincode invoeren", false);
    main.classList.add("profile-screen");
    const form = el("form",null,"pin-form");
    form.append(profileAvatar(p),el("p",p.name,"pin-profile-name"));
    const wrapper = el("label","Pincode","pin-label");
    const pin = el("input");
    pin.type = "password";
    pin.autocomplete = "off";
    pin.inputMode = "numeric";
    pin.pattern = "[0-9]{4,8}";
    pin.maxLength = 8;
    pin.required = true;
    wrapper.append(pin);
    const dots = el("span",null,"pin-dots");
    dots.setAttribute("aria-hidden","true");
    wrapper.append(dots);
    const digits = typeof data.pin === "string" ? data.pin.length : 4;
    function drawDigits() {
      pin.value = pin.value.replace(/[^0-9]/g,"").slice(0,8);
      dots.replaceChildren(...Array.from({length:Math.max(digits,pin.value.length)},(_,index) =>
        el("i",null,index < pin.value.length ? "filled" : "")));
    }
    pin.oninput = drawDigits;
    drawDigits();
    const submit = el("button","Ontgrendelen","primary");
    form.append(wrapper,submit,button("Terug",profiles));
    form.onsubmit = async event => {
      event.preventDefault();
      submit.disabled = true;
      try {
        const valid = data.pinHash ? await native("verifyPIN",{pin:pin.value, hash:data.pinHash}) : pin.value === String(data.pin);
        if (!valid) throw new Error("Onjuiste pincode.");
        if (form.isConnected) enter(p,data,catalog,collections);
      } catch(e) { error(e); } finally { submit.disabled = false; pin.value = ""; drawDigits(); }
    };
    main.append(form);
  } else enter(p,data,catalog,collections);
}
function traktScope(p = profile) {
  const user = session?.user?.id;
  return user && p?.id ? user + "." + p.id : null;
}
async function savedTraktSession(p) {
  const scope = traktScope(p);
  if (!scope) return null;
  try {
    const raw = await native("readTraktSession",{scope});
    const value = raw && JSON.parse(raw);
    if (value?.access_token && value.expiresAt > Date.now())
      return {...value,profileID:p.id,source:"track"};
    if (raw) await native("clearTraktSession",{scope});
  } catch {}
  return null;
}
async function rememberTrakt(result,p) {
  if (profile !== p || !result?.access_token) return;
  const clientID = settings.trakt || bingrTrakt?.id;
  const scope = traktScope(p);
  const lifetime = Number(result.expires_in);
  const start = time(Number(result.created_at)) || Date.now();
  const expiresAt = lifetime > 0 ? start + lifetime * 1000 : 0;
  trakt = connectedInTrack = {access_token:result.access_token,clientID,expiresAt,profileID:p.id,source:"track"};
  traktLists.clear();
  if (scope && expiresAt) {
    try { await native("saveTraktSession",{scope,data:JSON.stringify({access_token:result.access_token,clientID,expiresAt})}); }
    catch {}
  }
}
async function forgetTrakt(p = profile) {
  const scope = traktScope(p);
  trakt = connectedInTrack = null;
  traktLists.clear();
  if (scope) { try { await native("clearTraktSession",{scope}); } catch {} }
}
async function loadTraktConfig(p) {
  traktConfigFailed = false;
  bingrTraktExpired = false;
  if (p.kids) return;
  const [config, linked, saved] = await Promise.allSettled([
    device("config"),
    p.isMain === true ? device("get_state",{sections:["connections"]}) : Promise.resolve(null),
    savedTraktSession(p)
  ]);
  if (profile !== p) return;
  const data = config.value;
  if (typeof data?.traktClientID === "string" && data.traktClientID.trim()) {
    bingrTrakt = {id:data.traktClientID.trim(),secret:typeof data.traktClientSecret === "string" ? data.traktClientSecret.trim() : ""};
  }
  traktConfigFailed = config.status === "rejected" || linked.status === "rejected";
  const standalone = connectedInTrack?.profileID === p.id ? connectedInTrack : saved.value;
  if (standalone && standalone.clientID === (settings.trakt || bingrTrakt?.id) &&
      (!standalone.expiresAt || standalone.expiresAt > Date.now())) {
    trakt = connectedInTrack = standalone;
    return;
  }
  const existing = linked.value?.sections?.connections?.data?.trakt;
  const expires = time(existing?.expiresAt);
  if (bingrTrakt?.id && typeof existing?.accessToken === "string" && existing.accessToken) {
    if (expires && expires <= Date.now()) bingrTraktExpired = true;
    else trakt = {access_token:existing.accessToken,source:"bingr",username:existing.username};
  }
}
function enter(p,data,catalog,collections) {
  profile = p;
  unlocked = lockValue(data);
  shared = data;
  catalogMeta = catalog;
  collectionsState = collections;
  traktLoading = !p.kids;
  void render("Home").catch(error);
  void loadTraktConfig(p).then(() => {
    if (profile !== p) return;
    traktLoading = false;
    if (!main.querySelector("dialog[open]")) return render(tab);
  }).catch(error);
}
async function reload() {
  const p = profile;
  const data = await state(p);
  if (profile !== p) return;
  if (lockValue(data) !== unlocked) { await profiles(); return; }
  shared = data;
  catalogMeta = catalog;
  collectionsState = collections;
  traktLists.clear();
  await render(tab);
}
function time(v) { return typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v) || 0; }
function key(id) {
  const divider = String(id).indexOf("|");
  return divider < 0 ? String(id) : id.slice(0,divider).toLowerCase() + id.slice(divider);
}
function active(field, items) {
  const deleted = new Map();
  for (const removals of [shared[field + "Removed"],shared.removed?.[field]]) {
    for (const [id, at] of Object.entries(removals || {})) deleted.set(key(id),Math.max(time(at),deleted.get(key(id)) ?? -1));
  }
  const latest = new Map();
  for (const item of items) {
    if (!item?.id) continue;
    const id = key(item.id), stamp = time(item.at ?? item.updatedAt ?? item.date);
    if (item.removed) deleted.set(id,Math.max(stamp,deleted.get(id) ?? -1));
    else if (!latest.has(id) || stamp > latest.get(id).stamp) latest.set(id,{item,stamp});
  }
  return [...latest.entries()].filter(([id,value]) => value.stamp > (deleted.get(id) ?? -1))
    .sort((a,b) => b[1].stamp - a[1].stamp).map(([,value]) => value.item);
}
function records(field) {
  const list = shared[field];
  return active(field,Array.isArray(list) ? list.map(item => typeof item === "string" ? {id:item} : item) : []);
}
function external(item) {
  const title = item.seriesTitle || item.title;
  if (!title) return;
  const query = new URLSearchParams({type:["episode","series","show","season"].includes(item.type) ? "tv" : "movie",q:title});
  if (item.year) query.set("y",String(item.year));
  const tmdb = Number(item.tmdbId ?? item.ids?.tmdb);
  if (tmdb > 0) query.set("id",String(tmdb));
  return native("open",{url:"https://bingr.online/titel/?" + query});
}
function imageURL(item) {
  return typeof item.artwork === "string" && item.artwork.startsWith("https://image.tmdb.org/") ? item.artwork : null;
}
function kindLabel(item) {
  return ({movie:"Film",episode:"Aflevering",series:"Serie",show:"Serie",live:"Live-tv"})[item.type] || "";
}
function dateLabel(value, options = {dateStyle:"medium"}) {
  const stamp = time(value);
  return stamp ? new Date(stamp).toLocaleString("nl-NL",options) : "";
}
const scoreLabels = {imdb:"IMDb",tmdb:"TMDB",trakt:"Trakt",tomatoes:"Rotten Tomatoes",tomatoesaudience:"Publiek",metacritic:"Metacritic",letterboxd:"Letterboxd"};
function tmdbArt(path, width = "w780") {
  if (typeof path !== "string") return null;
  if (path.startsWith("https://image.tmdb.org/")) return path;
  return /^\/[\w.-]+$/.test(path) ? "https://image.tmdb.org/t/p/" + width + path : null;
}
function mediaLink(buttonText, url) { return button(buttonText,() => native("open",{url})); }
function showTitleDetails(panel, item, meta, ratings, intro, reviews) {
  panel.replaceChildren();
  if (intro) intro.replaceChildren();
  if (reviews) reviews.replaceChildren();
  const hero = el("div",null,"bingr-detail-hero");
  const artwork = tmdbArt(meta?.backdrop,"w780") || tmdbArt(meta?.poster,"w342") || imageURL(item);
  if (artwork) {
    const image = el("img",null,"detail-art");
    image.alt = ""; image.src = artwork; image.referrerPolicy = "no-referrer";
    image.onerror = () => image.remove(); hero.append(image);
  }
  const title = meta?.title?.nl || meta?.title?.en || item.title;
  hero.append(el("h2",title));
  panel.append(hero);
  const duration = item.runtime > 0 ? item.runtime + " min" : null;
  const quickFacts = [kindLabel(item),meta?.year || item.year,duration,item.certification].filter(Boolean).join(" · ");
  if (quickFacts) panel.append(el("p",quickFacts,"detail-facts detail-meta"));
  if (item.subtitle) panel.append(el("p",item.subtitle,"detail-facts"));
  const copy = intro || panel;
  if (item.tagline) copy.append(el("p",item.tagline,"detail-tagline"));
  const summary = meta?.overview?.nl || meta?.overview?.en || item.overview;
  if (summary) copy.append(el("p",summary,"detail-overview"));
  if (item.genres?.length) {
    const tags = el("div",null,"detail-tags");
    item.genres.slice(0,8).forEach(genre => tags.append(el("span",genre.replaceAll("-"," "))));
    copy.append(tags);
  }
  const valid = (ratings || []).filter(r => scoreLabels[r.source] && Number.isFinite(r.value));
  if (!valid.some(r => r.source === "trakt") && Number.isFinite(item.rating) && item.rating > 0)
    valid.push({source:"trakt",value:Math.round(item.rating * 10)});
  if (valid.length) {
    const grid = el("div",null,"detail-scores");
    for (const {source,value} of valid) {
      const score = el("div");
      const label = ["imdb","tmdb","letterboxd"].includes(source) ?
        value.toLocaleString("nl-NL",{maximumFractionDigits:1}) + (source === "letterboxd" ? "/5" : "/10") :
        Math.round(value) + (source === "metacritic" ? "/100" : "%");
      score.append(el("small",scoreLabels[source]),el("strong",label));
      grid.append(score);
    }
    (reviews || panel).append(el("h3","Beoordelingen"),grid);
  }
  const links = el("div",null,"detail-links");
  const tmdb = Number(meta?.id || item.ids?.tmdb || item.tmdbId);
  const isFilm = item.type === "movie";
  if (/^tt\d+$/i.test(item.ids?.imdb || "")) links.append(mediaLink("IMDb","https://www.imdb.com/title/" + item.ids.imdb + "/"));
  if (Number.isSafeInteger(tmdb) && tmdb > 0)
    links.append(mediaLink("TMDB","https://www.themoviedb.org/" + (isFilm ? "movie/" : "tv/") + tmdb));
  if (/^[a-z0-9-]+$/i.test(item.ids?.slug || "")) links.append(mediaLink("Trakt","https://trakt.tv/" + (isFilm ? "movies/" : "shows/") + item.ids.slug));
  if (links.childElementCount) (reviews || panel).append(links);
}
const titleMetadataCache = new Map();
async function bingrTitleMeta(item) {
  const query = new URLSearchParams({type:item.type === "movie" ? "movie" : "tv"});
  if (item.seriesTitle || item.title) query.set("q",item.seriesTitle || item.title);
  if (item.year) query.set("y",String(item.year));
  const id = Number(item.ids?.tmdb || item.tmdbId);
  if (Number.isSafeInteger(id) && id > 0) query.set("id",String(id));
  const cacheKey = query.toString();
  if (titleMetadataCache.has(cacheKey)) return titleMetadataCache.get(cacheKey);
  const request = bingr("/functions/v1/title-meta?" + cacheKey,null).catch(() => { titleMetadataCache.delete(cacheKey); return null; });
  if (titleMetadataCache.size >= 120) titleMetadataCache.delete(titleMetadataCache.keys().next().value);
  titleMetadataCache.set(cacheKey,request);
  return request;
}
async function enrichTitle(item, meta) {
  if (!traktClient() || profile?.kids) return item;
  const kind = item.type === "movie" ? "movie" : "show", id = item.ids?.trakt;
  try {
    if (Number.isSafeInteger(id) && id > 0) {
      const extra = await traktAPI("/" + (kind === "movie" ? "movies" : "shows") + "/" + id + "?extended=full",false);
      return {...item,...extra,type:item.type,subtitle:item.subtitle};
    }
    const tmdb = Number(meta?.id || item.ids?.tmdb || item.tmdbId);
    if (!Number.isSafeInteger(tmdb) || tmdb <= 0) return item;
    const hits = await traktAPI("/search/tmdb/" + tmdb + "?type=" + kind + "&extended=full",false);
    const match = hits.find(hit => hit[kind]?.ids?.tmdb === tmdb)?.[kind];
    return match ? {...item,...match,type:item.type,subtitle:item.subtitle} : item;
  } catch { return item; }
}
async function titleRatings(item,meta) {
  const tmdb = Number(meta?.id || item.ids?.tmdb || item.tmdbId);
  const imdb = item.ids?.imdb;
  if (!(Number.isSafeInteger(tmdb) && tmdb > 0) && !/^tt\d+$/i.test(imdb || "")) return [];
  const body = {type:item.type === "movie" ? "movie" : "show"};
  if (tmdb) body.tmdb = tmdb;
  if (imdb) body.imdb = imdb;
  try { return (await bingr("/functions/v1/ratings",body,true)).ratings || []; } catch { return []; }
}
function writeAccount(section, operation) {
  const current = profile;
  const owner = session?.user?.id;
  const profileSection = "profile." + current?.id;
  const task = accountWrite.catch(() => {}).then(async () => {
    const isCurrent = () => profile === current && owner && owner === session?.user?.id;
    if (!isCurrent()) throw new Error("Kies opnieuw je Bingr-profiel.");
    const result = await device("get_state",{sections:[...new Set([profileSection,section])]},owner);
    const states = result?.sections;
    const profileData = states?.[profileSection]?.data;
    if (!isCurrent() || !states || (!profileData && Object.keys(shared || {}).length) ||
        lockValue(profileData || {}) !== unlocked) throw new Error("Vernieuw je profiel vóór je wijzigingen opslaat.");
    const snapshot = states[section]?.data;
    if (section === "collections" && !snapshot && Object.keys(collectionsState).length)
      throw new Error("De Bingr-collecties zijn tijdelijk niet beschikbaar. Probeer het opnieuw.");
    const latest = snapshot || {};
    if (typeof latest !== "object" || Array.isArray(latest)) throw new Error("De Bingr-gegevens konden niet worden gelezen.");
    const timestamp = Math.max(Date.now(),(Date.parse(states[section]?.updatedAt) || 0) + 1);
    const next = operation(latest,new Date(timestamp).toISOString());
    if (!isCurrent()) throw new Error("Je profiel is gewijzigd.");
    const reply = await device("put_state",{section,data:next},owner);
    if (reply?.ok !== true) throw new Error("Bingr heeft de wijziging niet bevestigd.");
    if (isCurrent()) {
      if (section === profileSection) shared = next;
      else collectionsState = next;
    }
  });
  accountWrite = task;
  return task;
}
function libraryButtons(panel,item,meta,selectedKey) {
  panel.replaceChildren();
  const own = [...records("myList"),...records("history"),...progressItems()].map(row => ({
    ...row,id:row.playlistID && row.itemID ? row.playlistID + "|" + row.itemID : row.id
  }));
  const catalog = profile.kids ? {items:Object.fromEntries(own.filter(row => row.id && catalogMeta?.items?.[key(row.id)])
    .map(row => [key(row.id),catalogMeta.items[key(row.id)]]))} : catalogMeta;
  const {targets,ratingKey} = trackLibrary.titleTargets(item,catalog,own,meta?.id);
  const section = "profile." + profile.id;
  const update = async (name, operation, key) => {
    await writeAccount(name,operation);
    if (panel.isConnected) libraryButtons(panel,item,meta,key || selectedKey);
    error(new Error("Opgeslagen in je Bingr-profiel."));
  };
  if (ratingKey) {
    const group = el("div",null,"bingr-action-row");
    for (const [name,label,value] of [["thumb","Vind ik leuk",1],["down","Niet voor mij",-1]]) {
      const selected = trackLibrary.rating(shared,ratingKey) === value;
      const control = iconButton(name,label,() => update(section,(latest,at) =>
        trackLibrary.setRating(latest,ratingKey,trackLibrary.rating(latest,ratingKey) === value ? 0 : value,at)),selected);
      control.setAttribute("aria-pressed",String(selected));
      group.append(control);
    }
    panel.append(group);

  }
  if (!targets.length) {
    if (["movie","series","show"].includes(item.type)) panel.append(el("p","Voor Mijn lijst en collecties is een overeenkomende titel in je gesynchroniseerde Bingr-bibliotheek nodig.","detail-facts"));
    return;
  }
  const controls = el("div",null,"bingr-library-actions");
  panel.append(controls);
  function draw(target) {
    controls.replaceChildren();
    const saved = trackLibrary.saved(shared,target.key);
    const listControl = iconButton(saved ? "check" : "plus","Mijn lijst",() =>
      update(section,(latest,at) => trackLibrary.setSaved(latest,target.key,!trackLibrary.saved(latest,target.key),at),target.key),false,true);
    listControl.setAttribute("aria-pressed",String(saved));
    const row = el("div",null,"bingr-action-row");
    row.append(listControl);
    controls.append(row);
    const picker = el("details",null,"bingr-collection-picker");
    const summary = el("summary","Collecties");
    summary.prepend(glyph("collection"));
    picker.append(summary);
    for (const collection of trackLibrary.collectionItems(collectionsState,profile)) {
      if (collection.deleted || collection.deletedAt || collection.kind !== "manual") continue;
      const present = trackLibrary.collectionHas(collection,target);
      picker.append(button((present ? "Verwijder uit " : "Voeg toe aan ") + collection.name,() =>
        update("collections",(latest,at) => trackLibrary.updateCollections(latest,profile,items => {
          const active = items.find(row => row.id === collection.id && !row.deleted && !row.deletedAt);
          if (!active) throw new Error("Deze collectie is niet meer beschikbaar.");
          return items.map(row => row !== active ? row :
            trackLibrary.setCollectionMember(row,target,!trackLibrary.collectionHas(row,target),at));
        },at),target.key)));
    }
    if (picker.childElementCount > 1) controls.append(picker);
  }
  if (targets.length > 1) {
    const label = el("label","Bingr-server ");
    const select = el("select");
    for (const target of targets) {
      const option = el("option",target.label);
      option.value = target.key;
      select.append(option);
    }
    select.value = targets.some(target => target.key === selectedKey) ? selectedKey : targets[0].key;
    select.onchange = () => draw(targets.find(target => target.key === select.value));
    label.append(select);
    panel.insertBefore(label,controls);
  }
  draw(targets.find(target => target.key === selectedKey) || targets[0]);
}
function newCollectionID() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes,b => b.toString(16).padStart(2,"0")).join("");
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join("-");
}
function renderCollections(history) {
  const current = profile;
  const wrapper = el("section",null,"trakt-section");
  wrapper.append(el("h2","Bingr-collecties"));
  const form = el("form",null,"search-form");
  const name = field(form,"Naam van nieuwe collectie","text","off");
  name.maxLength = 80;
  const submit = el("button","Maak collectie","primary");
  form.append(submit);
  form.onsubmit = async event => {
    event.preventDefault();
    const title = name.value.trim();
    if (!title) return;
    submit.disabled = true;
    const id = newCollectionID();
    try {
      await writeAccount("collections",(latest,at) => trackLibrary.updateCollections(latest,current,items => {
        const order = Math.max(-1,...items.map(item => Number(item.order) || 0)) + 1;
        return [...items,{id,name:title,kind:"manual",items:[],image:{symbol:"folder.fill",colorIndex:0},order,updatedAt:at}];
      },at));
      if (profile === current && form.isConnected) await render("Mijn lijst");
    } catch (e) { error(e); } finally { submit.disabled = false; }
  };
  const accessible = [...listedItems(history),...history];
  const available = current.kids ? accessible : [...accessible,...trackLibrary.catalogTitles(catalogMeta)];
  for (const collection of trackLibrary.collectionItems(collectionsState,current).filter(row => !row.deleted && !row.deletedAt)
      .sort((a,b) => (a.order || 0) - (b.order || 0))) {
    const folder = el("details",null,"collection-group");
    folder.append(el("summary",collection.name));
    if (collection.kind !== "manual") folder.append(el("p","Deze slimme collectie wordt in Bingr opgebouwd."));
    else {
      const members = Array.isArray(collection.items) ? collection.items : [];
      const visible = new Map();
      for (const row of members) {
        const sid = row.sid || collection.sourceID;
        if (!sid || !["movie","series"].includes(row.type)) continue;
        const id = key(sid + "|" + row.id);
        const hit = available.find(item => item.title && item.type === row.type && key(item.playlistID && item.itemID ?
          item.playlistID + "|" + item.itemID : item.id || "") === id);
        if (hit) visible.set(id,hit);
      }
      cards([...visible.values()],"Geen gesynchroniseerde films of series in deze collectie.",folder);
      if (visible.size < members.length) folder.append(el("p","Sommige items zijn alleen beschikbaar in Bingr.","detail-facts"));
    }
    wrapper.append(folder);
  }
  wrapper.append(form);
  main.append(wrapper);
}
async function detail(item) {
  const dialog = el("dialog",null,"detail media-detail");
  const panel = el("div"), actions = el("div",null,"bingr-detail-actions"), library = el("div"), social = el("details",null,"detail-extra"), description = el("div",null,"detail-copy"), reviews = el("div",null,"detail-review");
  let current = item, foundMeta;
  showTitleDetails(panel,item,null,[],description,reviews);
  const close = iconButton("close","Sluiten",() => { dialog.close(); if (tab === "Lijsten" || tab === "Mijn lijst") return render(tab); });
  close.classList.add("detail-dismiss");
  social.append(el("summary","Seizoenen, reacties en Trakt-acties"));
  social.hidden = true;
  dialog.append(panel,close,actions,library,description,reviews,social);
  if (item.title && item.type !== "live") {
    const open = button("Open in Bingr",() => external({...current,tmdbId:foundMeta?.id || current.tmdbId}),true);
    open.prepend(glyph("play",true));
    actions.append(open);
  }
  dialog.addEventListener("close", () => dialog.remove(), {once:true});
  main.append(dialog);
  dialog.showModal();
  if (!item.title || item.type === "live") return;
  libraryButtons(library,item,null);
  const status = el("p","Titelinfo laden…","detail-facts");
  dialog.append(status);
  foundMeta = await bingrTitleMeta(item);
  if (!dialog.open || !dialog.isConnected) return;
  current = await enrichTitle(item,foundMeta);
  if (!dialog.open || !dialog.isConnected) return;
  showTitleDetails(panel,current,foundMeta,[],description,reviews);
  libraryButtons(library,current,foundMeta);
  if (traktClient() && !profile?.kids) {
    traktTitleActions(social,current);
    social.hidden = social.childElementCount <= 1;
  }
  const ratings = await titleRatings(current,foundMeta);
  if (!dialog.open || !dialog.isConnected) return;
  showTitleDetails(panel,current,foundMeta,ratings,description,reviews);
  if (foundMeta || current.overview || ratings.length) status.remove();
  else status.textContent = "Voor deze titel is geen extra informatie beschikbaar.";
}
const pendingArtwork = new WeakMap();
const artworkQueue = [];
let artworkActive = 0;
const artworkObserver = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    artworkObserver.unobserve(entry.target);
    const item = pendingArtwork.get(entry.target);
    if (item) artworkQueue.push({card:entry.target,item});
  }
  fillArtwork();
},{rootMargin:"100px"});
function fillArtwork() {
  while (artworkActive < 3 && artworkQueue.length) {
    const {card,item} = artworkQueue.shift();
    if (!card.isConnected) continue;
    artworkActive++;
    void bingrTitleMeta(item).then(meta => {
      const poster = tmdbArt(meta?.poster,"w342");
      if (card.isConnected && poster) insertArtwork(card,poster);
    }).finally(() => { artworkActive--; fillArtwork(); });
  }
}
function insertArtwork(card, art) {
  const img = el("img"); img.alt = ""; img.src = art; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
  img.onerror = () => img.remove(); card.prepend(img);
}
function cards(items, empty, container = main, layout = "") {
  if (!items.length) { container.append(el("p",empty,"empty")); return; }
  const grid = el("div",null,"grid" + (layout ? " " + layout : ""));
  for (const item of items) {
    const card = el("article",null,"card");
    const art = imageURL(item);
    if (art) insertArtwork(card,art);
    else if ((item.ids?.tmdb || item.tmdbId || (layout && item.title && item.type !== "live")) && artworkObserver) {
      pendingArtwork.set(card,item);
      artworkObserver.observe(card);
    }
    const label = [kindLabel(item),item.year].filter(Boolean).join(" · ");
    if (label) card.append(el("small",label,"media-kind"));
    const title = button(item.title || "Titel onbekend",() => detail(item));
    title.className = "title-button";
    card.append(title);
    if (item.source === "Trakt") card.append(el("small","Trakt","source-label"));
    if (item.subtitle) card.append(el("p",item.subtitle));
    if (Number.isFinite(item.fraction)) {
      const p = el("progress"); p.max = 1; p.value = Math.max(0,Math.min(1,item.fraction));
      p.setAttribute("aria-label","Kijkvoortgang");
      card.append(p,el("small",Math.round(p.value*100) + "% bekeken"));
    }
    grid.append(card);
  }
  container.append(grid);
}
function progressItems() {
  return active("progress",Object.entries(shared.progress || {}).map(([id,value]) => ({
    ...value,id,type:id.startsWith("ep:") ? "episode" : "movie",
    fraction:value?.fraction ?? (value?.duration > 0 ? value.position / value.duration : undefined)
  })));
}
function listIndex() {
  const direct = new Map(), legacy = new Map();
  for (const [rawId,entry] of Object.entries(catalogMeta?.items || {})) {
    if (!entry || typeof entry !== "object") continue;
    const id = key(rawId);
    direct.set(id,entry);
    const separator = id.indexOf("|");
    if (separator < 0) continue;
    const itemID = id.slice(separator + 1);
    if (legacy.has(itemID) && legacy.get(itemID) !== id) legacy.set(itemID,null);
    else legacy.set(itemID,id);
  }
  return {direct,legacy};
}
function remappedListID(id) {
  const visited = new Set([id.toLowerCase()]);
  let next = id;
  for (let i = 0; i < 10; i++) {
    const target = catalogMeta?.remap?.[next.toLowerCase()]?.to;
    if (typeof target !== "string" || !target) return next;
    const normalized = key(target);
    if (visited.has(normalized.toLowerCase())) return id;
    visited.add(normalized.toLowerCase());
    next = normalized;
  }
  return next;
}
function listedItems(history) {
  const {direct,legacy} = listIndex();
  const matches = new Map();
  const ambiguous = new Set();
  for (const row of [...history,...progressItems()]) {
    const itemID = row.itemID || row.id;
    if (!itemID || !row.title) continue;
    const scoped = row.playlistID && !String(itemID).toLowerCase().startsWith(String(row.playlistID).toLowerCase() + "|") ?
      key(row.playlistID + "|" + itemID) : key(itemID);
    if (!matches.has(scoped)) matches.set(scoped,row);
    const previous = matches.get(itemID);
    if (previous?.playlistID && row.playlistID &&
        String(previous.playlistID).toLowerCase() !== String(row.playlistID).toLowerCase()) ambiguous.add(itemID);
    if (!previous) matches.set(itemID,row);
  }
  const removed = new Map();
  function recordRemoval(id,at) {
    const normalized = key(id);
    removed.set(normalized,Math.max(time(at),removed.get(normalized) ?? -1));
  }
  for (const source of [shared.myListRemoved,shared.removed?.myList]) {
    for (const [id,at] of Object.entries(source || {})) recordRemoval(id,at);
  }
  for (const item of shared.myList || []) if (item?.removed && item.id) recordRemoval(item.id,item.at);
  const result = new Map();
  for (const row of records("myList")) {
    const oldID = key(row.id);
    const target = remappedListID(oldID);
    if (time(row.at) <= (removed.get(target) ?? -1)) continue;
    const id = direct.has(target) ? target : legacy.get(target) || target;
    if (result.has(id)) continue;
    const meta = direct.get(id) || direct.get(oldID);
    const historyItem = matches.get(id.includes("|") ? id : "") ||
      matches.get(oldID.includes("|") ? oldID : "") || (!ambiguous.has(id) && matches.get(id));
    const type = ({movie:"movie",series:"series",episode:"episode",channel:"live"})[meta?.k] || row.type || historyItem?.type;
    const tmdb = Number(meta?.tmdb || row.ids?.tmdb || row.tmdbId || historyItem?.tmdbId);
    result.set(id,{...historyItem,...row,id,type,
      title:meta?.t || row.title || historyItem?.title,
      year:meta?.y || row.year || historyItem?.year,
      artwork:meta?.img || row.artwork || historyItem?.artwork,
      seriesTitle:meta?.ep?.st || row.seriesTitle || historyItem?.seriesTitle,
      tmdbId:tmdb > 0 ? tmdb : undefined,
      ids:{...historyItem?.ids,...row.ids,...(tmdb > 0 ? {tmdb} : {})}});
  }
  return [...result.values()];
}
async function renderMyList(history,revision) {
  const list = listedItems(history);
  const needsLookup = list.filter(item => !item.title && item.tmdbId && ["series","movie","episode"].includes(item.type)).slice(0,30);
  const target = el("section");
  main.append(target);
  let selected = "Alles";
  function draw() {
    target.replaceChildren();
    const known = list.filter(x => x.title);
    const missing = list.length - known.length;
    filters(known,target,"Geen titels in deze selectie.",selected,label => { selected = label; });
    if (missing) {
      target.append(el("p", missing === 1 ? "Van 1 opgeslagen titel is nog geen naam beschikbaar in de Bingr-sync." :
        "Van " + missing + " opgeslagen titels is nog geen naam beschikbaar in de Bingr-sync.","empty"));
    }
  }
  draw();
  for (let offset = 0; offset < needsLookup.length && revision === screenRevision; offset += 3) {
    const batch = needsLookup.slice(offset,offset + 3);
    await Promise.all(batch.map(async item => {
      const meta = await bingrTitleMeta(item);
      const title = meta?.title?.nl || meta?.title?.en;
      if (title) Object.assign(item,{title,year:meta.year || item.year,artwork:tmdbArt(meta.poster,"w342") || item.artwork});
    }));
    if (revision === screenRevision) draw();
  }
}
function filters(items, container, empty, selected = "Alles", onSelect = () => {}) {
  const controls = el("div",null,"filter-row"), results = el("div");
  const options = [["Alles",() => true],["Films",x => x.type === "movie"],
    ["Series",x => ["episode","series","show"].includes(x.type)]];
  for (const [label, test] of options) controls.append(button(label,() => draw(label,test)));
  function draw(label,test) {
    onSelect(label);
    options.forEach(([name], index) => controls.children[index].setAttribute("aria-pressed",String(name === label)));
    results.replaceChildren();
    cards(items.filter(test),empty,results);
  }
  draw(...(options.find(([name]) => name === selected) || options[0]));
  container.append(controls,results);
}
function grouped(items, empty, container = main) {
  if (!items.length) { container.append(el("p",empty,"empty")); return; }
  const groups = new Map();
  for (const row of items) {
    const day = dateLabel(row.day ?? row.at ?? row.date,{dateStyle:"full"}) || "Datum onbekend";
    if (!groups.has(day)) groups.set(day,[]);
    groups.get(day).push(row);
  }
  for (const [day, rows] of groups) {
    container.append(el("h3",day));
    cards(rows,empty,container);
  }
}
function discover(history) {
  const form = el("form",null,"search-form");
  const input = field(form,"Zoek in je kijkgegevens","search","off");
  const submit = el("button","Zoek","primary");
  form.append(submit);
  const results = el("div");
  main.append(form,results);
  const local = [...progressItems(), ...listedItems(history), ...history, ...(profile.kids ? [] : trackLibrary.catalogTitles(catalogMeta))].filter(item => item.title && item.type !== "live");
  const revision = screenRevision;
  let searchCount = 0;
  form.onsubmit = async event => {
    event.preventDefault();
    const id = ++searchCount, query = input.value.trim();
    results.replaceChildren();
    if (!query) return;
    const lowered = query.toLocaleLowerCase("nl");
    const seen = new Set();
    const matches = local.filter(item => {
      const title = item.title.toLocaleLowerCase("nl");
      if (!title.includes(lowered) || seen.has(title)) return false;
      seen.add(title);
      return true;
    });
    results.append(el("h2","In jouw Bingr"));
    cards(matches,"Geen titels gevonden in je kijkgegevens.",results);
    if (!traktClient() || profile.kids) return;
    try {
      const found = await traktAPI("/search/movie,show?query=" + encodeURIComponent(query) + "&extended=full&limit=16",false);
      if (revision !== screenRevision || id !== searchCount) return;
      results.append(el("h2","Op Trakt"));
      filters(found.map(traktItem).filter(Boolean),results,"Geen titels gevonden op Trakt.");
    } catch (e) { if (revision === screenRevision && id === searchCount) error(e); }
  };

}
function traktItem(entry) {
  const media = entry.movie || entry.show || entry.episode;
  if (!media?.title) return null;
  return {...media,source:"Trakt",type:entry.movie ? "movie" : entry.episode && !entry.show ? "episode" : "series",
    subtitle:entry.episode && entry.show ? "S" + entry.episode.season + " · A" + entry.episode.number : ""};
}
function traktRows(path) {
  const now = Date.now(), cached = traktLists.get(path);
  if (cached && cached.until > now) return cached.promise;
  const promise = traktAPI(path).then(value => Array.isArray(value) ? value : []).catch(err => {
    if (traktLists.get(path)?.promise === promise) traktLists.delete(path);
    throw err;
  });
  traktLists.set(path,{until:now + 30000,promise});
  return promise;
}
function traktActivity(row) {
  const item = traktItem(row);
  if (!item) return null;
  const date = dateLabel(row.watched_at,{timeStyle:"short"});
  return {...item,source:"Trakt",at:row.watched_at,traktHistoryID:row.id,traktEpisode:row.episode,
    subtitle:[item.subtitle,row.episode?.title,date].filter(Boolean).join(" · ")};
}
function showTraktSection(title, fetchItems, empty, draw = cards) {
  const revision = screenRevision;
  const section = el("section",null,"trakt-section"), content = el("div");
  section.append(el("h2",title),content);
  main.append(section);
  if (!trakt) {
    if (traktLoading) content.append(el("p","Trakt-gegevens worden gecontroleerd…","empty"));
    else if (!profile.kids) content.append(button(bingrTraktExpired ? "Vernieuw je Trakt-koppeling" : "Trakt instellen",() => render("Profiel")));
    return;
  }
  content.append(el("p","Trakt-gegevens laden…","empty"));
  void fetchItems().then(items => {
    if (revision !== screenRevision) return;
    content.replaceChildren();
    draw(items,empty,content);
  }).catch(e => {
    if (revision !== screenRevision) return;
    content.replaceChildren(el("p",e.status === 401 ?
      "Je Trakt-koppeling is verlopen." : "Trakt-gegevens konden niet worden geladen.","empty"));
    content.append(button(e.status === 401 ? "Naar Trakt-instellingen" : "Probeer opnieuw",() =>
      render(e.status === 401 ? "Profiel" : tab)));
  });
}
async function nextOnTrakt() {
  const history = await traktRows("/sync/history/episodes?limit=25");
  const shows = new Map();
  for (const row of history) if (row.show?.ids?.trakt && !shows.has(row.show.ids.trakt))
    shows.set(row.show.ids.trakt,row.show);
  const results = await Promise.allSettled([...shows.entries()].slice(0,4).map(async ([id,show]) => {
    const info = await traktAPI("/shows/" + id + "/progress/watched");
    const next = info.next_episode;
    if (!next) return null;
    return {...show,type:"series",source:"Trakt",subtitle:"S" + next.season + " · A" + next.number +
      (next.title ? " · " + next.title : "")};
  }));
  if (results.length && results.every(x => x.status === "rejected")) throw results[0].reason;
  return results.map(x => x.value).filter(Boolean);
}
function modeBar(modes, selected, select) {
  const bar = el("div",null,"track-modes");
  for (const mode of modes) {
    const control = button(mode,() => select(mode));
    control.setAttribute("aria-pressed",String(mode === selected));
    bar.append(control);
  }
  main.append(bar);
}
function homeMode(selected) {
  const routes = {Media:"Home",Kalender:"Kalender",Activiteit:"Geschiedenis"};
  modeBar(Object.keys(routes),selected,mode => render(routes[mode]));
}
function shelf(title, items, empty, layout, open, container = main) {
  const group = el("section",null,"track-shelf");
  const heading = el("div",null,"shelf-heading");
  heading.append(el("h2",title));
  if (open || items.length > 6) heading.append(iconButton("arrow","Bekijk " + title.toLowerCase(),
    open || (() => {
      screen(title);
      main.append(iconButton("back","Terug",() => render(tab)));
      cards(items,empty);
    })));
  group.append(heading);
  cards(items.slice(0,12),empty,group,"shelf-" + layout);
  container.append(group);
}
function asyncShelf(title, fetch, empty, layout, open) {
  showTraktSection(title,fetch,empty,(items,message,container) => {
    if (open) container.append(button("Bekijk schema",open));
    cards(items.slice(0,12),message,container,"shelf-" + layout);
  });
}
function upcomingRows() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset()*60000).toISOString().slice(0,10);
  return traktRows("/calendars/my/shows/" + local + "/14").then(rows => rows
    .filter(row => row.show && row.episode && row.first_aired).map(row => {
      const item = traktItem(row);
      return {...item,day:row.first_aired,subtitle:[item?.subtitle,dateLabel(row.first_aired,{weekday:"short",day:"numeric",month:"short"})].filter(Boolean).join(" · ")};
    }));
}
function explore() {
  if (!traktClient() || profile.kids) {
    main.append(button("Zoeken in Bingr",() => render("Zoeken"),true));
    if (!profile.kids) main.append(el("p",traktLoading ? "Trakt-koppeling controleren…" : "Koppel Trakt in Profiel om trends en nieuwe titels te ontdekken."));
    return;
  }
  const container = el("div");
  const revision = screenRevision;
  let requestID = 0;
  function load(type) {
    const id = ++requestID;
    container.replaceChildren();
    for (const [category,title] of [["trending","Trending"],["popular","Populair"],["anticipated","Verwacht"]]) {
      const slot = el("div");
      slot.append(el("h2",title),el("p","Titels laden…"));
      container.append(slot);
      void traktAPI("/" + type + "/" + category + "?extended=full&limit=14",false).then(rows => {
        if (revision !== screenRevision || id !== requestID) return;
        slot.replaceChildren();
        const items = rows.map(row => traktItem(row) || traktItem(type === "movies" ? {movie:row} : {show:row})).filter(Boolean);
        shelf(title,items,"Er zijn geen titels beschikbaar.","poster",null,slot);
      }).catch(e => {
        if (revision === screenRevision && id === requestID) slot.replaceChildren(el("h2",title),el("p",e.message));
      });
    }
  }
  const bar = el("div",null,"track-modes");
  for (const [label,type] of [["Films","movies"],["Series","shows"]]) {
    const control = button(label,() => {
      for (const child of bar.children) child.setAttribute("aria-pressed",String(child === control));
      load(type);
    });
    control.setAttribute("aria-pressed",String(type === "movies"));
    bar.append(control);
  }
  main.append(bar,container);
  load("movies");
}
async function render(name) {
  if (!profile) return;
  tab = name;
  screen(name);
  const history = records("history");
  if (name === "Home" || name === "Vandaag") {
    homeMode("Media");
    const progress = progressItems();
    const saved = listedItems(history).filter(item => item.title);
    const recent = history.filter(item => item.title);
    shelf("Verder kijken",progress,"Je hebt nog geen titels om verder te kijken.","landscape");
    shelf("Begin met kijken",saved.filter(item => !progress.some(row =>
      row.title === item.title || (row.tmdbId && row.tmdbId === item.tmdbId))),
      "Bewaar een titel in Mijn lijst om hier te beginnen.","poster");
    if (!profile.kids && (trakt || traktLoading || bingrTraktExpired || canLinkTrakt())) {
      asyncShelf("Uitzendschema",upcomingRows,"Geen geplande afleveringen in de komende 14 dagen.","landscape",() => render("Kalender"));
      if (trakt) asyncShelf("Volgende afleveringen",nextOnTrakt,"Geen volgende afleveringen op Trakt.","landscape");
    }
    shelf("Recent bekeken",recent,"Je kijkgeschiedenis is leeg.","poster",() => render("Geschiedenis"));
  } else if (name === "Ontdek") {
    explore();
  } else if (name === "Zoeken") {
    discover(history);
  } else if (name === "Geschiedenis") {
    homeMode("Activiteit");
    grouped(history.slice(0,100).map(item => ({...item,subtitle:[item.subtitle,dateLabel(item.at ?? item.date,{timeStyle:"short"}),"Bingr"].filter(Boolean).join(" · ")})),"Je kijkgeschiedenis is leeg.");
    main.append(button("Vernieuw",reload));
    if (!profile.kids) showTraktSection("Trakt-geschiedenis",async () => (await traktRows("/sync/history?limit=50")).map(traktActivity).filter(Boolean),"Je Trakt-geschiedenis is leeg.",grouped);
  } else if (name === "Lijsten" || name === "Mijn lijst") {
    const modes = profile.kids ? ["Watchlist","Collecties"] : ["Watchlist","Collecties","Trakt"];
    if (!modes.includes(listMode)) listMode = "Watchlist";
    modeBar(modes,listMode,value => { listMode = value; return render("Lijsten"); });
    if (listMode === "Collecties") renderCollections(history);
    else if (listMode === "Trakt") {
      if (trakt) main.append(button("Mijn Trakt-lijsten",openTraktLists));
      showTraktSection("Trakt-watchlist",async () => (await traktRows("/sync/watchlist?limit=50")).map(row => ({...traktItem(row),source:"Trakt"})).filter(item => item.title),"Je Trakt-watchlist is leeg.",(items,empty,container) => filters(items,container,empty));
    } else {
      void renderMyList(history,screenRevision).catch(error);
      main.append(button("Vernieuw",reload));
    }
  } else if (name === "Kalender") {
    homeMode("Kalender");
    if (!trakt || profile.kids) {
      main.append(el("p",traktLoading ? "Trakt-koppeling controleren…" : "Koppel Trakt in Profiel om je uitzendkalender te zien.","empty"));
      if (!profile.kids) main.append(button("Naar Profiel", () => render("Profiel"), true));
      return;
    }
    main.append(el("p","Komende 14 dagen"));
    showTraktSection("Aankomende afleveringen",upcomingRows,
      "Geen geplande afleveringen in de komende 14 dagen.",grouped);
  } else {
    const actions = el("div",null,"actions");
    actions.append(button("Wissel profiel",profiles),button("Kijkgeschiedenis",() => render("Geschiedenis")),button("Uitloggen",logout));
    if (trakt && !profile.kids) actions.append(button("Kijkstatistieken",traktStats),button("Actieve check-in stoppen",async () => {
      await traktAPI("/checkin",true,null,"DELETE");
      error(new Error("Je Trakt-check-in is gestopt."));
    }));
    main.append(el("h2",profile.name),actions);
    if (settings.faceID) {
      main.append(el("h2","Face ID"),button(faceIDEnabled ? "Schakel Face ID uit" : "Schakel Face ID in", async () => {
        if (faceIDEnabled) await clearFaceID();
        else if (await native("enableFaceID",{token:session.refresh_token})) faceIDEnabled = true;
        else throw new Error("Face ID kon niet worden ingeschakeld.");
        await render("Profiel");
      }));
    }
    if (!profile.kids) {
      main.append(el("h2","Trakt"));
      if (trakt?.source === "bingr") main.append(el("p",trakt.username ? "Via Bingr gekoppeld als " + trakt.username : "Via Bingr gekoppeld"));
      else if (trakt) main.append(el("p","Gekoppeld in Track"),button("Ontkoppel Track",async () => { await forgetTrakt(); return render(tab); }));
      else if (traktLoading) main.append(el("p","Trakt-koppeling controleren…"));
      else if (bingrTraktExpired) {
        main.append(el("p","Je Bingr-koppeling is verlopen. Open Bingr om die te vernieuwen of koppel Track hier."));
        if (canLinkTrakt()) main.append(button("Koppel Trakt in Track",connectTrakt,true));
      }
      else if (canLinkTrakt()) main.append(button("Koppel Trakt",connectTrakt,true));
      else if (traktConfigFailed) main.append(el("p","De Trakt-instellingen konden niet worden geladen."),button("Opnieuw proberen",async () => { await loadTraktConfig(profile); await render("Profiel"); }));
      else main.append(el("p","Bingr geeft voor dit account geen Trakt-koppeling vrij."));
    }
  }
}
const traktRedirect = "bingrtrack://oauth/trakt";
async function connectTrakt() {
  if (!settings.trakt) return connectTraktDevice();
  const pkce = await native("pkce");
  pending = {profile:profile.id, verifier:pkce.verifier,state:pkce.state};
  const params = new URLSearchParams({response_type:"code",client_id:settings.trakt,
    redirect_uri:traktRedirect,code_challenge:pkce.challenge,code_challenge_method:"S256",state:pkce.state});
  await native("open",{url:"https://trakt.tv/oauth/authorize?" + params});
}
async function connectTraktDevice() {
  const current = profile, config = bingrTrakt;
  if (!config?.id || !config.secret || !current || current.kids) throw new Error("Trakt is niet beschikbaar voor dit profiel.");
  const base = "https://api.trakt.tv/oauth/device/";
  const credentials = await request(base + "code",{client_id:config.id});
  if (profile !== current) return;
  if (!credentials?.device_code || !credentials.user_code || !(credentials.expires_in > 0))
    throw new Error("Trakt heeft geen geldige koppelcode teruggestuurd.");
  const panel = el("dialog",null,"detail");
  const guidance = el("p","Voer deze code in op Trakt en geef toestemming.");
  const code = el("strong",credentials.user_code,"device-code");
  panel.append(el("h2","Koppel Trakt"),guidance,code,button("Open Trakt",() =>
    native("open",{url:"https://trakt.tv/activate"}),true),button("Annuleren",() => panel.close()));
  panel.addEventListener("close",() => panel.remove(),{once:true});
  main.append(panel);
  panel.showModal();
  const expires = Date.now() + Math.min(900,credentials.expires_in)*1000;
  let interval = Math.max(1,Number(credentials.interval) || 5)*1000;
  while (panel.open && panel.isConnected && profile === current && Date.now() + interval < expires) {
    await new Promise(resolve => setTimeout(resolve,interval));
    if (!panel.open || !panel.isConnected || profile !== current) return;
    try {
      const result = await request(base + "token",{code:credentials.device_code,client_id:config.id,client_secret:config.secret});
      if (!panel.open || !panel.isConnected || profile !== current) return;
      if (!result?.access_token) throw new Error("Trakt heeft geen sessie teruggestuurd.");
      await rememberTrakt(result,current);
      if (profile !== current) return;
      panel.close();
      await render("Profiel");
      return;
    } catch (e) {
      if (e.status === 400) continue;
      if (e.status === 429) { interval += 5000; continue; }
      guidance.textContent = ({404:"De koppelcode is ongeldig.",409:"Deze code is al gebruikt.",410:"De koppelcode is verlopen.",418:"De koppeling is geweigerd."})[e.status] || e.message;
      return;
    }
  }
  if (panel.open) guidance.textContent = "De koppelcode is verlopen. Sluit dit venster en probeer het opnieuw.";
}
window.oauth = async raw => {
  try {
    const url = new URL(raw);
    if (url.protocol !== "bingrtrack:" || url.host !== "oauth" || url.pathname !== "/trakt") return;
    const attempt = pending;
    if (!attempt || url.searchParams.get("state") !== attempt.state || profile?.id !== attempt.profile) return;
    pending = null;
    const code = url.searchParams.get("code");
    if (!code) throw new Error("Trakt-toegang is niet verleend.");
    const result = await request("https://api.trakt.tv/oauth/token",{code,client_id:settings.trakt,
      redirect_uri:traktRedirect,grant_type:"authorization_code",code_verifier:attempt.verifier});
    if (profile?.id !== attempt.profile) return;
    const current = profile;
    await rememberTrakt(result,current);
    if (profile !== current) return;
    await render("Profiel");
  } catch (e) { error(e); }
};
function traktMedia(item,episode = false) {
  const media = episode ? item.traktEpisode : item;
  const type = episode ? "episodes" : item.type === "movie" ? "movies" : "shows";
  return media?.ids?.trakt ? {type,ids:{trakt:media.ids.trakt}} : null;
}
async function traktSync(path,media,fields = {},verb = "POST") {
  const reply = await traktAPI(path,true,media ? {[media.type]:[{ids:media.ids,...fields}]} : fields,verb);
  if (reply?.not_found && Object.values(reply.not_found).some(rows => Array.isArray(rows) && rows.length))
    throw new Error("Trakt kon het gevraagde item niet vinden.");
  traktLists.clear();
  return reply;
}
function traktTitleActions(panel,item) {
  const media = traktMedia(item);
  if (!media) return;
  const actions = el("div",null,"detail-links");
  panel.append(el("h3","Trakt"),actions);
  const endpoint = "/" + media.type + "/" + encodeURIComponent(media.ids.trakt);
  const comments = el("details",null,"collection-group");
  comments.append(el("summary","Reacties op Trakt"));
  comments.ontoggle = async () => {
    if (!comments.open || comments.childElementCount > 1) return;
    const content = el("div",null,"detail-facts");
    comments.append(content);
    try {
      const rows = await traktAPI(endpoint + "/comments/likes?limit=8",false);
      if (!rows.length) content.append(el("p","Er zijn geen reacties."));
      for (const row of rows) {
        const entry = el("details");
        entry.append(el("summary",row.user?.username || "Trakt-gebruiker"),
          el("p",row.spoiler ? "Spoiler. Open de reacties op Trakt om deze te lezen." : row.comment || ""));
        content.append(entry);
      }
    } catch (e) { content.append(el("p",e.message)); }
  };
  panel.append(comments);
  if (media.type === "shows") {
    const seasons = el("details",null,"collection-group");
    seasons.append(el("summary","Seizoenen en afleveringen"));
    seasons.ontoggle = async () => {
      if (!seasons.open || seasons.childElementCount > 1) return;
      const content = el("div");
      seasons.append(content);
      try {
        const rows = await traktAPI(endpoint + "/seasons?extended=episodes",false);
        for (const row of rows) {
          const group = el("details");
          group.append(el("summary",row.number === 0 ? "Specials" : "Seizoen " + row.number));
          for (const episode of row.episodes || []) {
            group.append(button("A" + episode.number + " · " + (episode.title || "Aflevering"),() => {
              const previous = panel.closest("dialog");
              previous?.close();
              return detail({...item,subtitle:"S" + row.number + " · A" + episode.number + " · " + episode.title,traktEpisode:episode});
            }));
          }
          content.append(group);
        }
        if (!rows.length) content.append(el("p","Er zijn geen seizoenen beschikbaar."));
      } catch (e) { content.append(el("p",e.message)); }
    };
    panel.append(seasons);
  }
  if (!trakt) return;
  const respond = async (path,selection = media,fields = {},message = "Opgeslagen op Trakt.") => {
    await traktSync(path,selection,fields);
    error(new Error(message));
  };
  actions.append(button("Op Trakt-watchlist",() => respond("/sync/watchlist")),
    button("Uit Trakt-watchlist",() => respond("/sync/watchlist/remove")),
    button("In Trakt-lijst",() => pickTraktList(media)));
  const playable = traktMedia(item,true) || (media.type === "movies" ? media : null);
  if (playable) {
    actions.append(button("Markeer bekeken",() => respond("/sync/history",playable,{watched_at:new Date().toISOString()})));
    actions.append(button("Check in",async () => {
      const key = playable.type === "movies" ? "movie" : "episode";
      await traktAPI("/checkin",true,{[key]:{ids:playable.ids}});
      traktLists.clear();
      error(new Error("Je kijkt nu op Trakt."));
    }));
  }
  if (Number.isSafeInteger(item.traktHistoryID) && item.traktHistoryID > 0)
    actions.append(button("Verwijder dit kijkmoment",() => respond("/sync/history/remove",null,{ids:[item.traktHistoryID]})));
  const value = el("select");
  value.setAttribute("aria-label","Trakt-beoordeling");
  const placeholder = el("option","Kies een score");
  placeholder.value = "";
  value.append(placeholder);
  for (let n=1;n<=10;n++) {
    const option = el("option",n + "/10");
    option.value = String(n);
    value.append(option);
  }
  const ratingPanel = el("div",null,"detail-links");
  ratingPanel.append(value,button("Beoordeel op Trakt",() => {
    if (!value.value) throw new Error("Kies een score van 1 tot 10.");
    return respond("/sync/ratings",playable || media,{rating:Number(value.value)});
  }),button("Verwijder beoordeling",() => respond("/sync/ratings/remove",playable || media)));
  panel.append(ratingPanel);
}
async function openTraktLists() {
  screen("Mijn Trakt-lijsten");
  const screenID = screenRevision;
  main.append(button("Terug naar Mijn lijst",() => render("Mijn lijst")));
  const form = el("form",null,"search-form");
  const input = field(form,"Naam van nieuwe Trakt-lijst","text","off");
  input.maxLength = 80;
  const submit = el("button","Maak privélijst","primary");
  form.append(submit);
  form.onsubmit = async event => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    submit.disabled = true;
    try {
      await traktAPI("/users/me/lists",true,{name,privacy:"private"});
      traktLists.clear();
      if (screenRevision === screenID) await openTraktLists();
    } catch(e) { error(e); } finally { submit.disabled = false; }
  };
  main.append(form);
  const rows = await traktRows("/users/me/lists");
  if (screenRevision !== screenID) return;
  for (const list of rows.filter(list => list.ids?.trakt)) {
    const folder = el("details",null,"collection-group");
    folder.append(el("summary",list.name));
    folder.ontoggle = async () => {
      if (!folder.open || folder.childElementCount > 1) return;
      const content = el("div");
      folder.append(content);
      try {
        const rows = await traktRows("/users/me/lists/" + list.ids.trakt + "/items?page=1&limit=50");
        for (const row of rows) {
          const item = traktItem(row);
          if (!item) continue;
          const line = el("div",null,"detail-links");
          line.append(button(item.title,() => detail(item)),button("Uit deze lijst",async () => {
            const media = traktMedia(item);
            if (!media) return;
            await traktSync("/users/me/lists/" + list.ids.trakt + "/items/remove",media);
            line.remove();
          }));
          content.append(line);
        }
        if (!content.childElementCount) content.append(el("p","Deze lijst bevat geen films of series."));
      } catch(e) { content.append(el("p",e.message)); }
    };
    main.append(folder);
  }
  if (!rows.length) main.append(el("p","Je hebt nog geen eigen Trakt-lijsten."));
}
async function pickTraktList(media) {
  const revision = screenRevision, host = main.querySelector("dialog[open]");
  const rows = await traktRows("/users/me/lists");
  if (revision !== screenRevision || !host?.open) return;
  const chooser = el("section");
  host.querySelector(".trakt-list-picker")?.remove();
  chooser.className = "trakt-list-picker";
  chooser.append(el("h3","Kies een Trakt-lijst"));
  for (const list of rows.filter(list => list.ids?.trakt)) chooser.append(button(list.name,async () => {
    await traktSync("/users/me/lists/" + list.ids.trakt + "/items",media);
    chooser.remove();
    error(new Error("Opgeslagen op Trakt."));
  }));
  if (!rows.length) chooser.append(el("p","Maak eerst een privélijst via Mijn Trakt-lijsten."));
  host.append(chooser);
}
async function traktStats() {
  screen("Trakt-statistieken");
  const revision = screenRevision;
  main.append(button("Terug naar Profiel",() => render("Profiel")));
  const stats = await traktAPI("/users/me/stats");
  if (revision !== screenRevision) return;
  const groups = [["Films bekeken",stats.movies?.watched],["Series bekeken",stats.shows?.watched],
    ["Afleveringen bekeken",stats.episodes?.watched],["Minuten films",stats.movies?.minutes],["Minuten afleveringen",stats.episodes?.minutes]];
  const section = el("div",null,"metrics");
  for (const [label,value] of groups) if (Number.isFinite(value)) {
    const tile = el("div");
    tile.append(el("strong",value.toLocaleString("nl-NL")),el("span",label));
    section.append(tile);
  }
  main.append(section);
}
async function traktAPI(path, authenticated = true, payload = null, method = payload == null ? "GET" : "POST") {
  try {
    return await request("https://api.trakt.tv" + path,payload,{"trakt-api-version":"2","trakt-api-key":traktClient(),
      ...(authenticated ? {Authorization:"Bearer " + trakt.access_token} : {})},method);
  } catch (e) {
    if (authenticated && e.status === 401) {
      if (trakt?.source === "bingr") { bingrTraktExpired = true; trakt = null; traktLists.clear(); }
      else await forgetTrakt();
    }
    throw e;
  }
}
async function clearFaceID() {
  if (!settings?.faceID && !faceIDEnabled) return;
  await native("disableFaceID");
  faceIDEnabled = false;
}
async function rememberRefreshToken() {
  try {
    if (await native("updateFaceID",{token:session.refresh_token})) return;
  } catch {}
  await clearFaceID();
}
async function unlockWithFaceID() {
  if (unlocking) return;
  unlocking = true;
  try {
    const token = await native("readFaceID");
    if (!token) return;
    try {
      session = await bingr("/auth/v1/token?grant_type=refresh_token",{refresh_token:token});
    } catch (e) {
      if ([400,401].includes(e.status)) {
        await clearFaceID();
        login();
        throw new Error("Je Bingr-sessie is verlopen. Log opnieuw in met je wachtwoord.");
      }
      throw e;
    }
    await rememberRefreshToken();
    await profiles();
  } finally { unlocking = false; }
}
async function launch() {
  document.documentElement.dataset.platform = window.TrackNative ? "android" : "apple";
  const delay = new Promise(resolve => setTimeout(resolve,3500));
  try {
    const value = await native("config");
    settings = {...value,url:value.url.replace(/\/$/,"")};
    faceIDEnabled = Boolean(value.faceIDEnabled);
    await delay;
    login();
    if (faceIDEnabled) void unlockWithFaceID().catch(error);
  } catch (e) { await delay; error(e); }
  finally { document.getElementById("splash").hidden = true; }
}
void launch();
