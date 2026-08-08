# TODO

A working backlog. `ROADMAP.md` holds the original phase plan; this is the
running list of what is actually next.

Everything that was previously on this list has been built: the Space bug,
background conversion, interrupting synthesis on a jump, the position
indicator in the Text view, the audio cache, voice selection, retrying a
failed paragraph, the extraction fixtures, figure-content filtering, shared
preset cases, and the four cleanup items. What follows is what came out of
doing that, what has been asked for since, and the ideas that are still
waiting on a design.

## Next up

- [ ] **Do not open a document the moment it finishes converting.** Importing
  currently remembers the newest import in `autoOpenKey` and opens the reader
  on it when its text arrives. That is fine for one document and wrong for
  several: importing a handful in succession means the reader appears over
  whatever you were doing, at a moment you did not choose, for whichever one
  finished first. The card going openable is announcement enough. Removing it
  also removes the same behaviour from **Try again**, and the browser tests
  lean on it — `openReaderPage` in `tests/helpers/reader.mjs` treats "the
  reader appeared" as "the import finished", and would wait on the card
  instead.

- [ ] **Show time, not paragraph number, beside the transport.** The line
  under the play button reads `Paragraph 12 of 240`, which says nothing about
  how long is left. It should lead with elapsed and remaining time; the
  paragraph count is secondary. Most of this exists: `speech.estimate()`
  already returns elapsed seconds and a remaining estimate from characters
  spoken against wall-clock seconds taken, and `updateReaderProgress` already
  appends it. Two gaps to close first. It returns null until 80 characters
  have been spoken, so a document opens with no estimate at all — the audio
  cache now makes a cheap prior possible, since a cached chunk's duration is
  known without playing it. And the average is taken over wall-clock time at
  whatever speed was in force, so changing the speed control leaves a stale
  figure until enough new audio has played; measuring in audio seconds and
  dividing by the current rate at display time would fix that.

- [ ] **Skip bracketed text belongs in the reader.** The control sits in the
  import panel under **Advanced extraction**, which says it is an extraction
  setting. It is not: nothing is dropped from the extraction, and
  `speech.load()` applies `textForSpeech` when it builds the reading queue.
  So it is a reading option in the wrong place, and changing it while reading
  does nothing until the document is reopened. Moving it into the reader means
  rebuilding the queue when it is toggled, which is what `revoice()` already
  does for a voice change — the same shape, and the cache makes it cheap
  because bracketed and unbracketed text are separate keys. The resume record
  already stores the setting per document.

- [ ] **Full-width material on a two-column page is read last.** With the
  gutter now measured from the page rather than guessed, `_page_reading_order`
  splits and orders the columns correctly, but it still sorts lines into three
  buckets: anything above the topmost column line is a header and read first,
  the two columns follow, and anything else that spans the gutter is read at
  the end. A figure or table that spans both columns half way down a page is
  therefore read after the whole page. The fix is to segment the page into
  horizontal bands at each spanning line and order column material within each
  band, rather than treating the page as one region. `tests/fixtures` has no
  such page yet, so this wants one first.

- [ ] **A second tab's conversion is reported as interrupted.** A document
  still marked `converting` when a page loads was abandoned by a reload or a
  closed tab, so `reclaimAbandonedConversions` marks it failed and offers it
  again. If a *different* tab is converting it right now, that tab's card is
  marked failed until it finishes and writes its own result. Nothing is lost
  and the state corrects itself, but the card lies in the meantime. A
  heartbeat on the record, or a `BroadcastChannel` between tabs, would tell
  the two cases apart.

- [ ] **Only the Docling engines expose paragraph geometry.** `source` and
  `columns` return text with no boxes, so on those engines there are no PDF
  overlays, no highlights and no notes — the reader silently loses half its
  features and never says why. `BBoxParser` already has word positions for
  `columns` and throws them away; grouping them into the lines it already
  builds would give that engine real paragraph boxes.

## The gallery

