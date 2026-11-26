"use strict";

const trackLibrary = (() => {
  const scoped = value => {
    const separator = value.indexOf("|");
    return separator > 0 ? value.slice(0, separator).toLowerCase() + value.slice(separator) : value;
  };
  const mediaType = type => type === "movie" ? "movie" : ["series","show"].includes(type) ? "series" : null;
  const numericID = value => {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  const time = value => (typeof value === "number" ? value : Date.parse(value)) || 0;
  function reference(value, type) {
    const separator = value.indexOf("|");
    if (separator < 1 || separator === value.length - 1) return null;
    const sid = value.slice(0,separator);
    const id = value.slice(separator + 1);
    return {sid,id,type,key:scoped(value)};
  }

  function titleTargets(item, catalog, ownItems, tmdbID) {
    const type = mediaType(item.type);
    if (!type) return {type:null,ratingKey:null,targets:[]};
    const id = numericID(item.ids?.tmdb || item.tmdbId || tmdbID);
    const entries = Object.entries(catalog?.items || {});
    const byKey = new Map(entries.map(([key, value]) => [scoped(key),value]));
    const known = new Set(ownItems.map(row => scoped(String(row.id || ""))));
    const identifiers = [item.id,item.itemID && item.playlistID ? item.playlistID + "|" + item.itemID : null];
    const [explicit] = identifiers.filter(value => typeof value === "string" && value.includes("|"))
      .map(scoped).filter(value => known.has(value) || mediaType(byKey.get(value)?.k) === type);
    const candidates = new Map();
    if (explicit) candidates.set(explicit,reference(explicit,type));
    if (id) for (const [key, meta] of entries) {
      if (mediaType(meta?.k) !== type || numericID(meta?.tmdb) !== id) continue;
      const candidate = reference(key,type);
      if (candidate) candidates.set(candidate.key,candidate);
    }
    const targets = [...candidates.values()].map(target => ({
      ...target,label:byKey.get(target.key)?.sname || target.sid,
      unique:entries.filter(([id,meta]) => mediaType(meta?.k) === target.type && reference(id,target.type)?.id === target.id).length === 1
    }));
    const ratingKey = id ? "tmdb:" + (type === "series" ? "tv" : "movie") + ":" + id :
      explicit ? explicit.slice(0,explicit.indexOf("|") + 1) + type + ":" + explicit.slice(explicit.indexOf("|") + 1) : null;
    return {type,ratingKey,targets};
  }

  function array(value) { return Array.isArray(value) ? value : []; }
  function saved(data, id) {
    let added = -1, removed = -1;
    for (const row of array(data.myList)) {
      if (typeof row === "string" && scoped(row) === id) added = Math.max(added,0);
      if (typeof row?.id !== "string" || scoped(row.id) !== id) continue;
      if (row.removed) removed = Math.max(removed,time(row.at));
      else added = Math.max(added,time(row.at));
    }
    for (const source of [data.myListRemoved,data.removed?.myList]) {
      for (const [key,at] of Object.entries(source || {})) if (scoped(key) === id) removed = Math.max(removed,time(at));
    }
    return added > removed;
  }

  function setSaved(data,id,add,at) {
    const myList = array(data.myList).filter(row => scoped(String(row?.id ?? row ?? "")) !== id);
    const myListRemoved = {...data.myListRemoved};
    const removed = {...data.removed,myList:{...data.removed?.myList}};
    for (const source of [myListRemoved,removed.myList]) {
      for (const key of Object.keys(source)) if (scoped(key) === id) delete source[key];
    }
    if (add) myList.push({id,at});
    else {
      removed.myList[id] = at;
      if (data.myListRemoved) myListRemoved[id] = at;
    }
    return {...data,myList,removed,...(data.myListRemoved ? {myListRemoved} : {}),updatedAt:at};
  }

  function rating(data,key) {
    return array(data.ratings).reduce((latest,row) => row?.key === key && (!latest || time(row.at) >= time(latest.at)) ? row : latest,null)?.value ?? 0;
  }
  function setRating(data,key,value,at) {
    const ratings = array(data.ratings).filter(row => row?.key !== key);
    if (ratings.length >= 2000) {
      const retained = ratings.filter(row => row?.value !== 0 || time(row.at) > time(at) - 90*86400000);
      if (retained.length >= 2000) throw new Error("Je Bingr-profiel heeft het maximum aantal duimpjes bereikt.");
      return {...data,ratings:[...retained,{key,value,at}],updatedAt:at};
    }
    return {...data,ratings:[...ratings,{key,value,at}],updatedAt:at};
  }

  function collectionItems(section,profile) {
    if (section.version >= 2 || section.profiles) return array(section.profiles?.[profile.id]?.items);
    return profile.isMain ? array(section.items) : [];
  }
  function collectionMatch(row, target, collection) {
    const source = row?.sid || collection.sourceID;
    return row?.type === target.type && row.id === target.id &&
      (source ? source.toLowerCase() === target.sid.toLowerCase() : target.unique === true);
  }
  function collectionHas(collection,target) {
    return array(collection.items).some(row => collectionMatch(row,target,collection));
  }
  function setCollectionMember(collection,target,add,at) {
    if (collection.kind !== "manual") throw new Error("Deze collectie wordt automatisch gevuld door Bingr.");
    const items = array(collection.items).filter(row => !collectionMatch(row,target,collection));
    if (add) items.push({type:target.type,id:target.id,sid:target.sid});
    return {...collection,items,updatedAt:at};
  }
  function updateCollections(section,profile,operation,at) {
    if (!(section.version >= 2 || section.profiles) && array(section.items).length && !profile.isMain)
      throw new Error("Open eerst het hoofdprofiel om de oudere Bingr-collecties te synchroniseren.");
    const items = operation(collectionItems(section,profile));
    return {...section,version:2,profiles:{...section.profiles,[profile.id]:{...section.profiles?.[profile.id],items,updatedAt:at}},updatedAt:at};
  }

  function catalogTitles(catalog) {
    return Object.entries(catalog?.items || {}).flatMap(([id, meta]) => {
      const type = mediaType(meta?.k);
      const item = type && meta.t ? reference(id,type) : null;
      if (!item) return [];
      return [{id:item.key,type,title:meta.t,year:meta.y,artwork:meta.img,tmdbId:numericID(meta.tmdb)}];
    });
  }

  return {titleTargets,saved,setSaved,rating,setRating,collectionItems,collectionHas,setCollectionMember,updateCollections,catalogTitles};
})();
