# PDF Reader

A local PDF read-aloud application. It uses [Kokoro](https://github.com/hexgrad/kokoro) for speech, [Docling](https://github.com/docling-project/docling) for structured PDF extraction, and PDF.js for the interactive page view.

Nothing is uploaded by the application: the web server binds only to `127.0.0.1`, PDF conversion runs locally, and Kokoro runs locally. The first run may download the upstream model files into `.hf-cache/`.

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

`setup.sh` creates `.venv`, installs the pinned upstream Kokoro and Docling dependencies, installs PDF.js from npm, and copies only the browser assets required at runtime.

## Run

```bash
./scripts/run.sh
```

Open <http://127.0.0.1:8080>.

For PDFs with selectable text, choose **Docling text-only (no OCR)** for a faster conversion. Use the regular Docling option for scanned PDFs or when OCR is necessary.

## Reading controls and local storage

Choose an **extraction engine** first, then a **reading preset**:

- **Prose only** filters repeated running headers/footers, figure labels, isolated tokens, captions, and reference material from the reading queue.
- **Prose + captions** retains captions while applying the other prose filters.
- **Full document** keeps every non-empty Docling text block. Changing a preset after a Docling extraction reapplies the saved structured result locally; it does not rerun conversion.

The filter summary explains what was hidden. A filtered block is never deleted from the extraction result, so selecting a broader preset restores it. The square-bracket option is separate: it only omits bracketed text from spoken audio.

When you select a PDF, the browser calculates a SHA-256 digest locally. It uses that digest to store a small resume record in `localStorage`: extraction engine and preset, source paragraph and speech-part position, playback speed, bracket setting, zoom, and update time. The original PDF, its extracted text, and generated audio are not stored by this feature. To remove saved positions, clear this site's local storage in your browser's site-data settings.

In the full-page reader, use `Space` to play/pause, `J`/`K` to move between paragraphs, `[`/`]` to change playback rate, `-`/`=` to zoom, and `Escape` to exit. The **Shortcuts** button shows the same list.

## Development workflow

```bash
# Refresh the PDF.js runtime assets after a dependency update.
npm ci
npm run sync-pdfjs

# Start the local server.
./scripts/run.sh
```

The application source lives in `local_webui.py` and `local_webui.html`. Kokoro is intentionally not vendored or modified in this repository; it is installed as a pinned dependency from its upstream project.
