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

The filter summary explains what was hidden. A filtered block is never deleted from the extraction result, so selecting a broader preset restores it. **Skip [bracketed text] when speaking** is separate: it only omits bracketed text from spoken audio, not from the reading queue.

When you select a PDF, the browser calculates a SHA-256 digest locally and uses that digest as the document key. A small resume record goes to `localStorage`: extraction engine and preset, source paragraph and speech-part position, playback speed, bracket setting, zoom, and update time. Reopening a document from the gallery returns to that paragraph. Delete one gallery entry or use **Clear library** to remove saved reader data; clearing this site's local storage also removes resume positions.

In the full-page reader, use `Space` to play/pause, `J`/`K` to move between paragraphs, `[`/`]` to change playback rate, `-`/`=` to zoom, and `Escape` to exit. The **Shortcuts** button shows the same list. Paragraph audio is always generated at Kokoro's natural speed; the speed control changes audio playback rate, so a change applies immediately instead of discarding prepared audio.

Clicking a paragraph — in the PDF, the outline, or the text list — jumps there and starts reading it. Each paragraph also carries its own controls on hover: play/pause, highlight, and note. Their icons reflect the current state, so the paragraph being read shows a pause control and a highlighted paragraph shows a filled marker.

The reader panel has three views. **Outline** is derived from Docling titles and section headers. **Text** lists the reading queue with each paragraph's preparation state, and highlights search matches. **Highlights** lists everything you have marked on the document: each entry quotes the source paragraph and shows any note under it. Selecting one only scrolls the PDF to that paragraph: whatever is playing keeps playing, and the reading position is unchanged. Search runs entirely in the browser over the current reading queue; results scroll to their source PDF paragraph and offer an explicit **Read from here** action. Searching outlines the matching paragraphs in the PDF but never hides or disables the others.

**Highlight** and **Add note** — also available on hover over any PDF paragraph — write one record per paragraph: its source paragraph id, current PDF boxes, color, note text, excerpt, and timestamps, stored in IndexedDB. A note is a highlight with text on it; there is no separate bookmark. Highlights appear as a thin marker in the page margin, never over the text, and never copy the source PDF into that record. Hovering a paragraph that carries a note shows the note itself just below it. The highlight control toggles: using it on an already-highlighted paragraph removes it, and asks first when that would also delete an attached note. If an extraction later changes its paragraph ids, the saved excerpt is shown for recovery instead of silently moving the entry to a different paragraph.

The **local library** keeps metadata such as file name, page count, last-opened time, position, and collection membership in IndexedDB, alongside the imported PDF itself. Importing asks the browser for persistent storage when it is available and checks quota before saving; if the quota is insufficient the import stops with an explanation rather than storing a document that cannot be opened. An older metadata-only entry is labelled **Available after reselecting** and asks you to select the original file, then reuses its saved extraction. The library provides per-document and whole-library deletion, plus collections that can be renamed or deleted without deleting the documents, highlights, or notes they contain.

The reader can export the current paragraph, current section, or full reading queue as a WAV. Export runs only when requested, asks Kokoro for the reader's current playback speed so the file matches what you hear, honors the bracket-skipping option, and can be cancelled from the browser while generation is in progress. It is capped at 250,000 spoken characters per export and 4,000 characters per internal speech chunk.

**Listen only** uses the same queue and resume position while hiding the PDF and the reader panel views, and exposes play/pause and previous/next controls through the Media Session API when the browser supports it.

## Development workflow

```bash
# Refresh the PDF.js runtime assets after a dependency update.
npm ci
npm run sync-pdfjs

# Start the local server.
./scripts/run.sh
```

The application source lives in `local_webui.py` and `local_webui.html`. Kokoro is intentionally not vendored or modified in this repository; it is installed as a pinned dependency from its upstream project.
