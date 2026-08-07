# TODO

A working backlog. `ROADMAP.md` holds the original phase plan; this is the
running list of what is actually next.

Everything that was on this list has been built: the Space bug, background
conversion, interrupting synthesis on a jump, the position indicator in the
Text view, the audio cache, voice selection, retrying a failed paragraph, the
extraction fixtures, figure-content filtering, shared preset cases, and the
four cleanup items. What follows is what came out of doing that, plus the
ideas that were never designed in the first place.

## Next up

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

- **Dialogs do not trap focus.** Tab can leave an open modal.

- **The hover note card overlaps the paragraph above it.** Inherent to an
  on-page popover at that width; the alternative is docking notes in the sidebar.
