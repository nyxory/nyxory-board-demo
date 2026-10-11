#!/usr/bin/env node
// Leitet aus der öffentlichen Startseite einer Firma ein theme.json ab:
// Name, Logo (eingebettet als data:-URI), Primär- und Akzentfarbe.
//
//   node scripts/brand-from-domain.mjs example.com [--out theme.json]
//
// Holt nur https, mit Timeout und Größenlimit, und liest HTML/CSS als Text —
// nichts von der Seite wird ausgeführt. Was sich nicht finden lässt, fällt
// einzeln auf neutral zurück; die Ausgabe nennt, welche Felder das waren.
// Keine Abhängigkeiten, Node ≥ 22 (globales fetch).

import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const NEUTRAL = { name: 'nyxory', logo: '', primary: '#16160f', accent: '#ccff00', font: '' };

const TIMEOUT_MS = 8000;
const MAX_HTML = 1_500_000;
const MAX_CSS = 1_000_000; // je Stylesheet
const MAX_SHEETS = 4;
const MAX_LOGO = 250_000;
const LOGO_TYPEN = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'];

// --- Domain ------------------------------------------------------------------

export function domainNormieren(eingabe) {
  const host = String(eingabe ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '');
  const gueltig = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host);
  if (!gueltig) throw new Error(`keine gültige Domain: ${eingabe}`);
  return host;
}

const etikett = (host) => {
  const l = host.replace(/^www\./, '').split('.')[0];
  return l.charAt(0).toUpperCase() + l.slice(1);
};

// --- Holen mit Limits --------------------------------------------------------

async function holen(url, max, fetchImpl, accept) {
  const res = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept, 'user-agent': 'nyxory-board-brand/1.0' },
  });
  const endUrl = res.url || url;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if (!endUrl.startsWith('https:')) throw new Error(`${url}: Umleitung weg von https`);
  if (Number(res.headers.get('content-length')) > max) throw new Error(`${url}: zu groß`);
  const teile = [];
  let laenge = 0;
  for await (const stueck of res.body) {
    laenge += stueck.length;
    if (laenge > max) throw new Error(`${url}: zu groß`);
    teile.push(stueck);
  }
  return { buf: Buffer.concat(teile), typ: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), url: endUrl };
}

// --- HTML lesen (Text, kein DOM, nichts ausführen) ---------------------------

const entities = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map(([tag]) => {
    const a = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      a[m[1].toLowerCase()] = entities(m[2] ?? m[3] ?? m[4] ?? '');
    }
    return a;
  });
}

const metaWert = (metas, schluessel) =>
  metas.find((m) => (m.property || m.name || '').toLowerCase() === schluessel)?.content?.trim() || '';

export function nameFinden(html, host) {
  const metas = tags(html, 'meta');
  const site = metaWert(metas, 'og:site_name') || metaWert(metas, 'application-name');
  if (site) return site.slice(0, 60);
  const titel = entities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();
  const teile = titel.split(/\s+[|–—·:-]\s+/).map((s) => s.trim()).filter(Boolean);
  const label = etikett(host).toLowerCase();
  // Das Titelstück, das den Domainnamen enthält, ist meist der Firmenname
  // ("Muster GmbH | Software" → "Muster GmbH"); sonst das kürzeste Stück.
  const passend = teile.filter((t) => t.toLowerCase().replace(/[^a-z0-9]/g, '').includes(label));
  const wahl = (passend.length ? passend : teile).sort((a, b) => a.length - b.length)[0];
  // Ein ganzer Satz ist kein Name ("Schuhe … online bei ZALANDO"): dann nur
  // das Wort, das dem Domainnamen entspricht, in der Schreibweise der Seite.
  if (wahl && wahl.length > 30) {
    const wort = wahl.split(/\s+/).find((w) => w.toLowerCase().replace(/[^a-z0-9]/g, '') === label);
    return wort ? wort.replace(/[^\p{L}\p{N}&.-]/gu, '') : etikett(host);
  }
  return (wahl || etikett(host)).slice(0, 60);
}

