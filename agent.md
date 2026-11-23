# Personal Markdown Notes Server — As-Built Specification

## 1. Overview

A self-hosted, single-user notes service. Notes are plain `.md` files on disk
(portable, greppable, future-proof), with a web UI reachable from any browser
(desktop or phone) through an existing HTTPS reverse proxy. Supports
attachments (images, PDFs, arbitrary files, voice recordings), bulk import and
export of portable bundles, full-text search, an optional AI OCR/captioning
worker, and one-click **Auto Tag** (keyword rules + sentence embeddings).

**Out of scope (current):**
- Multi-user accounts / permissions
- Real-time collaborative editing
- Native mobile apps (responsive web only)
- End-to-end encryption of note content
- TOTP 2FA (single password + rate-limited login only)

---

## 2. Architecture

```
[Browser: phone/desktop] --HTTPS--> [Your nginx] --HTTP:PORT--> [App container] <--internal HTTP--> [AI worker container]
                                                                        |                                  |
                                                                 [Docker volume: /data]           [Docker volume: /models]
                                                                   ├── notes/<note-id>/note.md      (Florence-2 / Tesseract /
                                                                   ├── notes/<note-id>/attachments/...  MiniLM weights, cached)
                                                                   ├── trash/<note-id>/            (soft-deleted notes)
                                                                   └── index/search.db (SQLite FTS5)
```

- The app serves plain HTTP on one port (`PORT`, default `8082`); nginx just
  needs a `proxy_pass`. The app container serves the built frontend as static
  files plus the API.
- Optional **AI worker** container (Python) performs OCR/captioning of images
  and PDFs (scheduled) and hosts the Auto-Tag embedding model. It talks to the
  main app only over the internal Docker network — never exposed externally.
- Two named volumes: `/data` (notes, trash, index, config — the critical
  one to back up) and `/models` (disposable AI weight cache).

### Stack decisions
| Layer | Choice | Why |
|---|---|---|
| Backend | Node.js + TypeScript + Fastify | Fast, small, excellent fs/streaming support, multipart uploads |
| Frontend | React 19 + Vite + TypeScript | Fast dev loop, small bundle |
| Editor | CodeMirror 6, Joplin-style | Live-inline preview decorations (headers/bold/italic render styled while still plain-text-editable), word wrap, code folding-friendly. Files stay 100% portable (no WYSIWYG lock-in) — see §5 |
| Search index | SQLite + FTS5 (`better-sqlite3`) | Zero external services, rebuildable from source `.md` files |
| Auth | Single-user password + signed session cookie | httpOnly, sameSite=strict, 30-day sliding; login rate-limited |
| AI worker (OCR + captions + voice) | Python + FastAPI sidecar, Florence-2-base (fallback Tesseract) | Small MIT models doing OCR *and* captioning on CPU — see §8 |
| Voice transcription | `faster-whisper` (`base`/`small`/`medium`, CPU int8) | On-demand Whisper for voice notes — loaded only while transcribing, dropped after — see §8.3 |
| Auto Tag classifier | Keyword rules (deterministic) + `all-MiniLM-L6-v2` embeddings | Vocabulary-bound (no tag explosion), reliable on short notes — see §8.2 |
| Scheduler | `node-cron` in the backend, calling worker `/process` | No external cron dependency; schedule configurable in Settings |
| Container | Docker, docker-compose (app + ai-worker) | Two volumes to back up (`/data` critical, `/models` disposable) |

---

## 3. Data Model & Storage Layout

```
/data
  /notes
    /2026-09-05-my-first-note-ab12/
      note.md              <- frontmatter + markdown body
      attachments/
        photo1.jpg
        recording.webm
        report.pdf
  /trash                     <- soft-deleted note folders (bin)
  /index
    search.db              <- SQLite FTS5, fully rebuildable, NOT source of truth
  /config
    auth.json               <- bcrypt password hash, session secret
    settings.json           <- AI worker settings incl. whisper_model (chmod 600)
```

**Note ID / folder naming:** `<YYYY-MM-DD>-<slug>-<short-hash>` — human-readable,
sortable, collision-proof, safe to `ls`/`grep` directly on disk.

