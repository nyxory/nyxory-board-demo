// Live Impuls-Board — nyxory demo
//
// Ein Prozess, keine npm-Abhängigkeiten: node:http für den Server,
// node:sqlite für die Persistenz, SSE für den Live-Sync. Damit ist der
// Container-Build ein reines COPY — kein npm install, kein Lockfile.

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HIER = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const DB_PFAD = process.env.DB_PATH || join(HIER, 'data', 'board.db');
const START = Date.now();

// Deploy-Stand fürs Ops-Panel. Kommt im Container aus .app-version (Dockerfile),
// lokal aus der Umgebung — fehlt beides, steht da "lokal".
const VERSION =
  process.env.APP_VERSION ||
  (() => {
    try {
      return readFileSync(join(HIER, '.app-version'), 'utf8').trim();
    } catch {
      return 'lokal';
    }
  })();

// --- Theme ----------------------------------------------------------------
// theme.json bestimmt Name, Logo und Farben. Einmal beim Start gelesen und
// geprüft: nur #hex-Farben, Logo nur https: oder data:image/, Schrift nur
// eine harmlose font-family-Liste. Was nicht passt, fällt auf neutral zurück.

const NEUTRAL = { name: 'nyxory', logo: '', primary: '#16160f', accent: '#ccff00', font: '' };
const THEMA_PFAD = process.env.THEME_PATH || join(HIER, 'theme.json');

