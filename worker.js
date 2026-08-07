// Key Sniper – Cloudflare Worker (eine Datei, alles drin)
// -------------------------------------------------------
// Routen:
//   /            -> die App (HTML)
//   /api/deals   -> holt live die Deals von IsThereAnyDeal, rechnet Preislücken
//                   (?fresh=1 umgeht den Cache)
//   /api/keyshop -> Keyshop-Preis für ein Spiel (GG.deals, auf Abruf)
//   /api/radar   -> Keyshop-Radar (Grau-Markt-Deals)
//   /go?u=...    -> löst einen itad.link-Redirect auf und leitet direkt zum Shop
//
// Cron (scheduled): meldet krasse Deals per Discord und scannt rotierend
//                   mehr Spiele für den Radar.
//
// Einrichtung im Cloudflare-Dashboard:
//   1) Worker anlegen, diesen Code einfügen, Deploy.
//   2) Settings -> Variables and Secrets:
//        Secret   ITAD_API_KEY      dein ITAD-Key
//        Secret   GGDEALS_API_KEY   dein GG.deals-Key (Keyshop-Preise/Radar)
//        Secret   DISCORD_WEBHOOK   Webhook-URL für den Alarm (optional)
//        Variable GENRES_URL        raw-URL zu genres-db.json (optional, Genres)
//   3) Settings -> Bindings: KV-Namespace als  SNIPER_KV  binden (für den Alarm).
//   4) Settings -> Trigger Events -> Cron Trigger:  */10 * * * *
//   5) Worker-URL öffnen. Fertig.

const COUNTRY = 'DE';
const MAX_GAMES = 600;
const HIST_TOL_PCT = 5;   // "auf Historical Low", wenn <= ATL * (1 + 5%)
const CACHE_SECONDS = 120; // Serverseitiger Cache fürs Live-Holen

// Keyshop-Radar: die N beliebtesten Steam-Spiele auf Keyshop-Deals abklopfen
const RADAR_UNIVERSE = 100;      // Live-Fallback: ein GG.deals-Block
const RADAR_CACHE = 1500;        // 25 Min Cache (frisch genug, schont Limit)
const RADAR_NEAR_LOW_PCT = 15;   // "auf Keyshop-Tief"-Badge, wenn <= 15% über ATL
const RADAR_MAX_OVER_LOW = 30;   // in die Liste, wenn Keyshop <= 30% über dem Tief …
const RADAR_MIN_CUT = 35;        // … ODER mindestens 35% unter dem offiziellen Preis
const RADAR_BLOCK = 100;         // Spiele pro GG.deals-Anfrage (Rate-Limit: 100/Min)
const RADAR_TOTAL = 3000;      // Universumsgroesse: deckt auch Titel weit hinten ab
const RADAR_BLOCK_TTL = 6 * 3600; // Blöcke 6 h gültig

// Alarm (Cron): wann ist ein Deal "krass genug" zum Melden?
const ALARM_MIN_GAP = 7;        // € Preislücke zum zweitbilligsten Shop
const ALARM_HISTLOW_GAP = 3;    // bei Historical Low reicht diese kleinere Lücke
const ALARM_SCAN = 200;         // Spiele pro Alarm-Lauf (schlank wegen CPU-Limit)
const ALARM_TTL = 14 * 24 * 3600; // so lange gilt ein Deal als "schon gemeldet"
const ALARM_REDROP_PCT = 10;    // erneut melden, wenn Preis nochmal 10% fällt
const ALARM_MAX_EMBEDS = 10;    // Discord erlaubt max. 10 Embeds pro Nachricht
// Billig heißt nicht gut: schwach bewertete Spiele lösen keinen Alarm aus.
const ALARM_MIN_RATING = 75;    // % positiv auf Steam
const ALARM_MIN_VOTES = 50;     // darunter ist die Quote wertlos ("100% bei 3 Reviews")
// Bewertung fehlt (z.B. reine GOG/Epic-Titel) -> nicht aussortieren
const ratingOk = (r, c) =>
  r == null || (c != null && c < ALARM_MIN_VOTES) || r >= ALARM_MIN_RATING;

// Wächter: merkt, wenn der Cron stirbt oder eine API ausfällt
const HEALTH_TTL = 7 * 24 * 3600;
const ERROR_COOLDOWN = 3600;    // Fehler höchstens 1x pro Stunde melden
const REPORT_HOUR_UTC = 7;      // Tagesbericht ab dieser UTC-Stunde (~9 Uhr DE)

// Bild-Proxy (versorgt das Stream-Overlay mit Covern)
const IMG_HOSTS = ['assets.isthereanydeal.com', 'cdn.cloudflare.steamstatic.com'];
// Reihenfolge der Cover-Varianten: viele Spiele haben kein boxart, aber ein banner
const COVER_VARIANTS = ['boxart', 'banner600', 'banner400'];

const numPos = (x) => (x != null && +x > 0 ? +x : null);

// Seriöse Stores (Häkchen "Nur seriöse Stores" nutzt nur diese)
const REPUTABLE = [
  'steam', 'fanatical', 'humble', 'greenmangaming', 'gog', 'gamesplanet',
  'epic', 'microsoft', 'wingamestore', 'indiegala', 'gamebillet', 'ubisoft',
  'ea store', 'blizzard', 'gamersgate', 'dlgamer', 'allyouplay', '2game',
  'zoom platform', 'gamesload', 'dreamgame',
];
// Kleinere / Grauzone-Reseller (nur im Modus "alle Stores")
const GREY = [
  'etail.market', 'fireflower', 'fortuna digital', 'gamesporium',
  'joybuggy', 'muve', 'planetplay', 'playerland', 'playsum',
];
const ALL = REPUTABLE.concat(GREY);

const inSet = (set, name) => {
  const n = (name || '').toLowerCase();
  return set.some((w) => n.indexOf(w) !== -1);
};

