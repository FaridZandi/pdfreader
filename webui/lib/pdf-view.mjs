// The rendered PDF: pages, zoom, and the paragraph overlays drawn over them.
// It owns every piece of PDF.js state and never reads application state -
// callers hand it the data to paint and get callbacks for what the user does.
import { statusForItem } from './text.mjs';

const MIN_SCALE = 0.75;
const MAX_SCALE = 2.5;
// Pages are rasterised once at the largest supported zoom, so every zoom step
// is a CSS resize rather than a re-render at a lower resolution.
const RENDER_SCALE = MAX_SCALE;

const TOOLS = [
  {name: 'play', icon: 'i-play', label: 'Read from here'},
  {name: 'mark', icon: 'i-mark', label: 'Highlight paragraph'},
  {name: 'note', icon: 'i-note', label: 'Add note'},
];

export function createPdfView({
  viewer,
  zoomLabel,
  emptyMessage = 'The PDF will render here when reading begins.',
  onSelect = () => {},
  onTogglePlayback = () => {},
  onToggleHighlight = () => {},
  onEditNote = () => {},
  onScaleChange = () => {},
  onDocumentLoaded = () => {},
}) {
  let pdfjsLib;
  let pdfDocument;
  let sourceFile;
  let scale = 1.25;
  let renderVersion = 0;
  let zoomFrame;
  let pendingScale;
  let pendingAnchor;

  function showScale(value) {
    if (zoomLabel) zoomLabel.textContent = `${Math.round(value * 100)}%`;
  }

  /** Where the viewport sits, as a page and a fraction down it, so the same
   *  spot can be restored after the pages change size. */
  function captureViewport(clientY) {
    const pages = [...viewer.querySelectorAll('.pdf-page')];
    if (!pages.length) return null;
    const viewerRect = viewer.getBoundingClientRect();
    const viewportOffset = Math.max(0, Math.min(
      clientY === undefined ? viewer.clientHeight / 2 : clientY - viewerRect.top,
      viewer.clientHeight,
    ));
    const documentY = viewer.scrollTop + viewportOffset;
    for (const page of pages) {
      const pageRect = page.getBoundingClientRect();
      const pageTop = pageRect.top - viewerRect.top + viewer.scrollTop;
      if (documentY >= pageTop && documentY <= pageTop + pageRect.height) {
        return {
          pageNumber: page.dataset.pageNumber,
          pagePosition: (documentY - pageTop) / pageRect.height,
          viewportOffset,
        };
      }
    }
    return null;
  }

  function restoreViewport(anchor) {
    if (!anchor) return;
    const page = viewer.querySelector(`.pdf-page[data-page-number="${anchor.pageNumber}"]`);
    if (!page) return;
    const viewerRect = viewer.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    const pageTop = pageRect.top - viewerRect.top + viewer.scrollTop;
    viewer.scrollTop = Math.max(0, pageTop + (pageRect.height * anchor.pagePosition) - anchor.viewportOffset);
  }

  async function library() {
    pdfjsLib ||= await import('/static/pdfjs/pdf.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/pdfjs/pdf.worker.mjs';
    return pdfjsLib;
  }

  function buildOverlay(sourceId, box) {
    const overlay = document.createElement('div');
    overlay.tabIndex = 0;
    overlay.setAttribute('role', 'button');
    overlay.className = 'pdf-paragraph';
    overlay.dataset.sourceId = sourceId;
    overlay.title = 'Read from this paragraph';
    overlay.style.left = `${(box.bbox.l / box.page_size.width) * 100}%`;
    overlay.style.top = `${((box.page_size.height - box.bbox.t) / box.page_size.height) * 100}%`;
    overlay.style.width = `${((box.bbox.r - box.bbox.l) / box.page_size.width) * 100}%`;
    overlay.style.height = `${((box.bbox.t - box.bbox.b) / box.page_size.height) * 100}%`;
    overlay.addEventListener('click', () => onSelect(sourceId));
    overlay.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onSelect(sourceId);
    });

    const actions = {play: onTogglePlayback, mark: onToggleHighlight, note: onEditNote};
    const tools = document.createElement('span');
    tools.className = 'paragraph-tools';
    for (const {name, icon, label} of TOOLS) {
      const tool = document.createElement('button');
      tool.type = 'button';
      tool.dataset.tool = name;
      tool.title = label;
      tool.setAttribute('aria-label', label);
      tool.innerHTML = `<svg><use href="#${icon}"/></svg>`;
      tool.addEventListener('click', event => { event.stopPropagation(); actions[name](sourceId); });
      tools.append(tool);
    }

    // Filled in by refreshOverlays, and only shown for paragraphs with a note.
    const noteCard = document.createElement('button');
    noteCard.type = 'button';
    noteCard.className = 'paragraph-note';
    noteCard.title = 'Edit this note';
    noteCard.hidden = true;
    noteCard.innerHTML = '<svg><use href="#i-note"/></svg><span class="paragraph-note-text"></span>';
    noteCard.addEventListener('click', event => { event.stopPropagation(); onEditNote(sourceId); });

    overlay.append(tools, noteCard);
    return overlay;
  }

  function groupBoxesByPage(paragraphs) {
    const byPage = new Map();
    paragraphs.forEach(paragraph => {
      const boxes = paragraph.boxes || [{page: paragraph.page, bbox: paragraph.bbox, page_size: paragraph.page_size}];
      boxes.forEach(box => {
        if (!box.page || !box.bbox || !box.page_size) return;
        const pageBoxes = byPage.get(box.page) || [];
        pageBoxes.push({id: paragraph.id, box});
        byPage.set(box.page, pageBoxes);
      });
    });
    return byPage;
  }

  async function renderPages(paragraphs, viewportAnchor = captureViewport(), atScale = scale) {
    const version = ++renderVersion;
    const boxesByPage = groupBoxesByPage(paragraphs);
    const rendered = document.createDocumentFragment();
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      if (version !== renderVersion) return;
      const page = await pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({scale: atScale});
      const renderViewport = page.getViewport({scale: Math.max(atScale, RENDER_SCALE)});
      const pixelRatio = window.devicePixelRatio || 1;
      const pageElement = document.createElement('div');
      pageElement.className = 'pdf-page';
      pageElement.dataset.pageNumber = String(pageNumber);
      pageElement.style.width = `${viewport.width}px`;
      pageElement.style.height = `${viewport.height}px`;
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(renderViewport.width * pixelRatio);
      canvas.height = Math.floor(renderViewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      pageElement.append(canvas);
      await page.render({
        canvasContext: canvas.getContext('2d'),
        viewport: renderViewport,
        transform: [pixelRatio, 0, 0, pixelRatio, 0, 0],
      }).promise;
      if (version !== renderVersion) return;
      for (const {id, box} of boxesByPage.get(pageNumber) || []) pageElement.append(buildOverlay(id, box));
      rendered.append(pageElement);
    }
    if (version !== renderVersion) return;
    viewer.replaceChildren(rendered);
    restoreViewport(viewportAnchor);
    showScale(atScale);
  }

  function applyScale(nextScale, viewportAnchor) {
    if (!pdfDocument) return;
    const ratio = nextScale / scale;
    if (ratio === 1) return;
    scale = nextScale;
    // Resize what is already rasterised rather than rendering again.
    const pages = [...viewer.querySelectorAll('.pdf-page')].map(page => ({
      page,
      canvas: page.querySelector('canvas'),
      width: page.getBoundingClientRect().width,
      height: page.getBoundingClientRect().height,
    }));
    pages.forEach(({page, canvas, width, height}) => {
      const scaledWidth = width * ratio;
      const scaledHeight = height * ratio;
      page.style.width = `${scaledWidth}px`;
      page.style.height = `${scaledHeight}px`;
      canvas.style.width = `${scaledWidth}px`;
      canvas.style.height = `${scaledHeight}px`;
    });
    restoreViewport(viewportAnchor);
    showScale(nextScale);
    onScaleChange(nextScale);
  }

  return {
    minScale: MIN_SCALE,
    maxScale: MAX_SCALE,

    getScale: () => scale,

    /** Sets the zoom without touching the page, for restoring a saved one
     *  before anything has been rendered. */
    setScale(value) {
      if (!Number.isFinite(value) || value < MIN_SCALE || value > MAX_SCALE) return;
      scale = value;
      showScale(value);
    },

    /** Coalesces zoom steps into one frame, so a scroll wheel or a held key
     *  does not lay out the pages once per event. */
    zoomBy(change, clientY) {
      if (!pdfDocument) return;
      const base = pendingScale ?? scale;
      pendingScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.round((base + change) * 100) / 100));
      pendingAnchor = captureViewport(clientY);
      if (zoomFrame) return;
      zoomFrame = requestAnimationFrame(() => {
        const targetScale = pendingScale;
        const targetAnchor = pendingAnchor;
        pendingScale = undefined;
        pendingAnchor = undefined;
        zoomFrame = undefined;
        applyScale(targetScale, targetAnchor);
      });
    },

    async render(file, paragraphs) {
      const pdfjs = await library();
      if (file !== sourceFile) {
        sourceFile = file;
        pdfDocument = await pdfjs.getDocument({data: new Uint8Array(await file.arrayBuffer())}).promise;
        onDocumentLoaded(file, pdfDocument.numPages);
      }
      await renderPages(paragraphs);
    },

    /** Drops the rendered pages. Bumping the version first stops a render that
     *  is still walking the page list from repopulating the viewer, and each
     *  page is a full-resolution canvas worth releasing. */
    clear() {
      renderVersion += 1;
      viewer.replaceChildren(Object.assign(document.createElement('p'), {
        className: 'pdf-loading',
        textContent: emptyMessage,
      }));
    },

    reveal(sourceId) {
      if (!sourceId) return;
      viewer.querySelector(`.pdf-paragraph[data-source-id="${sourceId}"]`)
        ?.scrollIntoView({block: 'center', behavior: 'auto'});
    },

    /** Paints reading state onto the overlays. Indexed by source id first:
     *  this runs on every conversion state change, and scanning the queue once
     *  per overlay made it quadratic in the paragraph count. */
    refreshOverlays({items = [], currentSourceId, playing = false, highlights = [], query = ''} = {}) {
      const itemsBySource = new Map();
      items.forEach(item => {
        const existing = itemsBySource.get(item.sourceId);
        if (existing) existing.push(item);
        else itemsBySource.set(item.sourceId, [item]);
      });
      const highlightsBySource = new Map(highlights.map(highlight => [highlight.sourceId, highlight]));

      viewer.querySelectorAll('.pdf-paragraph').forEach(overlay => {
        const sourceId = overlay.dataset.sourceId;
        const sourceItems = itemsBySource.get(sourceId) || [];
        const statuses = sourceItems.map(statusForItem);
        const status = statuses.includes('playing') ? 'playing'
          : statuses.includes('converting') ? 'converting'
          : statuses.includes('ready') ? 'ready'
          : statuses.length && statuses.every(item => item === 'played') ? 'played' : 'queued';
        const highlight = highlightsBySource.get(sourceId);
        // A search marks its matches but never hides a paragraph: every
        // paragraph in the PDF stays visible and clickable.
        const matching = Boolean(query) && sourceItems.some(item => item.searchText.includes(query));
        overlay.className = `pdf-paragraph status-${status}${highlight ? ' annotated' : ''}${matching ? ' search-match' : ''}`;

        const setTool = (name, {on, label, icon}) => {
          const tool = overlay.querySelector(`[data-tool="${name}"]`);
          if (!tool) return;
          if (icon) tool.querySelector('use').setAttribute('href', icon);
          tool.classList.toggle('is-on', Boolean(on));
          tool.title = label;
          tool.setAttribute('aria-label', label);
        };
        const isPlaying = sourceId === currentSourceId && playing;
        setTool('play', {label: isPlaying ? 'Pause' : 'Read from here', icon: isPlaying ? '#i-pause' : '#i-play'});
        setTool('mark', {on: highlight, label: highlight ? 'Remove highlight' : 'Highlight paragraph'});
        setTool('note', {on: highlight?.note, label: highlight?.note ? 'Edit note' : 'Add note'});

        const noteCard = overlay.querySelector('.paragraph-note');
        if (!noteCard) return;
        noteCard.hidden = !highlight?.note;
        if (highlight?.note) {
          noteCard.querySelector('.paragraph-note-text').textContent = highlight.note;
          noteCard.setAttribute('aria-label', `Edit note: ${highlight.note.slice(0, 80)}`);
        }
      });
    },

    /** A first-page preview for the gallery card. */
    async thumbnail(file) {
      const pdfjs = await library();
      const document_ = await pdfjs.getDocument({data: new Uint8Array(await file.arrayBuffer())}).promise;
      const page = await document_.getPage(1);
      const viewport = page.getViewport({scale: 0.35});
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({canvasContext: canvas.getContext('2d'), viewport}).promise;
      return canvas.toDataURL('image/jpeg', 0.82);
    },
  };
}
