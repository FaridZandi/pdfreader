#!/usr/bin/env python3
"""A small localhost-only web interface for Kokoro text-to-speech."""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import select
import socket
import subprocess
import sys
import threading
import tempfile
import wave
from collections.abc import Callable
from html.parser import HTMLParser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.error import URLError
from urllib.parse import quote, unquote, urlparse
from urllib.request import Request, urlopen

import numpy as np

if TYPE_CHECKING:
    from kokoro import KPipeline


ROOT = Path(__file__).resolve().parent
PAGE = ROOT / "local_webui.html"
# Vendored browser runtime, kept apart from the hand-written application.
STATIC_ROOT = ROOT / "webui_static"
APP_ROOT = ROOT / "webui"
ASSET_ROOTS = {"/static/": STATIC_ROOT, "/app/": APP_ROOT}
CONTENT_TYPES = {
    ".mjs": "text/javascript; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
}
DOCLING = Path(sys.executable).with_name("docling")
PRINT_URL = ROOT / "scripts" / "print_url.mjs"
FETCH_TIMEOUT = 30
PRINT_TIMEOUT = 120
MAX_URL_LENGTH = 2_048
SAMPLE_RATE = 24_000
MAX_TEXT_LENGTH = 4_000
MAX_EXPORT_CHARACTERS = 250_000
MAX_PDF_SIZE = 50 * 1024 * 1024
READING_ORDERS = {"docling", "docling_no_ocr", "source", "columns"}
EXTRACTION_PRESETS = {"prose", "prose_captions", "full"}
PROSE_LABELS = {"text", "section_header", "title", "list_item"}
# How much of a text block has to sit inside a picture or table before it is
# treated as figure furniture rather than prose, and the point at which a
# "figure" is really the whole page and would silence everything on it.
FIGURE_CONTAINMENT = 0.8
FIGURE_MAX_PAGE_SHARE = 0.9
# The narrowest word-free band that can be a column gutter rather than a wide
# space inside a justified line, and the share of a page's rows allowed to
# cross a band before it stops looking like a gutter at all.
MIN_GUTTER_WIDTH = 8.0
GUTTER_ROW_TOLERANCE = 0.12
# Kokoro's American English voices, which is what `lang_code="a"` below expects.
# The first use of a voice downloads its (small) tensor from the model host.
DEFAULT_VOICE = "af_heart"
VOICES = (
    ("af_heart", "Heart (female)"),
    ("af_bella", "Bella (female)"),
    ("af_nicole", "Nicole (female)"),
    ("af_sarah", "Sarah (female)"),
    ("af_sky", "Sky (female)"),
    ("af_nova", "Nova (female)"),
    ("af_aoede", "Aoede (female)"),
    ("af_kore", "Kore (female)"),
    ("af_river", "River (female)"),
    ("af_alloy", "Alloy (female)"),
    ("af_jessica", "Jessica (female)"),
    ("am_michael", "Michael (male)"),
    ("am_adam", "Adam (male)"),
    ("am_echo", "Echo (male)"),
    ("am_eric", "Eric (male)"),
    ("am_fenrir", "Fenrir (male)"),
    ("am_liam", "Liam (male)"),
    ("am_onyx", "Onyx (male)"),
    ("am_puck", "Puck (male)"),
    ("am_santa", "Santa (male)"),
)
VOICE_IDS = {identifier for identifier, _ in VOICES}


class RequestCancelled(Exception):
    """Raised when the browser drops a request before its audio is generated."""


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


