# Key Sniper

Findet Game-Key-Schnäppchen im ganzen Markt: Deals, bei denen der billigste
seriöse Shop deutlich günstiger ist als der zweitbilligste – idealerweise auf
dem Historical Low. Datenquelle: [IsThereAnyDeal-API](https://docs.isthereanydeal.com/).

## Lokal benutzen
1. API-Key holen: <https://isthereanydeal.com/apps/>
2. Key in die Datei `key.txt` schreiben (eine Zeile, sonst nichts). Wird **nie** hochgeladen.
3. `run.bat` doppelklicken (oder `node collector.mjs`) → sammelt und öffnet die App.

## Online hosten (GitHub Pages, kostenlos)
Sammelt täglich in der Cloud, unabhängig vom eigenen PC. Seite von überall erreichbar.

1. Auf GitHub ein neues Repo anlegen (z.B. `key-sniper`).
2. Diesen Ordner hochpushen (siehe unten).
3. Im Repo: **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `ITAD_API_KEY`
   - Wert: dein Key
4. Im Repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
5. Der Workflow läuft bei jedem Push und täglich um 07:00 UTC. Die Seite erscheint
   unter `https://DEINNAME.github.io/key-sniper/`.

### Erstmals pushen
```bash
git remote add origin https://github.com/DEINNAME/key-sniper.git
git branch -M main
git push -u origin main
```

## Live hosten (Cloudflare Workers, kostenlos) — empfohlen
Holt die Deals **live beim Öffnen/Aktualisieren**, Key bleibt geheim, direkte Shop-Links.

1. Kostenlosen Account: <https://dash.cloudflare.com>
2. **Workers & Pages → Create → Workers → Create Worker** → Name `key-sniper` → Deploy.
3. **Edit code** → gesamten Inhalt von `worker.js` einfügen → **Deploy**.
4. **Settings → Variables and Secrets → Add** → Type *Secret*:
   - Name: `ITAD_API_KEY`, Wert: dein ITAD-Key → speichern → **Deploy**.
   - Für Keyshop-/Grau-Markt-Preise zusätzlich: Name `GGDEALS_API_KEY`, Wert: dein
     GG.deals-Key (kostenlos in den GG.deals-Einstellungen). Optional – ohne diesen
     Secret funktioniert die App, nur der „Keyshop-Preis"-Knopf meldet dann einen Fehler.
5. Worker-URL öffnen: `https://key-sniper.DEIN-SUBDOMAIN.workers.dev`

Alternativ per CLI: `npm i -g wrangler`, dann `wrangler deploy` und `wrangler secret put ITAD_API_KEY`.

## Deal-Alarm per Discord (Cron)
Meldet krasse Deals von allein – auch wenn die Seite zu ist.

1. **Discord-Webhook**: Server → Kanal bearbeiten → Integrationen → Webhooks →
   „Neuer Webhook" → URL kopieren.
2. Cloudflare → Settings → Variables and Secrets → **Secret** `DISCORD_WEBHOOK` = diese URL.
3. **KV** (fürs Dedup, sonst kämen dieselben Deals wiederholt):
   Storage & Databases → KV → Namespace anlegen → im Worker unter Settings → Bindings
   als **`SNIPER_KV`** binden.
4. Settings → Trigger Events → **Cron Trigger**: `*/10 * * * *`

Was der Cron pro Lauf macht:
- **Alarm**: prüft die 200 *beliebtesten* Spiele auf Historical Low bzw. große
  Preislücke (bewusst nicht die höchsten Rabatte – das wären fast nur Nischentitel
  mit absurdem Listenpreis). Schwellen: `ALARM_MIN_GAP`, `ALARM_HISTLOW_GAP`.
- **Radar-Rotation**: scannt einen 100er-Block bei GG.deals, nach 5 Läufen sind
  500 Spiele abgedeckt. `/api/radar` zeigt dann die gesammelten Blöcke.

Hinweis: Der **allererste** Lauf meldet einmalig viele Deals (alles ist „neu"),
danach kommen nur noch echte Neuigkeiten. Ein bereits gemeldeter Deal wird erst
wieder gemeldet, wenn der Preis nochmal ≥10 % fällt.

## Wächter (merkt, wenn nichts mehr läuft)
Ohne ihn ist Stille mehrdeutig: „keine Deals" oder „alles kaputt"?

- Der Cron schreibt seinen Zustand mit, abrufbar unter **`/api/health`**.
- Fehler meldet er per Discord (höchstens 1×/Stunde), dazu 1× täglich ein Lebenszeichen.
- **Externer Check** (`watchdog.mjs`, stündlich über `.github/workflows/watchdog.yml`):
  schlägt Alarm, wenn der Worker nicht antwortet oder der letzte Lauf > 30 Min her ist.
  Dafür in GitHub zwei Secrets setzen: `WORKER_URL` (deine Worker-Adresse) und
  `DISCORD_WEBHOOK` (dieselbe URL wie in Cloudflare).

## Content: Grafiken & Stream-Overlay
- **📸-Knopf** auf jeder Karte → fertige Post-Grafik als PNG, wahlweise **9:16**
  (TikTok/Reels/Shorts) oder **1:1** (Feed). Wasserzeichen über die Konstante
  `BRAND` oben in `worker.js` änderbar.
- **`/overlay`** → Browser-Source für OBS: transparenter Hintergrund, Top-Deals,
  aktualisiert sich alle 5 Min. Parameter: `?n=5&gap=7` (Anzahl, Mindest-Lücke).
- **`/img?u=…`** ist der Bild-Proxy dahinter (feste Host-Liste). Er probiert
  `boxart → banner600 → banner400`, weil ITAD bei fehlendem Bild HTTP 200 mit einer
  XML-Fehlermeldung liefert statt 404. Hebt die Cover-Abdeckung von 75 % auf 93 %.

Attribution: GG.deals verlangt einen Quellen-Link – der steht als Fußzeile in der App
und jeder geladene Keyshop-Preis verlinkt auf die GG.deals-Spielseite.

## Dateien
- `collector.mjs` – holt & filtert die Deals, schreibt `deals.js`
- `Key Sniper.html` – die App (Live-Filter für Preislücke, Max-Preis, Historical Low)
- `config.json` – Einstellungen (Land, Shop-Liste, Schwellen) – **ohne** Key
- `key.txt` – dein API-Key, lokal, per `.gitignore` geschützt
- `.github/workflows/deploy.yml` – der tägliche Cloud-Job
