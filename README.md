# Notes — self-hosted personal markdown notebook

A single-user notes server that stores everything as plain markdown files and
frontmatter on disk. Every note is a real folder with a readable `note.md`, so
the data is yours forever — open it in any editor, back it up with `rsync`,
export a portable `.jex` bundle, or import a `.zip` from another notes app.

## Features

- **Markdown storage** — each note is `data/notes/<id>/note.md` with YAML
  frontmatter (title, tags, created, updated, pinned, location, device,
  word count, and auto-tag bookkeeping). No database lock-in.
- **Editor** — CodeMirror 6 with source / split / live-inline preview modes,
  **word wrap** on, debounced autosave, word count, and a rich toolbar:
  bold, italic, inline code, code block, header picker (H1–H6), bullet /
  numbered / task lists, horizontal rule, table insert, date-time insert,
  attach file, and voice note. ⌘K focuses search.
- **Full-text search** — SQLite FTS5 across note body, title, tags, location
  and extracted attachment text, with snippets and attachment matches.
- **Attachments** — drag-and-drop any file into a note; images render inline,
  video/audio get native players.
- **Geolocation** — tag a note with your current location via
  `navigator.geolocation` and reverse-geocode to a place name
  (Nominatim, free, no API key).
- **Voice notes** — record from the browser (MediaRecorder → webm / ogg /
  **m4a on iOS Safari**) and insert as an attachment. A **▶ Transcribe voice**
  button under the record control (and a per-attachment **Transcribe** action
  on audio files) transcribes the clip **on demand** with Whisper — extract the
  text out of a recording. English/Spanish are auto-detected.
- **Note info panel** — tags **with a dropdown picker** (searchable, shows
  counts), pinned toggle, current location, created/updated timestamps, word
  count, device, and total **note size** (note.md + all attachments).
- **Trash / bin** — deleted notes move to a bin; restore or empty it.
- **Bulk actions** — checkbox-select any number of notes (a **select-all**
  toggle covers the whole visible list; selection also works while searching)
  and apply one of **Tag…** (add or remove a tag, typed or from an existing-tag
  picker) or **Move to bin**. An action bar shows the live count and a ✕ clears
  the selection.
- **Link previews** — a bare pasted URL (or `[link](url)`) that stands alone in
  the markdown preview shows a rich card (thumbnail + title + host): YouTube via
  oEmbed, everything else via OpenGraph/`<title>` scrape. Fetches happen
  server-side (SSRF-guarded) so no CORS errors.
- **Zip import** — bulk-import another notes app's export (Obsidian/Notion-style
  `Title.md` and `Title/attachments/` layouts).
- **JEX export** — download the whole notebook as a portable, deterministic
  backup bundle from Settings.
- **Auto Tag** — a manual, one-click classifier that reads every note and
  assigns general tags from a fixed vocabulary (keyword rules + small
  sentence-embedding model). Notes already scanned are skipped unless their
  content changed; auto tags merge with yours and never overwrite them.
- **Multi-device freshness** — the note list auto-refreshes every 5 minutes
  and immediately when the tab regains focus, so edits from another device
  show up without a manual reload.
- **Responsive UI** — three panes on desktop (list / editor / preview),
  single-pane on mobile with a hamburger menu and a floating “new note”
  button. New notes on mobile open in source view with the cursor already in
  the title field, ready to type.
- **Optional AI worker** — a separate container runs OCR *and* image
  captioning on photos and PDFs (Florence-2, or pure-OCR Tesseract
  fallback); extracted text and captions become searchable via FTS5.
  It also runs **on-demand Whisper voice transcription** (faster-whisper;
  model loads only while transcribing, then unloads). Auto Tag reuses this
  worker container for its embedding model.
- **Single-user auth** — bcrypt password, HMAC-signed session cookie
  (30-day sliding expiry, httpOnly, sameSite=strict), login rate limiting.

## Quick start (Docker)

```bash
cp .env.example .env
# set a strong SESSION_SECRET in .env
docker compose up -d
docker compose exec app node /app/backend/dist/lib/bootstrap.js
# or:  node /app/backend/dist/lib/bootstrap.js  (asks for a password)
```

Open `http://localhost:8082` and sign in.

> Bootstrap sets your login password on first run — do it before making it
> publicly reachable. `SESSION_SECRET` overrides the persisted session secret.

### With the AI worker (optional)