function themaPruefen(roh) {
  const t = { ...NEUTRAL };
  if (!roh || typeof roh !== 'object') return t;
  const hex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
  if (typeof roh.name === 'string' && roh.name.trim()) t.name = roh.name.trim().slice(0, 60);
  if (typeof roh.logo === 'string' && /^(https:\/\/|data:image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,)/i.test(roh.logo) && roh.logo.length < 400_000)
    t.logo = roh.logo;
  if (hex(roh.primary)) t.primary = roh.primary.toLowerCase();
  if (hex(roh.accent)) t.accent = roh.accent.toLowerCase();
  if (typeof roh.font === 'string' && /^[\w\s,"'-]{1,120}$/.test(roh.font)) t.font = roh.font;
  return t;
}

const THEMA = (() => {
  try {
    return themaPruefen(JSON.parse(readFileSync(THEMA_PFAD, 'utf8')));
  } catch {
    return { ...NEUTRAL };
  }
})();

await mkdir(dirname(DB_PFAD), { recursive: true });
const db = new DatabaseSync(DB_PFAD);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS notizen (
    id      TEXT PRIMARY KEY,
    text    TEXT    NOT NULL,
    autor   TEXT    NOT NULL,
    uid     TEXT    NOT NULL,
    farbe   INTEGER NOT NULL,
    x       REAL    NOT NULL,
    y       REAL    NOT NULL,
    stimmen INTEGER NOT NULL DEFAULT 0,
    erzeugt INTEGER NOT NULL
  );
`);

const alleNotizen = db.prepare('SELECT * FROM notizen ORDER BY erzeugt ASC');
const eineNotiz = db.prepare('SELECT * FROM notizen WHERE id = ?');
const einfuegen = db.prepare(
  'INSERT INTO notizen (id, text, autor, uid, farbe, x, y, erzeugt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
);
const verschieben = db.prepare('UPDATE notizen SET x = ?, y = ? WHERE id = ?');
const hochstimmen = db.prepare('UPDATE notizen SET stimmen = stimmen + 1 WHERE id = ?');
const loeschen = db.prepare('DELETE FROM notizen WHERE id = ? AND uid = ?');

// --- Live-Sync über Server-Sent Events -------------------------------------

const abonnenten = new Set();

function sende(typ, daten) {
  const zeile = `event: ${typ}\ndata: ${JSON.stringify(daten)}\n\n`;
  for (const res of abonnenten) res.write(zeile);
}

const online = () => abonnenten.size;

// --- Hilfen ----------------------------------------------------------------

const FARBEN = 6; // Palette liegt im CSS; der Client schickt nur den Index.
const kurz = (wert, max) => String(wert ?? '').trim().slice(0, max);
const klemme = (n, min, max) => Math.min(max, Math.max(min, Number(n)));

function json(res, code, koerper) {
  const text = JSON.stringify(koerper);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function koerperLesen(req) {
  let roh = '';
  for await (const stueck of req) {
    roh += stueck;
    if (roh.length > 8192) throw new Error('zu groß');
  }
  return roh ? JSON.parse(roh) : {};
}

// Sucht einen Platz, der nicht direkt auf einer bestehenden Notiz landet.
// ponytail: naive Zufallssuche mit 30 Versuchen — reicht bis ~40 Notizen,
// bei mehr bräuchte es ein echtes Raster.
function freierPlatz(vorhanden) {
  for (let i = 0; i < 30; i++) {
    const x = 0.02 + Math.random() * 0.74;
    const y = 0.03 + Math.random() * 0.7;
    const kollision = vorhanden.some((n) => Math.abs(n.x - x) < 0.16 && Math.abs(n.y - y) < 0.18);
    if (!kollision) return { x, y };
  }
  return { x: 0.02 + Math.random() * 0.74, y: 0.03 + Math.random() * 0.7 };
}

// --- Statische Dateien -----------------------------------------------------

const TYPEN = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function statisch(res, pfad) {
  // normalize + Präfixprüfung: kein ../ aus public/ heraus.
  const ziel = join(HIER, 'public', normalize(pfad === '/' ? '/index.html' : pfad));
  if (!ziel.startsWith(join(HIER, 'public'))) return json(res, 403, { fehler: 'verboten' });
  try {
    const inhalt = await readFile(ziel);
    res.writeHead(200, {
      'content-type': TYPEN[extname(ziel)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(inhalt);
  } catch {
    json(res, 404, { fehler: 'nicht gefunden' });
  }
}

// --- Routen ----------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pfad = url.pathname;

  try {
    if (pfad === '/healthz') {
      return json(res, 200, {
        status: 'ok',
        version: VERSION,
        laufzeitSek: Math.floor((Date.now() - START) / 1000),
        notizen: alleNotizen.all().length,
        online: online(),
      });
    }

    if (pfad === '/theme.json') return json(res, 200, THEMA);

    if (pfad === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no', // Ingress darf SSE nicht puffern.
      });
      res.write('retry: 3000\n\n');
      abonnenten.add(res);
      sende('praesenz', { online: online() });
      const puls = setInterval(() => res.write(': puls\n\n'), 25000);
      // res, nicht req: der Request-Stream eines GET ist sofort zu Ende,
      // erst das Schließen der Antwort heißt "Browser ist weg".
      res.on('close', () => {
        clearInterval(puls);
        abonnenten.delete(res);
        sende('praesenz', { online: online() });
      });
      return;
    }

    if (pfad === '/api/state' && req.method === 'GET') {
      return json(res, 200, { notizen: alleNotizen.all(), online: online(), version: VERSION });
    }

    if (pfad === '/api/notizen' && req.method === 'POST') {
      const b = await koerperLesen(req);
      const text = kurz(b.text, 200);
      const autor = kurz(b.autor, 40) || 'Anonym';
      const uid = kurz(b.uid, 64);
      if (!text) return json(res, 400, { fehler: 'Text fehlt' });
      if (!uid) return json(res, 400, { fehler: 'uid fehlt' });
      const farbe = klemme(b.farbe ?? 0, 0, FARBEN - 1) | 0;
      const { x, y } = freierPlatz(alleNotizen.all());
      const notiz = { id: randomUUID(), text, autor, uid, farbe, x, y, stimmen: 0, erzeugt: Date.now() };
      einfuegen.run(notiz.id, text, autor, uid, farbe, x, y, notiz.erzeugt);
      sende('neu', notiz);
      return json(res, 201, notiz);
    }

    const treffer = pfad.match(/^\/api\/notizen\/([\w-]+)(\/stimme)?$/);
    if (treffer) {
      const id = treffer[1];
      const istStimme = Boolean(treffer[2]);

      if (istStimme && req.method === 'POST') {
        // ponytail: keine serverseitige Doppel-Stimmen-Sperre — der Client
        // merkt sich seine Stimmen lokal. Für ein Live-Board reicht das.
        if (hochstimmen.run(id).changes === 0) return json(res, 404, { fehler: 'unbekannt' });
        const notiz = eineNotiz.get(id);
        sende('stimme', { id, stimmen: notiz.stimmen });
        return json(res, 200, { stimmen: notiz.stimmen });
      }

      if (!istStimme && req.method === 'PATCH') {
        const b = await koerperLesen(req);
        const x = klemme(b.x, 0, 0.9);
        const y = klemme(b.y, 0, 0.9);
        if (Number.isNaN(x) || Number.isNaN(y)) return json(res, 400, { fehler: 'x/y ungültig' });
        if (verschieben.run(x, y, id).changes === 0) return json(res, 404, { fehler: 'unbekannt' });
        sende('bewegt', { id, x, y });
        return json(res, 200, { x, y });
      }

      if (!istStimme && req.method === 'DELETE') {
        const uid = kurz(url.searchParams.get('uid'), 64);
        if (loeschen.run(id, uid).changes === 0) return json(res, 403, { fehler: 'nicht deine Notiz' });
        sende('weg', { id });
        return json(res, 200, { ok: true });
      }
    }

    if (req.method === 'GET') return statisch(res, pfad);
    json(res, 405, { fehler: 'Methode nicht erlaubt' });
  } catch (fehler) {
    json(res, 400, { fehler: String(fehler.message || fehler) });
  }
});

server.listen(PORT, () => {
  console.log(`${THEMA.name} Board läuft auf http://localhost:${PORT}  (db: ${DB_PFAD}, version: ${VERSION})`);
});
