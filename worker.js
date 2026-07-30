// Key Sniper – Cloudflare Worker (eine Datei, alles drin)
// -------------------------------------------------------
// Routen:
//   /            -> die App (HTML)
//   /api/deals   -> holt live die Deals von IsThereAnyDeal, rechnet Preislücken
//                   (?fresh=1 umgeht den Cache)
//   /go?u=...    -> löst einen itad.link-Redirect auf und leitet direkt zum Shop
//
// Einrichtung im Cloudflare-Dashboard:
//   1) Worker anlegen, diesen Code einfügen, Deploy.
//   2) Settings -> Variables and Secrets -> Secret hinzufügen:
//        Name: ITAD_API_KEY   Wert: dein ITAD-Key
//   3) Worker-URL öffnen. Fertig.

const COUNTRY = 'DE';
const MAX_GAMES = 600;
const HIST_TOL_PCT = 5;   // "auf Historical Low", wenn <= ATL * (1 + 5%)
const CACHE_SECONDS = 120; // Serverseitiger Cache fürs Live-Holen

const TRUSTED = [
  'steam', 'fanatical', 'humble', 'greenmangaming', 'green man gaming',
  'gog', 'gamesplanet', 'epic', 'microsoft', 'wingamestore', '2game',
  'indiegala', 'voidu', 'noctre', 'gamebillet', 'ubisoft', 'ea app',
  'battle.net', 'blizzard',
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/deals') return handleDeals(request, env, ctx);
    if (url.pathname === '/go') return handleGo(url);
    return new Response(HTML, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
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
    data = await buildDeals(key);
  } catch (e) {
    return json({ error: 'ITAD-Abruf fehlgeschlagen: ' + e.message }, 502);
  }

  const res = json(data);
  res.headers.set('Cache-Control', 'public, max-age=' + CACHE_SECONDS);
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function buildDeals(key) {
  const LIMIT = 200;

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

  // 4) Analyse
  const results = [];
  for (const id of ids) {
    const g = prices[id];
    if (!g) continue;
    const c = meta.get(id);

    const byShop = new Map();
    for (const d of g.deals || []) {
      if (!isTrusted(d.shop && d.shop.name) || !d.price || d.price.amount == null) continue;
      const cur = byShop.get(d.shop.name);
      if (!cur || d.price.amount < cur.price.amount) byShop.set(d.shop.name, d);
    }
    const sorted = [...byShop.values()].sort((a, b) => a.price.amount - b.price.amount);
    if (sorted.length < 2) continue;

    const p0 = sorted[0];
    const p1 = sorted[1];
    const gapAbs = +(p1.price.amount - p0.price.amount).toFixed(2);
    const gapPct = Math.round((1 - p0.price.amount / p1.price.amount) * 100);
    const histLow = g.historyLow && g.historyLow.all ? g.historyLow.all.amount : null;
    const atHistLow = histLow != null ? p0.price.amount <= histLow * (1 + HIST_TOL_PCT / 100) : false;

    results.push({
      title: c.title,
      slug: c.slug,
      boxart: c.boxart || null,
      cheapest: {
        shop: p0.shop.name,
        price: p0.price.amount,
        cut: p0.cut,
        url: '/go?u=' + encodeURIComponent(p0.url),
      },
      second: { shop: p1.shop.name, price: p1.price.amount },
      regular: (p0.regular && p0.regular.amount) ?? c.regular ?? null,
      gapAbs,
      gapPct,
      histLow,
      atHistLow,
      pop: popMap.get(id) || 0,
      itadUrl: 'https://isthereanydeal.com/game/' + c.slug + '/info/',
    });
  }

  results.sort((a, b) => b.gapAbs - a.gapAbs);
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

function isTrusted(name) {
  const n = (name || '').toLowerCase();
  return TRUSTED.some((w) => n.includes(w));
}

// ---------- /go: itad.link -> direkter Shop-Link ----------

async function handleGo(url) {
  let target = url.searchParams.get('u');
  if (!target) return new Response('missing u', { status: 400 });
  try {
    let cur = target;
    for (let i = 0; i < 5; i++) {
      const r = await fetch(cur, { method: 'GET', redirect: 'manual' });
      const loc = r.headers.get('location');
      if ([301, 302, 303, 307, 308].includes(r.status) && loc) {
        cur = new URL(loc, cur).href;
        if (!/itad\.link|isthereanydeal\.com/.test(cur)) { target = cur; break; }
      } else { target = cur; break; }
    }
  } catch (e) {
    // Fallback: Original-Link
  }
  return Response.redirect(target, 302);
}

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
    --text:#e7ebf2; --muted:#8b93a7; --accent:#4ade80; --accent2:#38bdf8; --gold:#fbbf24; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f4f6fb; --panel:#fff; --panel2:#f0f3f9; --border:#dde3ee;
      --text:#1a2233; --muted:#5b6474; --accent:#16a34a; --accent2:#0284c7; --gold:#d97706; } }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--text); line-height:1.4; }
  header { padding:22px 24px 14px; border-bottom:1px solid var(--border); }
  .hwrap { max-width:1100px; margin:0 auto; display:flex; flex-wrap:wrap; align-items:center; gap:12px; }
  h1 { font-size:22px; margin:0; letter-spacing:-.3px; }
  h1 .em { color:var(--accent); }
  .meta { color:var(--muted); font-size:13px; }
  #refresh { margin-left:auto; padding:9px 16px; border:0; border-radius:9px; background:var(--accent); color:#04120a; font-weight:650; font-size:14px; cursor:pointer; }
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
  .prices { font-size:13px; color:var(--muted); }
  .prices b { color:var(--text); }
  .price-main { font-size:20px; font-weight:700; color:var(--accent); }
  .row { display:flex; justify-content:space-between; align-items:baseline; margin-top:6px; gap:8px; }
  .buy { display:inline-block; margin-top:10px; padding:7px 13px; border-radius:9px; background:var(--accent); color:#04120a; font-weight:650; font-size:13px; text-decoration:none; }
  .buy:hover { filter:brightness(1.08); }
  .empty { text-align:center; padding:60px 20px; color:var(--muted); }
</style>
</head>
<body>
  <header><div class="hwrap">
    <h1>🎯 Key <span class="em">Sniper</span></h1>
    <span class="meta" id="meta"></span>
    <button id="refresh">Aktualisieren</button>
  </div></header>
  <div class="wrap">
    <div class="controls">
      <div class="ctrl"><label>Mindest-Lücke: <span class="val" id="gapAbsVal">5 €</span></label><input type="range" id="gapAbs" min="0" max="30" step="0.5" value="5" /></div>
      <div class="ctrl"><label>Mindest-Lücke: <span class="val" id="gapPctVal">0 %</span></label><input type="range" id="gapPct" min="0" max="90" step="5" value="0" /></div>
      <div class="ctrl"><label>Max. Preis: <span class="val" id="maxPriceVal">egal</span></label><input type="range" id="maxPrice" min="0" max="70" step="1" value="0" /></div>
      <div class="ctrl"><label>Sortierung</label><select id="sort">
        <option value="gapAbs">Größte Lücke (€)</option>
        <option value="gapPct">Größte Lücke (%)</option>
        <option value="pop">Beliebtheit</option>
        <option value="price">Billigster Preis</option>
        <option value="title">Name (A–Z)</option>
      </select></div>
      <div class="ctrl"><label>Suche</label><input type="search" id="q" placeholder="Spielname ..." /></div>
      <div class="ctrl"><label class="toggle"><input type="checkbox" id="onlyLow" /> Nur Historical Low</label></div>
    </div>
    <p class="summary" id="summary"></p>
    <div class="grid" id="grid"></div>
  </div>
<script>
  var DATA = { deals: [], generatedAt: null, count: 0, country: 'DE' };
  function $(id){ return document.getElementById(id); }
  function eur(n){ return n==null ? '–' : n.toLocaleString('de-DE',{style:'currency',currency:'EUR'}); }
  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

  var ui = { gapAbs:$('gapAbs'), gapPct:$('gapPct'), maxPrice:$('maxPrice'), sort:$('sort'), q:$('q'), onlyLow:$('onlyLow') };

  function setMeta(){
    if (DATA.generatedAt){
      var d = new Date(DATA.generatedAt);
      $('meta').textContent = 'Stand: ' + d.toLocaleTimeString('de-DE') + ' · ' + DATA.count + ' Kandidaten · Land ' + DATA.country;
    } else { $('meta').textContent = ''; }
  }

  function render(){
    var gapAbs = parseFloat(ui.gapAbs.value);
    var gapPct = parseInt(ui.gapPct.value, 10);
    var maxPrice = parseInt(ui.maxPrice.value, 10);
    var q = ui.q.value.trim().toLowerCase();
    var onlyLow = ui.onlyLow.checked;
    $('gapAbsVal').textContent = gapAbs + ' €';
    $('gapPctVal').textContent = gapPct + ' %';
    $('maxPriceVal').textContent = maxPrice === 0 ? 'egal' : maxPrice + ' €';

    var list = (DATA.deals || []).filter(function(r){
      if (r.gapAbs < gapAbs) return false;
      if (r.gapPct < gapPct) return false;
      if (maxPrice > 0 && r.cheapest.price > maxPrice) return false;
      if (onlyLow && !r.atHistLow) return false;
      if (q && r.title.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    var s = ui.sort.value;
    list.sort(function(a,b){
      if (s==='gapAbs') return b.gapAbs - a.gapAbs;
      if (s==='gapPct') return b.gapPct - a.gapPct;
      if (s==='pop') return (b.pop||0) - (a.pop||0) || (b.gapAbs - a.gapAbs);
      if (s==='price') return a.cheapest.price - b.cheapest.price;
      if (s==='title') return a.title.localeCompare(b.title);
      return 0;
    });

    $('summary').textContent = list.length + ' von ' + (DATA.deals ? DATA.deals.length : 0) + ' Deals passen zu deinen Filtern';
    var out = [];
    for (var i=0;i<list.length;i++){
      var r = list[i];
      var box = r.boxart ? '<img class="box" src="'+esc(r.boxart)+'" alt="" loading="lazy" onerror="this.style.display=\\'none\\'">' : '<div class="box"></div>';
      var low = r.atHistLow ? '<span class="badge low">📉 Historical Low</span>' : '';
      var cut = r.cheapest.cut ? '<span class="badge">−'+r.cheapest.cut+'%</span>' : '';
      out.push(
        '<div class="card">'+box+'<div class="body">'+
        '<p class="title"><a href="'+esc(r.itadUrl)+'" target="_blank" rel="noopener">'+esc(r.title)+'</a></p>'+
        '<div class="badges"><span class="badge gap">'+r.gapAbs+' € / '+r.gapPct+'% Lücke</span>'+low+cut+'</div>'+
        '<div class="row"><span class="price-main">'+eur(r.cheapest.price)+'</span><span class="prices">bei <b>'+esc(r.cheapest.shop)+'</b></span></div>'+
        '<div class="prices">Zweitbilligster: '+eur(r.second.price)+' bei '+esc(r.second.shop)+(r.histLow!=null?' · ATL '+eur(r.histLow):'')+'</div>'+
        '<a class="buy" href="'+esc(r.cheapest.url)+'" target="_blank" rel="noopener">Zum Shop →</a>'+
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

  var keys = ['gapAbs','gapPct','maxPrice','sort','q','onlyLow'];
  for (var k=0;k<keys.length;k++){ ui[keys[k]].addEventListener('input', render); ui[keys[k]].addEventListener('change', render); }
  $('refresh').addEventListener('click', function(){ load(true); });
  load(false);
</script>
</body>
</html>`;
