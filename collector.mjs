// Key Sniper – Collector
// Holt marktweite Deals von IsThereAnyDeal, findet Ausreisser-Preise bei
// seriösen Shops und schreibt die Kandidaten nach deals.js.
//
// Start:  node collector.mjs   (oder run.bat doppelklicken)

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const BASE = 'https://api.isthereanydeal.com';
const COUNTRY = CFG.country || 'DE';

// Key-Quellen in dieser Reihenfolge:
// 1) Umgebungsvariable ITAD_API_KEY (GitHub-Secret in der Cloud)
// 2) key.txt neben diesem Script (lokal, per .gitignore geschützt)
// 3) config.json "apiKey" (Fallback)
function loadKey() {
  if (process.env.ITAD_API_KEY) return process.env.ITAD_API_KEY.trim();
  try {
    const p = path.join(__dirname, 'key.txt');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  } catch {}
  return (CFG.apiKey || '').trim();
}
const KEY = loadKey();

if (!KEY || KEY.startsWith('HIER')) {
  console.error('\n  Kein API-Key gefunden.');
  console.error('  Hol dir einen kostenlosen Key auf https://isthereanydeal.com/apps/');
  console.error('  Lokal: in die Datei key.txt eintragen. Cloud: als Secret ITAD_API_KEY.\n');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, { method = 'GET', query = {}, body } = {}) {
  const u = new URL(BASE + pathname);
  u.searchParams.set('key', KEY);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(u, opt);
  if (res.status === 429) {
    const wait = (+(res.headers.get('retry-after') || '30') + 1) * 1000;
    console.log(`  Rate-Limit erreicht, warte ${wait / 1000}s ...`);
    await sleep(wait);
    return api(pathname, { method, query, body });
  }
  if (!res.ok) {
    throw new Error(`${method} ${pathname} -> HTTP ${res.status}\n${await res.text()}`);
  }
  return res.json();
}

const isTrusted = (name) => {
  const n = (name || '').toLowerCase();
  return CFG.trustedShops.some((w) => n.includes(w.toLowerCase()));
};

// Löst einen itad.link-Redirect zur echten Store-URL auf.
// Bei Fehler wird der Original-Link zurückgegeben (Button funktioniert immer).
async function resolveStoreUrl(u) {
  let cur = u;
  for (let hops = 0; hops < 5; hops++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    let res;
    try {
      res = await fetch(cur, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
    } catch {
      clearTimeout(t);
      return u;
    }
    clearTimeout(t);
    const loc = res.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
      try {
        cur = new URL(loc, cur).href;
      } catch {
        return u;
      }
      // Sobald der Redirect den ITAD-Bereich verlässt, sind wir beim Shop.
      if (!/itad\.link|isthereanydeal\.com/.test(cur)) return cur;
    } else {
      return cur;
    }
  }
  return cur;
}

