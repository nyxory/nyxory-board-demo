// brand-from-domain gegen eine lokale Fixture: ein Fake-fetch liefert HTML,
// CSS und Logo, damit der Test ohne Netz läuft und immer dasselbe sieht.
// Start: `node --test`

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { brandFromDomain, domainNormieren, NEUTRAL } from './scripts/brand-from-domain.mjs';

const html = await readFile(new URL('./test/fixture-brand.html', import.meta.url), 'utf8');
const LOGO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const seiten = {
  'https://acme.example/': [html, 'text/html; charset=utf-8'],
  // Bootstrap-Blau steht oft drin, ist aber nie die Marke.
  'https://acme.example/css/main.css': ['.btn{color:#0d6efd}.a{color:#0d6efd}.b{color:#0d6efd}.nav{background:#29335c}', 'text/css'],
  'https://acme.example/apple-touch-icon.png': [LOGO, 'image/png'],
};

const fakeFetch = async (url) => {
  const treffer = seiten[url];
  if (!treffer) return new Response('nope', { status: 404 });
  return new Response(treffer[0], { headers: { 'content-type': treffer[1] } });
};

test('Fixture: Name, Logo und Farben', async () => {
  const { thema, rueckfall } = await brandFromDomain('https://acme.example/irgendwas', fakeFetch);
  assert.equal(thema.name, 'Acme Robotics'); // og:site_name schlägt <title>
  assert.equal(thema.logo, `data:image/png;base64,${LOGO.toString('base64')}`); // apple-touch-icon zuerst
  assert.equal(thema.primary, '#e4572e'); // theme-color #fff ist grau → CSS-Brand-Variable
  assert.equal(thema.accent, '#29335c'); // #0d6efd ignoriert
  assert.deepEqual(rueckfall, []);
  assert.equal(globalThis.__ausgefuehrt, undefined); // Script der Seite lief nicht
});

test('Seite nicht erreichbar → neutral, Name aus der Domain', async () => {
  const { thema, rueckfall } = await brandFromDomain('www.acme.example', async () => {
    throw new Error('offline');
  });
  assert.equal(thema.name, 'Acme');
  assert.equal(thema.primary, NEUTRAL.primary);
  assert.equal(thema.logo, '');
  assert.deepEqual(rueckfall, ['name', 'logo', 'primary', 'accent']);
});

test('Umleitung auf http wird nicht gelesen', async () => {
  const { rueckfall } = await brandFromDomain('acme.example', async () => ({
    ok: true,
    url: 'http://acme.example/',
    headers: new Headers(),
    body: [Buffer.from(html)],
  }));
  assert.equal(rueckfall.length, 4);
});

test('Domain-Prüfung', () => {
  assert.equal(domainNormieren('HTTPS://www.Example.com/pfad?x=1'), 'www.example.com');
  for (const schlecht of ['localhost', '127.0.0.1', 'example', 'exa mple.com', '']) {
    assert.throws(() => domainNormieren(schlecht), /keine gültige Domain/);
  }
});

test('CLI: ohne Domain Nutzungshinweis, ungültige Domain Exit 2', () => {
  const lauf = (...a) => spawnSync(process.execPath, ['scripts/brand-from-domain.mjs', ...a], { encoding: 'utf8' });
  assert.equal(lauf().status, 2);
  // Domain als einziges Argument wird erkannt (Regression: fiel ohne --out weg).
  const r = lauf('nicht gültig');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /keine gültige Domain: nicht gültig/);
});