**`note.md` format (YAML frontmatter + body):**
```markdown
---
id: 2026-09-05-my-first-note-ab12
title: My First Note
tags: [ideas, project-x]
created: 2026-06-01T10:00:00Z
updated: 2026-06-03T08:12:00Z
pinned: false
location:
  lat: 40.4168
  lon: -3.7038
  name: "Madrid, Spain"       # reverse-geocoded (Nominatim), optional/nullable
device: "iPhone / Safari"      # captured from User-Agent at creation, informational
word_count: 42
auto_tag_hash: a1b2c3…         # sha256 of last auto-tagged content (skip marker)
auto_tagged_at: 2026-09-08T10:00:00.000Z
---

# My First Note

Some **markdown** content, an image:

![diagram](attachments/photo1.jpg)

A recording: [recording.webm](attachments/recording.webm)
```

**Metadata design notes:**
- All extra metadata fields are optional in the schema — a hand-written `.md`
  file with just `title` still parses/imports fine.
- **Geolocation is opt-in per note** (`navigator.geolocation`) and reverse-
  geocoded client-side via **Nominatim** (free, no key) to `location.name`;
  raw lat/lon is stored so it can be re-geocoded later.
- `device` and `word_count` are auto-computed and shown read-only in the note
  info panel. The panel also shows total **note size** (note.md + attachments).
- `auto_tag_hash` / `auto_tagged_at` are written only by Auto Tag and never
  bump `updated` (a tag sweep is not a content edit).
- The serializer always writes a blank line between the closing `---` and the
  body; `parseNoteFile` strips the leading `\n` gray-matter returns, so
  round-trips are stable.
- `auto_tagged_at` **looks like a YAML timestamp** — js-yaml parses it into a
  `Date`, so the parser must accept both `Date` and string (see §13.12).

Attachments are referenced with plain relative markdown links/images; the
frontend rewrites them at render time to the authenticated API URL
`/api/notes/:id/attachments/:file`. Filenames are percent-encoded at insert
so raw spaces don't break markdown parsing; the resolver decodes once before
re-encoding (no `%25` doubling).

