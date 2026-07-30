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

## Development workflow

```bash
# Refresh the PDF.js runtime assets after a dependency update.
npm ci
npm run sync-pdfjs

# Start the local server.
./scripts/run.sh
```

The application source lives in `local_webui.py` and `local_webui.html`. Kokoro is intentionally not vendored or modified in this repository; it is installed as a pinned dependency from its upstream project.
