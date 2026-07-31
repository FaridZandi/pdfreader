#!/usr/bin/env python3
"""A small localhost-only web interface for Kokoro text-to-speech."""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import subprocess
import sys
import threading
import tempfile
import wave
from html.parser import HTMLParser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlparse

import numpy as np

if TYPE_CHECKING:
    from kokoro import KPipeline


ROOT = Path(__file__).resolve().parent
PAGE = ROOT / "local_webui.html"
STATIC_ROOT = ROOT / "webui_static"
DOCLING = Path(sys.executable).with_name("docling")
SAMPLE_RATE = 24_000
MAX_TEXT_LENGTH = 4_000
MAX_PDF_SIZE = 50 * 1024 * 1024
READING_ORDERS = {"docling", "docling_no_ocr", "source", "columns"}
EXTRACTION_PRESETS = {"prose", "prose_captions", "full"}
PROSE_LABELS = {"text", "section_header", "title", "list_item"}


def _normalise_block_text(value: str) -> str:
    """Normalise repeated running text while ignoring changing page numbers."""
    value = re.sub(r"\b\d+\b", "#", value.casefold())
    return re.sub(r"\s+", " ", value).strip()


def _primary_page(paragraph: dict[str, object]) -> int | None:
    boxes = paragraph.get("boxes", [])
    if not isinstance(boxes, list) or not boxes:
        return None
    page = boxes[0].get("page")
    return int(page) if isinstance(page, (int, float)) else None


def _is_page_edge(paragraph: dict[str, object]) -> bool:
    """Whether every provenance box sits in the top or bottom 10% of a page."""
    boxes = paragraph.get("boxes", [])
    if not isinstance(boxes, list) or not boxes:
        return False
    for box in boxes:
        bbox = box.get("bbox", {})
        page_size = box.get("page_size", {})
        height = float(page_size.get("height", 0))
        if not height:
            return False
        top = float(bbox.get("t", 0)) / height
        bottom = float(bbox.get("b", 0)) / height
        if not (top >= 0.9 or bottom <= 0.1):
            return False
    return True


def _looks_like_figure_label(paragraph: dict[str, object], caption_pages: set[int]) -> bool:
    value = str(paragraph.get("text", "")).strip()
    if re.fullmatch(r"(?:fig(?:ure)?|table)\.?\s*\d+[a-z]?", value, flags=re.IGNORECASE):
        return True
    page = _primary_page(paragraph)
    return bool(
        page in caption_pages
        and paragraph.get("label") in {"text", "list_item"}
        and re.fullmatch(r"(?:\d+|[a-z])", value, flags=re.IGNORECASE)
    )


def _looks_like_reference_entry(paragraph: dict[str, object]) -> bool:
    if paragraph.get("label") == "list_item":
        return True
    value = str(paragraph.get("text", "")).strip()
    return bool(re.match(r"^(?:\[?\d+\]?|[A-Z][\w'’-]+,\s*[A-Z])", value))


def annotate_filter_reasons(paragraphs: list[dict[str, object]]) -> list[dict[str, object]]:
    """Attach transparent, deterministic prose-filter reasons to source blocks."""
    repeated_edge_text: set[str] = set()
    occurrences: dict[str, set[int]] = {}
    for paragraph in paragraphs:
        page = _primary_page(paragraph)
        normalized = _normalise_block_text(str(paragraph["text"]))
        if page is not None and normalized and _is_page_edge(paragraph):
            occurrences.setdefault(normalized, set()).add(page)
    repeated_edge_text = {value for value, pages in occurrences.items() if len(pages) >= 2}

    caption_pages = {page for paragraph in paragraphs if paragraph.get("label") == "caption" if (page := _primary_page(paragraph)) is not None}
    annotated: list[dict[str, object]] = []
    reference_section = False
    for paragraph in paragraphs:
        value = str(paragraph["text"])
        label = str(paragraph.get("label", ""))
        normalized = _normalise_block_text(value)
        reasons: list[str] = []
        if normalized in repeated_edge_text:
            reasons.append("header_footer")
        if label == "caption":
            reasons.append("caption")
        if normalized in {"references", "bibliography"} and label in {"title", "section_header", "text"}:
            reasons.append("reference_heading")
            reference_section = True
        elif reference_section and _looks_like_reference_entry(paragraph):
            reasons.append("reference_entry")
        if _looks_like_figure_label(paragraph, caption_pages):
            reasons.append("figure_label")
        if label in {"text", "list_item"} and len(value.split()) == 1:
            reasons.append("isolated_token")
        annotated.append({**paragraph, "filter_reasons": reasons})
    return annotated


