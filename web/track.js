"use strict";
const main = document.getElementById("main");
const nav = document.getElementById("nav");
const profileShortcut = document.getElementById("profile-shortcut");
const notice = document.getElementById("notice");
const tabs = ["Vandaag", "Ontdek", "Mijn lijst", "Kalender", "Profiel"];
const tabIcons = ["⌂", "⌕", "▤", "▦", "◯"];
let screenRevision = 0;
let bingrTrakt = null;
let traktConfigFailed = false;
const traktClient = () => settings.trakt || bingrTrakt?.id;
const canLinkTrakt = () => Boolean(settings.trakt || bingrTrakt?.secret);
let sequence = 0, settings, session, profile, shared, trakt, pending, tab = tabs[0];
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
async function device(action, data = {}) {
  const run = () => bingr("/functions/v1/device-auth", {action, ...data}, true);
  try { return await run(); } catch (e) {
    if (e.status !== 401) throw e;
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
  if (showNav) tabs.forEach((name,index) => {
    const b = button(name, () => render(name));
    const icon = el("span",tabIcons[index],"tab-icon");
    icon.setAttribute("aria-hidden","true");
    b.prepend(icon);
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
      await clearFaceID();
      profilePhotos.clear();
      password.value = "";
      await profiles();
    } catch (e) { error(e); } finally { submit.disabled = false; }
  };
  main.append(form);
  if (faceIDEnabled) main.append(button("Ontgrendel met Face ID", unlockWithFaceID, true));
}
async function profiles() {
  profile = shared = trakt = pending = bingrTrakt = null;
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
  finally { await clearFaceID(); profilePhotos.clear(); session = profile = shared = trakt = pending = bingrTrakt = null; login(); }
}
async function state(p) {
  const section = "profile." + p.id;
  const result = await device("get_state",{sections:[section]});
  return result.sections?.[section]?.data || {};
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
  const data = await state(p);
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
        if (form.isConnected) enter(p,data);
      } catch(e) { error(e); } finally { submit.disabled = false; pin.value = ""; drawDigits(); }
    };
    main.append(form);
  } else enter(p,data);
}
async function loadTraktConfig(p) {
  traktConfigFailed = false;
  if (settings.trakt || p.kids) return;
  try {
    const data = await device("config");
    if (profile !== p) return;
    if (typeof data.traktClientID === "string" && data.traktClientID.trim()) {
      bingrTrakt = {id:data.traktClientID.trim(),secret:typeof data.traktClientSecret === "string" ? data.traktClientSecret.trim() : ""};
    }
  } catch {
    if (profile === p) traktConfigFailed = true;
  }
}
function enter(p,data) {
  profile = p;
  unlocked = lockValue(data);
  shared = data;
  void render("Vandaag").catch(error);
  void loadTraktConfig(p).then(() => {
    if (profile === p && ["Ontdek","Profiel"].includes(tab)) return render(tab);
  }).catch(error);
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
  const query = new URLSearchParams({type:["episode","series","show","season"].includes(item.type) ? "tv" : "movie",q:title});
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
function detail(item) {
  const dialog = el("dialog",null,"detail");
  const title = el("h2",item.title || "Titel onbekend");
  dialog.append(title);
  const metadata = [kindLabel(item),item.year,item.subtitle].filter(Boolean).join(" · ");
  if (metadata) dialog.append(el("p",metadata));
  if (item.overview) dialog.append(el("p",item.overview));
  if (item.title && item.type !== "live") dialog.append(button("Open in Bingr",() => external(item),true));
  if (trakt && ["movie","series"].includes(item.type) && item.ids && !profile?.kids) {
    dialog.append(button("Bewaar op Trakt",async () => {
      await addToTrakt("/sync/watchlist",item);
      dialog.close();
    }));
  }
  dialog.append(button("Sluiten",() => dialog.close()));
  dialog.addEventListener("close", () => dialog.remove(), {once:true});
  main.append(dialog);
  dialog.showModal();
}
function cards(items, empty, container = main) {
  if (!items.length) { container.append(el("p",empty,"empty")); return; }
  const grid = el("div",null,"grid");
  for (const item of items) {
    const card = el("article",null,"card");
    const art = imageURL(item);
    if (art) {
      const img = el("img"); img.alt = ""; img.src = art; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
      img.onerror = () => img.remove(); card.append(img);
    }
    const label = [kindLabel(item),item.year].filter(Boolean).join(" · ");
    if (label) card.append(el("small",label,"media-kind"));
    const title = button(item.title || "Titel onbekend",() => detail(item));
    title.className = "title-button";
    card.append(title);
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
function listedItems(history) {
  const matches = new Map();
  for (const row of [...history,...progressItems()]) {
    if (!row?.itemID) continue;
    matches.set(key(row.itemID),row);
    if (row.playlistID) matches.set(key(row.playlistID + "|" + row.itemID),row);
  }
  return records("myList").map(row => ({...matches.get(key(row.id)),...row}));
}
function filters(items, container, empty) {
  const controls = el("div",null,"filter-row"), results = el("div");
  const options = [["Alles",() => true],["Films",x => x.type === "movie"],
    ["Series",x => ["episode","series","show"].includes(x.type)]];
  for (const [label, test] of options) controls.append(button(label,() => draw(label,test)));
  function draw(label,test) {
    options.forEach(([name], index) => controls.children[index].setAttribute("aria-pressed",String(name === label)));
    results.replaceChildren();
    cards(items.filter(test),empty,results);
  }
  draw(...options[0]);
  container.append(controls,results);
}
function grouped(items, empty) {
  if (!items.length) { main.append(el("p",empty,"empty")); return; }
  const groups = new Map();
  for (const row of items) {
    const day = dateLabel(row.day ?? row.at ?? row.date,{dateStyle:"full"}) || "Datum onbekend";
    if (!groups.has(day)) groups.set(day,[]);
    groups.get(day).push(row);
  }
  for (const [day, rows] of groups) {
    main.append(el("h2",day));
    cards(rows,empty);
  }
}
function discover(history) {
  const form = el("form",null,"search-form");
  const input = field(form,"Zoek in je kijkgegevens","search","off");
  const submit = el("button","Zoek","primary");
  form.append(submit);
  const results = el("div");
  main.append(form,results);
  const local = [...progressItems(), ...listedItems(history), ...history].filter(item => item.title && item.type !== "live");
  const revision = screenRevision;
  let searchCount = 0, trendingCount = 0;
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
  if (traktClient() && !profile.kids) {
    const featured = el("div");
    const buttons = el("div",null,"filter-row");
    async function trending(type) {
      const id = ++trendingCount;
      featured.replaceChildren(el("p","Titels laden…","empty"));
      try {
        const rows = await traktAPI("/" + type + "/trending?extended=full&limit=12",false);
        if (revision !== screenRevision || id !== trendingCount) return;
        featured.replaceChildren();
        cards(rows.map(traktItem).filter(Boolean),"Er zijn geen titels beschikbaar.",featured);
      } catch (e) {
        if (revision === screenRevision && id === trendingCount) featured.replaceChildren(el("p",e.message,"empty"));
      }
    }
    buttons.append(button("Trending films",() => trending("movies")),button("Trending series",() => trending("shows")));
    main.append(el("h2","Trending op Trakt"),buttons,featured);
    void trending("movies");
  }
}
function traktItem(entry) {
  const media = entry.movie || entry.show || entry.episode;
  if (!media?.title) return null;
  return {...media,type:entry.movie ? "movie" : entry.episode && !entry.show ? "episode" : "series",
    subtitle:entry.episode && entry.show ? "S" + entry.episode.season + " · A" + entry.episode.number : ""};
}
async function render(name) {
  if (!profile) return;
  tab = name;
  screen(name);
  const revision = screenRevision;
  const history = records("history");
  if (name === "Vandaag") {
    const hero = el("section",null,"dashboard");
    hero.append(el("p",profile.name,"profile-name"),el("h2","Jouw kijkoverzicht"));
    const metrics = el("div",null,"metrics");
    for (const [amount,label] of [[progressItems().length,"Verder kijken"],[records("myList").length,"Mijn lijst"],[history.length,"Kijkmomenten"]]) {
      const metric = el("div"); metric.append(el("strong",amount),el("span",label)); metrics.append(metric);
    }
    hero.append(metrics); main.append(hero,el("h2","Verder kijken"));
    cards(progressItems().slice(0,12),"Je hebt nog geen titels om verder te kijken.");
    main.append(el("h2","Recent bekeken"));
    cards(history.slice(0,4),"Je kijkgeschiedenis is leeg.");
    const actions = el("div",null,"actions");
    actions.append(button("Hele kijkgeschiedenis",() => render("Geschiedenis")),button("Vernieuw",reload));
    main.append(actions);
  } else if (name === "Ontdek") {
    discover(history);
  } else if (name === "Geschiedenis") {
    grouped(history.slice(0,100).map(item => ({...item,subtitle:[item.subtitle,dateLabel(item.at ?? item.date,{timeStyle:"short"}),"Bingr"].filter(Boolean).join(" · ")})),"Je kijkgeschiedenis is leeg.");
    main.append(button("Vernieuw",reload));
    if (trakt) main.append(button("Trakt-geschiedenis", () => traktCollection("/sync/history", "Trakt-geschiedenis")));
  } else if (name === "Mijn lijst") {
    filters(listedItems(history),main,"Geen titels in deze selectie.");
    main.append(button("Vernieuw",reload));
    if (trakt) main.append(button("Trakt-watchlist", () => traktCollection("/sync/watchlist", "Trakt-watchlist")));
  } else if (name === "Kalender") {
    if (!trakt || profile.kids) {
      main.append(el("p","Koppel Trakt in Profiel om je uitzendkalender te zien.","empty"));
      if (!profile.kids) main.append(button("Naar Profiel", () => render("Profiel"), true));
      return;
    }
    const date = new Date();
    const local = new Date(date.getTime() - date.getTimezoneOffset()*60000).toISOString().slice(0,10);
    main.append(el("p","Komende 14 dagen"));
    const result = await traktAPI("/calendars/my/shows/" + local + "/14");
    if (revision !== screenRevision) return;
    grouped(result.filter(item => item.show && item.episode).map(item => ({
      ...traktItem(item),day:item.first_aired
    })),"Geen geplande afleveringen in de komende 14 dagen.");
  } else {
    const actions = el("div",null,"actions");
    actions.append(button("Wissel profiel",profiles),button("Kijkgeschiedenis",() => render("Geschiedenis")),button("Uitloggen",logout));
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
      if (trakt) main.append(el("p","Verbonden voor deze sessie"),button("Ontkoppel Track",() => { trakt = null; return render(tab); }));
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
      trakt = result;
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
async function addToTrakt(path,item) {
  const kind = item.type === "movie" ? "movies" : "shows";
  const result = await traktAPI(path,true,{[kind]:[{ids:item.ids}]});
  if ((result?.not_found?.[kind] || []).length) throw new Error("Trakt kon deze titel niet vinden.");
  error(new Error("Opgeslagen op je Trakt-watchlist."));
}
async function traktAPI(path, authenticated = true, payload = null) {
  try {
    return await request("https://api.trakt.tv" + path,payload,{"trakt-api-version":"2","trakt-api-key":traktClient(),
      ...(authenticated ? {Authorization:"Bearer " + trakt.access_token} : {})});
  } catch (e) {
    if (authenticated && e.status === 401) { trakt = null; await render("Profiel"); }
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