- [ ] **Sort the gallery, and remember how.** `renderLibrary` sorts by
  `lastOpenedAt` descending and offers no choice. Wanted: last opened, last
  imported, name, and probably page count and reading progress. The
  preference is remembered, alongside the others in `preferenceKeys`. One
  thing is missing from the data: `registerRecentDocument` writes
  `lastOpenedAt` on every write, so nothing records when a document was
  *added*. That needs an `addedAt` set once at import; existing records can
  fall back to their extraction's `updatedAt`.

- [ ] **A list view for the gallery.** The card grid is the only layout, and
  it is the wrong one for a large library: covers are large, and the details
  worth scanning — name, pages, progress, collections, when it was added —
  are what a row shows well and a card shows badly. `.card-grid` and `.doc`
  in `app.css` carry the layout, so a modifier class on the container and a
  second set of rules for the card internals covers it. Remembered with the
  sort preference above.

- [ ] **Make collections worth using.** Today a collection is a chip row above
  the grid, and the only way into one is a folder button on each card that
  opens a dialog asking for a name. That is fine for making the first one and
  tedious for everything after. A sidebar listing the collections, with the
  documents dropped onto them, is the obvious direction — drag and drop
  between a card and a sidebar entry, and a batch import able to file
  everything it brings in under one collection by default. The pieces
  interlock with mass import below and with the list view above, so the
  layout question is worth settling for all three at once rather than
  three times.

## Features

- [ ] **Warn before an export the cache cannot cover.** Exporting the whole
  document at a speed other than 1.0x regenerates every chunk, which can take
  a long time with no indication of how long. The chunk count is known up
  front, and so is how many of them are already cached.

## Correctness and coverage

- [ ] **The audio cache has no browser test.** `tests/reader-playback.spec.mjs`
  proves speech is reused rather than regenerated, but eviction is untested:
  `evictCachedAudio` sorts by `usedAt` and deletes until the total is under the
  cap, and nothing exercises that path or the two-store split it relies on.

## Bigger ideas, not yet designed

- **Follow the reading at sentence or word level.** The highlight covers a whole
  paragraph. This is really two problems, and they have very different costs.

  *Which words are being spoken right now.* Sentence granularity needs nothing
  from the model: `splitForSpeech` already breaks paragraphs on sentence
  boundaries and only groups them to fill a 440-character budget. Split at one
  sentence per chunk and the chunk that is playing **is** the sentence that is
  playing — no timing data required. The costs are more, smaller requests, and a
  prefetch window that has to cover more of them; the audio cache makes this
  cheaper than it was, since short sentences repeat across documents. Word
  level is a different matter: it needs per-token timestamps. Worth checking
  whether the pinned Kokoro exposes them on its results before assuming it does
  not, since forced alignment is a heavy alternative.

  *Where those words are on the page.* Docling only gives paragraph boxes. But
  the repo already parses word-level geometry: `BBoxParser` reads
  `pdftotext -bbox` output for the `columns` engine and throws the positions
  away after ordering the lines. Keeping them, and matching them against the
  spoken text, is a plausible route to on-page highlighting without a new
  dependency. Highlighting in the Text drawer needs no geometry at all and
  could ship first.

- **Import many documents at once.** A whole conference proceedings, rather
  than one paper at a time. The shape is not worked out. One sketch: paste a
  list of addresses, comma separated, which becomes a column of input fields
  you can correct individually, then one set of import options applied to all
  of them — and, once collections are better, filed into one collection by
  default. The machinery underneath is mostly there already: extraction is a
  queue that runs one document at a time, cards carry their own converting
  and failed states, and a failure offers itself again without needing the
  original file. What is missing is the front of it — how a batch is
  described, corrected, and watched — and that is the part worth designing
  before writing any of it. Selecting many local files at once is the same
  problem with an easier input.

- **Dialogs do not trap focus.** Tab can leave an open modal.

- **The hover note card overlaps the paragraph above it.** Inherent to an
  on-page popover at that width; the alternative is docking notes in the sidebar.