def _looks_like_figure_label(
    paragraph: dict[str, object],
    caption_boxes: list[dict[str, object]],
) -> bool:
    value = str(paragraph.get("text", "")).strip()
    if re.fullmatch(r"(?:fig(?:ure)?|table)\.?\s*\d+[a-z]?", value, flags=re.IGNORECASE):
        return True
    if paragraph.get("label") not in {"text", "list_item"} or not re.fullmatch(
        r"(?:\d+|[a-z])", value, flags=re.IGNORECASE
    ):
        return False
    for box in paragraph.get("boxes", []):
        page = box.get("page")
        bbox = box.get("bbox", {})
        page_size = box.get("page_size", {})
        height = float(page_size.get("height", 0))
        if not height:
            continue
        center = (float(bbox.get("t", 0)) + float(bbox.get("b", 0))) / 2
        for caption_box in caption_boxes:
            if caption_box.get("page") != page:
                continue
            caption_bbox = caption_box.get("bbox", {})
            caption_center = (float(caption_bbox.get("t", 0)) + float(caption_bbox.get("b", 0))) / 2
            # Panel labels sit beside a figure/caption, rather than merely
            # sharing its page.  Ten percent of the page height is tolerant of
            # normal caption spacing but avoids dropping ordinary singleton text.
            if abs(center - caption_center) <= height * 0.1:
                return True
    return False


def _rectangle(box: dict[str, object]) -> tuple[float, float, float, float]:
    """A provenance box as (left, low, right, high), whichever way it was written."""
    bbox = box.get("bbox", {})
    left, right = float(bbox.get("l", 0)), float(bbox.get("r", 0))
    top, bottom = float(bbox.get("t", 0)), float(bbox.get("b", 0))
    return min(left, right), min(top, bottom), max(left, right), max(top, bottom)


def _covered_by_figure(box: dict[str, object], figure: dict[str, object]) -> bool:
    if box.get("page") != figure.get("page"):
        return False
    left, low, right, high = _rectangle(box)
    area = (right - left) * (high - low)
    if area <= 0:
        return False
    figure_left, figure_low, figure_right, figure_high = _rectangle(figure)
    page_size = figure.get("page_size", {})
    page_area = float(page_size.get("width", 0)) * float(page_size.get("height", 0))
    # A "figure" the size of the page is a scan or a full-page graphic, and
    # treating everything drawn on it as furniture would silence the page.
    if page_area and (figure_right - figure_left) * (figure_high - figure_low) > page_area * FIGURE_MAX_PAGE_SHARE:
        return False
    overlap = (
        max(0.0, min(right, figure_right) - max(left, figure_left))
        * max(0.0, min(high, figure_high) - max(low, figure_low))
    )
    return overlap / area >= FIGURE_CONTAINMENT


def _is_figure_content(
    paragraph: dict[str, object],
    figure_boxes: list[dict[str, object]],
) -> bool:
    """Whether every part of a block sits inside a picture or a table.

    Axis labels, legend entries and stray numbers drawn inside a figure are
    two to four words, so a word count cannot tell them from real short
    prose.  Where they are on the page can: Docling reports the boxes of the
    pictures and tables it found, and a block inside one of those is figure
    furniture however many words it has.  A caption is exempt because it
    belongs to the figure without being drawn inside it, and the preset
    already decides whether captions are read.
    """
    if not figure_boxes or paragraph.get("label") == "caption":
        return False
    boxes = paragraph.get("boxes", [])
    if not isinstance(boxes, list) or not boxes:
        return False
    return all(
        any(_covered_by_figure(box, figure) for figure in figure_boxes)
        for box in boxes
    )


def _looks_like_reference_entry(paragraph: dict[str, object]) -> bool:
    if paragraph.get("label") == "list_item":
        return True
    value = str(paragraph.get("text", "")).strip()
    return bool(re.match(r"^(?:\[?\d+\]?|[A-Z][\w'’-]+,\s*[A-Z])", value))


