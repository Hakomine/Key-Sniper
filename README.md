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

## Dateien
- `collector.mjs` – holt & filtert die Deals, schreibt `deals.js`
- `Key Sniper.html` – die App (Live-Filter für Preislücke, Max-Preis, Historical Low)
- `config.json` – Einstellungen (Land, Shop-Liste, Schwellen) – **ohne** Key
- `key.txt` – dein API-Key, lokal, per `.gitignore` geschützt
- `.github/workflows/deploy.yml` – der tägliche Cloud-Job