export function logoKandidaten(html, basis) {
  const links = tags(html, 'link');
  const rels = (l) => (l.rel || '').toLowerCase().split(/\s+/);
  const groesse = (l) => (/svg/.test(l.type || l.href) || l.sizes === 'any' ? 9999 : Math.max(0, ...(l.sizes || '').split(/\s+/).map((s) => parseInt(s, 10) || 0)));
  const nachGroesse = (a, b) => groesse(b) - groesse(a);
  const apple = links.filter((l) => rels(l).some((r) => r.startsWith('apple-touch-icon'))).sort(nachGroesse);
  const icons = links.filter((l) => rels(l).includes('icon')).sort(nachGroesse);
  const og = metaWert(tags(html, 'meta'), 'og:image');
  return [...apple, ...icons]
    .map((l) => l.href)
    .concat(og, '/favicon.ico')
    .filter(Boolean)
    .map((h) => {
      try {
        return new URL(h, basis).href;
      } catch {
        return '';
      }
    })
    .filter((u) => u.startsWith('https:') || u.startsWith('data:image/'))
    .filter((u, i, alle) => alle.indexOf(u) === i);
}

// Die ersten Stylesheets der Seite: das erste allein ist oft nur ein
// Utility- oder Font-Paket, die Markenfarben stehen ein, zwei Dateien später.
export function stylesheetUrls(html, basis) {
  return tags(html, 'link')
    .filter((l) => (l.rel || '').toLowerCase().split(/\s+/).includes('stylesheet') && l.href)
    .map((l) => {
      try {
        return new URL(l.href, basis).href;
      } catch {
        return '';
      }
    })
    .filter((u) => u.startsWith('https:'))
    .slice(0, MAX_SHEETS);
}