def annotate_filter_reasons(
    paragraphs: list[dict[str, object]],
    figure_boxes: list[dict[str, object]] | None = None,
) -> list[dict[str, object]]:
    """Attach transparent, deterministic prose-filter reasons to source blocks."""
    figure_boxes = figure_boxes or []
    occurrences: dict[str, set[int]] = {}
    for paragraph in paragraphs:
        page = _primary_page(paragraph)
        normalized = _normalise_block_text(str(paragraph["text"]))
        if page is not None and normalized and _is_page_edge(paragraph):
            occurrences.setdefault(normalized, set()).add(page)
    repeated_edge_text = {value for value, pages in occurrences.items() if len(pages) >= 2}

    caption_boxes = [
        box
        for paragraph in paragraphs
        if paragraph.get("label") == "caption"
        for box in paragraph.get("boxes", [])
    ]
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
        elif label in {"title", "section_header"}:
            # A new heading ends the reference list.  Without this an appendix
            # after the references is read as bibliography and dropped, and so
            # is everything else to the end of the document.
            reference_section = False
        elif reference_section and _looks_like_reference_entry(paragraph):
            reasons.append("reference_entry")
        if _looks_like_figure_label(paragraph, caption_boxes):
            reasons.append("figure_label")
        if _is_figure_content(paragraph, figure_boxes):
            reasons.append("figure_content")
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


def _better_gutter(
    best: tuple[float, float] | None,
    candidate: tuple[float, float],
    width: float,
) -> tuple[float, float] | None:
    start, end = candidate
    centre = (start + end) / 2
    if end - start < MIN_GUTTER_WIDTH:
        return best
    # A band against either margin is a margin, not a gutter.
    if not 0.35 * width <= centre <= 0.65 * width:
        return best
    return candidate if best is None or end - start > best[1] - best[0] else best


def _column_gutter(
    rows: list[list[tuple[float, float, float, str]]],
    width: float,
) -> tuple[float, float] | None:
    """The widest vertical band near the middle of the page that few rows cross.

    A fixed fraction of the page width does not work as a gutter test: the
    eight-millimetre column gap most proceedings use is narrower than five
    percent of a letter page, so consecutive left- and right-column lines get
    joined into one sentence.  The page states where its own gutter is, so
    measure it instead of guessing.

    A handful of rows are allowed to cross: a paper's title, its authors and
    the occasional full-width figure span both columns, and demanding a
    completely empty band would find no gutter on the very page that has one.
    """
    counts = [0] * (int(width) + 2)
    for row in rows:
        crossed: set[int] = set()
        for left, right, _, _ in row:
            crossed.update(range(max(0, int(left)), min(len(counts) - 1, int(right) + 1)))
        for column in crossed:
            counts[column] += 1
    limit = int(len(rows) * GUTTER_ROW_TOLERANCE)
    best: tuple[float, float] | None = None
    start: int | None = None
    for column, count in enumerate(counts):
        if count <= limit:
            if start is None:
                start = column
        elif start is not None:
            best = _better_gutter(best, (start, column), width)
            start = None
    return best


def _page_reading_order(page: dict[str, object]) -> str:
    width = float(page["width"])
    height = float(page["height"])
    words = list(page["words"])
    if not words:
        return ""

    # First form rows, then split any row that the page's gutter runs through.
    # This avoids treating simultaneous left/right-column lines as one sentence.
    rows: list[list[tuple[float, float, float, str]]] = []
    for word in sorted(words, key=lambda item: (item[2], item[0])):
        if not rows or abs(word[2] - rows[-1][0][2]) > 3:
            rows.append([word])
        else:
            rows[-1].append(word)

    gutter = _column_gutter(rows, width)
    lines: list[tuple[float, float, float, str]] = []
    for row in rows:
        part: list[tuple[float, float, float, str]] = []
        previous_right = 0.0
        for word in sorted(row, key=lambda item: item[0]):
            # Cut only where the gutter itself passes between two words, so a
            # stretched space in justified text is never mistaken for one.
            if part and gutter and previous_right <= gutter[0] and word[0] >= gutter[1]:
                lines.append((part[0][0], part[-1][1], part[0][2], " ".join(item[3] for item in part)))
                part = []
            part.append(word)
            previous_right = word[1]
        if part:
            lines.append((part[0][0], part[-1][1], part[0][2], " ".join(item[3] for item in part)))

    # Ignore an isolated page number near the bottom of the page.
    lines = [line for line in lines if not (line[3].isdigit() and line[2] > height * 0.88)]
    middle = (gutter[0] + gutter[1]) / 2 if gutter else width * 0.5
    left = [line for line in lines if line[1] <= middle]
    right = [line for line in lines if line[0] >= middle]

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


