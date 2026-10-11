// Client des Impuls-Boards: State kommt einmal per REST, danach hält ein
// SSE-Stream alle Browser synchron. Kein Framework, kein Build-Schritt.

const $ = (id) => document.getElementById(id);
const brett = $('brett');
const FARBEN = 6;

// --- Identität (nur lokal, keine Anmeldung) --------------------------------

const ich = {
  uid: localStorage.getItem('uid') || crypto.randomUUID(),
  name: localStorage.getItem('name') || '',
  farbe: Number(localStorage.getItem('farbe') ?? Math.floor(Math.random() * FARBEN)),
};
localStorage.setItem('uid', ich.uid);
const meineStimmen = new Set(JSON.parse(localStorage.getItem('stimmen') || '[]'));

$('autor').value = ich.name;

// --- Farbwahl --------------------------------------------------------------

for (let i = 0; i < FARBEN; i++) {
  const knopf = document.createElement('button');
  knopf.type = 'button';
  knopf.className = 'farbe';
  knopf.style.background = `var(--n${i})`;
  knopf.setAttribute('role', 'radio');
  knopf.setAttribute('aria-label', `Farbe ${i + 1}`);
  knopf.setAttribute('aria-checked', String(i === ich.farbe));
  knopf.onclick = () => {
    ich.farbe = i;
    localStorage.setItem('farbe', String(i));
    for (const [j, b] of [...$('farbwahl').children].entries()) {
      b.setAttribute('aria-checked', String(j === i));
    }
  };
  $('farbwahl').append(knopf);
}

// --- Notizen rendern -------------------------------------------------------

const knoten = new Map(); // id -> Element

function leerstandPruefen() {
  $('leer').hidden = knoten.size > 0;
}

function setzen(el, x, y) {
  el.style.left = `${x * 100}%`;
  el.style.top = `${y * 100}%`;
}

function zeichnen(notiz) {
  let el = knoten.get(notiz.id);
  if (!el) {
    el = document.createElement('article');
    el.className = 'notiz';
    el.style.background = `var(--n${notiz.farbe})`;
    el.innerHTML =
      '<div class="notiz-text"></div><div class="notiz-fuss">' +
      '<span class="notiz-autor"></span>' +
      '<button class="notiz-aktion" data-rolle="stimme"></button>' +
      '</div>';
    // textContent statt innerHTML: Nutzertext wird nie als HTML interpretiert.
    el.querySelector('.notiz-text').textContent = notiz.text;
    el.querySelector('.notiz-autor').textContent = notiz.autor;

    const stimmKnopf = el.querySelector('[data-rolle="stimme"]');
    stimmKnopf.onclick = () => stimmen(notiz.id, stimmKnopf);
    if (meineStimmen.has(notiz.id)) stimmKnopf.classList.add('gewaehlt');

    if (notiz.uid === ich.uid) {
      const weg = document.createElement('button');
      weg.className = 'notiz-aktion';
      weg.textContent = '✕';
      weg.title = 'Notiz entfernen';
      weg.onclick = () => fetch(`/api/notizen/${notiz.id}?uid=${ich.uid}`, { method: 'DELETE' });
      el.querySelector('.notiz-fuss').append(weg);
    }

    ziehbarMachen(el, notiz.id);
    brett.append(el);
    knoten.set(notiz.id, el);
  }
  el.querySelector('[data-rolle="stimme"]').textContent = `👍 ${notiz.stimmen}`;
  setzen(el, notiz.x, notiz.y);
  leerstandPruefen();
}

function entfernen(id) {
  knoten.get(id)?.remove();
  knoten.delete(id);
  leerstandPruefen();
}

// --- Ziehen (Maus + Touch über Pointer Events) -----------------------------

let ziehtGerade = null; // id der Notiz, die *ich* gerade ziehe

function ziehbarMachen(el, id) {
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return; // Klick auf 👍 / ✕ ist kein Zug
    const brettMasse = brett.getBoundingClientRect();
    const notizMasse = el.getBoundingClientRect();
    const versatzX = e.clientX - notizMasse.left;
    const versatzY = e.clientY - notizMasse.top;
    const maxX = Math.max(0, 1 - notizMasse.width / brettMasse.width);
    const maxY = Math.max(0, 1 - notizMasse.height / brettMasse.height);

    let x = 0;
    let y = 0;
    let letzterFunk = 0;

    ziehtGerade = id;
    el.classList.add('zieht');
    el.setPointerCapture(e.pointerId);

    const bewegen = (ev) => {
      x = Math.min(maxX, Math.max(0, (ev.clientX - versatzX - brettMasse.left) / brettMasse.width));
      y = Math.min(maxY, Math.max(0, (ev.clientY - versatzY - brettMasse.top) / brettMasse.height));
      setzen(el, x, y);
      // Gedrosselt mitsenden, damit die anderen die Bewegung live sehen.
      const jetzt = performance.now();
      if (jetzt - letzterFunk > 120) {
        letzterFunk = jetzt;
        melden(id, x, y);
      }
    };

    const loslassen = () => {
      el.removeEventListener('pointermove', bewegen);
      el.classList.remove('zieht');
      ziehtGerade = null;
      melden(id, x, y);
    };

    el.addEventListener('pointermove', bewegen);
    el.addEventListener('pointerup', loslassen, { once: true });
    el.addEventListener('pointercancel', loslassen, { once: true });
  });
}

