// The reader's side panel: the outline, text and highlight views, and the
// search across them. It holds its own copy of the reading queue, which the
// reader pushes in as it changes, so nothing here reaches into reader state.
import { headingDepth, normaliseSearchText, statusForItem } from './text.mjs';

export function createDrawer({
  drawer,
  searchInput,
  searchCount,
  searchPrev,
  searchNext,
  tabs,
  indicators = {},
  onJump = () => {},
  onReveal = () => {},
  onSearchChange = () => {},
}) {
  let queue = [];
  let annotations = [];
  let currentIndex = -1;
  let outlineItems = [];
  let searchResults = [];
  let searchResultIndex = -1;
  let activeView = 'outline';

  const views = {outline: showOutline, text: showText, highlights: showHighlights};

  function appendHighlightedText(container, value, query) {
    const normalisedQuery = normaliseSearchText(query || '');
    if (!normalisedQuery) { container.textContent = value; return; }
    const match = value.toLocaleLowerCase().indexOf(normalisedQuery);
    if (match < 0) { container.textContent = value; return; }
    container.append(
      document.createTextNode(value.slice(0, match)),
      Object.assign(document.createElement('mark'), {textContent: value.slice(match, match + normalisedQuery.length)}),
      document.createTextNode(value.slice(match + normalisedQuery.length)),
    );
  }

  function paragraphMeta(index) {
    return `Paragraph ${index + 1} · ${statusForItem(queue[index])}`;
  }

  // Update the open drawer in place rather than rebuilding it: conversion
  // state changes for every prefetched paragraph, and a rebuild would drop

  function buildOutline() {
    outlineItems = queue.flatMap((item, index) => (
      item.label === 'title' || item.label === 'section_header'
        ? [{index, sourceId: item.sourceId, text: item.text, depth: headingDepth(item.text)}] : []
    ));
    tabs.outline.disabled = false;
  }

  function openDrawer(title, entries, emptyMessage) {
    drawer.replaceChildren();
    const heading = document.createElement('h3');
    heading.textContent = title;
    drawer.append(heading);
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.textContent = emptyMessage;
      drawer.append(empty);
    } else entries.forEach(entry => drawer.append(entry));
    drawer.hidden = false;
  }

  function activateReaderView(button) {
    activeView = button === tabs.outline ? 'outline' : button === tabs.text ? 'text' : 'highlights';
    [tabs.outline, tabs.text, tabs.highlights].forEach(item => item.classList.toggle('active', item === button));
  }

  function showOutline() {
    const query = normaliseSearchText(searchInput.value || '');
    const entries = outlineItems.filter(item => !query || normaliseSearchText(item.text).includes(query)).map(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'drawer-item';
      button.style.paddingLeft = `${8 + ((item.depth - 1) * 14)}px`;
      button.textContent = item.text;
      button.addEventListener('click', () => onJump(item.index, {play: true}));
      return button;
    });
    openDrawer('Outline', entries, query ? 'No outline entries match this search.' : 'No section headings were detected in this reading queue.');
  }

  function showText() {
    const query = normaliseSearchText(searchInput.value || '');
    const entries = queue.flatMap((item, index) => !query || item.searchText.includes(query) ? [(() => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'drawer-item';
      appendHighlightedText(button, item.text, searchInput.value);
      button.dataset.paragraphIndex = String(index);
      button.classList.toggle('active', index === currentIndex);
      const meta = document.createElement('span'); meta.className = 'drawer-meta'; meta.textContent = paragraphMeta(index);
      button.append(meta); button.addEventListener('click', () => onJump(index, {play: true})); return button;
    })()] : []);
    openDrawer('Text', entries, query ? 'No paragraphs match this search.' : 'No imported text is available.');
  }

  function showHighlights() {
    const sourceIndices = new Map(queue.map((item, index) => [item.sourceId, index]));
    const query = normaliseSearchText(searchInput.value || '');
    const entries = annotations.filter(annotation => !query || normaliseSearchText(`${annotation.excerpt} ${annotation.note || ''}`).includes(query)).map(annotation => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `drawer-item passage${annotation.note ? ' has-note' : ''}`;
      const index = sourceIndices.get(annotation.sourceId);

      // The source text is what makes a note make sense later, so it is
      // always quoted first and the note reads as a reply to it.
      const quote = document.createElement('span');
      quote.className = 'passage-quote';
      appendHighlightedText(quote, annotation.excerpt || 'Highlighted paragraph', searchInput.value);
      button.append(quote);

      if (annotation.note) {
        const note = document.createElement('span');
        note.className = 'passage-note';
        appendHighlightedText(note, annotation.note, searchInput.value);
        button.append(note);
      }

      const meta = document.createElement('span');
      meta.className = 'drawer-meta';
      const when = annotation.updatedAt ? new Date(annotation.updatedAt) : null;
      const stamp = when && !Number.isNaN(when.valueOf())
        ? ` · ${when.toLocaleDateString(undefined, {month: 'short', day: 'numeric'})}` : '';
      meta.textContent = index === undefined
        ? 'Paragraph moved; use the quote above to find it'
        : `Paragraph ${index + 1}${stamp}`;
      button.append(meta);

      // Browsing saved passages only moves the page. Whatever is playing
      // keeps playing, and the reading position stays where it was.
      button.addEventListener('click', () => {
        if (index !== undefined) onReveal(index);
      });
      return button;
    });
    openDrawer('Highlights', entries, query ? 'No highlights or notes match this search.' : 'Use Highlight or Add note on a PDF paragraph to save it here.');
  }

  // The Text view deliberately does not follow the reader, so it needs to say
  // which way the paragraph being read went. Only that view has one, and only
  // while it is actually off screen.
  function currentElement() {
    return activeView === 'text' && currentIndex >= 0
      ? drawer.querySelector(`[data-paragraph-index="${currentIndex}"]`)
      : null;
  }

  function updateIndicators() {
    const {up, down} = indicators;
    if (!up || !down) return;
    const target = currentElement();
    // `offsetParent` is null whenever the list is not laid out at all, which
    // is how listen-only mode hides it; measuring then would compare zeroes
    // and leave an arrow pointing at nothing.
    if (!target || drawer.hidden || !drawer.offsetParent) { up.hidden = true; down.hidden = true; return; }
    const view = drawer.getBoundingClientRect();
    const item = target.getBoundingClientRect();
    up.hidden = item.bottom > view.top;
    down.hidden = item.top < view.bottom;
  }

  function scrollToCurrent() {
    const target = currentElement();
    if (!target) return;
    drawer.scrollTop = target.offsetTop - (drawer.clientHeight - target.offsetHeight) / 2;
    updateIndicators();
  }

  drawer.addEventListener('scroll', updateIndicators, {passive: true});
  [indicators.up, indicators.down].forEach(button => button?.addEventListener('click', scrollToCurrent));

  function updateSearchResults() {
    const query = normaliseSearchText(searchInput.value);
    searchResults = activeView === 'text' && query ? queue.flatMap((item, index) => item.searchText.includes(query) ? [{index, item}] : []) : [];
    searchResultIndex = searchResults.length ? 0 : -1;
    searchCount.textContent = `${searchResults.length} result${searchResults.length === 1 ? '' : 's'}`;
    searchPrev.disabled = !searchResults.length;
    searchNext.disabled = !searchResults.length;
    if (activeView === 'outline') showOutline();
    else if (activeView === 'text') showText();
    else showHighlights();
    onSearchChange();
  }

  function moveSearchResult(change) {
    if (!searchResults.length) return;
    searchResultIndex = (searchResultIndex + change + searchResults.length) % searchResults.length;
    const result = searchResults[searchResultIndex];
    onReveal(result.index);
    const readFromHere = document.createElement('button');
    readFromHere.type = 'button';
    readFromHere.className = 'drawer-item';
    readFromHere.textContent = `Read from here: ${result.item.text.slice(0, 180)}`;
    readFromHere.addEventListener('click', () => onJump(result.index, {play: true}));
    openDrawer(`Search result ${searchResultIndex + 1} of ${searchResults.length}`, [readFromHere], '');
  }

  return {
    get activeView() { return activeView; },
    setQueue(nextItems) {
      queue = nextItems;
      buildOutline();
    },
    setAnnotations(nextAnnotations) { annotations = nextAnnotations; },
    setCurrent(index) { currentIndex = index; updateIndicators(); },
    /** Switches view, either from a tab element or by name. */
    show(view) {
      const name = typeof view === 'string' ? view : (view === tabs.outline ? 'outline' : view === tabs.text ? 'text' : 'highlights');
      activateReaderView(tabs[name]);
      views[name]();
      updateIndicators();
    },
    /** Repaints the open view in place. Conversion state changes for every
     *  prefetched paragraph, and rebuilding would drop scroll and focus. */
    refresh() {
      drawer.querySelectorAll('[data-paragraph-index]').forEach(element => {
        const index = Number(element.dataset.paragraphIndex);
        if (!queue[index]) return;
        element.classList.toggle('active', index === currentIndex);
        element.querySelector('.drawer-meta').textContent = paragraphMeta(index);
      });
      updateIndicators();
    },
    search: updateSearchResults,
    moveResult: moveSearchResult,
    reset() {
      searchInput.value = '';
      searchResults = [];
      searchResultIndex = -1;
      searchCount.textContent = '0 results';
      searchPrev.disabled = true;
      searchNext.disabled = true;
      drawer.hidden = true;
      updateIndicators();
    },
  };
}
