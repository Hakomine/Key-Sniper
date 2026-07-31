---
tags: [projekt, tool]
status: aktiv
erstellt: 2026-07-30
aktualisiert: 2026-07-31
---

# Key Sniper

Eigene App, die den Spiele-Markt nach Key-Schnäppchen absucht und bei krassen
Angeboten **von allein per Discord Bescheid gibt**. Ausgangspunkt war ein Fund auf
GG.deals: ein Key für 3 €, der nächstbillige Anbieter bei 10 € – also 7 € Lücke.
Genau dieses Muster sucht die App automatisch.

Getrennt vom [[Kontrollzentrum]] – ist ein eigenes Tool.

## Wo es läuft
- **Cloud-App (Hauptversion)**: Cloudflare Worker unter `key-sniper.hakanking0110.workers.dev`.
  Holt die Preise live beim Öffnen, läuft auch am Handy, Keys liegen als Secrets.
- **Desktop-App**: `run.bat` → Icon auf dem Desktop. Sammelt lokal und öffnet `Key Sniper.html`.
- **GitHub**: hält die Genre-Datenbank aktuell (Job läuft stündlich) und hostet sie für den Worker.

## Snipe-Logik
- **Preislücke**: billigster vs. zweitbilligster Shop (3 € vs 10 € = 7 € Lücke).
  In der App per Schieberegler einstellbar.
- **Historical Low**: markiert, wenn der Preis auf/nahe dem Allzeittief liegt.
- **Store-Umschalter**: Standard alle Stores, Häkchen „Nur seriöse Stores" rechnet die
  Lücke neu – nur mit Shops, die Support und Käuferschutz haben.
- **Filter**: Nur Steam-Keys, Nur Historical Low, Genre, Max-Preis, Suche.
- **Sortierung**: Lücke (€/%), Beliebtheit, Preis, Name.

## Discord-Alarm (das Herzstück)
Ein Cron im Worker läuft **alle 10 Minuten** und meldet Treffer per Discord-Webhook
(mit Cover, Preis, Shop und direktem Link).

- Geprüft werden die **200 beliebtesten Spiele** – bewusst *nicht* die höchsten Rabatte.
- Kriterium: **Historical Low** oder **Lücke ≥ 7 €** (Konstanten `ALARM_MIN_GAP`,
  `ALARM_HISTLOW_GAP` oben in `worker.js`).
- **Kein Spam**: Gemeldetes wird 14 Tage gemerkt (KV-Speicher `SNIPER_KV`). Erneut
  gemeldet wird erst, wenn der Preis nochmal ≥10 % fällt.

## Keyshop-Radar (Grau-Markt)
Eigener Schalter in der App. Findet Spiele, die **nur über Keyshops** gerade top sind –
also welche, die die normale Liste gar nicht kennt. Datenquelle: GG.deals-API.
- Verglichen wird **Keyshop gegen Keyshop-Allzeittief** (nicht gegen den offiziellen Preis).
- Der Cron scannt rotierend je 100 Spiele → **500 Spiele** Abdeckung.

## Einrichtung
Keys stehen **nicht** in diesen Dateien: lokal in `key.txt` / `ggkey.txt` (beide per
`.gitignore` gesperrt), in der Cloud als Secrets.

| Wo | Name | Wofür |
|---|---|---|
| Cloudflare Secret | `ITAD_API_KEY` | Marktpreise (IsThereAnyDeal) |
| Cloudflare Secret | `GGDEALS_API_KEY` | Keyshop-Preise (GG.deals) |
| Cloudflare Secret | `DISCORD_WEBHOOK` | Alarm-Nachrichten |
| Cloudflare Variable | `GENRES_URL` | raw-Link zu `genres-db.json` |
| Cloudflare Binding | `SNIPER_KV` | merkt sich Gemeldetes |
| Cloudflare Trigger | `*/10 * * * *` | Cron-Takt |
| GitHub Secret | `ITAD_API_KEY` | Genre-Job |

## Dateien
- `worker.js` – die Cloud-App: Oberfläche, APIs, Cron/Alarm. **Die Hauptdatei.**
- `collector.mjs` + `Key Sniper.html` + `run.bat` – die lokale Desktop-Variante
- `config.json` – Land, Shop-Listen (seriös/Grauzone), Schwellen
- `genres-db.json` – Genre-Datenbank (füttert den Genre-Filter)
- `keyshop-radar.mjs` – lokaler Batch-Radar (Vorläufer der Worker-Variante)

## Erkenntnisse (nicht nochmal reinlaufen)
- **G2A, Kinguin, Eneba gehen nicht.** ITAD trackt sie nicht, GG.deals gibt sie über
  die API nicht raus. Was da ist, ist drin.
- **Nach höchstem Rabatt sortieren ist wertlos** für den Alarm: liefert fast nur
  Nischen-Ramsch mit absurdem Listenpreis (getestet: 64 Treffer, 0 davon relevant).
  Deshalb ist die Alarm-Basis die Beliebtheitsliste.
- **Genres gibt es nirgends im Batch** – jedes Spiel muss einzeln abgefragt werden.
  Darum die persistente `genres-db.json`, die nur neue Spiele nachlädt.
- **Cloudflare-Free gibt Cron-Läufen nur 10 ms CPU.** Deshalb ist der Alarm-Pfad
  bewusst schlank (2 API-Calls). Bei `Exceeded CPU limit` in den Logs: auf GitHub
  Actions ausweichen.

## Notizen
- Region steht auf DE/EUR (`COUNTRY` in `worker.js`, `country` in `config.json`).
- Das Repo ist **öffentlich** auf GitHub – hier also nichts Privates reinschreiben.
- Keys aus seriösen Shops laufen nicht ab und können jederzeit eingelöst werden.