const melden = (id, x, y) =>
  fetch(`/api/notizen/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x, y }),
  }).catch(() => {});

// --- Stimmen ---------------------------------------------------------------

async function stimmen(id, knopf) {
  if (meineStimmen.has(id)) return;
  meineStimmen.add(id);
  localStorage.setItem('stimmen', JSON.stringify([...meineStimmen]));
  knopf.classList.add('gewaehlt');
  await fetch(`/api/notizen/${id}/stimme`, { method: 'POST' }).catch(() => {});
}

// --- Notiz anlegen ---------------------------------------------------------

$('verfassen').onsubmit = async (e) => {
  e.preventDefault();
  const autor = $('autor').value.trim();
  const text = $('text').value.trim();
  if (!autor || !text) return;
  ich.name = autor;
  localStorage.setItem('name', autor);

  const antwort = await fetch('/api/notizen', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, autor, uid: ich.uid, farbe: ich.farbe }),
  });
  if (!antwort.ok) {
    $('hinweis').textContent = (await antwort.json()).fehler || 'Konnte nicht angeheftet werden.';
    return;
  }
  $('hinweis').textContent = '';
  $('text').value = '';
  $('text').focus();
};

// --- Live-Verbindung -------------------------------------------------------

function praesenzSetzen(zahl) {
  $('online-zahl').textContent = zahl;
  $('ops-online').textContent = zahl;
}

function verbindungsstatus(live) {
  $('puls').classList.toggle('live', live);
  const s = $('ops-status');
  s.textContent = live ? 'SSE verbunden' : 'Verbindung verloren — verbinde neu …';
  s.classList.toggle('live', live);
  s.classList.toggle('tot', !live);
}

function verbinden() {
  const strom = new EventSource('/api/events');
  strom.onopen = () => verbindungsstatus(true);
  strom.onerror = () => verbindungsstatus(false); // EventSource verbindet selbst neu
  strom.addEventListener('praesenz', (e) => praesenzSetzen(JSON.parse(e.data).online));
  strom.addEventListener('neu', (e) => zeichnen(JSON.parse(e.data)));
  strom.addEventListener('weg', (e) => entfernen(JSON.parse(e.data).id));
  strom.addEventListener('bewegt', (e) => {
    const { id, x, y } = JSON.parse(e.data);
    if (id === ziehtGerade) return; // meinen eigenen Zug nicht überschreiben
    const el = knoten.get(id);
    if (el) setzen(el, x, y);
  });
  strom.addEventListener('stimme', (e) => {
    const { id, stimmen: anzahl } = JSON.parse(e.data);
    const knopf = knoten.get(id)?.querySelector('[data-rolle="stimme"]');
    if (knopf) knopf.textContent = `👍 ${anzahl}`;
  });
}

// --- Ops-Leiste ------------------------------------------------------------

const dauer = (sek) => {
  const h = Math.floor(sek / 3600);
  const m = Math.floor((sek % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${sek % 60}s`;
};

async function opsAktualisieren() {
  try {
    const g = await (await fetch('/healthz')).json();
    $('ops-version').textContent = g.version;
    $('ops-laufzeit').textContent = dauer(g.laufzeitSek);
    $('ops-notizen').textContent = g.notizen;
  } catch {
    /* Ops-Leiste ist Deko — ein Ausfall darf das Board nicht stören. */
  }
}

// --- Theme (theme.json, vom Server geprüft) --------------------------------

// Relative Leuchtdichte nach WCAG: entscheidet, ob Text auf einer Fläche hell
// oder dunkel sein muss, damit auch eine gelbe Marke lesbar bleibt.
function leuchtdichte(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const textAuf = (hex) => (leuchtdichte(hex) > 0.4 ? '#16160f' : '#ffffff');

async function themaAnwenden() {
  let t;
  try {
    t = await (await fetch('/theme.json')).json();
  } catch {
    return; // CSS-Defaults sind das neutrale Theme
  }
  const wurzel = document.documentElement.style;
  wurzel.setProperty('--primary', t.primary);
  wurzel.setProperty('--on-primary', textAuf(t.primary));
  wurzel.setProperty('--accent', t.accent);
  wurzel.setProperty('--on-accent', textAuf(t.accent));
  if (t.font) wurzel.setProperty('--font', `${t.font}, system-ui, sans-serif`);

  $('marke-name').textContent = t.name;
  const fremd = t.name.toLowerCase() !== 'nyxory';
  $('marke-kreuz').hidden = !fremd;
  $('marke-nyxory').hidden = !fremd;
  document.title = fremd ? `${t.name} × nyxory — Live Impuls-Board` : 'Live Impuls-Board';
  if (t.logo) {
    $('marke-logo').src = t.logo;
    $('marke-logo').alt = t.name;
    $('marke-logo').hidden = false;
    $('marke-logo').onerror = () => ($('marke-logo').hidden = true);
    $('favicon').href = t.logo;
  }
}

// --- Start -----------------------------------------------------------------

await themaAnwenden();

const start = await (await fetch('/api/state')).json();
start.notizen.forEach(zeichnen);
praesenzSetzen(start.online);
leerstandPruefen();
verbinden();
opsAktualisieren();
setInterval(opsAktualisieren, 5000);