**Search index schema (SQLite FTS5):**
```sql
CREATE VIRTUAL TABLE notes_fts USING fts5(
  id UNINDEXED, title, body, tags, location_name, tokenize='porter unicode61'
);

CREATE TABLE attachment_text (            -- OCR/caption results, fed by the AI worker
  note_id TEXT NOT NULL, filename TEXT NOT NULL, extracted_text TEXT,
  source TEXT, processed_at TEXT,
  status TEXT DEFAULT 'pending',          -- pending | done | failed | skipped
  PRIMARY KEY (note_id, filename)
);

CREATE VIRTUAL TABLE attachment_text_fts USING fts5(
  note_id UNINDEXED, filename UNINDEXED, extracted_text, content='attachment_text'
);
```
Every note create/update/delete/import upserts the corresponding FTS row, and
`POST /api/reindex` rebuilds everything from disk. Search merges matches from
`notes_fts` and `attachment_text_fts`, so a note surfaces if the *note text*,
its *tags/location*, or the *content of an attached photo/PDF* matches.
Attachment OCR progress is appended into notes on disk as a
`## Transcribed Data` section (idempotent — reruns don't duplicate).

---

## 4. API Design

All `/api` routes require the session cookie except `POST /api/auth/login` and
`GET /api/health`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` `/api/auth/logout` | session |
| GET | `/api/auth/session` | session check |
| GET/POST | `/api/notes` | list (paged/sortable/filterable) / create |
| GET/PUT/DELETE | `/api/notes/:id` | read / update / soft-delete (→ bin) |
| POST | `/api/notes/batch/tags` | bulk tag add/remove `{ids, add?, remove?}`; 400 for empty/no-op, `missing` ids reported, `remove` wins over `add` |
| POST | `/api/notes/batch/delete` | bulk move-to-bin `{ids}`; `missing` ids reported |
| POST/GET/DELETE | `/api/notes/:id/attachments[/:filename]` | upload / stream / delete |
| GET | `/api/search?q=...` | full-text search (notes + attachment text) |
| GET | `/api/tags` | tag counts |
| POST | `/api/reindex` | rebuild search index from disk |
| GET | `/api/settings` | AI settings (enabled, model, schedule) |
| PUT | `/api/settings` | update AI settings |
| GET | `/api/transcription/status` | worker queue counts |
| GET | `/api/transcription/attachment/:noteId/:filename` | extracted text + status for one attachment |
| POST | `/api/transcription/run` | manually trigger a transcription pass |
| POST | `/api/autotag/run` | manually run the Auto Tag pass (needs ai-worker up) |
| POST | `/api/voice/transcribe` | on-demand Whisper transcription of a voice attachment `{noteId, filename}`; 409 while already running, 504 on worker timeout, 502 if worker unreachable |
| GET | `/api/linkpreview?url=…` | rich metadata for a pasted URL — YouTube/shorts via oEmbed (thumb + title), otherwise OpenGraph/`<title>` scrape; http(s) only, ~4.5s timeout, SSRF-guarded (private/loopback IPs blocked), 10-min in-memory cache |
| POST | `/api/import` | bulk import a `.zip` |
| GET | `/api/export` | stream a `.jex` backup tar |
| GET | `/api/trash` | list binned notes |
| POST | `/api/trash/:id/restore` | restore a binned note |
| DELETE | `/api/trash/:id` | purge one binned note |
| DELETE | `/api/trash` | empty the bin |

*(Internal-only, called by the backend, never exposed externally)*

| Method | Path (AI worker, internal network only) | Purpose |
|---|---|---|
| GET | `/health` | worker readiness (model loaded, pending count, model name, `busy` + `whisper_busy`) |
| POST | `/process` | **non-blocking**: starts a transcription pass in a background thread; replies immediately `{started, busy, model}`. Returns `{started:false, busy:true}` (HTTP 409 via backend) if a pass is already running |
| POST | `/autotag` | classify `{texts: [...]}` → per-text `[{tag, score, method}]` |
| POST | `/transcribe-voice` | transcribe `{note_id, filename, model?}` → `{transcribed, language, duration, text?, error?}`. Runs on-demand; result written to `attachment_text` (+ FTS) and appended to the note body. Single-flight: returns `busy:true` if another transcription is running |

**Concurrency guard (worker + backend):** `/process` used to run the whole
pass synchronously before replying, so any other request during a CPU-heavy
pass (Auto Tag, a second "Run transcription", the 20–30s client timeout)
timed out and was misreported as "AI worker unavailable / aborted". Now:
1. The worker runs the pass in a daemon thread and replies immediately with
   `{started:true, busy:true}`; a second `/process` while one is running
   returns `{started:false, busy:true, error}` (no double pass, no blocking).
2. The backend `POST /transcription/run` keeps a 20s timeout (a live health
   check readies the model), returns 409 with a clear "already running" message
   instead of a timeout, and converts a genuine abort into an explanatory
   502 rather than "container not running".
3. `POST /autotag/run` is single-flight (a second click → 409 "already
   running") and maps a worker timeout/abort to an explicit 504 ("worker
   busy", e.g. during a transcription pass) instead of "container missing".
   `WORKER_TIMEOUT_MS` is 1h in `backend/src/lib/autotag.ts` (a healthy
   worker replies per 40-note batch well under that).
4. `POST /api/voice/transcribe` is also single-flight (second request → 409
   "already running") and maps a worker timeout to an explanatory 504; the
   worker's `/transcribe-voice` itself is single-flight with its own
   `whisper_busy` flag so two concurrent requests can never double-load
   Whisper.

---

## 5. Frontend / UX Design (as built)

**Layout (responsive, mobile-first):**
- **Desktop (≥1024px):** three-pane — collapsible note list (left), editor
  (center), live preview (right; toggleable to split/full source). Pane and
  editor mode persist per device.
- **Mobile (<1024px):** single pane. Hamburger/sidebar opens the notes list;
  a floating **+** button creates a note (hidden whenever an editor pane is
  open). Editor gets a compact fixed source toolbar, and a **⋯** sheet
  (EditorMenu) on mobile for actions that the desktop chrome shows inline.
  The side info panel opens as a **full-screen overlay** and is `display:none`
  when closed (a `width:0` collapse would squash the stacked editor — §13.7).
- Mobile behaviour notes:
  - Opening an existing note on mobile starts in **live preview**;
  - Creating a **new** note starts in **source view** with the title focused
    (delayed 80ms focus for mobile-browser reliability), so you can type
    immediately.
- The note list **auto-refreshes every 5 minutes** and on tab
  `visibilitychange`, so edits made on another device appear without a manual
  reload (the interval is paused while the tab is hidden).

**Editor toolbox:**
- CodeMirror 6 with `lineWrapping` enabled (no horizontal scroll).
- Modes: **Source** / **Split** / **Live** (markdown-it for preview; live mode
  uses a decorations StateField — block widgets must come from a `StateField`,
  not a `ViewPlugin`, see §13.6). ⌘K focuses search.
- Rich toolbar (scrollable horizontally on mobile): **Bold**, *Italic*,
  Inline code, Code block, Header selector (H1–H6), Bullet list, Numbered
  list, Checklist, Horizontal rule, Table (with caret placed in first cell),
  Insert date & time, Attach file, Record voice note, More (⋯).
- Debounced autosave (~700ms) that reads the latest draft at fire time and
  triggers on title edits too — fast typing can't persist stale text (§13.3).

**Note info panel (desktop sidebar / mobile overlay):**
- **Tags** with a **▾ dropdown picker**: searchable list of all existing tags
  with counts, checkbox multi-select; checking/unchecking applies immediately
  and saves; closes on outside click / Escape.
- Pinned toggle, 📍 Tag current location (geolocation + Nominatim reverse
  geocode), created/updated, word count, device, and **Size** (note.md +
  attachments, human-readable).

**Other surfaces:**
- **Settings dialog:** AI transcription enable + model select + cron schedule
  + "Run transcription now"; **Voice model (Whisper)** select (`base`/`small`/
  `medium`, loads on demand — independent of the OCR toggle); **Auto Tag**
  button (always available); Import (`.zip`/`.jex`) and **Export backup (.jex)**.
- **Trash dialog:** list of binned notes with restore / delete-one / empty-all.
- **Import view:** drag a zip, see per-file imported/skipped/errored results.
- **Voice recording:** MediaRecorder → webm / ogg / **m4a (iOS Safari)**,
  uploads on stop, auto-inserts an audio embed link at the cursor; a
  **▶ Transcribe voice** button appears under the record control (targeting
  the last recording) and audio attachments offer a per-row **Transcribe**
  action — see §8.3.
- Autosave status is announced via `role="status"` / `aria-live="polite"`;
  empty states and failures are worded in-product ("saved", "imported"),
  not generic placeholders.

**Visual direction (as built):** calm single-accent utility UI (near-neutral
base + one accent, dark-mode via `prefers-color-scheme`), information density
over decoration, monospaced/technical type in the editor pane, motion reserved
for user-triggered transitions only, consistent verbs end-to-end (Save/Saved,
Delete/Deleted, Import/Imported).

---

## 6. Security Considerations (as built)

- Single bcrypt-hashed password in `/data/config/auth.json` (bootstrapped via
  CLI, never in git).
- Session cookie `httpOnly`, `sameSite=strict`, `secure` behind HTTPS
  (`COOKIE_SECURE`), 30-day sliding expiry with HMAC signature.
- Login rate-limited (5 attempts / 15 min per IP).
- Uploads validated: `sanitizeFilename` (no path traversal), configurable
  `MAX_UPLOAD_MB`, files count limit
- Headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`; global rate-limit on the API.
- `TRUST_PROXY` gates trusting `X-Forwarded-*` (only ever behind your nginx).

---

## 7. Docker & Deployment

- **App image** (backend multi-stage): Vite frontend build → `tsc` → slim
  node image serving static frontend + API.
- **AI worker image** (`python:3.11-slim`, CPU): `torch`/`torchvision` from
  the **CPU wheel index** in the Dockerfile (avoids the ~5.5GB CUDA stack);
  `requirements.txt` holds the rest. `transformers` is pinned `<5`
  (transformers 5.x has no `Florence2LanguageConfig.forced_bos_token_id`, which
  breaks Florence-2's remote config); `einops`/`timm` are runtime deps of the
  Florence-2 modeling code. `faster-whisper` (voice transcription) lives in its
  **own** `RUN pip install --no-cache-dir faster-whisper` layer.
- **Build-layer rule (critical):** `torch`, `torchvision`, `transformers`,
  `einops`, `timm`, and `faster-whisper` must stay in their dedicated `RUN pip
  install` layers in the Dockerfile, **not** merged into `requirements.txt` —
  touching that file invalidates the base pip layer and forces a ~2.7GB
  re-download. The `COPY app ./app` layer is the only thing that changes on
  worker code edits.
- Two compose services: `app` (host port, volume `/data`) and `ai-worker`
  (no host port, internal network only, volume `/models`, gated by the `ai`
  profile). Environment: `PORT`, `SESSION_SECRET`, `TRUST_PROXY`,
  `COOKIE_SECURE`, `MAX_UPLOAD_MB`, `ENABLE_AI_TRANSCRIPTION`,
  `TRANSCRIPTION_SCHEDULE`; worker gets `TRANSCRIPTION_MODEL` + `WHISPER_MODEL`.
- Backup story: `/data` is critical (`rsync`/tar or Settings → Export `.jex`);
  `/models` is a disposable cache that re-downloads if lost.

---

## 8. AI OCR & Captioning Pipeline

**Goal:** make photos and PDFs searchable by *content* — a scanned receipt
matches "electricity bill", a textless photo matches "sunset at the beach".
Runs as a scheduled batch job (default nightly) so it never blocks
note-taking; a manual pass is available in Settings.

- **Florence-2-base** (primary): one model for both OCR (`<OCR>` task prompt,
  used for scanned PDFs / screenshots / photos of text) and captioning
  (`<DETAILED_CAPTION>` for textless photos). `florence-2-large` and
  **Tesseract** (pure OCR, no captioning, no torch) are alternates.
- Weights auto-download from HF Hub into `/models` on first use; runtime
  switchable via `PUT /api/settings` without touching Docker config.
- Images: run OCR; if ≥5 letter-words, treat as text image, else caption.
  PDFs: use embedded text when present (cleaner), rasterize otherwise
  (`pypdfium2`) and run the image pipeline per page.
- Results land in `attachment_text` (+ FTS) and are appended to the note body
  as `## Transcribed Data (<file>)` — idempotent across reruns.
- Worker internals sit behind a `run_image(image, model) -> (text, source)`
  adapter so a different VLM can replace Florence-2 later.

### 8.2 Auto Tag (A+B classifier)

A manual, one-click classification pass (`Settings → Auto Tag`) that assigns
general tags to every note while keeping the tag set bounded.

- **Vocabulary-bound:** the classifier only ever returns tags from a fixed
  curated list (~14 general tags: Work, Personal, Ideas, Finance, Travel,
  Recipes, Health, Tech, Shopping, Home, Car, Study, Diary, Books). No tag
  explosion — this list is editable in `ai-worker/app/tagging.py`.
- **Two mechanisms:**
  - *Option A (keyword rules):* each tag has distinctive keywords with
    weights; a single dominant tag (score ≥2 with a clear margin) is returned
    deterministically, no model involved.
  - *Option B (embeddings):* the note text is embedded with
    `all-MiniLM-L6-v2` (~90MB, CPU) and compared against per-tag centroids
    built from hand-written exemplar sentences. Cosine ≥ 0.32 (top 2 tags)
    → tagged. MiniLM is a *sentence* model, so short notes are handled well.
- **Input text:** title + markdown-stripped body + OCR'd attachment text from
  the index.
- **Skip-if-unchanged:** each note's content is fingerprinted (sha256) and
  stored in frontmatter as `auto_tag_hash`. Only notes whose hash differs are
  re-classified, so subsequent runs are near-instant and never re-tag
  untouched notes — unless the content is edited.
- **Merging, not overwriting:** auto tags are *added* to a note's existing
  tags (never duplicating, never removing manual tags), and never bump the
  note's `updated` timestamp.
- **Threshold honesty:** notes with no confident tag are left untagged (and
  still marked processed), instead of forcing a wrong tag.
- Low-confidence results remain tunable via `VECTOR_MIN`, `VECTOR_TOPK`,
  `KEYWORD_MIN`, and the keyword/exemplar data in `tagging.py`.

### 8.3 Voice transcription (Whisper, on-demand)

A phone/desktop voice note can be transcribed with Whisper, *on demand only*:
the model is **not** preloaded — it loads on the first request and is dropped
(`del` + `gc.collect()`) as soon as that request finishes, so an idle worker
holds no Whisper state.

- **Stack:** `faster-whisper` (CTranslate2 + PyAV, no ffmpeg binary) in a
  dedicated Docker layer (§7 build-layer rule). CPU int8; `small` default.
  Formats: webm/opus, ogg/opus, **m4a/aac (iOS Safari)** — decoded via PyAV.
- **Model choice:** `base` (~150MB) / `small` (~500MB) / `medium` (~1.5GB),
  selected in Settings → stored as `whisper_model` in `settings.json`; worker
  default `WHISPER_MODEL` env (`small`). First use downloads into `/models`
  (HF Hub, CTranslate2 conversion); we pre-download at deploy so real first
  use is instant.
- **Languages:** auto-detected, **restricted to English/Spanish**. If the
  detected language is anything else the request is refused with a clear
  message ("Detected French — only English and Spanish voice notes are
  transcribed") instead of transcribing gibberish.
- **Result path:** identical to OCR — written to `attachment_text` (`source`
  = `whisper-<model>:<lang>`, status `done`), searchable via FTS, appended to
  the note body as `## Transcribed Data (<file>)`, and fed to Auto Tag's
  extracted-attachment text. Re-runs are idempotent.
- **Guards:** worker-level single-flight (`whisper_busy`) so two concurrent
  calls can't double-load the model; backend single-flight (409). An OCR pass
  never clobbers an already-transcribed voice file (`process_one` checks for
  a prior `done` row before marking audio "skipped").
- **UX:** the "Transcribe voice" button shows a spinner and is disabled while
  running; the request keeps processing server-side even if the panel is
  closed, and the editor refetches the note when it completes so the appended
  transcript appears immediately.

---

## 9. Delivered Features

All implemented, tested, and deployed — use as the baseline; nothing below is
pending:

1. **Core note CRUD** — create/read/update/delete, frontmatter handling,
   atomic writes, trash/bin with restore + empty.
2. **Rich metadata** — tags, geolocation capture + Nominatim reverse-geocode,
   device, word count, note size; tag dropdown picker in the info panel.
3. **Attachments** — upload/list/delete/serve; images inline, media players,
   drag-and-drop, sanitized filenames, size limits.
4. **Voice recording** — MediaRecorder → webm/ogg/m4a (iOS Safari),
   auto-embed; **▶ Transcribe voice** button + per-attachment Transcribe.
5. **Full-text search** — SQLite FTS5 (notes + OCR'd attachment text),
   snippets, per-field matching, rebuildable index.
6. **AI OCR/captioning pipeline** — Florence-2 (OCR + captions) / Tesseract
   fallback, scheduled + manual passes, per-attachment status.
7. **Auto Tag** — A+B classifier (keyword rules + MiniLM embeddings), fixed
   general vocabulary, skip-if-unchanged via content hash, tag-merging.
8. **Bulk import** — `.zip` of `.md` files (+ assets); JEX import supported.
9. **JEX export/backup** — deterministic tar download; clean re-import.
10. **Auth** — single-user login, HMAC cookie, rate limiting.
11. **Joplin-style editor** — Source/Split/Live panes, word wrap, rich
    toolbar (headers, lists, tasks, rule, table, time, code blocks).
12. **Responsive frontend** — desktop 3-pane; mobile single-pane + hamburger
    + FAB + full-screen info overlay + ⋯ sheet; mobile new-note flow.
13. **Multi-device freshness** — 5-minute polling + visibility refresh.
14. **Docker packaging** — app + ai-worker services, two volumes, nginx sample.
15. **On-demand voice transcription** — faster-whisper, en/es auto-detect,
    load-on-demand + unload, transcript appended to the note + searchable +
    Auto Tag input (§8.3).
16. **Bulk selection** — per-row checkboxes + select-all (visible list incl.
    search results); bulk **Tag…** (add/remove, typed or existing-tag picker
    chip) and **Move to bin** with inline confirm; action bar shows live count.
Backed by `batchUpdateTags`/`batchDelete` (storage) + batch routes
     (`remove` wins over `add`; no-ops skipped so `updated` isn't bumped;
     missing ids reported without failing the batch).
17. **Link previews** — a standalone pasted URL (or single `[text](url)` link)
     in markdown renders a rich card in the preview pane: thumb + title + host.
     Backend `lib/linkpreview.ts` fetches metadata server-side with an SSRF
     guard (http(s) only, private/loopback-IP block via literal check + DNS
     lookup), 4.5s timeout, size caps, 10-min in-memory cache. **Provider
     fast-paths:** YouTube (`extractVideoId` → `youtube.com/oembed`, falls back
     to `i.ytimg.com/vi/<id>/hqdefault.jpg`) and MakerWorld
     (`extractMakerWorldDesignId` from `/models/<id>` → anonymous
     `api.bambulab.com/v1/design-service/design/<id>` because makerworld.com
     page routes return a Cloudflare 403 challenge; `cleanHtml` strips
     tags/entities from `summary`). Every other URL goes to oEmbed discovery
     then OpenGraph/`<title>` scrape. Frontend renders cards
     **synchronously from React state** (NOT async DOM surgery — the original
     approach left "Loading preview…" stuck when `dangerouslySetInnerHTML`
     replaced the subtree mid-fetch): `markdown.ts` emits a `.link-preview
     loading` placeholder for single-link paragraphs (linkify/`[x](y)` only,
     media/attachment links excluded) or the full `.link-preview-card` when the
     URL is already in the `previews` map; `Preview.tsx` owns that map, fetches
     via `GET /api/linkpreview` after a 350ms debounce (so partly-typed URLs
     don't storm the API), caches per-URL module-wide (nav-away/back renders
     instantly), and drops the card when the backend has no preview. A failed
     preview keeps just the plain link; client fetch has an 8s timeout so the
     loader can never hang forever.

---

## 10. Assumptions (still in force)

- Single user, no accounts system.
- nginx (or equivalent) terminates HTTPS; the app exposes one internal HTTP
  port and `TRUST_PROXY` opts into trusting `X-Forwarded-*`.
- The editor keeps the file as plain portable markdown at all times —
  "live preview" means *styled-while-typing*, not a separate rich format.
- "Import in bulk" means a folder/zip of `.md` notes (possibly with images).
- Attachment size / total storage limited only by disk; no S3.
- No offline/PWA requirement.
- AI runs locally in the sidecar container (privacy-preserving, CPU-capable);
  cloud APIs are not required for OCR/captioning or auto-tagging.
- Geolocation captured client-side only when the user explicitly opts in.

---

## 11. Repo conventions for agents

- **Verify, don't eyeball:** use `npm run typecheck`, `npm test` (backend
  vitest suite: 8 files, 63 tests), `npm run build` (frontend), and
  `scripts/verify-api.sh` (22 HTTP checks against a running server). Deploy
  check: `docker compose build app` + `up -d` + `curl http://localhost:8082/`.
- **Small, independent turns:** one feature per session; commit after each
  completed unit. Keep `git diff`/scoped reads over whole-file re-reads.
- **Backend storage fixtures** in tests set `DATA_DIR` to a fresh temp dir
  *before* importing storage modules (they read env at load); isolate each
  test with a fresh notes dir.
- **Frontend tsconfig** is `strict` with `noUnusedLocals` /
  `noUnusedParameters` — unused exports/imports fail the build.
- **Never** move torch/transformers layers into `requirements.txt` (see §7
  build-layer rule). When iterating on the worker, rebuild only the app-copy
  layer.
- This file is the project's persistent memory: re-read it at the start of a
  session to recover context, and append new post-build constraints to §13
  rather than rewriting history.

---

## 12. Post-build fixes & constraints (applied during implementation)

1. **Empty `GET /api/notes` list with correct `total`.** The route passed
   `limit: 0` to `listNotes`, and storage paginates with `slice(offset,
   offset + limit)` — so lists came back `notes: []` while `noteCount` was
   right. Fix: pass `limit`/`offset` straight through. Guarded by storage and
   verify-api.sh tests.
2. **DELETE → 400 "Bad Request".** The frontend `request()` helper set
   `Content-Type: application/json` on body-less DELETEs; Fastify then tried
   to parse the empty body. Fix: send the header only when a body exists.
3. **Stale autosave ("ttt" saved as "tt").** The debounced `save` read draft
   state at call time and was recreated on every dep change. Fix: `save` is
   stable per note (`[note.id]`); draft and `onChanged` are read via refs at
   fire time. Title edits also trigger the debounced save.
4. **Phantom empty first line.** gray-matter returns the `---\n\n` separator
   as a leading `\n` in body; it round-tripped into the editor. Fix: strip
   one leading `\n` in `parseNoteFile`; existing notes self-heal on save.
5. **Broken attachment images.** Stored links stay portable (`attachments/…`);
   the frontend rewrites them at render to the API URL. Uploaded filenames
   are percent-encoded (raw space breaks markdown); the resolver decodes once
   (no `%25` doubling). Own-line images embed as block widgets.
6. **Live-mode widgets crash.** CodeMirror throws `Block decorations may not
   be specified via plugins` — block `<img>` widgets must come from a
   `StateField`, not a `ViewPlugin`.
7. **Mobile editor squeezed to a sliver.** The always-mounted `.side-info`
   panel's `width:0` collapse reclaims no vertical space once mobile stacks
   columns; the invisible height starved the editor. Fix: `display:none`
   when closed on mobile + `min-height:0` on the editor pane; redundant
   mobile controls hidden, toolbar compacted.
8. **SPA fallback 404s.** `fastifyStatic` must not be registered with
   `decorateReply: false`, or `reply.sendFile("index.html")` is unavailable.
9. **AI worker scope.** Worker = OCR + captioning (Florence-2/Tesseract) +
   **on-demand voice transcription** (faster-whisper, §8.3), weights in
   `/models`; no ffmpeg binary in the image (PyAV decodes audio). OCR is
   adapted behind `run_image(image, model) -> (text, source)`; voice behind
   `app/transcribe.py`.
10. **Whisper never blocks startup.** `faster-whisper` is imported lazily
    inside `transcribe.py` only when a voice note is transcribed; the health
    endpoint reports `whisper_busy`. Voice results must not be overwritten by
    an OCR pass: `process_one` leaves a `done` row alone when an attachment is
    an unsupported type.
11. **Prefix-phrase search.** `"untitl"` matched "untitled" but not
    "untitledvoic". Fix: quoted prefix phrases (`"token"*`) — safe (special
    chars stay inside quotes) and matches every term with that prefix;
    multi-word queries keep AND semantics.
12. **Mobile FAB stayed visible over the editor.** The hide rule needed
    `[data-pane="editor"] .mobile-fab { display:none }`, but the FAB was
    rendered *outside* `.home-layout`, so the selector never matched. Fix:
    FAB is a direct child of `.home-layout` (sibling of aside/main).
13. **`auto_tagged_at` round-tripped as `null`.** js-yaml parses ISO-looking
    frontmatter values (`2026-01-01T00:00:00Z`) into `Date` objects, so a
    `typeof === "string"` guard silently dropped it. Fix: the parser accepts
    `Date` or string and normalizes to ISO.
14. **Auto Tag must not masquerade as an edit.** Applying tags went through
    `updateNote`, which bumped `updated` and reordered the list. Fix:
    `patchNoteMeta()` writes only metadata (tags, auto-tag bookkeeping),
    preserves `updated`, and atomically renames like the normal update path.
15. **Auto-tag orchestration is testable without a GPU.** `runAutotag`
    accepts an injectable worker call; the vitest suite proves skip-hash,
    merge-no-duplicate, no-confidence → processed, and `updated` preservation.
16. **Build-layer rule for the worker image.** `torch`/`torchvision` come from
    the CPU wheel index and `transformers~4.x`, `einops`, `timm`,
    `faster-whisper` live in dedicated Dockerfile `RUN` layers. Do not fold
    them into `requirements.txt` (see §7).