```bash
docker compose --profile ai up -d
```

Then in the app's **Settings** dialog enable "AI transcription", pick
Florence-2 base / Florence-2 large / Tesseract (or set `TRANSCRIPTION_MODEL`
for the worker), and optionally run a manual pass. **Auto Tag** is always
available and only needs the worker container running. The first use of each
model downloads its weights (Florence-2 ~460MB, MiniLM ~90MB) into the
persisted `models` volume (`/models`).

> Standard `docker compose up -d` skips the AI worker because the model
> downloads make the image several GB. Enable it only if you want OCR /
> captions / auto-tagging — especially on machines without a powerful GPU.

The app reaches the worker over the internal Docker network at
`http://ai-worker:8000`. This is the default and needs **no configuration** —
the `app` container resolves the service name `ai-worker` on the shared compose
network. If your worker runs under a different project/host, set
`AI_WORKER_URL` in `.env` (it is forwarded to the app container by
docker-compose). A common symptom of a wrong/missing URL is `AI worker
unavailable: fetch failed` in the UI, or workers that show as running while
transcriptions never start.

## Running locally (dev)

Requires Node 20+ (built against 26) and npm >= 11.

```bash
# backend
cd backend && npm install
npm run setup-password        # creates data/config/auth.json
npm run dev                   # http://localhost:8082

# frontend (separate terminal)
cd frontend && npm install
npm run dev                   # vite on :5173, proxies /api -> :8082
```

npm 12 blocks install scripts by default; if `better-sqlite3` / `esbuild`
warn about blocked scripts, approve them:

```bash
npm install-scripts approve better-sqlite3 esbuild
npm rebuild better-sqlite3    # no prebuilt binary for very new Node versions
```

## Data layout

```
data/
├── notes/
│   └── 2026-09-05-photo-notes-a1b2/
│       ├── note.md              # frontmatter + markdown body
│       └── attachments/         # uploaded files
├── trash/                       # soft-deleted notes (bin)
├── index/search.db              # FTS5 index (rebuildable via POST /api/reindex)
└── config/                      # auth.json, settings.json (chmod 600)
```

Note frontmatter may also carry `auto_tag_hash` / `auto_tagged_at` — the
bookkeeping Auto Tag uses to skip notes whose content is unchanged since the
last run.

Back up the whole `data/` directory (or export a `.jex` from Settings). Notes
on disk are always the source of truth — the search index can be rebuilt with
the Settings dialog or `POST /api/reindex`.

## nginx reverse proxy

Sample configs in [`nginx/notes.conf`](nginx/notes.conf). Behind a proxy set
`TRUST_PROXY=true` and `COOKIE_SECURE=false` (plain HTTP) or keep it `true`
behind HTTPS.

## Production deployment (SWAG / nginx)

The app runs as plain HTTP on port 8082 and the proxy terminates HTTPS. The
following assumes `https://n.DOMAINNAME` on a fresh machine that proxies all
traffic to `127.0.0.1:8082` on the same host.

```bash
# 1) copy the project to the production machine (docker + compose plugin required)
#    - rsync/scp the whole folder. NOTE: `.env` and `data/` are gitignored:
#      copying just the git checkout gets you neither.
#    - copy `data/` too if you want your existing notes AND the same login
#      (auth.json + settings.json live there). For a fresh start, leave it out.

# 2) environment  (web_note/.env)
cp .env.example .env
openssl rand -hex 32        # -> put in SESSION_SECRET; keep it once set openssl rand -hex 32
# COOKIE_SECURE=true        (must stay true behind HTTPS)
# MAX_UPLOAD_MB=512         (keep in sync with nginx client_max_body_size)
# ENABLE_AI_TRANSCRIPTION=true   (needs docker compose --profile ai up -d --build)
# AI_WORKER_URL=http://ai-worker:8000  (default; only set if the worker is elsewhere)

# 3) build & start — INCLUDING the AI worker (OCR / captions / Auto Tag / Whisper)
docker compose --profile ai up -d --build

# 4) first-time password (SKIP if you copied data/ from this machine)
docker compose exec app node /app/backend/dist/lib/bootstrap.js

# 5) verify
curl -I https://n.DOMAINNAME/api/health
```


### Gotchas

- **`--profile ai` is mandatory.** A bare `docker compose up -d` silently skips
  the AI worker — OCR, captions, Auto Tag, and Whisper transcription all stop
  working. Always use `docker compose --profile ai up -d --build`.