// Löst viele Links parallel auf (begrenzte Gleichzeitigkeit).
async function resolveAll(items, concurrency = 12) {
  let i = 0;
  let done = 0;
  const worker = async () => {
    while (i < items.length) {
      const r = items[i++];
      r.cheapest.url = await resolveStoreUrl(r.cheapest.url);
      done++;
      if (done % 50 === 0) console.log(`  ... ${done}/${items.length} Shop-Links aufgelöst`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

// 1) Marktweite Deals als Kandidaten (jedes Spiel einmal)
async function collectCandidates() {
  const max = CFG.maxGames || 600;
  const limit = 200;
  let offset = 0;
  const items = [];
  while (items.length < max) {
    const page = await api('/deals/v2', {
      query: { country: COUNTRY, offset, limit, sort: CFG.dealsSort || '-cut' },
    });
    const list = Array.isArray(page) ? page : page.list || [];
    if (list.length === 0) break;
    items.push(...list);
    const hasMore = Array.isArray(page) ? list.length === limit : page.hasMore ?? list.length === limit;
    if (!hasMore) break;
    offset += limit;
    await sleep(200);
  }
  return items.slice(0, max);
}

// 2) Alle Shop-Preise + Historical Low pro Spiel (Batches à 200)
async function pricesFor(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const data = await api('/games/prices/v3', {
      method: 'POST',
      query: { country: COUNTRY, capacity: 0 },
      body: batch,
    });
    for (const g of data) out[g.id] = g;
    await sleep(250);
  }
  return out;
}

async function main() {
  console.log(`\n  Key Sniper – Land: ${COUNTRY}`);
  console.log('  Sammle marktweite Deals ...');
  const candidates = await collectCandidates();
  console.log(`  ${candidates.length} Deal-Kandidaten geladen.`);

  console.log('  Hole Shop-Preise + Historical Low ...');
  const prices = await pricesFor(candidates.map((c) => c.id));

  const tol = CFG.histLowTolerancePct ?? 5;
  const results = [];

  for (const c of candidates) {
    const g = prices[c.id];
    if (!g) continue;

    // Nur seriöse Shops, pro Shop den billigsten Preis behalten
    const byShop = new Map();
    for (const d of g.deals || []) {
      if (!isTrusted(d.shop?.name) || d.price?.amount == null) continue;
      const cur = byShop.get(d.shop.name);
      if (!cur || d.price.amount < cur.price.amount) byShop.set(d.shop.name, d);
    }
    const sorted = [...byShop.values()].sort((a, b) => a.price.amount - b.price.amount);
    if (sorted.length < 2) continue; // ohne Zweitbilligsten gibt es keine Lücke

    const p0 = sorted[0];
    const p1 = sorted[1];
    const gapAbs = +(p1.price.amount - p0.price.amount).toFixed(2);
    const gapPct = Math.round((1 - p0.price.amount / p1.price.amount) * 100);
    const histLow = g.historyLow?.all?.amount ?? null;
    const atHistLow = histLow != null ? p0.price.amount <= histLow * (1 + tol / 100) : false;

    results.push({
      title: c.title,
      slug: c.slug,
      type: c.type,
      boxart: c.assets?.boxart || c.assets?.banner300 || null,
      cheapest: { shop: p0.shop.name, price: p0.price.amount, cut: p0.cut, url: p0.url },
      second: { shop: p1.shop.name, price: p1.price.amount },
      regular: p0.regular?.amount ?? c.regular?.amount ?? null,
      currency: p0.price.currency || 'EUR',
      gapAbs,
      gapPct,
      histLow,
      atHistLow,
      trustedCount: sorted.length,
      itadUrl: `https://isthereanydeal.com/game/${c.slug}/info/`,
    });
  }

  console.log(`  Löse direkte Shop-Links auf (${results.length}) ...`);
  await resolveAll(results);

  results.sort((a, b) => b.gapAbs - a.gapAbs);

  const payload = {
    generatedAt: new Date().toISOString(),
    country: COUNTRY,
    count: results.length,
    trustedShops: CFG.trustedShops,
    deals: results,
  };
  fs.writeFileSync(
    path.join(__dirname, 'deals.js'),
    'window.SNIPER_DATA = ' + JSON.stringify(payload) + ';\n'
  );

  console.log(`\n  Fertig: ${results.length} Schnäppchen-Kandidaten -> deals.js`);
  const top = results.slice(0, 5);
  if (top.length) {
    console.log('  Top-Lücken:');
    for (const r of top) {
      console.log(
        `   • ${r.title}: ${r.cheapest.price}€ (${r.cheapest.shop}) vs ${r.second.price}€  = ${r.gapAbs}€ Lücke${r.atHistLow ? '  [Historical Low]' : ''}`
      );
    }
  }
  console.log('');
}

main().catch((e) => {
  console.error('\n  Fehler:', e.message, '\n');
  process.exit(1);
});