export const inlineCss = (html) => [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');

// --- Farben ------------------------------------------------------------------

const hex6 = (h) => (h.length === 4 ? '#' + [...h.slice(1)].map((c) => c + c).join('') : h).toLowerCase();
const zuHex = (r, g, b) => '#' + [r, g, b].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('');

function hsl(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

// Schwarz, Weiß und Grau tragen keine Marke, die Bootstrap-Standardpalette
// (4 und 5) auch nicht: sie steht in vielen Seiten, ohne je benutzt zu werden.
const FRAMEWORK = new Set(
  '#0d6efd #6610f2 #6f42c1 #d63384 #dc3545 #fd7e14 #ffc107 #198754 #20c997 #0dcaf0 #007bff #28a745 #17a2b8 #e83e8c'.split(' '),
);
export const bunt = (hex) => {
  const { s, l } = hsl(hex);
  return s >= 0.25 && l >= 0.12 && l <= 0.88 && !FRAMEWORK.has(hex);
};

const farbabstand = (a, b) => {
  const d = Math.abs(hsl(a).h - hsl(b).h);
  return Math.min(d, 360 - d);
};

// Zählt bunte Farben über [css, gewicht]-Paare; Custom Properties mit
// Markennamen zählen zehnfach. Inline-CSS bekommt mehr Gewicht als externe
// Dateien, weil dort seltener Framework-Ballast steht.
export function farbRangliste(quellen) {
  const zaehler = new Map();
  const plus = (hex, n) => bunt(hex) && zaehler.set(hex, (zaehler.get(hex) || 0) + n);
  for (const [css, w] of quellen) {
    for (const m of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) plus(hex6(m[0]), w);
    for (const m of css.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/gi)) plus(zuHex(m[1], m[2], m[3]), w);
    for (const m of css.matchAll(/--[\w-]*(?:primary|brand|main|corporate)[\w-]*\s*:\s*(#[0-9a-f]{6}\b|#[0-9a-f]{3}\b)/gi))
      plus(hex6(m[1]), 10 * w);
  }
  return [...zaehler.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex);
}

const aufhellen = (hex, anteil) =>
  zuHex(...[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - anteil) + 255 * anteil)));

export function farbenWaehlen(themeColor, rangliste) {
  const tc = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(themeColor) ? hex6(themeColor) : '';
  const primary = tc && bunt(tc) ? tc : rangliste[0];
  if (!primary) return null;
  const accent = rangliste.find((c) => c !== primary && farbabstand(c, primary) >= 25) || aufhellen(primary, 0.45);
  return { primary, accent };
}

// --- Zusammen ----------------------------------------------------------------

async function logoEinbetten(kandidaten, fetchImpl) {
  for (const url of kandidaten.slice(0, 6)) {
    if (url.startsWith('data:image/')) {
      if (url.length < MAX_LOGO * 1.4 && LOGO_TYPEN.some((t) => url.startsWith(`data:${t};base64,`))) return url;
      continue;
    }
    try {
      const { buf, typ } = await holen(url, MAX_LOGO, fetchImpl, 'image/*');
      if (LOGO_TYPEN.includes(typ) && buf.length > 0) return `data:${typ};base64,${buf.toString('base64')}`;
    } catch {
      /* nächster Kandidat */
    }
  }
  return '';
}

export async function brandFromDomain(eingabe, fetchImpl = fetch) {
  const host = domainNormieren(eingabe);
  const quelle = `https://${host}/`;
  const thema = { ...NEUTRAL, name: etikett(host), source: quelle };
  const rueckfall = [];

  // Aus einer Mail-Domain kommt meist die nackte Domain; manche Firmen
  // antworten nur unter www. — dann der zweite Versuch.
  const versuche = host.startsWith('www.') ? [quelle] : [quelle, `https://www.${host}/`];
  let html = '';
  let basis = quelle;
  let letzterFehler;
  for (const url of versuche) {
    try {
      const seite = await holen(url, MAX_HTML, fetchImpl, 'text/html');
      html = seite.buf.toString('utf8');
      basis = seite.url;
      thema.source = url;
      break;
    } catch (fehler) {
      letzterFehler = fehler;
    }
  }
  if (!html) return { thema, rueckfall: ['name', 'logo', 'primary', 'accent'], fehler: String(letzterFehler?.message || letzterFehler) };

  thema.name = nameFinden(html, host);

  thema.logo = await logoEinbetten(logoKandidaten(html, basis), fetchImpl);
  if (!thema.logo) rueckfall.push('logo');

  const quellen = [[inlineCss(html), 3]];
  const sheets = await Promise.all(
    stylesheetUrls(html, basis).map((u) =>
      holen(u, MAX_CSS, fetchImpl, 'text/css').then(
        (r) => r.buf.toString('utf8'),
        () => '', // ein fehlendes Stylesheet kostet nur Genauigkeit
      ),
    ),
  );
  for (const css of sheets) quellen.push([css, 1]);
  const farben = farbenWaehlen(metaWert(tags(html, 'meta'), 'theme-color'), farbRangliste(quellen));
  if (farben) Object.assign(thema, farben);
  else rueckfall.push('primary', 'accent');

  return { thema, rueckfall };
}

// --- CLI ---------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : join(dirname(fileURLToPath(import.meta.url)), '..', 'theme.json');
  const domain = args.find((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));
  if (!domain || !out) {
    console.error('Aufruf: node scripts/brand-from-domain.mjs <domain> [--out theme.json]');
    process.exit(2);
  }
  let ergebnis;
  try {
    ergebnis = await brandFromDomain(domain);
  } catch (fehler) {
    console.error(String(fehler.message || fehler));
    process.exit(2);
  }
  await writeFile(out, JSON.stringify(ergebnis.thema, null, 2) + '\n');
  const { logo, ...rest } = ergebnis.thema;
  console.log(
    JSON.stringify(
      {
        ...rest,
        logo: logo ? `${logo.slice(0, logo.indexOf(','))} (${Math.round(logo.length / 1024)} KB)` : '',
        written: out,
        fallback: ergebnis.rueckfall,
        ...(ergebnis.fehler ? { error: ergebnis.fehler } : {}),
      },
      null,
      2,
    ),
  );
}
