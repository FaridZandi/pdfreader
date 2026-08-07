# PDF Reader

A local PDF read-aloud application. It uses [Kokoro](https://github.com/hexgrad/kokoro) for speech, [Docling](https://github.com/docling-project/docling) for structured PDF extraction, and PDF.js for the interactive page view.

Your documents are never uploaded: the web server binds only to `127.0.0.1`, PDF conversion runs locally, and Kokoro runs locally. The first run may download the upstream model files into `.hf-cache/`.

**From URL** is the one feature that reaches the internet, and only for the address you type. The server downloads that address; if it is not already a PDF, a headless Chromium loads the page and prints it to one, which runs that page's scripts as any browser would. Only `http://` and `https://` addresses are accepted, and the download is capped at 50 MB. Nothing about your library is sent anywhere.

## Setup

Prerequisites:

- Python 3.10 through 3.13 (Python 3.11 recommended)
- Node.js and npm
- macOS: `espeak-ng` (`brew install espeak-ng`)

```bash
git clone git@github.com:FaridZandi/pdfreader.git
cd pdfreader
PYTHON_BIN=python3.11 ./scripts/setup.sh
```

`setup.sh` creates `.venv`, installs the pinned upstream Kokoro and Docling dependencies, installs PDF.js from npm, copies only the browser assets required at runtime, and downloads the Chromium that **From URL** uses to print web pages (roughly 150 MB). Skip that last step with `npx playwright install chromium` omitted if you only ever open local files; the rest of the application works without it, and **From URL** will explain what is missing.

## Run

```bash
./scripts/run.sh
```

Open <http://127.0.0.1:8080>.

For PDFs with selectable text, choose **Docling text-only (no OCR)** for a faster conversion. Use the regular Docling option for scanned PDFs or when OCR is necessary.

## Reading controls and local storage

**Add PDF** imports a document once: it stores the file in the browser gallery, renders a first-page preview, and extracts the text. **From URL** takes a web address instead: a link to a PDF is downloaded, and any other page is printed to a PDF first so the reader still has real pages to show and real geometry to highlight. Either way the result then follows the same path, and everything after that happens locally against the stored copy. Choose a **reading preset** in the import panel, and an **extraction engine** under **Advanced extraction**:

- **Prose only** filters repeated running headers/footers, figure labels, isolated tokens, captions, and reference material from the reading queue.
- **Prose + captions** retains captions while applying the other prose filters.
- **Full document** keeps every non-empty Docling text block. Changing a preset after a Docling extraction reapplies the saved structured result locally; it does not rerun conversion.

The prose presets also drop text that was drawn inside a figure — axis labels, legend entries, stray numbers. That decision comes from geometry rather than word count: Docling reports the boxes of the pictures and tables it found, and a text block sitting inside one is figure furniture however many words it has. A caption is exempt, because it belongs to a figure without being drawn inside it, and the preset already decides whether captions are read.

The filter summary explains what was hidden. A filtered block is never deleted from the extraction result, so selecting a broader preset restores it. **Skip [bracketed text] when speaking** is separate: it only omits bracketed text from spoken audio, not from the reading queue.

**Add to library** stores the PDF and its preview immediately and closes the dialog; extracting the text runs in the background, and the document opens when it is ready. Until then its gallery card says so and cannot be opened. Extraction runs one document at a time, so several large imports cannot swamp the machine. If it fails — or is cut short by a reload or a closed tab — the card says why and offers **Try again**, which reuses the stored PDF and needs nothing from you.

When you select a PDF, the browser calculates a SHA-256 digest locally and uses that digest as the document key. A small resume record goes to `localStorage`: extraction engine and preset, source paragraph and speech-part position, playback speed, bracket setting, zoom, and update time. Reopening a document from the gallery returns to that paragraph. Delete one gallery entry or use **Clear library** to remove saved reader data; clearing this site's local storage also removes resume positions.

In the full-page reader, use `Space` to play/pause, `J`/`K` to move between paragraphs, `[`/`]` to change playback rate, `-`/`=` to zoom, and `Escape` to exit. The **Shortcuts** button shows the same list. `Space` works wherever you are in the reader, including with a paragraph or the speed slider focused; a paragraph overlay answers `Enter` rather than `Space` so it never takes the play/pause key away. Pressing it while a paragraph is still being generated decides whether that paragraph plays when it arrives.

**Voice** picks which of Kokoro's American English voices reads to you. The list comes from the server, so it cannot offer one Kokoro will refuse, and the first use of a voice downloads its (small) tensor. Changing it re-prepares the current paragraph; nothing you already heard is lost, because generated speech is cached per voice.

Paragraph audio is always generated at Kokoro's natural speed; the speed control changes audio playback rate, so a change applies immediately instead of discarding prepared audio. That audio is kept in IndexedDB and reused, so reopening a document does not re-synthesise what you already heard, and an export of a passage you have listened to at normal speed is assembled locally without asking the model again. The cache holds 250 MB and drops the least recently used speech beyond that; deleting a document takes its audio with it.

Clicking a paragraph — in the PDF, the outline, or the text list — jumps there and starts reading it, and takes the model off whatever it was generating for where you just left rather than queueing behind it. Each paragraph also carries its own controls on hover: play/pause, highlight, and note. Their icons reflect the current state, so the paragraph being read shows a pause control and a highlighted paragraph shows a filled marker. If a paragraph fails to convert, **Try this paragraph again** appears under the transport.

The reader panel has three views. **Outline** is derived from Docling titles and section headers. **Text** lists the reading queue with each paragraph's preparation state, and highlights search matches. It does not scroll itself to follow the reader, but when the paragraph being read is off screen a **Reading above** or **Reading below** button appears against that edge of the list; pressing it scrolls the list there and changes nothing about playback. **Highlights** lists everything you have marked on the document: each entry quotes the source paragraph and shows any note under it. Selecting one only scrolls the PDF to that paragraph: whatever is playing keeps playing, and the reading position is unchanged. Search runs entirely in the browser over the current reading queue; results scroll to their source PDF paragraph and offer an explicit **Read from here** action. Searching outlines the matching paragraphs in the PDF but never hides or disables the others.

**Highlight** and **Add note** — also available on hover over any PDF paragraph — write one record per paragraph: its source paragraph id, current PDF boxes, color, note text, excerpt, and timestamps, stored in IndexedDB. A note is a highlight with text on it; there is no separate bookmark. Highlights appear as a thin marker in the page margin, never over the text, and never copy the source PDF into that record. Hovering a paragraph that carries a note shows the note itself just below it. The highlight control toggles: using it on an already-highlighted paragraph removes it, and asks first when that would also delete an attached note. If an extraction later changes its paragraph ids, the saved excerpt is shown for recovery instead of silently moving the entry to a different paragraph.

The **local library** keeps metadata such as file name, page count, last-opened time, position, and collection membership in IndexedDB, alongside the imported PDF itself. Importing asks the browser for persistent storage when it is available and checks quota before saving; if the quota is insufficient the import stops with an explanation rather than storing a document that cannot be opened. An older metadata-only entry is labelled **Available after reselecting** and asks you to select the original file, then reuses its saved extraction. The library provides per-document and whole-library deletion, plus collections that can be renamed or deleted without deleting the documents, highlights, or notes they contain.

The reader can export the current paragraph, current section, or full reading queue as a WAV. Export runs only when requested, asks Kokoro for the reader's current playback speed so the file matches what you hear, honors the bracket-skipping option, and can be cancelled from the browser while generation is in progress — cancelling stops the model, rather than leaving it generating audio nobody will receive. It is capped at 250,000 spoken characters per export and 4,000 characters per internal speech chunk.

**Listen only** uses the same queue and resume position while hiding the PDF and the reader panel views, and exposes play/pause and previous/next controls through the Media Session API when the browser supports it.

## Development workflow

```bash
# Refresh the PDF.js runtime assets after a dependency update.
npm ci
npm run sync-pdfjs

# Start the local server.
./scripts/run.sh
```

Source layout:

| Path | Contents |
| --- | --- |
| `local_webui.py` | the localhost server: extraction, speech, export, URL fetching |
| `local_webui.html` | markup and the icon sprite only |
| `webui/app.css` | the whole stylesheet, driven by tokens at the top |
| `webui/app.mjs` | import, dialogs, storage, and the wiring between the parts |
| `webui/lib/speech.mjs` | the reading engine: queue, conversion, audio cache, playback |
| `webui/lib/text.mjs` | pure text and reading-queue helpers, unit tested |
| `webui/lib/db.mjs` | the IndexedDB schema and every record operation |
| `webui/lib/pdf-view.mjs` | rendered pages, zoom, and the paragraph overlays |
| `webui/lib/library.mjs` | the gallery: cards, collections, deletion |
| `webui/lib/drawer.mjs` | the reader's outline, text and highlight views, and search |
| `webui_static/pdfjs/` | vendored PDF.js, synced from npm and not edited |

The server exposes `webui/` at `/app/` and `webui_static/` at `/static/`. Application sources are served with `no-store`, so a browser refresh picks up a change to the markup, stylesheet or scripts; changing `local_webui.py` needs the server restarted.

```bash
npm run check       # syntax-check every JavaScript file
npm run test:unit   # node:test, no browser needed
npm run test:browser
python -m unittest discover -s tests
```

`tests/fixtures/` holds a two-column paper and what the real tools make of it, so the extraction code is tested against real output rather than hand-built dictionaries. Regenerate them from the HTML kept beside them after changing how the fixture should look:

```bash
node scripts/print_url.mjs "file://$PWD/tests/fixtures/two-column-paper.source.html" tests/fixtures/two-column-paper.pdf
pdftotext -bbox -enc UTF-8 tests/fixtures/two-column-paper.pdf tests/fixtures/two-column-paper.bbox.html
.venv/bin/docling convert tests/fixtures/two-column-paper.pdf --to json --image-export-mode placeholder --output tests/fixtures --quiet --no-ocr
mv tests/fixtures/two-column-paper.json tests/fixtures/two-column-paper.docling.json
```

`tests/fixtures/preset_cases.json` is shared: the reading preset is applied by `content_for_preset` on the server and again by `selectParagraphsForPreset` in the browser when you change it without re-extracting, and both are run against the same cases so they cannot drift apart.

Kokoro is intentionally not vendored or modified in this repository; it is installed as a pinned dependency from its upstream project.