def content_for_preset(all_paragraphs: list[dict[str, object]], preset: str) -> dict[str, object]:
    """Create a reading queue without changing stable source paragraph ids."""
    if preset not in EXTRACTION_PRESETS:
        raise ValueError("Unknown extraction preset.")
    selected: list[dict[str, object]] = []
    hidden_reasons: dict[str, int] = {}
    for paragraph in all_paragraphs:
        label = str(paragraph.get("label", ""))
        reasons = list(paragraph.get("filter_reasons", []))
        suppressed_reason: str | None = None
        if preset != "full":
            if label not in PROSE_LABELS and not (preset == "prose_captions" and label == "caption"):
                suppressed_reason = "caption" if label == "caption" else "non_prose"
            else:
                non_caption_reasons = [reason for reason in reasons if reason != "caption"]
                if non_caption_reasons:
                    suppressed_reason = non_caption_reasons[0]
        if suppressed_reason:
            hidden_reasons[suppressed_reason] = hidden_reasons.get(suppressed_reason, 0) + 1
            continue
        selected.append(paragraph)
    return {
        "text": "\n\n".join(str(item["text"]) for item in selected),
        "paragraphs": selected,
        "all_paragraphs": all_paragraphs,
        "filter_summary": {
            "preset": preset,
            "visible": len(selected),
            "hidden": len(all_paragraphs) - len(selected),
            "reasons": hidden_reasons,
        },
    }


def to_wav(audio: np.ndarray) -> bytes:
    """Encode Kokoro's float waveform as a standard mono PCM WAV."""
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm.tobytes())
    return buffer.getvalue()


class BBoxParser(HTMLParser):
    """Read Poppler's word-position HTML without introducing a PDF dependency."""

    def __init__(self) -> None:
        super().__init__()
        self.pages: list[dict[str, object]] = []
        self.word_attributes: dict[str, str] | None = None
        self.word_parts: list[str] = []

    def handle_starttag(self, tag: str, attributes: list[tuple[str, str | None]]) -> None:
        attrs = {key: value or "" for key, value in attributes}
        if tag == "page":
            self.pages.append({"width": float(attrs["width"]), "height": float(attrs["height"]), "words": []})
        elif tag == "word" and self.pages:
            self.word_attributes = attrs
            self.word_parts = []

    def handle_data(self, data: str) -> None:
        if self.word_attributes is not None:
            self.word_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag != "word" or self.word_attributes is None:
            return
        text = "".join(self.word_parts).strip()
        if text:
            self.pages[-1]["words"].append(
                (
                    float(self.word_attributes["xmin"]),
                    float(self.word_attributes["xmax"]),
                    float(self.word_attributes["ymin"]),
                    text,
                )
            )
        self.word_attributes = None
        self.word_parts = []


def _join_lines(lines: list[tuple[float, float, float, str]]) -> str:
    """Join visual lines, restoring a word split by a line-end hyphen."""
    text = ""
    for _, _, _, line in lines:
        if text.endswith("-"):
            text += line
        elif text:
            text += "\n" + line
        else:
            text = line
    return text


def _page_reading_order(page: dict[str, object]) -> str:
    width = float(page["width"])
    height = float(page["height"])
    words = list(page["words"])
    if not words:
        return ""

    # First form rows, then split any row across a conspicuous horizontal gutter.
    # This avoids treating simultaneous left/right-column lines as one sentence.
    rows: list[list[tuple[float, float, float, str]]] = []
    for word in sorted(words, key=lambda item: (item[2], item[0])):
        if not rows or abs(word[2] - rows[-1][0][2]) > 3:
            rows.append([word])
        else:
            rows[-1].append(word)

    lines: list[tuple[float, float, float, str]] = []
    gutter = max(24, width * 0.05)
    for row in rows:
        part: list[tuple[float, float, float, str]] = []
        previous_right = 0.0
        for word in sorted(row, key=lambda item: item[0]):
            if part and word[0] - previous_right > gutter:
                lines.append((part[0][0], part[-1][1], part[0][2], " ".join(item[3] for item in part)))
                part = []
            part.append(word)
            previous_right = word[1]
        if part:
            lines.append((part[0][0], part[-1][1], part[0][2], " ".join(item[3] for item in part)))

    # Ignore an isolated page number near the bottom of the page.
    lines = [line for line in lines if not (line[3].isdigit() and line[2] > height * 0.88)]
    left = [line for line in lines if line[1] <= width * 0.5]
    right = [line for line in lines if line[0] >= width * 0.5]

    # Treat a page as two columns only when both sides have enough independent
    # lines. Otherwise ordinary top-to-bottom extraction is less surprising.
    if len(left) >= 3 and len(right) >= 3:
        left_ids = {id(line) for line in left}
        right_ids = {id(line) for line in right}
        column_top = min(left[0][2], right[0][2])
        header = [
            line for line in lines
            if id(line) not in left_ids | right_ids and line[2] < column_top
        ]
        remainder = [
            line for line in lines
            if id(line) not in left_ids | right_ids and line[2] >= column_top
        ]
        ordered = (
            sorted(header, key=lambda item: item[2])
            + sorted(left, key=lambda item: item[2])
            + sorted(right, key=lambda item: item[2])
            + sorted(remainder, key=lambda item: item[2])
        )
    else:
        ordered = sorted(lines, key=lambda item: item[2])
    return _join_lines(ordered)