// Wertet die Angebote eines Spiels für eine Store-Menge aus.
// Liefert billigster/zweitbilligster + Lücke, oder null bei < 2 Angeboten.
function analyze(deals, set, histLow) {
  const byShop = new Map();
  for (const d of deals || []) {
    const name = d.shop && d.shop.name;
    if (!inSet(set, name) || !d.price || d.price.amount == null) continue;
    const cur = byShop.get(name);
    if (!cur || d.price.amount < cur.price.amount) byShop.set(name, d);
  }
  const sorted = [...byShop.values()].sort((a, b) => a.price.amount - b.price.amount);
  if (sorted.length < 2) return null;
  const p0 = sorted[0];
  const p1 = sorted[1];
  const drmNames = (p0.drm || []).map((x) => (x.name || '').toLowerCase());
  const steam = /steam/.test((p0.shop.name || '').toLowerCase()) || drmNames.indexOf('steam') !== -1;
  return {
    cheapest: {
      shop: p0.shop.name,
      price: p0.price.amount,
      cut: p0.cut,
      url: '/go?u=' + encodeURIComponent(p0.url),
      steam,
    },
    second: { shop: p1.shop.name, price: p1.price.amount },
    gapAbs: +(p1.price.amount - p0.price.amount).toFixed(2),
    gapPct: Math.round((1 - p0.price.amount / p1.price.amount) * 100),
    atHistLow: histLow != null ? p0.price.amount <= histLow * (1 + HIST_TOL_PCT / 100) : false,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/deals') return handleDeals(request, env, ctx);
    if (url.pathname === '/api/keyshop') return handleKeyshop(url, env, ctx);
    if (url.pathname === '/api/radar') return handleRadar(url, env, ctx);
    if (url.pathname === '/api/health') return handleHealth(env);
    if (url.pathname === '/img') return handleImg(url);
    if (url.pathname === '/overlay') {
      return new Response(OVERLAY_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (url.pathname === '/go') return handleGo(url);
    return new Response(HTML, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },

  // Cron: läuft im Hintergrund (Trigger im Dashboard, z.B. */10 * * * *)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};

// ---------- kleiner Key-Value-Speicher ----------
// Nutzt den KV-Namespace SNIPER_KV, falls gebunden. Ohne KV fällt er auf die
// Cache-API zurück – die ist nicht garantiert persistent, deshalb ist KV besser.
const store = {
  _req: (k) => new Request('https://key-sniper.state/' + encodeURIComponent(k)),
  async get(env, k) {
    if (env.SNIPER_KV) return env.SNIPER_KV.get(k);
    const hit = await caches.default.match(store._req(k));
    return hit ? await hit.text() : null;
  },
  async put(env, k, v, ttl) {
    if (env.SNIPER_KV) return env.SNIPER_KV.put(k, v, { expirationTtl: ttl });
    return caches.default.put(
      store._req(k),
      new Response(v, { headers: { 'Cache-Control': 'public, max-age=' + ttl } })
    );
  },
};

// ---------- API: Deals live holen (mit kurzem Cache) ----------

async function handleDeals(request, env, ctx) {
  const key = env.ITAD_API_KEY;
  if (!key) return json({ error: 'ITAD_API_KEY fehlt (als Secret setzen)' }, 500);

  const cache = caches.default;
  const cacheKey = new Request('https://key-sniper.cache/deals?c=' + COUNTRY);
  const fresh = new URL(request.url).searchParams.get('fresh') === '1';

  if (!fresh) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let data;
  try {
    data = await buildDeals(env);
  } catch (e) {
    return json({ error: 'ITAD-Abruf fehlgeschlagen: ' + e.message }, 502);
  }

  const res = json(data);
  res.headers.set('Cache-Control', 'public, max-age=' + CACHE_SECONDS);
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// ---------- Keyshop-Preis für EIN Spiel (GG.deals, auf Abruf) ----------
// Kette: ITAD-uuid -> Steam-App-ID -> GG.deals-Preise (inkl. Grau-Markt).
async function handleKeyshop(url, env, ctx) {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id fehlt' }, 400);
  const ggKey = env.GGDEALS_API_KEY;
  if (!ggKey) return json({ error: 'GGDEALS_API_KEY fehlt (als Secret setzen)' }, 500);

  const cache = caches.default;
  const cacheKey = new Request('https://key-sniper.cache/keyshop?id=' + id);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let out;
  try {
    const info = await itad('/games/info/v2', { query: { id }, key: env.ITAD_API_KEY });
    const appid = info && info.appid;
    if (!appid) {
      out = { available: false };
    } else {
      const gg = await fetch(
        'https://api.gg.deals/v1/prices/by-steam-app-id/?ids=' + appid + '&region=' + COUNTRY.toLowerCase() + '&key=' + encodeURIComponent(ggKey)
      );
      const gj = await gg.json();
      const d = gj && gj.data && gj.data[String(appid)];
      const p = (d && d.prices) || null;
      const num = (x) => (x != null && +x > 0 ? +x : null);
      out = p
        ? {
            available: true,
            keyshop: num(p.currentKeyshops),
            retail: num(p.currentRetail),
            histKeyshop: num(p.historicalKeyshops),
            url: d.url || null,
          }
        : { available: false };
    }
  } catch (e) {
    return json({ error: 'GG.deals-Abruf fehlgeschlagen: ' + e.message }, 502);
  }

  const res = json(out);
  res.headers.set('Cache-Control', 'public, max-age=600'); // 10 Min Cache (schont Rate-Limit)
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// Spiele-DB aus GENRES_URL: uuid -> { tags, appid }.
// Liefert Genres für den Filter und die Steam-ID für die Keyshop-Preise.
// Verträgt das alte Format (reines tags-Array) mit.
async function loadGameDb(env) {
  const map = new Map();
  if (!env.GENRES_URL) return map;
  try {
    const res = await fetch(env.GENRES_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!res.ok) return map;
    const raw = await res.json();
    for (const k in raw) {
      const e = raw[k];
      map.set(
        k,
        Array.isArray(e)
          ? { tags: e, appid: null, rating: null, ratingCount: null }
          : { tags: e.t || [], appid: e.a || null, rating: e.r ?? null, ratingCount: e.rc ?? null }
      );
    }
  } catch {}
  return map;
}

// ---------- Keyshop-Radar: neue Grau-Markt-Deals entdecken ----------

// Universum: die beliebtesten kaufbaren Steam-Spiele (SteamSpy, nach Bewertungszahl)
async function steamUniverse(limit) {
  const res = await fetch('https://steamspy.com/api.php?request=all&page=0');
  if (!res.ok) throw new Error('SteamSpy HTTP ' + res.status);
  const ss = await res.json();
  return Object.values(ss)
    .filter((g) => g && +g.price > 0)
    .sort((a, b) => (b.positive + b.negative || 0) - (a.positive + a.negative || 0))
    .slice(0, limit)
    .map((g) => g.appid);
}

// Keyshop-Preise für einen Block App-IDs holen und auf Schnäppchen filtern.
// Vergleich Keyshop-gegen-Keyshop: wie weit über dem eigenen Allzeittief?
async function scanKeyshops(ggKey, appids) {
  const gg = await fetch(
    'https://api.gg.deals/v1/prices/by-steam-app-id/?ids=' + appids.join(',') +
      '&region=' + COUNTRY.toLowerCase() + '&key=' + encodeURIComponent(ggKey)
  );
  const gj = await gg.json();
  const data = (gj && gj.data) || {};
  const deals = [];
  for (const [appid, d] of Object.entries(data)) {
    if (!d || !d.prices) continue;
    const ks = numPos(d.prices.currentKeyshops);
    const retail = numPos(d.prices.currentRetail);
    const ksLow = numPos(d.prices.historicalKeyshops);
    if (!ks) continue;
    // Keine Vorfilterung mehr: wer den Abstand zum Keyshop-Tief zu eng zieht,
    // verliert Titel, die zwar über ihrem Tief liegen, aber massiv unter UVP sind.
    const overLowPct = ksLow != null ? Math.round((ks / ksLow - 1) * 100) : null;
    if (overLowPct == null) continue;
    const atKsLow = overLowPct <= RADAR_NEAR_LOW_PCT;
    const savingPct = retail != null ? Math.round((1 - ks / retail) * 100) : null;
    deals.push({ appid: +appid, title: d.title, keyshop: ks, retail, ksLow, overLowPct, savingPct, atKsLow, url: d.url || null });
  }
  return deals;
}

// Bevorzugt die vom Cron rotierend befüllten Blöcke (großes Universum).
// Nur solange die noch leer sind, wird live ein einzelner Block gescannt.
async function handleRadar(url, env, ctx) {
  const fresh = new URL(url).searchParams.get('fresh') === '1';

  if (!fresh) {
    const merged = [];
    let newest = null;
    for (let i = 0; i < Math.ceil(RADAR_TOTAL / RADAR_BLOCK); i++) {
      const raw = await store.get(env, 'radar_block_' + i);
      if (!raw) continue;
      try {
        const b = JSON.parse(raw);
        if (b && Array.isArray(b.deals)) {
          merged.push(...b.deals);
          if (!newest || b.at > newest) newest = b.at;
        }
      } catch {}
    }
    if (merged.length) {
      merged.sort((a, b) => (b.savingPct || 0) - (a.savingPct || 0) || a.overLowPct - b.overLowPct);
      return json({
        generatedAt: newest || new Date().toISOString(),
        universe: RADAR_TOTAL,
        count: merged.length,
        deals: merged,
      });
    }
  }

  // Fallback: live einen Block scannen (bis der Cron die Blöcke gefüllt hat)
  const ggKey = env.GGDEALS_API_KEY;
  if (!ggKey) return json({ error: 'GGDEALS_API_KEY fehlt (als Secret setzen)' }, 500);

  const cache = caches.default;
  const cacheKey = new Request('https://key-sniper.cache/radar?r=' + COUNTRY);
  if (!fresh) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let out;
  try {
    const appids = await steamUniverse(RADAR_UNIVERSE);
    const deals = await scanKeyshops(ggKey, appids);
    deals.sort((a, b) => a.overLowPct - b.overLowPct); // am nächsten am Keyshop-Tief zuerst
    out = { generatedAt: new Date().toISOString(), universe: RADAR_UNIVERSE, count: deals.length, deals };
  } catch (e) {
    return json({ error: 'Radar fehlgeschlagen: ' + e.message }, 502);
  }

  const res = json(out);
  res.headers.set('Cache-Control', 'public, max-age=' + RADAR_CACHE);
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function buildDeals(env) {
  const key = env.ITAD_API_KEY;
  const LIMIT = 200;

  // Spiele-DB (optional): Genres für den Filter, Steam-IDs für die Keyshop-Preise
  const genreMap = new Map();   // wird unten für Tags und Bewertung genutzt
  const db = await loadGameDb(env);
  for (const [id, e] of db) genreMap.set(id, e);

  // 1) Deals (tiefste Rabatte) UND beliebteste Spiele parallel holen
  const dealsPromise = (async () => {
    let offset = 0;
    const cands = [];
    while (cands.length < MAX_GAMES) {
      const page = await itad('/deals/v2', {
        query: { country: COUNTRY, offset, limit: LIMIT, sort: '-cut' },
        key,
      });
      const list = Array.isArray(page) ? page : page.list || [];
      if (list.length === 0) break;
      cands.push(...list);
      const more = Array.isArray(page) ? list.length === LIMIT : page.hasMore ?? list.length === LIMIT;
      if (!more) break;
      offset += LIMIT;
    }
    return cands.slice(0, MAX_GAMES);
  })();
  const [dealItems, popular] = await Promise.all([
    dealsPromise,
    itad('/stats/most-popular/v1', { query: { limit: 500 }, key }).catch(() => []),
  ]);
  const popList = Array.isArray(popular) ? popular : [];
  const popMap = new Map();
  for (const g of popList) if (g && g.id) popMap.set(g.id, g.count || 0);

  // 2) Kandidaten-Metadaten aus beiden Quellen zusammenführen (Deals sind reicher: boxart/regular)
  const meta = new Map();
  for (const c of dealItems) {
    if (!meta.has(c.id)) {
      meta.set(c.id, {
        title: c.title,
        slug: c.slug,
        boxart: (c.assets && (c.assets.boxart || c.assets.banner300)) || null,
        regular: c.regular && c.regular.amount,
      });
    }
  }
  for (const g of popList) {
    if (g && g.id && !meta.has(g.id)) meta.set(g.id, { title: g.title, slug: g.slug, boxart: null, regular: null });
  }
  const ids = [...meta.keys()];

  // 3) Preise für alle Kandidaten
  const batches = [];
  for (let i = 0; i < ids.length; i += 200) batches.push(ids.slice(i, i + 200));
  const priceLists = await Promise.all(
    batches.map((b) =>
      itad('/games/prices/v3', { method: 'POST', query: { country: COUNTRY, capacity: 0 }, body: b, key })
    )
  );
  const prices = {};
  for (const arr of priceLists) for (const g of arr) prices[g.id] = g;

  // 4) Analyse – zwei Sichten pro Spiel: "all" (alle Stores) und "rep" (nur seriöse)
  const results = [];
  for (const id of ids) {
    const g = prices[id];
    if (!g) continue;
    const c = meta.get(id);
    const histLow = g.historyLow && g.historyLow.all ? g.historyLow.all.amount : null;

    const all = analyze(g.deals, ALL, histLow);
    if (!all) continue; // ohne Zweitbilligsten (über alle Stores) keine Lücke
    const rep = analyze(g.deals, REPUTABLE, histLow);

    results.push({
      id,
      title: c.title,
      slug: c.slug,
      boxart: 'https://assets.isthereanydeal.com/' + id + '/boxart.jpg',
      histLow,
      pop: popMap.get(id) || 0,
      tags: (genreMap.get(id) || {}).tags || [],
      rating: (genreMap.get(id) || {}).rating ?? null,
      ratingCount: (genreMap.get(id) || {}).ratingCount ?? null,
      itadUrl: 'https://isthereanydeal.com/game/' + c.slug + '/info/',
      all,
      rep,
    });
  }

  results.sort((a, b) => b.all.gapAbs - a.all.gapAbs);
  return { generatedAt: new Date().toISOString(), country: COUNTRY, count: results.length, deals: results };
}

async function itad(path, { method = 'GET', query = {}, body, key } = {}) {
  const u = new URL('https://api.isthereanydeal.com' + path);
  u.searchParams.set('key', key);
  for (const [k, v] of Object.entries(query)) if (v != null) u.searchParams.set(k, String(v));
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['content-type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(u, opt);
  if (!r.ok) throw new Error(path + ' -> HTTP ' + r.status);
  return r.json();
}

// ---------- /go: itad.link -> direkter Shop-Link ----------

// Löst einen itad.link-Redirect zur echten Shop-URL auf.
// Bei Fehler kommt der Original-Link zurück (Link funktioniert immer).
async function resolveStoreUrl(u) {
  try {
    let cur = u;
    for (let i = 0; i < 5; i++) {
      const r = await fetch(cur, { method: 'GET', redirect: 'manual' });
      const loc = r.headers.get('location');
      if ([301, 302, 303, 307, 308].includes(r.status) && loc) {
        cur = new URL(loc, cur).href;
        if (!/itad\.link|isthereanydeal\.com/.test(cur)) return cur;
      } else return cur;
    }
    return cur;
  } catch (e) {
    return u;
  }
}

async function handleGo(url) {
  const target = url.searchParams.get('u');
  if (!target) return new Response('missing u', { status: 400 });
  return Response.redirect(await resolveStoreUrl(target), 302);
}

// ---------- Wächter: Zustand nach außen sichtbar machen ----------
// Der externe Watchdog (GitHub Action) fragt das ab. Ein toter Worker kann sich
// nicht selbst melden – deshalb schaut jemand von außen auf das Alter.
async function handleHealth(env) {
  const raw = await store.get(env, 'health');
  if (!raw) return json({ ok: false, reason: 'noch kein Cron-Lauf verzeichnet' }, 503);
  let h;
  try {
    h = JSON.parse(raw);
  } catch {
    return json({ ok: false, reason: 'Zustand unlesbar' }, 503);
  }
  const ageMinutes = Math.round((Date.now() - new Date(h.at).getTime()) / 60000);

  // Das Lebenszeichen vom Anfang des Cron-Laufs. Der Vergleich beider Zeiten
  // sagt, WO es klemmt:
  //   beide alt          -> der Cron feuert gar nicht (Trigger/Plattform)
  //   Lebenszeichen frisch, Abschluss alt -> er feuert und stirbt unterwegs
  //   beide frisch       -> alles in Ordnung
  const beat = await store.get(env, 'heartbeat');
  const beatAgeMinutes = beat ? Math.round((Date.now() - new Date(beat).getTime()) / 60000) : null;

  return json({
    ...h,
    ageMinutes,
    letzterStart: beat || null,
    startAgeMinutes: beatAgeMinutes,
    diagnose:
      beat == null
        ? 'kein Lebenszeichen – Worker läuft noch mit der alten Fassung'
        : beatAgeMinutes > 30
        ? 'Cron feuert nicht (Trigger oder Plattform)'
        : ageMinutes > 30
        ? 'Cron startet, bricht aber vor dem Abschluss ab'
        : 'in Ordnung',
  });
}

// ---------- Bild-Proxy für die Post-Grafiken ----------
// Ohne diesen Umweg wäre das Canvas "tainted" (fremde Domain) und der Download
// würde scheitern. Bewusst nur eine feste Host-Liste – kein offener Proxy.
async function handleImg(url) {
  const target = url.searchParams.get('u');
  if (!target) return new Response('missing u', { status: 400 });
  let host;
  try {
    host = new URL(target).hostname;
  } catch {
    return new Response('bad url', { status: 400 });
  }
  if (!IMG_HOSTS.includes(host)) return new Response('host not allowed', { status: 403 });

  // Nicht jedes Spiel hat ein "boxart" – ITAD liefert dann HTTP 200 mit einer
  // XML-Fehlermeldung statt 404. Deshalb Inhaltstyp prüfen und Varianten durchgehen.
  let candidates = [target];
  const m = target.match(/^(https:\/\/assets\.isthereanydeal\.com\/[^/]+\/)(?:boxart|banner600|banner400|banner300)\.jpg/);
  if (m) candidates = COVER_VARIANTS.map((v) => m[1] + v + '.jpg');

  for (const c of candidates) {
    const upstream = await fetch(c, { cf: { cacheTtl: 86400, cacheEverything: true } });
    const ct = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !ct.startsWith('image/')) continue;
    const res = new Response(upstream.body, upstream);
    res.headers.set('Cache-Control', 'public, max-age=86400');
    res.headers.set('Access-Control-Allow-Origin', '*');
    return res;
  }
  return new Response('kein Bild vorhanden', { status: 404 });
}

// ---------- Cron: Alarm melden + Radar rotierend füllen ----------

async function runCron(env) {
  const alerts = [];
  const errors = [];
  let checked = 0;

  // Lebenszeichen SOFORT wegschreiben, bevor irgendwas Aufwendiges passiert.
  // Ohne das sehen "Cron feuert gar nicht" und "Cron feuert und stirbt
  // unterwegs" von außen genau gleich aus – beide Male steht in /api/health
  // ein alter Zeitstempel. Wird ein Lauf von Cloudflare abgeräumt (Zeit- oder
  // CPU-Limit), bleibt wenigstens dieser Eintrag stehen und verrät es.
  const startedAt = new Date().toISOString();
  await store.put(env, 'heartbeat', startedAt, HEALTH_TTL);

  try {
    const hits = await alarmDeals(env);
    checked += ALARM_SCAN;
    alerts.push(...hits);
  } catch (e) {
    errors.push('Alarm-Check: ' + e.message);
  }
  try {
    const hits = await rotateRadar(env);
    checked += RADAR_BLOCK;
    alerts.push(...hits);
  } catch (e) {
    errors.push('Radar: ' + e.message);
  }

  // Krasseste zuerst – sonst verdrängen viele normale Treffer die Keyshop-Funde
  // aus den zehn Embeds, die Discord pro Nachricht erlaubt.
  alerts.sort((a, b) => alertScore(b) - alertScore(a));
  if (alerts.length) await sendDiscord(env, alerts);

  // Zustand festhalten – daran erkennt der externe Watchdog, ob es noch lebt
  const ok = errors.length === 0;
  await store.put(
    env,
    'health',
    JSON.stringify({ at: new Date().toISOString(), ok, checked, alerts: alerts.length, error: errors.join(' | ') || null }),
    HEALTH_TTL
  );

  if (!ok) await reportError(env, errors);
  else await dailyReport(env, checked, alerts.length);

  console.log('Cron fertig – ' + alerts.length + ' neue Alarme' + (ok ? '' : ' | FEHLER: ' + errors.join(' | ')));
}

// Fehler melden, aber höchstens 1x pro Stunde (sonst pingt ein dauerhaft
// kaputter Dienst alle 10 Minuten).
async function reportError(env, errors) {
  const last = +(await store.get(env, 'error_cooldown')) || 0;
  if (Date.now() - last < ERROR_COOLDOWN * 1000) return;
  await store.put(env, 'error_cooldown', String(Date.now()), ERROR_COOLDOWN * 2);
  await sendDiscordRaw(env, {
    username: 'Key Sniper',
    content: '⚠️ **Key Sniper hat ein Problem**',
    embeds: [
      {
        title: 'Cron-Lauf fehlgeschlagen',
        description: errors.map((e) => '• ' + e).join('\n').slice(0, 3900),
        color: 16007990,
        footer: { text: 'Nächste Meldung frühestens in einer Stunde' },
      },
    ],
  });
}

// Einmal am Tag ein Lebenszeichen – so fällt Stille auch dann auf,
// wenn gerade wirklich keine Deals da sind.
async function dailyReport(env, checked, alerts) {
  const now = new Date();
  if (now.getUTCHours() < REPORT_HOUR_UTC) return;
  const today = now.toISOString().slice(0, 10);
  if ((await store.get(env, 'daily_report')) === today) return;
  await store.put(env, 'daily_report', today, 3 * 24 * 3600);
  await sendDiscordRaw(env, {
    username: 'Key Sniper',
    embeds: [
      {
        title: '✅ Key Sniper läuft',
        description:
          'Gerade ' + checked + ' Spiele geprüft.' +
          (alerts ? ' ' + alerts + ' neue Treffer dabei.' : ' Aktuell nichts Neues.'),
        color: 4906624,
        footer: { text: 'Tägliches Lebenszeichen' },
      },
    ],
  });
}

// Rangfolge für die Discord-Meldung: Allzeittiefs schlagen alles,
// danach zählt, wie stark reduziert der Treffer ist.
function alertScore(h) {
  if (h.kind === 'keyshop') return (h.atKsLow ? 1000 : 0) + (h.savingPct || 0);
  return (h.atHistLow ? 1000 : 0) + (h.gapPct || 0);
}

// Schlanker Alarm-Pfad (2 API-Calls, wenig CPU).
// Basis sind bewusst die BELIEBTESTEN Spiele, nicht die höchsten Rabatte:
// "-cut" liefert fast nur Nischen-Ramsch mit absurdem Listenpreis, während hier
// Titel kommen, die man wirklich haben will. Volle Analyse macht /api/deals.
async function alarmDeals(env) {
  const key = env.ITAD_API_KEY;
  if (!key) return [];

  const [popular, db] = await Promise.all([
    itad('/stats/most-popular/v1', { query: { limit: ALARM_SCAN }, key }),
    loadGameDb(env), // liefert die Steam-Bewertung je Spiel
  ]);
  const list = Array.isArray(popular) ? popular : [];
  if (!list.length) return [];

  const meta = new Map();
  for (const c of list) if (c && c.id && !meta.has(c.id)) meta.set(c.id, c);
  const prices = await itad('/games/prices/v3', {
    method: 'POST',
    query: { country: COUNTRY, capacity: 0 },
    body: [...meta.keys()],
    key,
  });

  const hits = [];
  for (const g of prices || []) {
    const c = meta.get(g.id);
    if (!c) continue;
    const histLow = g.historyLow && g.historyLow.all ? g.historyLow.all.amount : null;
    const v = analyze(g.deals, REPUTABLE, histLow);
    if (!v) continue;
    // "Krass genug": große Lücke, oder Historical Low mit spürbarer Lücke
    if (!(v.gapAbs >= ALARM_MIN_GAP || (v.atHistLow && v.gapAbs >= ALARM_HISTLOW_GAP))) continue;
    const gi = db.get(g.id);
    const rating = gi ? gi.rating : null;
    const ratingCount = gi ? gi.ratingCount : null;
    if (!ratingOk(rating, ratingCount)) continue;
    hits.push({
      key: 'deal:' + g.id,
      kind: 'deal',
      price: v.cheapest.price,
      title: c.title,
      shop: v.cheapest.shop,
      gapAbs: v.gapAbs,
      gapPct: v.gapPct,
      atHistLow: v.atHistLow,
      steam: v.cheapest.steam,
      rating,
      ratingCount,
      boxart: 'https://assets.isthereanydeal.com/' + g.id + '/boxart.jpg',
      link: rawShopUrl(v.cheapest.url),
    });
  }

  // Beste zuerst (Historical Low schlägt große Lücke) – die Top-Treffer landen
  // so im Discord-Embed, falls mal viele auf einmal auftauchen.
  hits.sort((a, b) => (b.atHistLow ? 1 : 0) - (a.atHistLow ? 1 : 0) || b.gapAbs - a.gapAbs);

  const fresh = await onlyNew(env, hits);
  // Shop-Links nur für die tatsächlich gezeigten Treffer auflösen (spart Requests)
  for (const h of fresh.slice(0, ALARM_MAX_EMBEDS)) h.link = await resolveStoreUrl(h.link);
  return fresh;
}

// Pro Lauf einen 100er-Block scannen und in den Speicher legen. Nach RADAR_BLOCKS
// Läufen ist das ganze Universum (RADAR_TOTAL Spiele) abgedeckt.
// Universum: die RADAR_TOTAL meistverbreiteten Steam-Spiele, einmal täglich
// geholt und im Speicher gehalten (SteamSpy liefert 1000 pro Seite).
// Wichtig ist die Größe: Keyshop-Schnäppchen betreffen oft Titel weit hinten –
// "Still Wakes the Deep" steht z.B. erst auf Platz ~4900.
async function radarUniverse(env) {
  const cached = await store.get(env, 'radar_pool');
  if (cached) {
    try {
      const ids = JSON.parse(cached);
      if (Array.isArray(ids) && ids.length) return ids;
    } catch {}
  }
  const ids = [];
  for (let page = 0; page * 1000 < RADAR_TOTAL; page++) {
    const res = await fetch('https://steamspy.com/api.php?request=all&page=' + page);
    if (!res.ok) break;
    const data = await res.json();
    for (const g of Object.values(data)) {
      if (!g || !(+g.price > 0)) continue;
      // Bewertung gleich mitnehmen – SteamSpy liefert sie ohne Zusatzkosten
      const votes = (g.positive || 0) + (g.negative || 0);
      ids.push({ a: g.appid, r: votes ? Math.round((g.positive / votes) * 100) : null, rc: votes || null });
    }
    if (ids.length >= RADAR_TOTAL) break;
  }
  const pool = ids.slice(0, RADAR_TOTAL);
  if (pool.length) await store.put(env, 'radar_pool', JSON.stringify(pool), 24 * 3600);
  return pool;
}

// Pro Lauf ein 100er-Block, der Cursor wandert durch das ganze Universum.
// Bei 10-Minuten-Takt sind das 600 Spiele pro Stunde.
async function rotateRadar(env) {
  const ggKey = env.GGDEALS_API_KEY;
  if (!ggKey) return [];

  const pool = await radarUniverse(env);
  if (!pool.length) return [];

  const blocks = Math.max(1, Math.ceil(pool.length / RADAR_BLOCK));
  const cur = (+(await store.get(env, 'radar_cursor')) || 0) % blocks;
  const block = pool.slice(cur * RADAR_BLOCK, (cur + 1) * RADAR_BLOCK);
  if (!block.length) return [];

  const ratingBy = new Map(block.map((b) => [b.a, b]));
  const deals = await scanKeyshops(ggKey, block.map((b) => b.a));
  for (const d of deals) {
    const b = ratingBy.get(d.appid);
    d.rating = b ? b.r : null;
    d.ratingCount = b ? b.rc : null;
  }
  // Für die Radar-Ansicht: nah am Keyshop-Tief oder deutlich unter dem offiziellen Preis
  const keep = deals.filter(
    (d) => d.overLowPct <= RADAR_MAX_OVER_LOW || (d.savingPct != null && d.savingPct >= RADAR_MIN_CUT)
  );
  await store.put(
    env,
    'radar_block_' + cur,
    JSON.stringify({ at: new Date().toISOString(), deals: keep }),
    RADAR_BLOCK_TTL
  );
  await store.put(env, 'radar_cursor', String((cur + 1) % blocks), 30 * 24 * 3600);

  // Alarm nur beim Keyshop-Allzeittief: "so billig war es dort noch nie".
  // Gemessen ergibt das ~12 Meldungen pro Durchlauf. Ein reines Rabatt-Kriterium
  // wäre wertlos – 90 % unter UVP ist bei Keyshops Alltag.
  const hits = keep
    .filter((d) => d.overLowPct <= 0 && ratingOk(d.rating, d.ratingCount))
    .map((d) => ({
      key: 'ks:' + d.appid,
      kind: 'keyshop',
      price: d.keyshop,
      title: d.title,
      keyshop: d.keyshop,
      retail: d.retail,
      cutPct: d.savingPct,
      atKsLow: d.overLowPct <= 0,
      savingPct: d.savingPct,
      rating: d.rating,
      ratingCount: d.ratingCount,
      boxart: 'https://cdn.cloudflare.steamstatic.com/steam/apps/' + d.appid + '/library_600x900.jpg',
      link: d.url,
    }));
  return onlyNew(env, hits);
}

// Dedup: schon gemeldete Deals nur erneut melden, wenn der Preis nochmal fällt.
async function onlyNew(env, hits) {
  const out = [];
  for (const h of hits) {
    const k = 'alerted:' + h.key;
    const prev = await store.get(env, k);
    const prevPrice = prev != null ? +prev : null;
    if (prevPrice != null && !(h.price <= prevPrice * (1 - ALARM_REDROP_PCT / 100))) continue;
    out.push(h);
    await store.put(env, k, String(h.price), ALARM_TTL);
  }
  return out;
}

const eurTxt = (n) => (n == null ? '–' : (+n).toFixed(2).replace('.', ',') + ' €');
const votesTxt = (n) =>
  n == null ? '' : n >= 1000000 ? (n / 1000000).toFixed(1).replace('.', ',') + ' Mio.'
  : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
const ratingTxt = (h) =>
  h.rating == null ? '' : '\n👍 ' + h.rating + '% positiv' + (h.ratingCount ? ' (' + votesTxt(h.ratingCount) + ')' : '');
const rawShopUrl = (goUrl) => {
  const i = (goUrl || '').indexOf('u=');
  return i === -1 ? goUrl : decodeURIComponent(goUrl.slice(i + 2));
};

async function sendDiscord(env, hits) {
  const hook = env.DISCORD_WEBHOOK;
  if (!hook) {
    console.log('DISCORD_WEBHOOK fehlt – ' + hits.length + ' Treffer nicht gesendet');
    return;
  }
  const embeds = hits.slice(0, ALARM_MAX_EMBEDS).map((h) =>
    h.kind === 'keyshop'
      ? {
          title: '🔥 ' + h.title,
          url: h.link || undefined,
          description:
            'Keyshop: **' + eurTxt(h.keyshop) + '**' +
            (h.savingPct != null && h.savingPct > 0
              ? ' · **−' + h.savingPct + '%** gegenüber ' + eurTxt(h.retail)
              : '') +
            (h.atKsLow ? '\n📉 **So billig war es dort noch nie**' : '') +
            ratingTxt(h),
          color: 3718648,
          thumbnail: h.boxart ? { url: h.boxart } : undefined,
          footer: { text: 'Keyshop-Radar (Grau-Markt) · GG.deals' },
        }
      : {
          title: (h.atHistLow ? '📉 ' : '🎯 ') + h.title,
          url: h.link || undefined,
          description:
            '**' + eurTxt(h.price) + '** bei **' + h.shop + '**\n' +
            h.gapAbs + ' € / ' + h.gapPct + '% Lücke zum zweitbilligsten Shop' +
            (h.atHistLow ? '\n📉 **Historical Low**' : '') +
            ratingTxt(h) +
            (h.steam ? '\nSteam-Key' : ''),
          color: h.atHistLow ? 16498468 : 4906624,
          thumbnail: h.boxart ? { url: h.boxart } : undefined,
          footer: { text: 'Key Sniper · seriöse Stores' },
        }
  );

  const more = hits.length > ALARM_MAX_EMBEDS ? ' (+' + (hits.length - ALARM_MAX_EMBEDS) + ' weitere)' : '';
  await sendDiscordRaw(env, {
    username: 'Key Sniper',
    content: '🎯 **' + hits.length + (hits.length === 1 ? ' neuer Deal' : ' neue Deals') + '**' + more,
    embeds,
  });
}

// Gemeinsamer Versandweg für Alarm, Fehlermeldung und Tagesbericht
async function sendDiscordRaw(env, payload) {
  const hook = env.DISCORD_WEBHOOK;
  if (!hook) return;
  try {
    const res = await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.log('Discord HTTP ' + res.status);
  } catch (e) {
    console.log('Discord-Versand fehlgeschlagen: ' + e.message);
  }
}

// ---------- Stream-Overlay für OBS (Browser-Source) ----------
// Transparenter Hintergrund, aktualisiert sich selbst. Parameter: ?n=5&gap=7
const OVERLAY_HTML = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<title>Key Sniper – Overlay</title>
<style>
  html,body { margin:0; background:transparent; }
  body { font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; padding:18px; }
  .head { display:flex; align-items:center; gap:9px; margin-bottom:12px;
    font-size:20px; font-weight:800; color:#4ade80; text-shadow:0 2px 6px rgba(0,0,0,.9); }
  .row { display:flex; align-items:center; gap:12px; margin-bottom:9px; padding:10px 14px;
    background:rgba(15,17,21,.82); border:1px solid rgba(74,222,128,.35); border-left:5px solid #4ade80;
    border-radius:12px; box-shadow:0 4px 18px rgba(0,0,0,.5); max-width:520px; }
  .cover { width:44px; height:66px; border-radius:6px; object-fit:cover; flex:0 0 auto; background:#1e2330; }
  .info { flex:1; min-width:0; }
  .name { font-size:17px; font-weight:700; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sub { font-size:13px; color:#9aa3b5; }
  .price { font-size:24px; font-weight:800; color:#4ade80; white-space:nowrap; }
  .low { color:#fbbf24; font-size:12px; font-weight:700; }
</style>
</head>
<body>
  <div class="head" id="head">🎯 KEY SNIPER · TOP DEALS</div>
  <div id="list"></div>
<script>
  var q = new URLSearchParams(location.search);
  var N = Math.min(+(q.get('n') || 5), 12);
  var MINGAP = +(q.get('gap') || 5);
  var eur = function(n){ return n==null ? '–' : n.toLocaleString('de-DE',{style:'currency',currency:'EUR'}); };
  var esc = function(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };

  async function tick(){
    try {
      var d = await (await fetch('/api/deals')).json();
      var items = [];
      for (var i=0;i<(d.deals||[]).length;i++){
        var r = d.deals[i], v = r.rep || r.all;
        if (!v || v.gapAbs < MINGAP) continue;
        items.push({ r: r, v: v });
      }
      items.sort(function(a,b){
        return (b.v.atHistLow?1:0)-(a.v.atHistLow?1:0) || b.v.gapAbs-a.v.gapAbs;
      });
      var out = [];
      for (var j=0;j<Math.min(N, items.length);j++){
        var r = items[j].r, v = items[j].v;
        out.push('<div class="row">' +
          (r.boxart ? '<img class="cover" src="/img?u='+encodeURIComponent(r.boxart)+'" onerror="this.style.visibility=\\'hidden\\'">' : '<div class="cover"></div>') +
          '<div class="info"><div class="name">'+esc(r.title)+'</div>' +
          '<div class="sub">'+esc(v.cheapest.shop)+' · '+v.gapAbs+' € günstiger' +
          (v.atHistLow ? ' <span class="low">📉 TIEFSTPREIS</span>' : '') + '</div></div>' +
          '<div class="price">'+eur(v.cheapest.price)+'</div></div>');
      }
      document.getElementById('list').innerHTML = out.join('');
    } catch (e) { /* stillschweigend – im Stream soll nichts kaputt aussehen */ }
  }
  tick();
  setInterval(tick, 300000); // alle 5 Minuten
</script>
</body>
</html>`;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// ---------- Die App (HTML). Kein Template-Literal / kein ${} im Client-JS! ----------

const HTML = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Key Sniper</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --panel2:#1e2330; --border:#2a3040;
    --text:#e7ebf2; --muted:#8b93a7; --accent:#4ade80; --accent2:#38bdf8; --gold:#fbbf24; --danger:#f87171; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f4f6fb; --panel:#fff; --panel2:#f0f3f9; --border:#dde3ee;
      --text:#1a2233; --muted:#5b6474; --accent:#16a34a; --accent2:#0284c7; --gold:#d97706; --danger:#dc2626; } }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--text); line-height:1.4; }
  header { padding:22px 24px 14px; border-bottom:1px solid var(--border); }
  .hwrap { max-width:1100px; margin:0 auto; display:flex; flex-wrap:wrap; align-items:center; gap:12px; }
  h1 { font-size:22px; margin:0; letter-spacing:-.3px; }
  h1 .em { color:var(--accent); }
  .meta { color:var(--muted); font-size:13px; }
  .modetoggle { margin-left:auto; display:flex; align-items:center; gap:7px; font-size:14px; font-weight:600; color:var(--accent2); cursor:pointer; user-select:none; padding:7px 12px; border:1px solid var(--accent2); border-radius:9px; }
  .modetoggle input { width:16px; height:16px; accent-color:var(--accent2); }
  #refresh { padding:9px 16px; border:0; border-radius:9px; background:var(--accent); color:#04120a; font-weight:650; font-size:14px; cursor:pointer; }
  #refresh:disabled { opacity:.6; cursor:default; }
  .wrap { max-width:1100px; margin:0 auto; padding:0 24px; }
  .controls { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:16px; padding:18px; margin:18px 0; background:var(--panel); border:1px solid var(--border); border-radius:14px; }
  .ctrl label { display:block; font-size:12px; color:var(--muted); margin-bottom:6px; text-transform:uppercase; letter-spacing:.5px; }
  .ctrl .val { color:var(--accent); font-weight:600; }
  input[type=range] { width:100%; accent-color:var(--accent); }
  input[type=search], select { width:100%; padding:9px 11px; background:var(--panel2); border:1px solid var(--border); border-radius:9px; color:var(--text); font-size:14px; }
  .toggle { display:flex; align-items:center; gap:8px; font-size:14px; cursor:pointer; user-select:none; margin-top:22px; }
  .toggle input { width:17px; height:17px; accent-color:var(--accent); }
  .summary { color:var(--muted); font-size:13px; margin:0 0 12px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:14px; padding-bottom:60px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:14px; display:flex; gap:13px; transition:border-color .15s, transform .15s; }
  .card:hover { border-color:var(--accent); transform:translateY(-2px); }
  .box { width:74px; height:98px; flex:0 0 auto; border-radius:8px; object-fit:cover; background:var(--panel2); border:1px solid var(--border); }
  .body { flex:1; min-width:0; }
  .title { font-weight:650; font-size:15px; margin:0 0 6px; }
  .title a { color:inherit; text-decoration:none; }
  .title a:hover { color:var(--accent2); }
  .badges { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
  .badge { font-size:11px; padding:3px 8px; border-radius:999px; background:var(--panel2); border:1px solid var(--border); color:var(--muted); }
  .badge.low { color:var(--gold); border-color:var(--gold); }
  .badge.gap { color:var(--accent); border-color:var(--accent); font-weight:600; }
  .badge.steam { color:var(--accent2); border-color:var(--accent2); }
  .badge.good { color:var(--accent); border-color:var(--accent); }
  .badge.weak { color:var(--danger); border-color:var(--danger); }
  .prices { font-size:13px; color:var(--muted); }
  .prices b { color:var(--text); }
  .price-main { font-size:20px; font-weight:700; color:var(--accent); }
  .row { display:flex; justify-content:space-between; align-items:baseline; margin-top:6px; gap:8px; }
  .buy { display:inline-block; margin-top:10px; padding:7px 13px; border-radius:9px; background:var(--accent); color:#04120a; font-weight:650; font-size:13px; text-decoration:none; }
  .buy:hover { filter:brightness(1.08); }
  .ks { margin-top:9px; font-size:13px; }
  .ksbtn { padding:5px 10px; border:1px solid var(--border); border-radius:8px; background:var(--panel2); color:var(--muted); font-size:12px; cursor:pointer; }
  .ksbtn:hover { border-color:var(--accent2); color:var(--accent2); }
  .ksbtn:disabled { opacity:.6; cursor:default; }
  .ksinfo b { color:var(--gold); }
  .ksinfo a { color:var(--accent2); }
  .ksinfo.err { color:var(--danger); }
  .empty { text-align:center; padding:60px 20px; color:var(--muted); }
  .credit { max-width:1100px; margin:0 auto; padding:0 24px 40px; color:var(--muted); font-size:12px; }
  .credit a { color:var(--accent2); }
</style>
</head>
<body>
  <header><div class="hwrap">
    <h1>🎯 Key <span class="em">Sniper</span></h1>
    <span class="meta" id="meta"></span>
    <label class="modetoggle"><input type="checkbox" id="radar" /> 🔦 Keyshop-Radar</label>
    <button id="refresh">Aktualisieren</button>
  </div></header>
  <div class="wrap">
    <div class="controls">
      <div class="ctrl"><label>Mindest-Lücke: <span class="val" id="gapAbsVal">5 €</span></label><input type="range" id="gapAbs" min="0" max="30" step="0.5" value="5" /></div>
      <div class="ctrl"><label>Mindest-Lücke: <span class="val" id="gapPctVal">0 %</span></label><input type="range" id="gapPct" min="0" max="90" step="5" value="0" /></div>
      <div class="ctrl"><label>Max. Preis: <span class="val" id="maxPriceVal">egal</span></label><input type="range" id="maxPrice" min="0" max="70" step="1" value="0" /></div>
      <div class="ctrl"><label>Mindest-Bewertung: <span class="val" id="minRatingVal">egal</span></label><input type="range" id="minRating" min="0" max="95" step="5" value="0" /></div>
      <div class="ctrl"><label>Sortierung</label><select id="sort">
        <option value="gapAbs">Größte Lücke (€)</option>
        <option value="gapPct">Größte Lücke (%)</option>
        <option value="pop">Beliebtheit</option>
        <option value="rating">Beste Bewertung</option>
        <option value="price">Billigster Preis</option>
        <option value="title">Name (A–Z)</option>
      </select></div>
      <div class="ctrl"><label>Genre</label><select id="genre">
        <option value="">Alle Genres</option>
        <option value="action">Action</option>
        <option value="shooter">Shooter / FPS</option>
        <option value="rpg">RPG</option>
        <option value="rogue">Roguelike / -lite</option>
        <option value="strateg">Strategie</option>
        <option value="indie">Indie</option>
        <option value="adventure">Adventure</option>
        <option value="simulat">Simulation</option>
        <option value="horror">Horror</option>
        <option value="metroidvania">Metroidvania</option>
        <option value="souls">Souls-like</option>
        <option value="racing">Rennspiel</option>
        <option value="sport">Sport</option>
        <option value="puzzle">Puzzle</option>
        <option value="open world">Open World</option>
        <option value="co-op">Koop / Multiplayer</option>
      </select></div>
      <div class="ctrl"><label>Suche</label><input type="search" id="q" placeholder="Spielname ..." /></div>
      <div class="ctrl">
        <label class="toggle"><input type="checkbox" id="onlyRep" /> Nur seriöse Stores</label>
        <label class="toggle" style="margin-top:10px"><input type="checkbox" id="onlyLow" /> Nur Historical Low</label>
        <label class="toggle" style="margin-top:10px"><input type="checkbox" id="onlySteam" /> Nur Steam-Keys</label>
      </div>
    </div>
    <p class="summary" id="summary"></p>
    <div class="grid" id="grid"></div>
  </div>
  <footer class="credit">
    Marktpreise: <a href="https://isthereanydeal.com" target="_blank" rel="noopener">IsThereAnyDeal</a>
    · Keyshop-Preise: <a href="https://gg.deals" target="_blank" rel="noopener">GG.deals</a>
  </footer>

<script>
  var DATA = { deals: [], generatedAt: null, count: 0, country: 'DE' };
  function $(id){ return document.getElementById(id); }
  function eur(n){ return n==null ? '–' : n.toLocaleString('de-DE',{style:'currency',currency:'EUR'}); }
  function votes(n){ return n==null?'':(n>=1000000?(n/1000000).toFixed(1).replace('.',',')+' Mio.':(n>=1000?Math.round(n/1000)+'k':String(n))); }
  function ratingBadge(r, c){
    if (r == null) return '';
    var cls = r >= 80 ? 'badge good' : (r >= 60 ? 'badge' : 'badge weak');
    return '<span class="'+cls+'">👍 '+r+'%'+(c?' ('+votes(c)+')':'')+'</span>';
  }
  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

  // Viele Spiele haben kein "boxart", aber ein Banner – der Reihe nach durchprobieren
  var COVER_VARIANTS = ['boxart','banner600','banner400'];
  function coverFail(el){
    var cur = el.getAttribute('data-v') || 'boxart';
    var i = COVER_VARIANTS.indexOf(cur);
    if (i > -1 && i < COVER_VARIANTS.length - 1) {
      var nx = COVER_VARIANTS[i+1];
      el.setAttribute('data-v', nx);
      el.src = el.src.replace('/' + cur + '.jpg', '/' + nx + '.jpg');
    } else { el.style.visibility = 'hidden'; }
  }

  var ui = { gapAbs:$('gapAbs'), gapPct:$('gapPct'), maxPrice:$('maxPrice'), minRating:$('minRating'), sort:$('sort'), genre:$('genre'), q:$('q'), onlyRep:$('onlyRep'), onlyLow:$('onlyLow'), onlySteam:$('onlySteam') };
  var RADAR = { deals: [], generatedAt: null, loaded: false, loading: false };
  var GENRE_KW = { shooter:['shooter','fps'], 'co-op':['co-op','coop','multiplayer'] };
  function matchGenre(tags, cat){
    if (!cat) return true;
    if (!tags || !tags.length) return false;
    var hay = tags.join(' ').toLowerCase();
    var kws = GENRE_KW[cat] || [cat];
    for (var i=0;i<kws.length;i++) if (hay.indexOf(kws[i]) !== -1) return true;
    return false;
  }

  function setMeta(){
    if (DATA.generatedAt){
      var d = new Date(DATA.generatedAt);
      $('meta').textContent = 'Stand: ' + d.toLocaleTimeString('de-DE') + ' · ' + DATA.count + ' Kandidaten · Land ' + DATA.country;
    } else { $('meta').textContent = ''; }
  }

  async function loadRadar(fresh){
    if (RADAR.loading) return;
    RADAR.loading = true;
    $('grid').innerHTML = '<div class="empty" style="grid-column:1/-1">Scanne die beliebtesten Spiele auf Keyshop-Deals … (paar Sekunden)</div>';
    try {
      var res = await fetch('/api/radar' + (fresh ? '?fresh=1' : ''));
      var d = await res.json();
      if (d.error) throw new Error(d.error);
      RADAR = { deals: d.deals || [], generatedAt: d.generatedAt, loaded: true, loading: false };
    } catch (e) {
      RADAR.loading = false; RADAR.loaded = false;
      $('grid').innerHTML = '<div class="empty" style="grid-column:1/-1">Radar-Fehler: ' + esc(e.message) + '<br>Nochmal auf Aktualisieren tippen.</div>';
      return;
    }
    renderRadar();
  }

  function renderRadar(){
    if (!RADAR.loaded) { loadRadar(false); return; }
    if (RADAR.generatedAt){
      var d = new Date(RADAR.generatedAt);
      $('meta').textContent = 'Radar-Stand: ' + d.toLocaleTimeString('de-DE') + ' · ' + RADAR.deals.length + ' Keyshop-Deals';
    }
    $('summary').textContent = RADAR.deals.length + ' Keyshop-Deals (Grau-Markt) aus den aktuellen Angeboten – stärkster Rabatt zuerst';
    var out = [];
    for (var i=0;i<RADAR.deals.length;i++){
      var r = RADAR.deals[i];
      var over = (r.overLowPct != null && r.overLowPct <= 0)
        ? '<span class="badge low">🔥 Keyshop-Allzeittief</span>'
        : '<span class="' + (r.atKsLow ? 'badge low' : 'badge') + '">' + r.overLowPct + '% über Keyshop-Tief</span>';
      var sav = (r.savingPct != null && r.savingPct > 0)
        ? '<span class="badge gap">−'+r.savingPct+'% ggü. '+eur(r.retail)+'</span>' : '';
      var cov = 'https://cdn.cloudflare.steamstatic.com/steam/apps/'+r.appid+'/library_600x900.jpg';
      var box = '<img class="box" src="'+cov+'" alt="" loading="lazy" onerror="this.style.display=\\'none\\'">';
      out.push(
        '<div class="card">'+box+'<div class="body">'+
        '<p class="title">'+esc(r.title)+'</p>'+
        '<div class="badges">'+over+ratingBadge(r.rating,r.ratingCount)+sav+'</div>'+
        '<div class="row"><span class="price-main">'+eur(r.keyshop)+'</span><span class="prices">Keyshop (Grau-Markt)</span></div>'+
        '<div class="prices">Keyshop-Allzeittief: '+eur(r.ksLow)+(r.retail!=null?' · offiziell: '+eur(r.retail):'')+'</div>'+
        (r.url ? '<a class="buy" href="'+esc(r.url)+'" target="_blank" rel="noopener">auf GG.deals →</a>' : '')+
        '</div></div>'
      );
    }
    $('grid').innerHTML = out.join('') || '<div class="empty" style="grid-column:1/-1">Gerade keine Keyshop-Deals gefunden.</div>';
  }

  function render(){
    if ($('radar').checked) { renderRadar(); return; }
    var gapAbs = parseFloat(ui.gapAbs.value);
    var gapPct = parseInt(ui.gapPct.value, 10);
    var maxPrice = parseInt(ui.maxPrice.value, 10);
    var minRating = parseInt(ui.minRating.value, 10);
    var q = ui.q.value.trim().toLowerCase();
    var genre = ui.genre.value;
    var onlyRep = ui.onlyRep.checked;
    var onlyLow = ui.onlyLow.checked;
    var onlySteam = ui.onlySteam.checked;
    $('gapAbsVal').textContent = gapAbs + ' €';
    $('gapPctVal').textContent = gapPct + ' %';
    $('maxPriceVal').textContent = maxPrice === 0 ? 'egal' : maxPrice + ' €';
    $('minRatingVal').textContent = minRating === 0 ? 'egal' : 'ab ' + minRating + '%';

    // aktive Sicht je nach Häkchen: nur seriöse Stores oder alle
    var items = [];
    var deals = DATA.deals || [];
    for (var j=0;j<deals.length;j++){
      var v = onlyRep ? deals[j].rep : deals[j].all;
      if (!v) continue;
      items.push({ r: deals[j], v: v });
    }
    items = items.filter(function(x){
      if (x.v.gapAbs < gapAbs) return false;
      if (x.v.gapPct < gapPct) return false;
      if (maxPrice > 0 && x.v.cheapest.price > maxPrice) return false;
      if (onlyLow && !x.v.atHistLow) return false;
      if (onlySteam && !x.v.cheapest.steam) return false;
      if (minRating > 0 && x.r.rating != null && x.r.rating < minRating) return false;
      if (genre && !matchGenre(x.r.tags, genre)) return false;
      if (q && x.r.title.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    var s = ui.sort.value;
    items.sort(function(a,b){
      if (s==='gapAbs') return b.v.gapAbs - a.v.gapAbs;
      if (s==='gapPct') return b.v.gapPct - a.v.gapPct;
      if (s==='pop') return (b.r.pop||0) - (a.r.pop||0) || (b.v.gapAbs - a.v.gapAbs);
      if (s==='rating') return (b.r.rating||0) - (a.r.rating||0) || (b.r.ratingCount||0) - (a.r.ratingCount||0);
      if (s==='price') return a.v.cheapest.price - b.v.cheapest.price;
      if (s==='title') return a.r.title.localeCompare(b.r.title);
      return 0;
    });

    $('summary').textContent = items.length + ' von ' + deals.length + ' Deals passen zu deinen Filtern' + (onlyRep ? ' (nur seriöse Stores)' : '');
    var out = [];
    for (var i=0;i<items.length;i++){
      var r = items[i].r, v = items[i].v;
      var box = r.boxart ? '<img class="box" src="'+esc(r.boxart)+'" alt="" loading="lazy" data-v="boxart" onerror="coverFail(this)">' : '<div class="box"></div>';
      var low = v.atHistLow ? '<span class="badge low">📉 Historical Low</span>' : '';
      var cut = v.cheapest.cut ? '<span class="badge">−'+v.cheapest.cut+'%</span>' : '';
      var stm = v.cheapest.steam ? '<span class="badge steam">Steam</span>' : '';
      out.push(
        '<div class="card">'+box+'<div class="body">'+
        '<p class="title"><a href="'+esc(r.itadUrl)+'" target="_blank" rel="noopener">'+esc(r.title)+'</a></p>'+
        '<div class="badges"><span class="badge gap">'+v.gapAbs+' € / '+v.gapPct+'% Lücke</span>'+ratingBadge(r.rating,r.ratingCount)+low+stm+cut+'</div>'+
        '<div class="row"><span class="price-main">'+eur(v.cheapest.price)+'</span><span class="prices">bei <b>'+esc(v.cheapest.shop)+'</b></span></div>'+
        '<div class="prices">Zweitbilligster: '+eur(v.second.price)+' bei '+esc(v.second.shop)+(r.histLow!=null?' · ATL '+eur(r.histLow):'')+'</div>'+
        '<a class="buy" href="'+esc(v.cheapest.url)+'" target="_blank" rel="noopener">Zum Shop →</a>'+
        '<div class="ks" data-id="'+esc(r.id)+'"><button class="ksbtn" type="button">Keyshop-Preis (GG.deals)</button></div>'+
        '</div></div>'
      );
    }
    $('grid').innerHTML = out.join('') || '<div class="empty" style="grid-column:1/-1">Keine Deals passen zu diesen Filtern.</div>';
  }

  async function load(fresh){
    var btn = $('refresh');
    btn.disabled = true; btn.textContent = 'Lädt …';
    $('grid').innerHTML = '<div class="empty" style="grid-column:1/-1">Hole aktuelle Deals … (ein paar Sekunden)</div>';
    try {
      var res = await fetch('/api/deals' + (fresh ? '?fresh=1' : ''));
      var data = await res.json();
      if (data.error) throw new Error(data.error);
      DATA = data;
    } catch (e) {
      $('grid').innerHTML = '<div class="empty" style="grid-column:1/-1">Fehler: ' + esc(e.message) + '<br>Nochmal auf Aktualisieren tippen.</div>';
      btn.disabled = false; btn.textContent = 'Aktualisieren'; return;
    }
    btn.disabled = false; btn.textContent = 'Aktualisieren';
    setMeta(); render();
  }

  var keys = ['gapAbs','gapPct','maxPrice','minRating','sort','genre','q','onlyRep','onlyLow','onlySteam'];
  for (var k=0;k<keys.length;k++){ ui[keys[k]].addEventListener('input', render); ui[keys[k]].addEventListener('change', render); }
  $('refresh').addEventListener('click', function(){ if ($('radar').checked) loadRadar(true); else load(true); });

  // Radar-Modus umschalten: normale Filter ausblenden, Radar zeigen
  $('radar').addEventListener('change', function(){
    document.querySelector('.controls').style.display = this.checked ? 'none' : '';
    render();
  });

  // Keyshop-Preis auf Abruf (GG.deals) – ein Klick lädt genau dieses Spiel
  $('grid').addEventListener('click', async function(e){
    var btn = e.target && e.target.closest ? e.target.closest('.ksbtn') : null;
    if (!btn) return;
    var box = btn.parentNode;
    var id = box.getAttribute('data-id');
    btn.disabled = true; btn.textContent = 'Lädt …';
    try {
      var res = await fetch('/api/keyshop?id=' + encodeURIComponent(id));
      var d = await res.json();
      if (d.error) throw new Error(d.error);
      if (!d.available) { box.innerHTML = '<span class="ksinfo">Kein Keyshop-Preis (kein Steam-Spiel)</span>'; return; }
      var parts = [];
      if (d.keyshop != null) parts.push('Keyshop: <b>' + eur(d.keyshop) + '</b>');
      if (d.retail != null) parts.push('offiziell: ' + eur(d.retail));
      var link = d.url ? ' · <a href="' + esc(d.url) + '" target="_blank" rel="noopener">auf GG.deals →</a>' : '';
      box.innerHTML = '<span class="ksinfo">' + (parts.join(' · ') || 'kein Preis') + link + '</span>';
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Keyshop-Preis (GG.deals)';
      box.insertAdjacentHTML('beforeend', '<span class="ksinfo err"> — Fehler</span>');
    }
  });

  load(false);
</script>
</body>
</html>`;
