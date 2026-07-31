# PDF Reader Roadmap

## Product boundaries

- The application remains local-first: the HTTP server binds to `127.0.0.1`; PDFs, extracted text, audio, notes, and settings are not sent to a hosted service.
- Kokoro remains the speech dependency. Docling remains the preferred structured PDF extractor, and PDF.js remains the in-browser page renderer.
- A source paragraph is the stable unit of interaction. Its Docling `id`, text, page number, and bounding boxes must survive filtering, navigation, bookmarks, and annotations.
- Extraction is never silently destructive. Presets may suppress material from the *reading queue*, but the user can select a less-filtered preset and re-extract the original PDF.

## Phase 1 - Dependable reading experience

### Goal

Make the extracted reading queue consistently useful for academic papers while retaining a direct path back to the original PDF content.

### 1.1 Extraction presets

Replace the current reading-order selector with an extraction configuration containing these presets:

| Preset | Included content | Suppressed content |
| --- | --- | --- |
| Prose only | titles, headings, body text, normal list items | repeated headers/footers, figure labels, isolated tokens, reference entries, captions |
| Prose + captions | Prose only content plus figure/table captions | repeated headers/footers, figure labels, isolated tokens, reference entries |
| Full document | every supported Docling text block | only invalid/empty blocks |

Implementation details:

- Keep `docling`, `docling_no_ocr`, `source`, and `columns` as extraction engines/order choices. The new preset is a separate filter applied after extraction.
- Extend each structured Docling paragraph with `label`, `page`, `boxes`, and a stable `id`. Do not create a new `id` when filtering.
- Return both `paragraphs` (the selected reading queue) and `all_paragraphs` (unfiltered structured content) from `/api/extract-pdf`. The browser may reapply a different preset without rerunning Docling when the chosen engine supports geometry.
- Keep the existing square-bracket playback option separate from extraction filtering. It controls what is spoken, not which PDF paragraphs exist.

### 1.2 Deterministic non-prose filtering

Start with transparent heuristics, not another opaque model:

- Header/footer: normalize whitespace, case, and page numbers; suppress a block only when the normalized form recurs on at least two pages and all occurrences fall in the top or bottom 10% of their page.
- Figure labels: suppress a one- or two-token block matching patterns such as `Figure 2`, `Fig. 2`, `Table 3`, or a bare numeric panel label when it is adjacent to an image/caption block.
- References: once a heading normalizes to `references` or `bibliography`, mark following list-like blocks as references until the end of the document. Do not suppress a heading earlier in the paper merely because it contains the word “reference.”
- Captions: treat Docling `caption` blocks as captions; include them only in the Prose + captions and Full document presets.
- Always show a small filter summary after extraction, for example: “186 reading paragraphs; 12 headers/footers and 38 reference entries hidden.”

### 1.3 Reader controls

Add keyboard controls only while focus is outside an editable form field:

- `Space`: play/pause.
- `J` / `K`: next/previous paragraph.
- `[` / `]`: lower/raise playback speed by 0.1x, within the existing 0.5x–2.0x range.
- `-` / `=`: zoom out/in.
- `Escape`: exit the full-page reader.

Expose the shortcuts in a help button and use `aria-keyshortcuts` where appropriate.

### 1.4 Per-document resume state

Persist the following locally after each paragraph transition and on reader exit:

- document key;
- selected extraction engine and preset;
- source paragraph `id` and speech-part index;
- playback speed, skip-bracket setting, and PDF zoom;
- last updated timestamp.

Use a SHA-256 digest of the PDF bytes as the document key, calculated with `crypto.subtle.digest`. File name, size, and modified date are display metadata only; they are not reliable identifiers.

### Phase 1 acceptance criteria

- A two-column paper can be re-extracted under every preset without uploading it anywhere.
- The PDF highlight, transcript item, playback state, and saved resume position refer to the same source paragraph `id`.
- Users can replay a completed paragraph and resume a document after a page refresh.
- A visible explanation identifies what was filtered and how to recover it.

## Phase 2 - Navigation and comprehension

### Goal

Make a long document navigable without manually scrolling either the PDF or transcript.

### 2.1 Section outline

- Derive outline entries from Docling `title` and `section_header` blocks, preserving document order and source paragraph `id`.
- Infer heading depth conservatively from numbering (`1`, `1.1`, `1.1.1`) when available. Do not invent a hierarchy for unnumbered headings.
- Provide an outline drawer in the full-page reader. Selecting an entry jumps to its first paragraph, scrolls the PDF to its box, and begins preparation from that point.
- If no headings are detected, omit the outline UI rather than showing an empty panel.

### 2.2 Search

- Search normalized transcript text locally: case-insensitive, whitespace-normalized, with a plain substring match in the first release.
- Return result count, surrounding text, and source paragraph `id`; do not search image pixels or attempt OCR beyond the selected extraction engine.
- Selecting a result jumps to the matching paragraph in both panels without automatically starting playback. Include an explicit “Read from here” action.
- Highlight only the matched phrase in the transcript. Keep the existing PDF paragraph box as the PDF-side target because word-level geometry is not yet guaranteed by the Docling response.