def extract_with_docling(
    input_file: Path,
    output_directory: Path,
    *,
    no_ocr: bool = False,
    preset: str = "prose",
) -> dict[str, object]:
    """Return Docling text blocks and geometry without exporting image payloads."""
    output_directory.mkdir(parents=True, exist_ok=True)
    command = [
        str(DOCLING) if DOCLING.exists() else "docling", "convert", str(input_file), "--to", "json",
        "--image-export-mode", "placeholder",
        "--output", str(output_directory), "--quiet",
    ]
    if no_ocr:
        command.append("--no-ocr")
    result = subprocess.run(
        command,
        capture_output=True,
        timeout=300,
        check=False,
    )
    if result.returncode:
        message = result.stderr.decode("utf-8", errors="replace").strip()
        raise ValueError(message or "Docling could not convert this PDF.")
    json_files = list(output_directory.rglob("*.json"))
    if not json_files:
        raise ValueError("Docling completed without producing structured output.")
    document = json.loads(json_files[0].read_text(encoding="utf-8"))
    pages = document.get("pages", {})
    paragraphs: list[dict[str, object]] = []
    for text_index, item in enumerate(document.get("texts", [])):
        value = str(item.get("text", "")).strip()
        if not value:
            continue
        boxes: list[dict[str, object]] = []
        for provenance in item.get("prov", []):
            page_number = str(provenance.get("page_no", ""))
            page = pages.get(page_number, {})
            bbox = provenance.get("bbox", {})
            size = page.get("size", {})
            if not bbox or not size:
                continue
            boxes.append(
                {
                    "page": int(page_number),
                    "bbox": {key: float(bbox[key]) for key in ("l", "t", "r", "b")},
                    "page_size": {key: float(size[key]) for key in ("width", "height")},
                }
            )
        # A Docling text item can span multiple regions or pages.  It is one
        # logical piece of prose, so keep it as one reading-queue item and
        # retain all of its boxes solely for PDF highlighting.  A rare text
        # item without geometry remains readable in the Full document preset.
        paragraphs.append(
            {
                "id": str(text_index),
                "text": value,
                "label": str(item.get("label", "")),
                "page": int(boxes[0]["page"]) if boxes else None,
                "boxes": boxes,
            }
        )
    return content_for_preset(annotate_filter_reasons(paragraphs), preset)


def extract_pdf_text(
    input_file: Path,
    reading_order: str,
    output_directory: Path,
    preset: str,
) -> dict[str, object]:
    """Extract text with Docling or an explicitly selected Poppler fallback."""
    if reading_order in {"docling", "docling_no_ocr"}:
        return extract_with_docling(
            input_file,
            output_directory,
            no_ocr=reading_order == "docling_no_ocr",
            preset=preset,
        )
    if reading_order == "source":
        result = subprocess.run(
            ["pdftotext", "-raw", "-enc", "UTF-8", str(input_file), "-"],
            capture_output=True,
            timeout=60,
            check=False,
        )
        if result.returncode:
            message = result.stderr.decode("utf-8", errors="replace").strip()
            raise ValueError(message or "This PDF could not be read.")
        text = result.stdout.decode("utf-8", errors="replace").replace("\f", "\n\n").strip()
        return {
            "text": text,
            "paragraphs": [],
            "all_paragraphs": [],
            "filter_summary": {"preset": preset, "visible": 0, "hidden": 0, "reasons": {}},
        }

    result = subprocess.run(
        ["pdftotext", "-bbox", "-enc", "UTF-8", str(input_file), "-"],
        capture_output=True,
        timeout=60,
        check=False,
    )
    if result.returncode:
        message = result.stderr.decode("utf-8", errors="replace").strip()
        raise ValueError(message or "This PDF could not be read.")
    parser = BBoxParser()
    parser.feed(result.stdout.decode("utf-8", errors="replace"))
    return {
        "text": "\n\n".join(filter(None, (_page_reading_order(page) for page in parser.pages))).strip(),
        "paragraphs": [],
        "all_paragraphs": [],
        "filter_summary": {"preset": preset, "visible": 0, "hidden": 0, "reasons": {}},
    }


