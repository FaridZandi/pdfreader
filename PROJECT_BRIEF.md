# PDF Reader — project brief

Last verified: **2026-10-11** against repository code and configuration.
Read [AGENTS.md](AGENTS.md) and the canonical [TODO.md](TODO.md) before work.
[README.md](README.md) is the detailed usage guide; [ROADMAP.md](ROADMAP.md)
is historical design context, not a second backlog.

## Purpose and entry points

A local PDF read-aloud app for navigating papers with source-linked paragraphs,
search, highlights, notes, collections, and WAV export. Kokoro produces American
English speech; Docling extracts structured text; PDF.js renders pages.

Open `http://127.0.0.1:8080/` (`/index.html` also works). **Add PDF** imports a
local file; **From URL** downloads a PDF or prints a web page with Chromium, then
imports it. **Paste text** opens a temporary reader without a PDF. Saved gallery
cards reopen documents; **Import library** restores a library archive. Full-page
and listen-only views share the speech queue. See the README for controls.

## Run and dependencies

From the repository root:

```sh
PYTHON_BIN=python3.11 ./scripts/setup.sh
./scripts/run.sh                 # defaults to port 8080
./scripts/run.sh --port 8081      # optional alternate port
```

Setup creates `.venv`, installs [requirements.txt](requirements.txt), runs
`npm ci`, syncs PDF.js, and installs Playwright Chromium. README recommends
Python 3.11 (supported range stated there: 3.10–3.13), Node/npm, and macOS
`espeak-ng`. The `source` and `columns` extraction engines additionally require
Poppler's `pdftotext` on PATH; setup does not install system tools.

Kokoro is upstream code pinned to a Git revision, not vendored or modified here;
Docling is pinned to 2.117.0. [package.json](package.json) pins PDF.js 6.2.108 and
uses `@playwright/test` for both tests and runtime web-page printing; exact npm
resolution is in `package-lock.json`. Chromium is installed by Playwright outside
the repository. Model files download on first use; no remote speech API exists.

## Architecture and ownership

| Source | Responsibility |
| --- | --- |
| [local_webui.py](local_webui.py) | Python threaded localhost server; Docling/Poppler extraction, URL fetching, Kokoro synthesis and export. Inference is serialized per chunk. |
| [local_webui.html](local_webui.html), [webui/app.css](webui/app.css) | Markup/icon sprite and stylesheet. |
| [webui/app.mjs](webui/app.mjs) | UI orchestration, import queue (one extraction at a time per tab), resume/preferences, temporary text sessions, export and backup actions. |
| [webui/lib/speech.mjs](webui/lib/speech.mjs), [webui/lib/text.mjs](webui/lib/text.mjs) | Speech queue/chunks, cancellation, prefetch/cache/playback; pure text, filtering and paragraph helpers. |
| [webui/lib/db.mjs](webui/lib/db.mjs), [webui/lib/backup.mjs](webui/lib/backup.mjs) | IndexedDB schema/operations and portable archive encoding/restore. |
| [webui/lib/pdf-view.mjs](webui/lib/pdf-view.mjs), [webui/lib/drawer.mjs](webui/lib/drawer.mjs), [webui/lib/library.mjs](webui/lib/library.mjs) | PDF geometry/overlays, outline/text/search/highlights, gallery/collections. |

The browser uses `/api/voices`, `/api/extract-pdf`, `/api/synthesize`,
`/api/export-audio`, and `/api/fetch-url`. Handwritten modules are served at
`/app/`; generated PDF.js assets at `/static/`. Application assets use `no-store`;
Python edits need a server restart. Refresh generated assets with
`npm run sync-pdfjs` after dependency updates; never edit `webui_static/pdfjs/`.

## Data and network behavior

- Browser-origin IndexedDB `pdfreader`, schema v6, stores document metadata,
  PDF files/previews, extractions, annotations, collections/memberships, and
  generated speech. Imported PDFs are retained by default. Quota is checked and
  persistent storage requested, but the browser may decline persistence.
- `localStorage` holds `pdfreader.resume.<document SHA-256>` positions/settings
  and global voice, speed, engine, preset and bracket preferences. Different
  ports/hostnames or browser profiles have different libraries.
- Speech is generated at 1x and played at the selected rate. `audio` blobs and
  `audioMeta` sizes/use-times are separate stores; LRU eviction caps speech at
  250 MiB. Document deletion removes its related records/audio; Clear library
  also removes resume records, retaining global preferences.
- Export library downloads a JSON archive of PDFs and reading data, including
  resume records; generated audio and global preferences are excluded. Import
  replaces the library after confirmation and first requests a backup download.
  Restore validates records and uses an IndexedDB transaction plus resume
  rollback. This is a manual backup, not automatic server-side persistence.
- Pasted text/audio live only in memory until reader close/reload, with no saved
  document, resume record or audio cache; voice/speed preferences still persist.
- Server extraction/printing uses `tmp/pdfs/` and `tmp/pages/` temporary
  directories, cleaned on normal context exit; abrupt termination may leave
  remnants. `.venv/`, `node_modules/`, `webui_static/pdfjs/`, `.hf-cache/`, `tmp/`
  and test artifacts are ignored. `HF_HOME` can override the model-cache path.
- Server binds only `127.0.0.1`. Documents go to that local server for processing.
  URL import uses HTTP(S), follows redirects, and runs page scripts/subresource
  requests during Chromium printing. Setup/model downloads also use the network.
  Incoming PDFs are capped at 50 MiB; speech requests at 4,000 characters;
  audio exports at 250,000 spoken characters.

## Decisions, current work and pitfalls

Established product constraints in the [roadmap](ROADMAP.md): local processing,
Kokoro/Docling/PDF.js ownership, stable source paragraph IDs across filtering and
navigation, and recoverable rather than destructive extraction filters. The
[README](README.md) and current code supersede the roadmap's optional-only PDF
storage proposal. Temporary pasted-text behavior was chosen in PDF-018 (commit
`4fc0b15`); library backup was delivered in `b6f89d2`. No additional personal user
preferences are established by the inspected files.

Use [TODO.md](TODO.md) for live priorities/status and all new work. PDF-019 adds
this handoff; PDF-018 is the latest feature delivery. Known open issues include
import auto-opening, time estimates, bracket-option placement, two-column
spanning material, multi-tab conversion status, fallback-engine geometry, and
modal focus traps. Read the relevant task before changing these behaviors.
Only Docling engines currently provide paragraph geometry; the Poppler fallbacks
return text without overlays/annotation targets. Preset logic exists in both
Python and JS; preserve parity through the shared fixture.

## Verification and maintenance

```sh
npm run check
npm run test:unit
.venv/bin/python -m unittest discover -s tests
npm run test:browser
```

Browser specs start their own localhost servers and use stubbed extraction and
speech for reader flows; Chromium and synced PDF.js must exist. Python tests
include localhost API/cancellation servers and saved extraction fixtures.
Restricted sandboxes may need permission to bind ports. These checks do not
establish live Kokoro quality or fresh Docling/OCR model behavior. Fixture
regeneration commands are in the README.

For PDF-019, source/configuration, planning documents and Git state were inspected;
CLI help and installed tools were checked. Fresh setup/model downloads, live
speech/OCR quality, browser storage durability and platform compatibility were
not revalidated. No secrets, personal documents or runtime data were inspected
for this brief.

Maintain this file when entry points, commands, architecture, dependencies,
storage or established decisions change. Recheck each affected claim against code,
update the last-verified date, and record actual verification/limits in TODO.
Keep this brief short; link detailed guides and the backlog instead of copying
plans or task lists. Label uncertainty rather than assuming undocumented history.