### 2.3 Bookmarks and notes

- A bookmark stores document key, source paragraph `id`, optional note text, creation timestamp, and a short immutable text excerpt for recovery if extraction changes.
- Store bookmarks in IndexedDB, not `localStorage`, so notes are not constrained by small key-value quotas.
- If an older bookmark’s source `id` no longer exists after re-extraction, offer the stored excerpt as a search query; do not silently attach it to a different paragraph.

### 2.4 Progress and time remaining

- Progress is based on source paragraphs, not temporary TTS chunks.
- Show: current paragraph / total paragraphs, current section, elapsed listening time, and estimated remaining listening time.
- Estimate remaining time from a rolling average of completed audio duration per spoken character at the selected playback speed. Before enough audio has played, label the number as an estimate.

### Phase 2 acceptance criteria

- A user can find a phrase, jump to it, bookmark it, refresh, and return to it locally.
- Outline and progress operate correctly when one source paragraph contains multiple internal speech chunks.
- No search result or bookmark changes the selected extraction output.

## Phase 3 - Personal library

### Goal

Support returning to documents over multiple sessions without making local storage of original PDFs implicit.

### 3.1 Recent document index

- Store document metadata, last position, extraction settings, progress, and bookmark counts in IndexedDB.
- By default, store no original PDF bytes. A “recent” item asks the user to reselect the local file before rendering it again.
- Display file name, page count, last-opened time, progress, and an “available after reselecting” state.
- Provide explicit delete controls for one record and for all locally stored reader data.

### 3.2 Optional offline copies

- Offer an explicit “Keep an offline copy in this browser” action; never enable it by default.
- Before writing bytes to IndexedDB, request persistent storage where available and check `navigator.storage.estimate()`.
- If quota is insufficient or persistent storage is unavailable, keep the metadata-only record and show a clear explanation.
- The UI must distinguish a saved PDF from a metadata-only recent item.

### 3.3 Collections

- A collection contains only document keys, name, optional color, and ordering metadata.
- Documents may belong to multiple collections.
- Renaming/deleting a collection does not delete documents, notes, or offline copies.

### 3.4 Audio export

- Support export of the current paragraph, current section, or entire reading queue.
- Use a dedicated server endpoint that synthesizes sequentially with the selected Kokoro voice speed, streams/assembles WAV output, and enforces the existing local input size limits.
- Export includes only the selected reading queue and honors the skip-bracket setting.
- Make this an explicit user action with progress and cancellation; do not pre-generate full-document audio in the background.

### Phase 3 acceptance criteria

- A user can resume metadata and notes after a browser restart without the application retaining the PDF unless they explicitly opted in.
- Deleting library data removes corresponding IndexedDB records and optional offline bytes.
- Exported audio plays as a valid WAV and follows the active reading settings.

## Phase 4 - Study tools

### Goal

Turn the reader into a local active-reading environment without implying that every feature requires an AI model.

### 4.1 Source-linked annotations

- An annotation stores document key, source paragraph `id`, page/box snapshot, selected color, note text, and timestamps.
- PDF annotations render as a non-obscuring border/marker, using the same coordinate system as the current playback highlight.
- A transcript annotation remains attached to the source paragraph even when its internal speech chunks change.

### 4.2 Review queue

- Users can add bookmarked or annotated paragraphs to a review queue.
- Queue entries retain a source paragraph reference and optional spaced-review metadata (`next_review_at`, interval, ease score).
- The first release provides manual “reviewed” and “review again” actions; automatic spaced-repetition scheduling can follow after usage validation.

### 4.3 Optional local assistance

- Keep summaries, section previews, and question prompts behind an explicit local-model configuration screen.
- Do not add a remote API fallback. If no configured local model is available, hide or disable the feature with an explanation.
- Every generated result must include source paragraph links so a user can inspect the underlying PDF text.

### 4.4 Listen-only mode

- Provide a compact reader view with playback controls, section title, progress, and bookmark action; hide the PDF canvas and transcript.
- Use the Media Session API for lock-screen/headphone controls when the browser supports it.
- Keep the same queue, resume state, and keyboard controls as the full reader.

### Phase 4 acceptance criteria

- Annotations and review items remain source-linked after reopening the same PDF.
- Optional assistance remains fully local and traceable to source paragraphs.
- Listen-only mode can resume the same document position as full-page mode.

## Delivery and verification rules

- Add focused tests for filtering rules, document-key generation, state migrations, and source-paragraph mapping.
- Add a browser-level smoke test for extraction, reader startup, jump-to-paragraph, resume, and zoom anchor preservation.
- Version persisted IndexedDB records and provide migrations for schema changes; never assume old state has the newest fields.
- Keep all new storage and model behavior documented in `README.md`, including exactly what is stored locally and how users clear it.
- Deliver each phase behind a working, manually testable UI path before starting the next phase.