class KokoroApp:
    def __init__(self) -> None:
        # Keep model downloads inside this checkout unless the user overrides it.
        os.environ.setdefault("HF_HOME", str(ROOT / ".hf-cache"))
        from kokoro import KPipeline

        self.pipeline: KPipeline = KPipeline(lang_code="a")
        self.lock = threading.Lock()

    def synthesize(self, text: str, speed: float) -> bytes:
        chunks: list[np.ndarray] = []
        # Serializing inference prevents simultaneous browser requests competing
        # for the same model instance and system memory.
        with self.lock:
            for result in self.pipeline(text, voice="af_heart", speed=speed):
                if result.audio is not None:
                    chunks.append(result.audio.numpy())
        if not chunks:
            raise ValueError("Kokoro did not produce audio for that text.")
        return to_wav(np.concatenate(chunks))

    def extract_pdf(self, pdf: bytes, reading_order: str, preset: str) -> dict[str, object]:
        """Extract text from a user PDF without retaining the uploaded file."""
        if b"%PDF-" not in pdf[:1024]:
            raise ValueError("That file does not look like a PDF.")
        temporary_root = ROOT / "tmp" / "pdfs"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary_root) as directory:
            input_file = Path(directory) / "document.pdf"
            input_file.write_bytes(pdf)
            content = extract_pdf_text(input_file, reading_order, Path(directory) / "output", preset)
        if not content["text"]:
            raise ValueError(
                "No selectable text was found. This may be a scanned PDF; run OCR on it first."
            )
        return content


def handler_for(app: KokoroApp) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path.startswith("/static/"):
                self._serve_static(path)
                return
            if path not in ("/", "/index.html"):
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            body = PAGE.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _serve_static(self, request_path: str) -> None:
            target = (STATIC_ROOT / request_path.removeprefix("/static/")).resolve()
            if STATIC_ROOT not in target.parents or not target.is_file():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            body = target.read_bytes()
            content_type = "text/javascript; charset=utf-8" if target.suffix == ".mjs" else "application/octet-stream"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:  # noqa: N802
            if self.path == "/api/extract-pdf":
                self._extract_pdf()
                return
            if self.path != "/api/synthesize":
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_TEXT_LENGTH + 200:
                    raise ValueError("Request is too large.")
                payload = json.loads(self.rfile.read(length))
                text = str(payload.get("text", "")).strip()
                speed = float(payload.get("speed", 1.0))
                if not text:
                    raise ValueError("Enter some text first.")
                if len(text) > MAX_TEXT_LENGTH:
                    raise ValueError(f"Text must be {MAX_TEXT_LENGTH:,} characters or fewer.")
                if not 0.5 <= speed <= 2.0:
                    raise ValueError("Speed must be between 0.5 and 2.0.")
                body = app.synthesize(text, speed)
            except (ValueError, json.JSONDecodeError) as error:
                self.log_error("Invalid synthesis request: %s", error)
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except Exception as error:  # Keep model errors visible in the page.
                self.log_error("Synthesis failed: %s", error)
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(error)})
                return

            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _extract_pdf(self) -> None:
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_PDF_SIZE:
                    raise ValueError("Choose a PDF smaller than 50 MB.")
                reading_order = self.headers.get("X-Reading-Order", "source")
                if reading_order not in READING_ORDERS:
                    raise ValueError("Unknown PDF reading-order option.")
                preset = self.headers.get("X-Extraction-Preset", "prose")
                if preset not in EXTRACTION_PRESETS:
                    raise ValueError("Unknown PDF reading preset.")
                content = app.extract_pdf(self.rfile.read(length), reading_order, preset)
            except (ValueError, subprocess.TimeoutExpired) as error:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except Exception as error:
                self.log_error("PDF extraction failed: %s", error)
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(error)})
                return
            self._send_json(HTTPStatus.OK, content)

        def _send_json(self, status: HTTPStatus, payload: dict[str, object]) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            print(f"[webui] {self.address_string()} - {format % args}")

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="Local web UI for Kokoro")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")

    print("Loading Kokoro model…")
    app = KokoroApp()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler_for(app))
    print(f"Kokoro web UI is ready at http://127.0.0.1:{args.port}")
    print("Press Ctrl+C here to stop it.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