def _provenance_boxes(item: dict[str, object], pages: dict[str, object]) -> list[dict[str, object]]:
    """Docling provenance as page-relative boxes, dropping anything unplaceable."""
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
    return boxes


def paragraphs_from_docling_document(
    document: dict[str, object],
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    """Map Docling's JSON to source paragraphs, plus the figure and table boxes.

    The boxes are returned alongside rather than folded in because they are not
    reading material themselves: they only say which of the text blocks were
    drawn inside a figure.
    """
    pages = document.get("pages", {})
    paragraphs: list[dict[str, object]] = []
    for text_index, item in enumerate(document.get("texts", [])):
        value = str(item.get("text", "")).strip()
        if not value:
            continue
        boxes = _provenance_boxes(item, pages)
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
    figure_boxes = [
        box
        for group in ("pictures", "tables")
        for item in document.get(group, [])
        for box in _provenance_boxes(item, pages)
    ]
    return paragraphs, figure_boxes


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
    # Sorted so the choice does not depend on directory order, even though the
    # temporary directory holds exactly one file today.
    json_files = sorted(output_directory.rglob("*.json"))
    if not json_files:
        raise ValueError("Docling completed without producing structured output.")
    document = json.loads(json_files[0].read_text(encoding="utf-8"))
    paragraphs, figure_boxes = paragraphs_from_docling_document(document)
    return content_for_preset(annotate_filter_reasons(paragraphs, figure_boxes), preset)


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


def _document_name(value: str, fallback: str) -> str:
    """Turn a URL tail or page title into a safe, readable file name."""
    name = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", " ", unquote(value)).strip()
    name = re.sub(r"\s+", " ", name)[:120].strip() or fallback
    return name if name.lower().endswith(".pdf") else f"{name}.pdf"


def _name_from_url(url: str) -> str:
    parsed = urlparse(url)
    tail = parsed.path.rsplit("/", 1)[-1]
    return _document_name(tail or parsed.netloc, "document.pdf")


def print_url_as_pdf(url: str) -> tuple[bytes, str]:
    """Render a web page to PDF with the browser Playwright manages."""
    if not PRINT_URL.exists():
        raise ValueError("The web page printer is missing from this checkout.")
    temporary_root = ROOT / "tmp" / "pages"
    temporary_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=temporary_root) as directory:
        output = Path(directory) / "page.pdf"
        result = subprocess.run(
            ["node", str(PRINT_URL), url, str(output)],
            capture_output=True,
            timeout=PRINT_TIMEOUT,
            check=False,
            cwd=str(ROOT),
        )
        if result.returncode or not output.exists():
            message = result.stderr.decode("utf-8", errors="replace").strip()
            raise ValueError(message or "That page could not be printed to PDF.")
        try:
            title = str(json.loads(result.stdout.decode("utf-8", errors="replace")).get("title", ""))
        except (ValueError, AttributeError):
            title = ""
        return output.read_bytes(), _document_name(title, urlparse(url).netloc or "page.pdf")