- **First-run model downloads:** the `models` volume starts empty, so
  Florence-2 (~460 MB) pulls at worker startup and MiniLM (~90 MB) and
  whisper-small (~500 MB) lazily on first use. Pre-warm Whisper so the first
  real transcription isn't slow:
  ```bash
  docker compose --profile ai exec ai-worker \
    python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"
  ```
- **Forwarded headers:** SWAG's `proxy.conf` include already sets
  `X-Forwarded-Proto`/`Host`, which the app needs (`TRUST_PROXY=true` is baked
  into docker-compose). `COOKIE_SECURE=true` then issues Secure cookies
  correctly.
- **Transcription timeouts:** the default 60 s nginx `proxy_read_timeout`
  kills long Whisper/OCR requests — raise it as shown above.
- **Port binding:** the app binds `0.0.0.0:8082`. If the production box is
  internet-reachable and you only need nginx-on-the-same-host to reach it,
  change the compose mapping to `"127.0.0.1:${PORT:-8082}:8082"` and open only
  port 443 to the internet.
- **Small CPU:** Whisper `small` runs ~1–2× realtime on a modern CPU (int8).
  Pick `base` in Settings for faster/lower-quality output.
- **Backups:** back up `./data/` (notes, search index, auth). The `models`
  volume is a re-downloadable cache — no need to back it up. `GET /api/export`
  (.jex) is a belt-and-suspenders option.

## API overview

All routes under `/api` require the session cookie except `POST /api/auth/login`
and `GET /api/health`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/auth/login` `/api/auth/logout` | session |
| GET | `/api/auth/session` | session check |
| GET/POST | `/api/notes` | list / create |
| GET/PUT/DELETE | `/api/notes/:id` | read / save / delete |
| POST | `/api/notes/batch/tags` | bulk tag add/remove `{ids, add?, remove?}` (400 for empty ids/no-op, missing ids reported) |
| POST | `/api/notes/batch/delete` | bulk move-to-bin `{ids}` (missing ids reported) |
| POST/GET/DELETE | `/api/notes/:id/attachments[/:file]` | upload / stream / delete |
| GET | `/api/search?q=` | full-text search |
| GET | `/api/tags` | tag counts |
| POST | `/api/reindex` | rebuild search index |
| GET/PUT | `/api/settings` | AI worker config |
| GET | `/api/transcription/status` | worker queue status |
| GET | `/api/transcription/attachment/:note/:file` | extracted text for one attachment |
| POST | `/api/transcription/run` | start a transcription pass (non-blocking; 409 "already running" if a pass is active) |
| POST | `/api/autotag/run` | trigger the Auto Tag pass (single-flight; 409 if already running, 504 if the worker is busy) |
| POST | `/api/voice/transcribe` | on-demand Whisper transcription of a voice attachment `{noteId, filename}` (409 while already running, 504 if the worker times out) |
| GET | `/api/linkpreview?url=…` | rich metadata for a pasted URL (YouTube + MakerWorld fast-paths, otherwise oEmbed/OpenGraph scrape); SSRF-guarded |
| POST | `/api/import` | zip import |
| GET | `/api/export` | full backup download (`.jex` tar) |
| GET | `/api/trash` | list binned notes |
| POST | `/api/trash/:id/restore` | restore a binned note |
| DELETE | `/api/trash/:id` | purge one binned note |
| DELETE | `/api/trash` | empty the bin |

## Project layout

| Path | What it is |
| --- | --- |
| `agent.md` | the as-built specification this project follows |
| `backend/` | Fastify + TypeScript API, storage, search, scheduler, auto-tag orchestration |
| `frontend/` | React 19 + Vite + CodeMirror 6 SPA |
| `ai-worker/` | optional Python sidecar (FastAPI: Florence-2 OCR/captioning, Tesseract, MiniLM auto-tag, on-demand Whisper voice transcription) |
| `scripts/verify-api.sh` | end-to-end API test suite (22 checks) |
| `nginx/` | reverse-proxy sample |
| `docker-compose.yml` | backend + optional AI worker stack |

## Development checks

```bash
cd backend  && npm run typecheck && npm test    # vitest suite (63 tests)
cd frontend && npx tsc --noEmit   && npm run build
bash scripts/verify-api.sh          # against a running server (BASE/PASS/DATA_DIR env)
```
