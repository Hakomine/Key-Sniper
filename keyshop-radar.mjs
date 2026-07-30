// Key Sniper – Keyshop-Radar (Batch)
// -----------------------------------
// Findet Spiele, die *nur* über Keyshops (Grau-Markt) gerade ein Top-Angebot
// sind – auch wenn ITAD sie nicht als Deal führt. Läuft getaktet (Rate-Limit
// GG.deals: 100 Spiele/Minute), nicht live.
//
// Ablauf: SteamSpy liefert beliebte Steam-Spiele (mit App-ID) -> GG.deals
//         Keyshop-Preise -> Filter auf echte Schnäppchen -> keyshop-deals.json
//
// Key:  Umgebungsvariable GGDEALS_API_KEY  oder Datei ggkey.txt
// Start: node keyshop-radar.mjs

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const REGION = 'de';
const PAGES = +(process.env.RADAR_PAGES || 1);     // SteamSpy-Seiten à 1000 Spiele
const LIMIT_GAMES = +(process.env.RADAR_MAX || 0); // 0 = kein Limit (für Tests)
const NEAR_KS_LOW_PCT = 15;   // "auf Keyshop-Tief", wenn <= ATL * (1 + 15%)
const MIN_SAVING_PCT = 15;    // mind. so viel günstiger als offizieller Preis

function loadKey() {
  if (process.env.GGDEALS_API_KEY) return process.env.GGDEALS_API_KEY.trim();
  const p = path.join(__dirname, 'ggkey.txt');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  return '';
}
const GG_KEY = loadKey();
if (!GG_KEY) {
  console.error('\n  Kein GG.deals-Key. In ggkey.txt eintragen oder GGDEALS_API_KEY setzen.\n');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) Universum: beliebte Steam-Spiele (App-IDs) von SteamSpy
async function steamUniverse() {
  const ids = [];
  for (let page = 0; page < PAGES; page++) {
    const res = await fetch(`https://steamspy.com/api.php?request=all&page=${page}`);
    if (!res.ok) throw new Error('SteamSpy HTTP ' + res.status);
    const data = await res.json();
    for (const [appid, g] of Object.entries(data)) {
      // freie Spiele überspringen (kein Kauf, kein Keyshop-Deal)
      const price = g && g.price != null ? +g.price : null;
      if (price === 0) continue;
      ids.push(appid);
    }
    if (page < PAGES - 1) await sleep(1200); // SteamSpy schonen
  }
  const uniq = [...new Set(ids)];
  return LIMIT_GAMES > 0 ? uniq.slice(0, LIMIT_GAMES) : uniq;
}

// 2) GG.deals Keyshop-Preise, Blöcke à 100, gedrosselt (Rate-Limit 100/Min)
async function keyshopPrices(appids) {
  const out = {};
  const BATCH = 100;
  const batches = Math.ceil(appids.length / BATCH);
  for (let i = 0; i < appids.length; i += BATCH) {
    const chunk = appids.slice(i, i + BATCH);
    const uurl =
      'https://api.gg.deals/v1/prices/by-steam-app-id/?ids=' +
      chunk.join(',') + '&region=' + REGION + '&key=' + encodeURIComponent(GG_KEY);
    const res = await fetch(uurl);
    if (res.status === 429) {
      console.log('  Rate-Limit, warte 65s ...');
      await sleep(65000);
      i -= BATCH; // Block wiederholen
      continue;
    }
    if (!res.ok) throw new Error('GG.deals HTTP ' + res.status);
    const j = await res.json();
    Object.assign(out, j.data || {});
    const done = Math.min(i + BATCH, appids.length);
    console.log(`  ... ${done}/${appids.length} Spiele bei GG.deals abgefragt`);
    // 100/Min einhalten: nach jedem Block ~61s warten (außer letztem)
    if (i + BATCH < appids.length) await sleep(61000);
  }
  return out;
}

const num = (x) => (x != null && +x > 0 ? +x : null);

async function main() {
  console.log(`\n  Keyshop-Radar – Region ${REGION.toUpperCase()}`);
  console.log('  Hole Spiele-Universum (SteamSpy) ...');
  const appids = await steamUniverse();
  console.log(`  ${appids.length} kaufbare Spiele im Universum.`);

  const mins = Math.ceil(appids.length / 100);
  console.log(`  Frage GG.deals ab (gedrosselt, ~${mins} Min) ...`);
  const prices = await keyshopPrices(appids);

  const deals = [];
  for (const [appid, d] of Object.entries(prices)) {
    if (!d || !d.prices) continue;
    const ks = num(d.prices.currentKeyshops);
    const retail = num(d.prices.currentRetail);
    const ksLow = num(d.prices.historicalKeyshops);
    if (!ks) continue;

    const atKsLow = ksLow != null && ks <= ksLow * (1 + NEAR_KS_LOW_PCT / 100);
    const savingAbs = retail != null ? +(retail - ks).toFixed(2) : null;
    const savingPct = retail != null ? Math.round((1 - ks / retail) * 100) : null;
    const goodVsRetail = savingPct != null && savingPct >= MIN_SAVING_PCT;

    // Interessant, wenn Keyshop nahe Allzeittief ODER klar billiger als offiziell
    if (!atKsLow && !goodVsRetail) continue;

    deals.push({
      appid: +appid,
      title: d.title,
      keyshop: ks,
      retail,
      ksLow,
      savingAbs,
      savingPct,
      atKsLow,
      url: d.url || null,
    });
  }

  // Sortierung: größte Ersparnis ggü. offiziellem Preis zuerst
  deals.sort((a, b) => (b.savingAbs || 0) - (a.savingAbs || 0));

  const payload = { generatedAt: new Date().toISOString(), region: REGION, count: deals.length, deals };
  fs.writeFileSync(path.join(__dirname, 'keyshop-deals.json'), JSON.stringify(payload));

  console.log(`\n  Fertig: ${deals.length} Keyshop-Deals -> keyshop-deals.json`);
  for (const r of deals.slice(0, 6)) {
    console.log(
      `   • ${r.title}: Keyshop ${r.keyshop}€${r.retail ? ` vs offiziell ${r.retail}€ (−${r.savingPct}%)` : ''}${r.atKsLow ? '  [Keyshop-Tief]' : ''}`
    );
  }
  console.log('');
}

main().catch((e) => {
  console.error('\n  Fehler:', e.message, '\n');
  process.exit(1);
});