def fetch_url_as_pdf(url: str, printer: Callable[[str], tuple[bytes, str]] = print_url_as_pdf) -> tuple[bytes, str]:
    """Download a PDF, or print the page at that address to one."""
    url = url.strip()
    if len(url) > MAX_URL_LENGTH:
        raise ValueError("That web address is too long.")
    parsed = urlparse(url)
    # Only web addresses: this keeps the fetch away from file:// and friends.
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Enter an http:// or https:// address.")
    request = Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; pdfreader/1.0)"})
    try:
        with urlopen(request, timeout=FETCH_TIMEOUT) as response:  # noqa: S310 - scheme checked above
            payload = response.read(MAX_PDF_SIZE + 1)
            final_url = response.geturl()
    except (URLError, OSError, ValueError) as error:
        raise ValueError(f"Could not open that address: {error}") from error
    if len(payload) > MAX_PDF_SIZE:
        raise ValueError("That document is larger than 50 MB.")
    if not payload:
        raise ValueError("That address returned an empty response.")
    # Sniff the bytes rather than trusting Content-Type, which is often wrong.
    if b"%PDF-" in payload[:1024]:
        return payload, _name_from_url(final_url)
    return printer(url)


class KokoroApp:
    def __init__(self) -> None:
        # Keep model downloads inside this checkout unless the user overrides it.
        os.environ.setdefault("HF_HOME", str(ROOT / ".hf-cache"))
        from kokoro import KPipeline

        self.pipeline: KPipeline = KPipeline(lang_code="a")
        self.lock = threading.Lock()

    def synthesize(
        self,
        text: str,
        speed: float,
        voice: str = DEFAULT_VOICE,
        should_stop: Callable[[], bool] | None = None,
    ) -> bytes:
        return to_wav(self._synthesize_chunks([text], speed, voice, should_stop))

    def synthesize_export(
        self,
        chunks_to_speak: list[str],
        speed: float,
        voice: str = DEFAULT_VOICE,
        should_stop: Callable[[], bool] | None = None,
    ) -> bytes:
        """Generate one WAV from an explicit, client-selected reading queue."""
        return to_wav(self._synthesize_chunks(chunks_to_speak, speed, voice, should_stop))

    def _synthesize_chunks(
        self,
        chunks_to_speak: list[str],
        speed: float,
        voice: str = DEFAULT_VOICE,
        should_stop: Callable[[], bool] | None = None,
    ) -> np.ndarray:
        chunks: list[np.ndarray] = []
        for text in chunks_to_speak:
            if should_stop is not None and should_stop():
                raise RequestCancelled
            # Serializing inference prevents simultaneous browser requests
            # competing for the same model instance and system memory.  The
            # lock is taken per chunk rather than around the whole batch, so a
            # long export does not stall the paragraph the reader is waiting on.
            with self.lock:
                for result in self.pipeline(text, voice=voice, speed=speed):
                    # Checked between the pieces the pipeline yields, not only
                    # between chunks, so leaving stops generation part-way
                    # through a long paragraph instead of at the end of it.
                    if should_stop is not None and should_stop():
                        raise RequestCancelled
                    if result.audio is not None:
                        chunks.append(result.audio.numpy())
        if not chunks:
            raise ValueError("Kokoro did not produce audio for that text.")
        return np.concatenate(chunks)

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
            if any(path.startswith(prefix) for prefix in ASSET_ROOTS):
                self._serve_static(path)
                return
            if path == "/api/voices":
                self._send_json(HTTPStatus.OK, {
                    "default": DEFAULT_VOICE,
                    "voices": [{"id": identifier, "label": label} for identifier, label in VOICES],
                })
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
            for prefix, root in ASSET_ROOTS.items():
                if request_path.startswith(prefix):
                    break
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            target = (root / request_path.removeprefix(prefix)).resolve()
            if root not in target.parents or not target.is_file():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            body = target.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", CONTENT_TYPES.get(target.suffix, "application/octet-stream"))
            self.send_header("Content-Length", str(len(body)))
            # Application sources change during development; only the vendored
            # runtime is safe to cache indefinitely.
            immutable = root is STATIC_ROOT
            self.send_header("Cache-Control", "public, max-age=31536000, immutable" if immutable else "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:  # noqa: N802
            if self.path == "/api/extract-pdf":
                self._extract_pdf()
                return
            if self.path == "/api/export-audio":
                self._export_audio()
                return
            if self.path == "/api/fetch-url":
                self._fetch_url()
                return
            if self.path != "/api/synthesize":
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                # Content-Length counts encoded JSON bytes, so allow for escapes
                # and multi-byte characters before the text-length check below.
                if not 0 < length <= MAX_TEXT_LENGTH * 6 + 200:
                    raise ValueError("Request is too large.")
                payload = json.loads(self.rfile.read(length))
                text = str(payload.get("text", "")).strip()
                speed = float(payload.get("speed", 1.0))
                voice = self._voice_from(payload)
                if not text:
                    raise ValueError("Enter some text first.")
                if len(text) > MAX_TEXT_LENGTH:
                    raise ValueError(f"Text must be {MAX_TEXT_LENGTH:,} characters or fewer.")
                if not 0.5 <= speed <= 2.0:
                    raise ValueError("Speed must be between 0.5 and 2.0.")
                body = app.synthesize(text, speed, voice, self._client_gone)
            except RequestCancelled:
                # The reader moved on, so this paragraph is no longer wanted.
                # Stopping here frees the model for the one that is.
                self.log_message("Synthesis cancelled by the browser")
                self.close_connection = True
                return
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

        def _export_audio(self) -> None:
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_EXPORT_CHARACTERS * 6 + 4096:
                    raise ValueError("Export request is too large.")
                payload = json.loads(self.rfile.read(length))
                chunks = [str(item).strip() for item in payload.get("chunks", [])]
                if not chunks or any(not item or len(item) > MAX_TEXT_LENGTH for item in chunks):
                    raise ValueError("Export chunks must contain 1 to 4,000 characters each.")
                if sum(map(len, chunks)) > MAX_EXPORT_CHARACTERS:
                    raise ValueError("Export is limited to 250,000 characters at a time.")
                speed = float(payload.get("speed", 1.0))
                if not 0.5 <= speed <= 2.0:
                    raise ValueError("Speed must be between 0.5 and 2.0.")
                body = app.synthesize_export(chunks, speed, self._voice_from(payload), self._client_gone)
            except RequestCancelled:
                # Cancelling in the browser has to stop the work here too, or
                # the model keeps generating audio nobody will receive.
                self.log_message("Export cancelled by the browser")
                self.close_connection = True
                return
            except (ValueError, json.JSONDecodeError) as error:
                self.log_error("Invalid export request: %s", error)
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except Exception as error:
                self.log_error("Export failed: %s", error)
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(error)})
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Disposition", 'attachment; filename="pdf-reader-export.wav"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _fetch_url(self) -> None:
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_URL_LENGTH * 4:
                    raise ValueError("Request is too large.")
                payload = json.loads(self.rfile.read(length))
                url = str(payload.get("url", "")).strip()
                if not url:
                    raise ValueError("Enter a web address.")
                body, filename = fetch_url_as_pdf(url)
            except (ValueError, json.JSONDecodeError) as error:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                return
            except subprocess.TimeoutExpired:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "That page took too long to print."})
                return
            except Exception as error:
                self.log_error("URL fetch failed: %s", error)
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(error)})
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/pdf")
            # Percent-encoded so a non-ASCII title survives the header.
            self.send_header("X-Document-Name", quote(filename))
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

        def _voice_from(self, payload: dict[str, object]) -> str:
            voice = str(payload.get("voice", "") or DEFAULT_VOICE)
            if voice not in VOICE_IDS:
                raise ValueError("Unknown voice.")
            return voice

        def _client_gone(self) -> bool:
            """Whether the browser closed the connection, as a cancel does."""
            try:
                readable, _, _ = select.select([self.connection], [], [], 0)
                if not readable:
                    return False
                # Readable with nothing to peek at means the peer sent EOF.
                return not self.connection.recv(1, socket.MSG_PEEK)
            except OSError:
                return True

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
