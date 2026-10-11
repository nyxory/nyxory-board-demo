// Ein Durchlauf über die API gegen eine Wegwerf-Datenbank: anlegen,
// verschieben, stimmen, fremd löschen (muss scheitern), selbst löschen,
// und der SSE-Strom muss das Anlegen tatsächlich ausliefern.
// Start: `node --test`

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8123;
const BASIS = `http://127.0.0.1:${PORT}`;
const verzeichnis = await mkdtemp(join(tmpdir(), 'board-test-'));

// Ein Theme mit einem gültigen und drei ungültigen Feldern: der Server muss
// die ungültigen auf neutral zurücksetzen statt sie auszuliefern.
await writeFile(
  join(verzeichnis, 'theme.json'),
  JSON.stringify({ name: 'Acme', primary: '#E4572E', accent: 'red;}body{display:none', logo: 'javascript:alert(1)', font: '</style>' }),
);

const kind = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: join(verzeichnis, 'test.db'), THEME_PATH: join(verzeichnis, 'theme.json') },
  stdio: 'ignore',
});

after(async () => {
  kind.kill();
  await rm(verzeichnis, { recursive: true, force: true });
});

// Warten bis der Server antwortet, statt blind zu schlafen.
for (let i = 0; ; i++) {
  try {
    await fetch(`${BASIS}/healthz`);
    break;
  } catch {
    if (i > 50) throw new Error('Server ist nicht hochgekommen');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const post = (pfad, koerper) =>
  fetch(BASIS + pfad, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(koerper),
  });

test('Notiz anlegen, verschieben, stimmen, löschen', async () => {
  const angelegt = await (await post('/api/notizen', { text: 'Hallo Board', autor: 'Tobi', uid: 'u1', farbe: 2 })).json();
  assert.equal(angelegt.text, 'Hallo Board');
  assert.equal(angelegt.farbe, 2);
  assert.ok(angelegt.x >= 0 && angelegt.x <= 0.9);

  const bewegt = await (
    await fetch(`${BASIS}/api/notizen/${angelegt.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: 5, y: -1 }), // muss geklemmt werden
    })
  ).json();
  assert.deepEqual(bewegt, { x: 0.9, y: 0 });

  assert.equal((await (await post(`/api/notizen/${angelegt.id}/stimme`)).json()).stimmen, 1);

  // Fremde uid darf nicht löschen …
  assert.equal((await fetch(`${BASIS}/api/notizen/${angelegt.id}?uid=fremd`, { method: 'DELETE' })).status, 403);
  // … die eigene schon.
  assert.equal((await fetch(`${BASIS}/api/notizen/${angelegt.id}?uid=u1`, { method: 'DELETE' })).status, 200);

  const stand = await (await fetch(`${BASIS}/api/state`)).json();
  assert.equal(stand.notizen.length, 0);
});

test('leerer Text wird abgelehnt', async () => {
  assert.equal((await post('/api/notizen', { text: '   ', autor: 'X', uid: 'u1' })).status, 400);
});

test('SSE liefert neue Notizen aus', async () => {
  const strom = await fetch(`${BASIS}/api/events`);
  const leser = strom.body.getReader();
  const dekoder = new TextDecoder();

  await post('/api/notizen', { text: 'Live-Sync', autor: 'Tobi', uid: 'u2', farbe: 0 });

  // Der Strom kommt in beliebig geschnittenen Paketen — bis zum Ereignis lesen.
  let roh = '';
  while (!roh.includes('event: neu')) {
    const { value, done } = await leser.read();
    assert.ok(!done, 'Strom endete vor dem Ereignis');
    roh += dekoder.decode(value, { stream: true });
  }
  assert.match(roh, /Live-Sync/);
  await leser.cancel();
});

test('theme.json wird geprüft ausgeliefert', async () => {
  const t = await (await fetch(`${BASIS}/theme.json`)).json();
  assert.deepEqual(t, { name: 'Acme', logo: '', primary: '#e4572e', accent: '#ccff00', font: '' });
});
