# Live Impuls-Board, a nyxory demo

Ein gemeinsames Board für einen Raum voller Leute: jede:r hängt Impulse an,
alle sehen sie im selben Moment, Notizen lassen sich verschieben und hochstimmen.
Alles landet in SQLite und überlebt jeden Neustart.

Das Board zieht sich das Erscheinungsbild deiner Firma an. Gib das Repo deinem
Coding-Agent (Claude Code, Codex, Cursor …) mit verbundenem nyxory-MCP und sag
„deploy das“: er findet heraus, für welche Firma es ist, holt Name, Logo und
Farben von deren öffentlicher Website und bringt das Board auf nyxory. Die
Anleitung für den Agenten steht in [`AGENTS.md`](AGENTS.md).

*A shared live board that brands itself for your company. Hand this repo to
your coding agent with the nyxory MCP connected and say "deploy this". The
agent instructions are in [`AGENTS.md`](AGENTS.md).*

## Lokal starten

```bash
npm run dev                      # http://localhost:3000
npm run brand -- example.com     # theme.json aus der Website von example.com
node --test                      # Tests (API, SSE, Theme, Brand-Skript)
```

Keine Abhängigkeiten, kein `npm install`: der Server nutzt `node:http` und
`node:sqlite` aus der Runtime. Voraussetzung ist **Node ≥ 24**.

## Branding: `theme.json`

```json
{ "name": "nyxory", "logo": "", "primary": "#16160f", "accent": "#ccff00", "font": "" }
```

| Feld      | Bedeutung                                                              |
| --------- | ---------------------------------------------------------------------- |
| `name`    | Firmenname im Kopf („<Name> × nyxory“), leer oder `nyxory` = neutral    |
| `logo`    | `https://…` oder eingebettet als `data:image/…;base64,…`               |
| `primary` | Kopfleiste, Knopf, Schriftfarbe (abgedunkelt), `#rrggbb`                |
| `accent`  | Live-Puls und erste Notizfarbe, `#rrggbb`                               |
| `font`    | optional, eine `font-family`-Liste                                     |

Der Server liest die Datei beim Start (`THEME_PATH`, Default `./theme.json`),
prüft jedes Feld und liefert sie unter `/theme.json` aus; Ungültiges fällt
auf neutral zurück. Textfarben auf Kopf und Knopf wählt der Client nach
Kontrast, damit auch eine gelbe Marke lesbar bleibt.

`scripts/brand-from-domain.mjs <domain>` schreibt `theme.json` aus der
öffentlichen Startseite: Name aus `og:site_name` oder `<title>`, Logo aus
`apple-touch-icon`, `icon` oder `og:image` (eingebettet, max. 250 KB), Farbe
aus `theme-color` oder der häufigsten Markenfarbe im CSS (Grau, Schwarz,
Weiß und die Bootstrap-Standardpalette zählen nicht). Nur https, 8 s Timeout,
Größenlimits, nichts von der Seite wird ausgeführt. Was sich nicht finden
lässt, fällt einzeln auf neutral zurück.

## Wie es funktioniert

| Baustein     | Umsetzung                                                          |
| ------------ | ------------------------------------------------------------------ |
| Multi-User   | Server-Sent Events, ein Stream pro Browser, Broadcast bei Änderung |
| Persistenz   | SQLite über `node:sqlite`, Datei unter `DB_PATH`                   |
| Präsenz      | Anzahl offener SSE-Streams                                         |
| Identität    | uid + Name im `localStorage`, keine Anmeldung                      |
| Positionen   | als Bruchteile der Brettfläche gespeichert, geräteunabhängig       |

Auf dem Handy fließen die Notizen als Spalte statt frei positioniert. Die
Koordinaten bleiben erhalten und gelten wieder auf dem großen Schirm.

## Umgebung

| Variable      | Default            | Zweck                                   |
| ------------- | ------------------ | --------------------------------------- |
| `PORT`        | `8080`             | Port des Servers                        |
| `DB_PATH`     | `./data/board.db`  | Ort der SQLite-Datei                    |
| `THEME_PATH`  | `./theme.json`     | Branding                                |
| `APP_VERSION` | aus `.app-version` | Was in der Ops-Leiste als Version steht |

## Deploy

```bash
docker build -t board . && docker run -p 8080:8080 board
```

Das Image läuft auf `distroless/nodejs24` als nonroot (65532), ohne Shell.
`/healthz` liefert Status, Version und Uptime. Für Persistenz über den Pod
hinaus ein Volume mounten und `DB_PATH` darauf zeigen lassen.

**Eine Replica.** SQLite und der SSE-Broadcast leben im Prozess, zwei Pods
hätten zwei getrennte Boards. Für ein Board in einem Raum reicht das.

## API

| Route                     | Methode | Zweck                                                    |
| ------------------------- | ------- | -------------------------------------------------------- |
| `/api/state`              | GET     | Alle Notizen + Präsenz                                   |
| `/api/events`             | GET     | SSE-Strom (`neu`, `bewegt`, `stimme`, `weg`, `praesenz`) |
| `/api/notizen`            | POST    | Notiz anlegen                                            |
| `/api/notizen/:id`        | PATCH   | Position setzen                                          |
| `/api/notizen/:id`        | DELETE  | Eigene Notiz löschen (`?uid=`)                           |
| `/api/notizen/:id/stimme` | POST    | Hochstimmen                                              |
| `/theme.json`             | GET     | Geprüftes Branding                                       |
| `/healthz`                | GET     | Status, Version, Uptime, Zähler                          |
