---
tags: [projekt, tool]
status: aktiv
erstellt: 2026-07-30
---

# Key Sniper

Eigenständige App, die den ganzen Spiele-Markt nach Key-Schnäppchen absucht: Deals, bei denen der billigste seriöse Shop deutlich günstiger ist als der zweitbilligste (Preislücke), idealerweise auf dem Historical Low. Datenquelle: [IsThereAnyDeal-API](https://docs.isthereanydeal.com/).

Getrennt vom [[Kontrollzentrum]] – ist ein eigenes Tool.

## Snipe-Logik
- **Ganzer Markt**: nimmt alle aktuellen Deals (nicht nur eine Wishlist).
- **Nur seriöse Shops**: Steam, Fanatical, Humble, GreenManGaming, GOG, Gamesplanet usw. Kein Grau-Markt (kein G2A). Liste in `config.json` unter `trustedShops`.
- **Preislücke**: billigster vs. zweitbilligster Preis (€3 vs €10 = 7 € Lücke). Flexibel per Schieberegler in der App.
- **Historical Low**: Kandidaten werden markiert, wenn der Preis auf/nahe dem All-Time-Low liegt (Toleranz in `config.json`).

## Einrichtung (einmalig)
1. Kostenlosen API-Key holen: https://isthereanydeal.com/apps/ → App registrieren → Key kopieren.
2. In `config.json` bei `"apiKey"` eintragen.

## Benutzung
- **`run.bat`** doppelklicken → sammelt frische Deals und öffnet die App.
- Oder Sammler allein: `node collector.mjs`. App: `Key Sniper.html` öffnen.
- In der App: Preislücke, Max-Preis und "Nur Historical Low" live einstellen.

## Automatisch im Hintergrund (optional)
Windows Task Scheduler lässt den Sammler z.B. täglich um 9 Uhr laufen, dann sind beim Öffnen der App immer frische Ergebnisse drin. Command siehe Chat / unten in den Notizen.

## Dateien
- `collector.mjs` – holt & filtert die Deals, schreibt `deals.js`
- `Key Sniper.html` – die App (liest `deals.js`, filtert live)
- `config.json` – API-Key, Land, Shop-Liste, Schwellen
- `deals.js` – die gesammelten Ergebnisse (wird überschrieben)
- `run.bat` – sammeln + App öffnen

## Notizen
- Land steht auf DE (EUR). Für andere Region `country` in config.json ändern.
- `maxGames` steuert, wie viele Deals durchsucht werden (Default 600). Höher = gründlicher, mehr API-Anfragen.
