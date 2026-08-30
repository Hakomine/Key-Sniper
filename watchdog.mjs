// Key Sniper – externer Wächter
// -----------------------------
// Fragt /api/health des Workers ab und meldet per Discord, wenn der Cron nicht
// mehr läuft. Nötig, weil ein toter Worker sich nicht selbst melden kann.
//
// Läuft stündlich über .github/workflows/watchdog.yml
// Umgebung: WORKER_URL (z.B. https://key-sniper.xy.workers.dev), DISCORD_WEBHOOK

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/+$/, '');
const HOOK = process.env.DISCORD_WEBHOOK || '';
const MAX_AGE_MIN = 30; // Cron läuft alle 10 Min – 30 sind großzügig

if (!WORKER_URL) {
  console.error('WORKER_URL fehlt');
  process.exit(1);
}

async function alarm(title, text) {
  console.error(title + ' – ' + text);
  if (!HOOK) return;
  await fetch(HOOK, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'Key Sniper Wächter',
      content: '🚨 **Key Sniper meldet sich nicht**',
      embeds: [
        {
          title,
          description: text,
          color: 16007990,
          footer: { text: 'Externer Wächter (GitHub Actions)' },
        },
      ],
    }),
  }).catch((e) => console.error('Discord-Versand fehlgeschlagen:', e.message));
}

// Den Befund des Workers an den Alarm anhängen.
// /api/health liefert mehr als das Alter des letzten Abschlusses: das
// Lebenszeichen vom Anfang des Laufs (`startAgeMinutes`) und ein fertig
// ausgerechnetes `diagnose`-Feld. Davon landete bisher nichts im Alarm – er
// nannte nur „Letzter Lauf vor N Minuten". Damit sehen „Cron feuert gar
// nicht" und „Cron feuert und stirbt unterwegs" von außen identisch aus,
// obwohl die Antwort den Unterschied längst kennt. Wer den Alarm bekam,
// musste die Health-Antwort von Hand nachschlagen, um überhaupt zu wissen,
// wo er suchen soll.
//
// Läuft der Worker noch auf einem älteren Stand, fehlen die Felder einfach –
// dann bleibt der Zusatz weg, statt „undefined" zu melden.
function befund(h) {
  const zeilen = [];
  // `diagnose` beurteilt nur die Zeitstempel, nicht die Fehler eines Laufs.
  // Im Fehler-Alarm steht deshalb regelmäßig „in Ordnung" – das widerspricht
  // der Meldung, statt sie zu erklären. Nur aufnehmen, wenn es etwas sagt.
  if (h.diagnose && h.diagnose !== 'in Ordnung') {
    zeilen.push('Befund des Workers: **' + h.diagnose + '**');
  }
  if (h.startAgeMinutes != null) {
    zeilen.push(
      'Letzter Start vor ' + h.startAgeMinutes + ' Min, letzter Abschluss vor ' + h.ageMinutes + ' Min.'
    );
  }
  if (h.phase) zeilen.push('Zuletzt erreichte Stufe: ' + h.phase + '.');
  if (h.webhookGesetzt === false) zeilen.push('Achtung: Der Worker hat keinen Discord-Webhook gesetzt.');
  return zeilen.length ? '\n\n' + zeilen.join('\n') : '';
}

let res;
try {
  res = await fetch(WORKER_URL + '/api/health', { signal: AbortSignal.timeout(20000) });
} catch (e) {
  await alarm('Worker nicht erreichbar', 'Die Seite antwortet gar nicht: ' + e.message);
  process.exit(1);
}

if (!res.ok) {
  const body = (await res.text().catch(() => '')).slice(0, 300);
  await alarm('Worker antwortet mit Fehler', 'HTTP ' + res.status + '\n' + body);
  process.exit(1);
}

const h = await res.json();

// Die Rohantwort ins Log. Wer einen fehlgeschlagenen Lauf öffnet, soll den
// vollen Zustand sehen, ohne den Worker noch einmal selbst abzufragen – von
// außen ist er außer über diesen Weg oft gar nicht erreichbar.
console.log('Zustand: ' + JSON.stringify(h));

if (h.ageMinutes == null) {
  await alarm('Kein Cron-Lauf verzeichnet', 'Antwort ohne Zeitstempel: ' + JSON.stringify(h).slice(0, 300));
  process.exit(1);
}
if (h.ageMinutes > MAX_AGE_MIN) {
  await alarm(
    'Cron läuft nicht mehr',
    'Letzter Lauf vor **' + h.ageMinutes + ' Minuten** (erwartet: alle 10).\n' +
      'Prüfen: Cron-Trigger im Cloudflare-Dashboard, Worker-Logs, API-Keys.' +
      befund(h)
  );
  process.exit(1);
}
if (h.ok === false) {
  await alarm('Letzter Cron-Lauf hatte Fehler', String(h.error || 'unbekannt').slice(0, 500) + befund(h));
  process.exit(1);
}

console.log('OK – letzter Lauf vor ' + h.ageMinutes + ' Min, ' + h.checked + ' Spiele geprüft, ' + h.alerts + ' Alarme');
