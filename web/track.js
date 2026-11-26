"use strict";
const main = document.getElementById("main");
const nav = document.getElementById("nav");
const notice = document.getElementById("notice");
const tabs = ["Vandaag", "Mijn lijst", "Kalender", "Geschiedenis", "Profiel"];
let sequence = 0, settings, session, profile, shared, trakt, pending, tab = tabs[0];
const waiting = new Map();
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
async function device(action, data = {}) {
  const run = () => bingr("/functions/v1/device-auth", {action, ...data}, true);
  try { return await run(); } catch (e) {
    if (e.status !== 401) throw e;
    if (!refreshing) refreshing = bingr("/auth/v1/token?grant_type=refresh_token", {refresh_token:session.refresh_token})
      .then(value => session = value).finally(() => refreshing = null);
    try { await refreshing; } catch (refreshError) {
      if ([400,401].includes(refreshError.status)) { session = profile = shared = null; login(); }
      throw refreshError;
    }
    return run();
  }
}
function screen(title, showNav = Boolean(profile)) {
  main.replaceChildren(el("h1",title));
  nav.hidden = !showNav;
  nav.replaceChildren();
  if (showNav) tabs.forEach(name => {
    const b = button(name, () => render(name));
    if (tab === name) b.setAttribute("aria-current","page");
    nav.append(b);
  });
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
      password.value = "";
      await profiles();
    } catch (e) { error(e); } finally { submit.disabled = false; }
  };
  main.append(form);
}
async function profiles() {
  profile = shared = trakt = pending = null;
  screen("Wie kijkt er?", false);
  let result;
  try { result = await device("get_profiles"); }
  catch (e) {
    if (session) main.append(button("Probeer profielen opnieuw te laden",profiles,true),button("Uitloggen",logout));
    throw new Error("Bingr-profielen konden niet worden geladen. " + e.message);
  }
  const items = (result.profiles || []).filter(p => !p.deleted && !p.deletedAt && p.id && p.name)
    .sort((a,b) => Number(b.isMain || false) - Number(a.isMain || false) || (a.order || 0) - (b.order || 0));
  if (!items.length) main.append(el("p","Open Bingr om je eerste profiel in te stellen."));
  const grid = el("div",null,"grid");
  for (const p of items) grid.append(button(p.name, () => select(p)));
  main.append(grid, button("Uitloggen", logout));
}
async function logout() {
  try { if (session) await bingr("/auth/v1/logout?scope=local",{},true); }
  finally { session = profile = shared = trakt = pending = null; login(); }
}
async function state(p) {
  const section = "profile." + p.id;
  const result = await device("get_state",{sections:[section]});
  return result.sections?.[section]?.data || {};
}
function lockValue(data) { return JSON.stringify([data.pinHash ?? null,data.pin ?? null]); }
let unlocked;
async function select(p) {
  const data = await state(p);
  if (data.pinHash || data.pin) {
    screen("Pincode voor " + p.name, false);
    const form = el("form");
    const pin = field(form, "Pincode", "password", "off");
    pin.inputMode = "numeric";
    pin.pattern = "[0-9]{4,8}";
    const submit = el("button","Ontgrendelen","primary");
    form.append(submit,button("Terug",profiles));
    form.onsubmit = async event => {
      event.preventDefault();
      submit.disabled = true;
      try {
        const valid = data.pinHash ? await native("verifyPIN",{pin:pin.value, hash:data.pinHash}) : pin.value === String(data.pin);
        if (!valid) throw new Error("Onjuiste pincode.");
        enter(p,data);
      } catch(e) { error(e); } finally { submit.disabled = false; pin.value = ""; }
    };
    main.append(form);
  } else enter(p,data);
}
function enter(p,data) {
  profile = p;
  unlocked = lockValue(data);
  shared = data;
  void render("Vandaag").catch(error);
}
async function reload() {
  const p = profile;
  const data = await state(p);
  if (profile !== p) return;
  if (lockValue(data) !== unlocked) { await profiles(); return; }
  shared = data;
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
  const query = new URLSearchParams({type:["episode","series","show"].includes(item.type) ? "tv" : "movie",q:title});
  const tmdb = Number(item.tmdbId ?? item.ids?.tmdb);
  if (tmdb > 0) query.set("id",String(tmdb));
  return native("open",{url:"https://bingr.online/titel/?" + query});
}
function cards(items, empty) {
  if (!items.length) { main.append(el("p",empty)); return; }
  const grid = el("div",null,"grid");
  for (const item of items) {
    const card = el("article",null,"card");
    if (profile?.isMain && typeof item.artwork === "string" && item.artwork.startsWith("https://image.tmdb.org/")) {
      const img = el("img"); img.alt = ""; img.src = item.artwork; card.append(img);
    }
    card.append(el("h2",item.title || "Titel onbekend"));
    if (item.subtitle) card.append(el("p",item.subtitle));
    if (Number.isFinite(item.fraction)) {
      const p = el("progress"); p.max = 1; p.value = Math.max(0,Math.min(1,item.fraction));
      p.setAttribute("aria-label","Kijkvoortgang"); card.append(p,el("small",Math.round(p.value*100) + "% bekeken"));
    }
    if (item.title && item.type !== "live") card.append(button("Open in Bingr", () => external(item)));
    grid.append(card);
  }
  main.append(grid);
}
async function render(name) {
  if (!profile) return;
  tab = name;
  screen(name);
  const history = records("history");
  if (name === "Vandaag") {
    main.append(el("p",profile.name),el("h2","Verder kijken"));
    cards(active("progress",Object.entries(shared.progress || {}).map(([id,value]) => ({
      ...value,id,type:id.startsWith("ep:") ? "episode" : "movie",
      fraction:value?.fraction ?? (value?.duration > 0 ? value.position / value.duration : undefined)
    }))).slice(0,12),"Je hebt nog geen titels om verder te kijken.");
    main.append(button("Vernieuw",reload));
  } else if (name === "Geschiedenis") {
    cards(history.slice(0,100).map(item => ({...item,subtitle:[item.subtitle,time(item.at ?? item.date) ?
      new Date(time(item.at ?? item.date)).toLocaleString("nl-NL",{dateStyle:"medium",timeStyle:"short"}) : null,"Bingr"].filter(Boolean).join(" · ")})),"Je kijkgeschiedenis is leeg.");
    main.append(button("Vernieuw",reload));
    if (trakt) main.append(button("Trakt-geschiedenis", () => traktCollection("/sync/history", "Trakt-geschiedenis")));
  } else if (name === "Mijn lijst") {
    const matches = new Map();
    for (const row of [...history,...Object.values(shared.progress || {})]) {
      if (row?.itemID) {
        matches.set(key(row.itemID),row);
        if (row.playlistID) matches.set(key(row.playlistID + "|" + row.itemID),row);
      }
    }
    cards(records("myList").map(row => ({...matches.get(key(row.id)),...row})),"Mijn lijst is leeg.");
    main.append(button("Vernieuw",reload));
    if (trakt) main.append(button("Trakt-watchlist", () => traktCollection("/sync/watchlist", "Trakt-watchlist")));
  } else if (name === "Kalender") {
    if (!trakt || profile.kids) { main.append(el("p","Koppel Trakt in Profiel om je uitzendkalender te zien.")); return; }
    const date = new Date();
    const local = new Date(date.getTime() - date.getTimezoneOffset()*60000).toISOString().slice(0,10);
    const current = profile;
    const result = await traktAPI("/calendars/my/shows/" + local + "/14");
    if (profile !== current || tab !== name) return;
    cards(result.map(item => ({title:item.show.title,type:"series",ids:item.show.ids,
      subtitle:new Date(item.first_aired).toLocaleDateString("nl-NL") + " · S" + item.episode.season + " A" + item.episode.number
    })),"Geen geplande afleveringen in de komende 14 dagen.");
  } else {
    main.append(el("h2",profile.name),button("Wissel profiel",profiles),button("Uitloggen",logout));
    if (!profile.kids) {
      main.append(el("h2","Trakt"));
      if (trakt) main.append(el("p","Verbonden voor deze sessie"),button("Ontkoppel Track",() => { trakt = null; return render(tab); }));
      else main.append(button("Koppel Trakt",connectTrakt,true));
    }
  }
}
const traktRedirect = "bingrtrack://oauth/trakt";
async function connectTrakt() {
  if (!settings.trakt) throw new Error("Trakt-configuratie ontbreekt in deze build.");
  const pkce = await native("pkce");
  pending = {profile:profile.id, verifier:pkce.verifier,state:pkce.state};
  const params = new URLSearchParams({response_type:"code",client_id:settings.trakt,
    redirect_uri:traktRedirect,code_challenge:pkce.challenge,code_challenge_method:"S256",state:pkce.state});
  await native("open",{url:"https://trakt.tv/oauth/authorize?" + params});
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
    trakt = result;
    await render("Profiel");
  } catch (e) { error(e); }
};
async function traktCollection(path, title) {
  const current = profile;
  const currentTab = tab;
  const entries = await traktAPI(path + "?limit=50");
  if (profile !== current || tab !== currentTab) return;
  screen(title);
  cards(entries.map(entry => {
    const media = entry.movie || entry.show || entry.episode;
    if (!media) return null;
    const date = entry.watched_at ? new Date(entry.watched_at).toLocaleDateString("nl-NL") : "";
    const episode = entry.episode ? "S" + entry.episode.season + " A" + entry.episode.number : "";
    return {title:media.title, type:entry.movie ? "movie" : "series", ids:media.ids,
      subtitle:[episode,date,"Trakt"].filter(Boolean).join(" · ")};
  }).filter(Boolean), "Deze lijst is leeg.");
  main.append(button("Terug", () => render(currentTab)));
}
async function traktAPI(path) {
  try {
    return await request("https://api.trakt.tv" + path,null,{"trakt-api-version":"2","trakt-api-key":settings.trakt,
      Authorization:"Bearer " + trakt.access_token});
  } catch (e) {
    if (e.status === 401) { trakt = null; await render("Profiel"); }
    throw e;
  }
}
native("config").then(value => {settings = {...value,url:value.url.replace(/\/$/,"")}; login();}).catch(error);
