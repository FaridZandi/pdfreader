import { createDrawer } from './lib/drawer.mjs';
import { createLibrary } from './lib/library.mjs';
import { createPdfView } from './lib/pdf-view.mjs';
import { createSpeech, SYNTHESIS_SPEED } from './lib/speech.mjs';
import {
  allRecords,
  deleteRecord,
  getRecord,
  putRecord,
  recordsForDocument,
} from './lib/db.mjs';
import {
  filterSummaryMessage,
  normaliseSearchText,
  selectParagraphsForPreset,
  splitDocumentParagraphs,
} from './lib/text.mjs';

const skipBracketedText = document.querySelector('#skip-bracketed-text');
const pdf = document.querySelector('#pdf');
const choosePdf = document.querySelector('#choose-pdf');
const loadUrl = document.querySelector('#load-url');
const fileName = document.querySelector('#file-name');
const documentSetup = document.querySelector('#document-setup');
const importCancel = document.querySelector('#import-cancel');
const importClose = document.querySelector('#import-close');
const importChoose = document.querySelector('#import-choose');
const extract = document.querySelector('#extract');
const readingOrder = document.querySelector('#reading-order');
const extractionPreset = document.querySelector('#extraction-preset');
const pdfStatus = document.querySelector('#pdf-status');
const reader = document.querySelector('#reader');
const readerTitle = document.querySelector('#reader-title');
const pdfViewer = document.querySelector('#pdf-viewer');
const readerPlayer = document.querySelector('#reader-player');
const readerToggle = document.querySelector('#reader-toggle');
const pdfZoomOut = document.querySelector('#pdf-zoom-out');
const pdfZoomIn = document.querySelector('#pdf-zoom-in');
const pdfZoomValue = document.querySelector('#pdf-zoom-value');
const readerPlaybackSpeed = document.querySelector('#reader-playback-speed');
const readerPlaybackValue = document.querySelector('#reader-playback-value');
const readerVoice = document.querySelector('#reader-voice');
const readerRetry = document.querySelector('#reader-retry');
const readerProgress = document.querySelector('#reader-progress');
const readerDetail = document.querySelector('#reader-detail');
const readerProgressFill = document.querySelector('#reader-progress-fill');
const readerPrev = document.querySelector('#reader-prev');
const readerNext = document.querySelector('#reader-next');
const readerStatus = document.querySelector('#reader-status');
const readerClose = document.querySelector('#reader-close');
const readerHelp = document.querySelector('#reader-help');
const readerHelpDialog = document.querySelector('#reader-help-dialog');
const readerHelpClose = document.querySelector('#reader-help-close');
const readerOutline = document.querySelector('#reader-outline');
const readerHighlightToggle = document.querySelector('#reader-highlight-toggle');
const readerText = document.querySelector('#reader-text');
const readerHighlightsButton = document.querySelector('#reader-highlights');
const readerSearch = document.querySelector('#reader-search');
const readerSearchPrev = document.querySelector('#reader-search-prev');
const readerSearchNext = document.querySelector('#reader-search-next');
const readerSearchCount = document.querySelector('#reader-search-count');
const readerDrawer = document.querySelector('#reader-drawer');
const drawerJumpUp = document.querySelector('#drawer-jump-up');
const drawerJumpDown = document.querySelector('#drawer-jump-down');
const newCollection = document.querySelector('#new-collection');
const clearLibrary = document.querySelector('#clear-library');
const libraryList = document.querySelector('#library-list');
const libraryCount = document.querySelector('#library-count');
const collectionList = document.querySelector('#collection-list');
const exportMenu = document.querySelector('#export-menu');
const readerExportParagraph = document.querySelector('#reader-export-paragraph');
const readerExportSection = document.querySelector('#reader-export-section');
const readerExportDocument = document.querySelector('#reader-export-document');
const readerExportCancel = document.querySelector('#reader-export-cancel');
const readerAnnotate = document.querySelector('#reader-annotate');
const readerListenOnly = document.querySelector('#reader-listen-only');
const entryDialog = document.querySelector('#entry-dialog');
const entryForm = document.querySelector('#entry-form');
const entryTitle = document.querySelector('#entry-title');
const entryDescription = document.querySelector('#entry-description');
const entryName = document.querySelector('#entry-name');
const entryNote = document.querySelector('#entry-note');
const entryConfirm = document.querySelector('#entry-confirm');
const entryCancel = document.querySelector('#entry-cancel');
let preparedText = '';
let preparedParagraphs = [];
let allPreparedParagraphs = [];
let lastFilterSummary;
let currentDocumentKey;
let pendingResume;
let documentSelectionVersion = 0;
let currentDocumentFile;
let exportAbortController;
let readerAnnotations = [];
let entrySubmit;
let openingGalleryKey;
const PREFETCH_COUNT = 2;
// Docling is heavy enough that two large PDFs at once can swamp the machine,
// so imports queue rather than all starting at the moment they are added.
const MAX_CONCURRENT_EXTRACTIONS = 1;
const preferenceKeys = {
  readerPlaybackSpeed: 'pdfreader.reader-playback-speed',
  skipBracketedText: 'pdfreader.skip-bracketed-text',
  readingOrder: 'pdfreader.reading-order',
  extractionPreset: 'pdfreader.extraction-preset',
  voice: 'pdfreader.voice',
};

const library = createLibrary({
  libraryList,
  collectionList,
  libraryCount,
  openDialog: options => openEntryDialog(options),
  onOpen: documentRecord => openGalleryDocument(documentRecord),
  onReselect: documentRecord => {
    // The change handler reuses the saved extraction when this key matches.
    openingGalleryKey = documentRecord.key;
    choosePdf.click();
  },
  onRetryConversion: documentRecord => retryConversion(documentRecord),
  onDocumentRemoved: key => {
    try { localStorage.removeItem(`pdfreader.resume.${key}`); } catch { /* Storage is optional. */ }
  },
  onCleared: () => {
    try {
      Object.keys(localStorage)
        .filter(key => key.startsWith('pdfreader.resume.'))
        .forEach(key => localStorage.removeItem(key));
    } catch { /* Storage is optional. */ }
    setReaderAnnotations([]);
  },
});

const drawer = createDrawer({
  drawer: readerDrawer,
  searchInput: readerSearch,
  searchCount: readerSearchCount,
  searchPrev: readerSearchPrev,
  searchNext: readerSearchNext,
  tabs: {outline: readerOutline, text: readerText, highlights: readerHighlightsButton},
  indicators: {up: drawerJumpUp, down: drawerJumpDown},
  onJump: (index, options) => speech.jumpTo(index, options),
  onReveal: index => revealParagraph(index),
  onSearchChange: () => refreshOverlays(),
});

const pdfView = createPdfView({
  viewer: pdfViewer,
  zoomLabel: pdfZoomValue,
  onSelect: sourceId => speech.jumpToSource(sourceId, {play: true, reveal: false}),
  onTogglePlayback: sourceId => speech.toggleSource(sourceId),
  onToggleHighlight: toggleHighlight,
  onEditNote: addNote,
  onScaleChange: () => saveDocumentResume(),
  onDocumentLoaded: (file, pageCount) => {
    if (currentDocumentKey) registerRecentDocument(file, {pageCount}).catch(() => {});
  },
});

// The reading engine owns the queue, the conversions and the audio element.
// Everything below reacts to where it says the reader is.
const speech = createSpeech({
  player: readerPlayer,
  toggleButton: readerToggle,
  retry: readerRetry,
  prefetch: PREFETCH_COUNT,
  voice: () => readerVoice.value,
  speed: () => Number(readerPlaybackSpeed.value),
  skipBracketed: () => skipBracketedText.checked,
  documentKey: () => currentDocumentKey,
  title: () => readerTitle.textContent,
  requestError,
  onPosition: (index, {reveal} = {}) => {
    drawer.setCurrent(index);
    refreshReaderState();
    if (reveal) revealParagraph(index);
    saveDocumentResume();
  },
  onChange: refreshReaderState,
  onStatus: message => { readerStatus.textContent = message; },
  onSave: saveDocumentResume,
});

// The single place saved passages are replaced, so the drawer's copy and the
// PDF overlays can never drift from what storage holds.
function setReaderAnnotations(list) {
  readerAnnotations = list;
  drawer.setAnnotations(list);
}

function loadPreference(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function savePreference(key, value) {
  try { localStorage.setItem(key, value); } catch { /* Storage is optional. */ }
}

function resumeStorageKey() {
  return currentDocumentKey ? `pdfreader.resume.${currentDocumentKey}` : null;
}

function loadDocumentResume() {
  const key = resumeStorageKey();
  if (!key) return null;
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value?.version === 1 ? value : null;
  } catch { return null; }
}

function saveDocumentResume() {
  const key = resumeStorageKey();
  const position = speech.position();
  if (!key || !position) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      sourceId: position.sourceId,
      speechChunk: position.partIndex,
      readingOrder: readingOrder.value,
      preset: extractionPreset.value,
      playbackSpeed: Number(readerPlaybackSpeed.value),
      skipBracketedText: skipBracketedText.checked,
      zoom: pdfView.getScale(),
      updatedAt: new Date().toISOString(),
    }));
    queueRecentDocumentUpdate({
      extraction: {engine: readingOrder.value, preset: extractionPreset.value},
      progress: {sourceId: position.sourceId, paragraphIndex: position.index, totalParagraphs: position.total},
    });
  } catch { /* Storage is optional. */ }
}

// The resume record above is the durable one and is written immediately.
// The gallery's copy is only display metadata, so it is coalesced: this
// runs on every paragraph, every conversion, and every drag of the speed
// slider, and each write costs an IndexedDB transaction.
let pendingRecentChanges;
let recentDocumentTimer;

function queueRecentDocumentUpdate(changes) {
  pendingRecentChanges = changes;
  if (recentDocumentTimer) return;
  recentDocumentTimer = setTimeout(flushRecentDocumentUpdate, 1500);
}

function flushRecentDocumentUpdate() {
  clearTimeout(recentDocumentTimer);
  recentDocumentTimer = undefined;
  const changes = pendingRecentChanges;
  pendingRecentChanges = undefined;
  if (changes && currentDocumentFile) registerRecentDocument(currentDocumentFile, changes).catch(() => {});
}

async function identifyDocument(file) {
  if (!window.crypto?.subtle) return null;
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function applyResumePreferences(resume) {
  if (!resume) return;
  if ([...readingOrder.options].some(option => option.value === resume.readingOrder)) {
    readingOrder.value = resume.readingOrder;
  }
  if ([...extractionPreset.options].some(option => option.value === resume.preset)) {
    extractionPreset.value = resume.preset;
  }
  if (Number.isFinite(resume.playbackSpeed) && resume.playbackSpeed >= 0.5 && resume.playbackSpeed <= 2) {
    readerPlaybackSpeed.value = String(resume.playbackSpeed);
    readerPlaybackValue.textContent = `${resume.playbackSpeed.toFixed(1)}x`;
  }
  if (typeof resume.skipBracketedText === 'boolean') skipBracketedText.checked = resume.skipBracketedText;
  pdfView.setScale(resume.zoom);
}

function applyPreparedPreset() {
  if (!allPreparedParagraphs.length) return false;
  const selected = selectParagraphsForPreset(allPreparedParagraphs, extractionPreset.value);
  preparedParagraphs = selected.paragraphs;
  lastFilterSummary = selected.filter_summary;
  preparedText = preparedParagraphs.map(paragraph => paragraph.text).join('\n\n');
  pdfStatus.textContent = `${filterSummaryMessage(lastFilterSummary)} This preset was applied locally without re-extracting.`;
  return true;
}

// Server errors carry {"error"}, but a 404 comes from http.server itself
// as HTML - which means the running server predates this page and has to
// be restarted. Say so rather than reporting a generic failure.
async function requestError(response, fallback) {
  const body = await response.json().catch(() => null);
  if (body?.error) return new Error(body.error);
  if (response.status === 404) {
    return new Error(`${fallback} The running server does not have this endpoint — restart it with ./scripts/run.sh.`);
  }
  return new Error(`${fallback} (HTTP ${response.status})`);
}

function openEntryDialog({
  title, description, name = '', withName = Boolean(name), namePlaceholder = 'Name',
  note = '', withNote = true, confirmLabel = 'Save', onSave,
}) {
  entryTitle.textContent = title;
  entryDescription.textContent = description;
  entryName.value = name;
  entryName.placeholder = namePlaceholder;
  entryName.setAttribute('aria-label', namePlaceholder);
  entryName.hidden = !withName;
  entryNote.value = note;
  entryNote.hidden = !withNote;
  entryConfirm.textContent = confirmLabel;
  entryDialog.hidden = false;
  entrySubmit = onSave;
  (withName ? entryName : withNote ? entryNote : entryConfirm).focus();
}

function closeEntryDialog() {
  entryDialog.hidden = true;
  entrySubmit = undefined;
}

entryCancel.addEventListener('click', closeEntryDialog);
// Captured before every other handler so Escape reaches this dialog from
// inside its own text field, and never falls through to the reader's
// Escape, which would exit the reader and discard what was typed.
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || entryDialog.hidden) return;
  event.preventDefault();
  event.stopPropagation();
  closeEntryDialog();
}, true);
entryForm.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = entrySubmit;
  entryDialog.hidden = true;
  entrySubmit = undefined;
  if (submit) await submit({name: entryName.value.trim(), note: entryNote.value.trim()});
});

async function refreshHighlights(message) {
  setReaderAnnotations(await recordsForDocument('annotations', currentDocumentKey));
  refreshOverlays();
  if (message) readerStatus.textContent = message;
  if (drawer.activeView === 'highlights') drawer.show('highlights');
}

async function toggleHighlight(sourceId = speech.current?.sourceId) {
  if (!currentDocumentKey || !sourceId) return;
  const item = speech.items.find(entry => entry.sourceId === sourceId);
  if (!item) return;
  const existing = highlightFor(sourceId);
  if (existing?.note) {
    // Removing this record would take its note with it, so confirm first.
    openEntryDialog({
      title: 'Remove highlight',
      description: 'This paragraph has a note attached. Removing the highlight deletes the note too.',
      withNote: false,
      confirmLabel: 'Remove both',
      onSave: async () => {
        await deleteRecord('annotations', existing.id);
        await refreshHighlights('Highlight and note removed.');
      },
    });
    return;
  }
  if (existing) {
    await deleteRecord('annotations', existing.id);
    await refreshHighlights('Highlight removed.');
    return;
  }
  const source = preparedParagraphs.find(paragraph => paragraph.id === sourceId);
  await putRecord('annotations', {
    id: `${currentDocumentKey}:${sourceId}`,
    documentKey: currentDocumentKey,
    sourceId,
    boxes: source?.boxes || [],
    color: '#e3a400', note: '', excerpt: item.text.slice(0, 240),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await refreshHighlights('Highlighted.');
}

// Annotating names its paragraph outright, so it never has to move the
// reading position to reach one.
async function addNote(sourceId = speech.current?.sourceId) {
  if (!currentDocumentKey || !sourceId) return;
  const item = speech.items.find(entry => entry.sourceId === sourceId);
  if (!item) return;
  const source = preparedParagraphs.find(paragraph => paragraph.id === sourceId);
  const existing = highlightFor(sourceId);
  openEntryDialog({title: existing?.note ? 'Edit note' : 'Add note', description: item.text.slice(0, 160), note: existing?.note || '', confirmLabel: existing?.note ? 'Update' : 'Save', onSave: async ({note}) => {
    await putRecord('annotations', {...existing, id: existing?.id || `${currentDocumentKey}:${sourceId}`, documentKey: currentDocumentKey, sourceId, boxes: source?.boxes || [], color: '#e3a400', note, excerpt: item.text.slice(0, 240), createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString()});
    await refreshHighlights(note ? 'Note saved.' : 'Highlighted.');
  }});
}

async function registerRecentDocument(file, changes = {}) {
  if (!currentDocumentKey) return;
  const existing = await getRecord('documents', currentDocumentKey) || {};
  await putRecord('documents', {
    ...existing,
    ...changes,
    key: currentDocumentKey,
    fileName: file.name,
    fileSize: file.size,
    lastOpenedAt: new Date().toISOString(),
    offline: changes.offline ?? Boolean(existing.offline),
  });
  // Rebuilding the grid behind the full-screen reader is wasted work;
  // leaving it renders the gallery from the record just written.
  if (reader.hidden) library.render();
}

async function retainPdfInGallery(file) {
  if (!currentDocumentKey) return false;
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota && estimate.quota - (estimate.usage || 0) < file.size) return false;
    // Adding a document is explicit user intent to keep it in this local
    // gallery. Request persistence when supported, but retain the PDF
    // even when the browser cannot guarantee it.
    const persisted = await navigator.storage?.persist?.();
    await putRecord('offlineFiles', {key: currentDocumentKey, file});
    await registerRecentDocument(file, {offline: true, storagePersistent: Boolean(persisted)});
    return true;
  } catch { return false; }
}


async function openOfflineDocument(key) {
  const stored = await getRecord('offlineFiles', key);
  return stored?.file;
}



async function openGalleryDocument(documentRecord) {
  documentSetup.hidden = true;
  fileName.textContent = documentRecord.fileName;
  currentDocumentKey = documentRecord.key;
  currentDocumentFile = await openOfflineDocument(documentRecord.key);
  if (!currentDocumentFile) {
    openingGalleryKey = documentRecord.key;
    documentSetup.hidden = false;
    pdfStatus.textContent = 'This document is no longer stored in the browser. Select the original PDF to reopen it.';
    return;
  }
  const stored = await getRecord('extractions', documentRecord.key).catch(() => null);
  if (!stored) {
    openingGalleryKey = undefined;
    documentSetup.hidden = false;
    pdfStatus.textContent = 'This document has no saved text yet. Extract it again to open the reader.';
    return;
  }
  const transfer = new DataTransfer();
  transfer.items.add(currentDocumentFile);
  pdf.files = transfer.files;
  // Assigning input.files fires no change event, so the resume record and
  // its saved reader settings have to be restored here as well.
  pendingResume = loadDocumentResume();
  applyResumePreferences(pendingResume);
  preparedText = stored.text || '';
  preparedParagraphs = stored.paragraphs || [];
  allPreparedParagraphs = stored.allParagraphs || preparedParagraphs;
  lastFilterSummary = stored.filterSummary;
  readerTitle.textContent = documentRecord.fileName;
  pdfStatus.textContent = 'Opening saved document…';
  openReader();
}

function updateReaderProgress() {
  const items = speech.items;
  const index = speech.currentIndex;
  if (index < 0 || !items.length) return;
  const {elapsedSeconds, remainingSeconds} = speech.estimate();
  const remaining = remainingSeconds === null ? ''
    : ` · ~${Math.floor(remainingSeconds / 60) ? `${Math.floor(remainingSeconds / 60)}m ` : ''}${remainingSeconds % 60}s left`;
  readerProgress.textContent = `Paragraph ${index + 1} of ${items.length}`;
  readerDetail.textContent = `${speech.sectionAt(index)} · ${Math.floor(elapsedSeconds / 60)}m listened${remaining}`;
  readerProgressFill.style.width = `${((index + 1) / items.length) * 100}%`;
  readerPrev.disabled = index <= 0;
  readerNext.disabled = index >= items.length - 1;
}

/** Joins WAVs Kokoro produced into one. They are all mono 16-bit PCM at the
 *  same rate with a canonical 44-byte header, so this is a header and the
 *  samples behind it. Anything else is refused rather than mangled. */
async function joinWavs(blobs) {
  const HEADER = 44;
  const buffers = await Promise.all(blobs.map(blob => blob.arrayBuffer()));
  const readable = buffers.every(buffer => {
    if (buffer.byteLength <= HEADER) return false;
    const tag = new TextDecoder().decode(new Uint8Array(buffer, 0, HEADER));
    return tag.startsWith('RIFF') && tag.slice(8, 12) === 'WAVE' && tag.slice(36, 40) === 'data';
  });
  if (!readable) return null;
  const samples = buffers.reduce((total, buffer) => total + buffer.byteLength - HEADER, 0);
  const output = new Uint8Array(HEADER + samples);
  output.set(new Uint8Array(buffers[0], 0, HEADER));
  let offset = HEADER;
  for (const buffer of buffers) {
    output.set(new Uint8Array(buffer, HEADER), offset);
    offset += buffer.byteLength - HEADER;
  }
  const view = new DataView(output.buffer);
  view.setUint32(4, 36 + samples, true);
  view.setUint32(40, samples, true);
  return new Blob([output], {type: 'audio/wav'});
}

async function exportAudio(scope) {
  const chunks = speech.chunksFor(scope).filter(Boolean);
  if (!chunks.length) return;
  const controls = [readerExportParagraph, readerExportSection, readerExportDocument];
  controls.forEach(button => { button.disabled = true; });
  readerExportCancel.hidden = false;
  exportAbortController = new AbortController();
  readerStatus.textContent = `Exporting ${scope} locally (${chunks.length} speech chunks)...`;
  try {
    const speed = Number(readerPlaybackSpeed.value);
    // The export you are most likely to ask for is the passage you just
    // heard, which is already in the cache. Cached speech was generated at
    // Kokoro's natural speed though, so it can only stand in for an export at
    // that speed; any other has to be asked of the model, because that is
    // where an export's speed comes from.
    const blobs = speed === SYNTHESIS_SPEED ? await speech.cachedChunks(chunks) : null;
    const audio = (blobs && await joinWavs(blobs)) || await (async () => {
      const response = await fetch('/api/export-audio', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        // Live playback reaches the chosen speed through the audio element,
        // so an export has to ask Kokoro for it to sound the same.
        body: JSON.stringify({chunks, speed, voice: readerVoice.value}),
        signal: exportAbortController.signal,
      });
      if (!response.ok) throw await requestError(response, 'Could not export audio.');
      return response.blob();
    })();
    const url = URL.createObjectURL(audio);
    const link = document.createElement('a');
    link.href = url; link.download = `${readerTitle.textContent.replace(/\.pdf$/i, '')}-${scope}.wav`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    readerStatus.textContent = 'WAV export downloaded.';
  } catch (error) {
    readerStatus.textContent = error.name === 'AbortError' ? 'Audio export cancelled.' : error.message;
  } finally {
    exportAbortController = undefined;
    readerExportCancel.hidden = true;
    controls.forEach(button => { button.disabled = !speech.items.length; });
  }
}

function loadPreferences() {
  const savedReadingOrder = loadPreference(preferenceKeys.readingOrder);
  if ([...readingOrder.options].some(option => option.value === savedReadingOrder)) {
    readingOrder.value = savedReadingOrder;
  }
  const savedPreset = loadPreference(preferenceKeys.extractionPreset);
  if ([...extractionPreset.options].some(option => option.value === savedPreset)) {
    extractionPreset.value = savedPreset;
  }
  skipBracketedText.checked = loadPreference(preferenceKeys.skipBracketedText) === 'true';
  const savedPlaybackSpeed = Number(loadPreference(preferenceKeys.readerPlaybackSpeed));
  if (Number.isFinite(savedPlaybackSpeed) && savedPlaybackSpeed >= 0.5 && savedPlaybackSpeed <= 2) {
    readerPlaybackSpeed.value = String(savedPlaybackSpeed);
    readerPlaybackValue.textContent = `${savedPlaybackSpeed.toFixed(1)}x`;
    readerPlayer.playbackRate = savedPlaybackSpeed;
  }
}

// The voice list comes from the server so it cannot drift from what Kokoro
// will accept; the markup carries the default alone as a fallback.
async function loadVoices() {
  try {
    const response = await fetch('/api/voices');
    if (!response.ok) return;
    const {voices = [], default: fallback} = await response.json();
    if (!voices.length) return;
    const preferred = loadPreference(preferenceKeys.voice) || fallback;
    readerVoice.replaceChildren(...voices.map(voice => Object.assign(
      document.createElement('option'), {value: voice.id, textContent: voice.label},
    )));
    readerVoice.value = voices.some(voice => voice.id === preferred) ? preferred : fallback;
  } catch { /* The single option in the markup still reads. */ }
}

loadPreferences();
loadVoices();
reclaimAbandonedConversions().then(() => library.render());

choosePdf.addEventListener('click', () => pdf.click());
loadUrl.addEventListener('click', askForUrl);
importChoose.addEventListener('click', () => pdf.click());
function cancelImport() {
  pdf.value = '';
  currentDocumentFile = undefined;
  currentDocumentKey = undefined;
  openingGalleryKey = undefined;
  documentSetup.hidden = true;
}

importCancel.addEventListener('click', cancelImport);
importClose.addEventListener('click', cancelImport);
// Shared by picking a local file and by loading a URL. Assigning
// input.files fires no change event, so the URL path calls this directly.
async function beginImport(file) {
  const selectionVersion = ++documentSelectionVersion;
  currentDocumentKey = undefined;
  currentDocumentFile = file;
  pendingResume = undefined;
  fileName.textContent = file.name;
  documentSetup.hidden = false;
  extract.disabled = false;
  preparedText = '';
  preparedParagraphs = [];
  allPreparedParagraphs = [];
  pdfStatus.textContent = 'Identifying PDF locally to restore its reader settings...';
  try {
    currentDocumentKey = await identifyDocument(file);
    if (selectionVersion !== documentSelectionVersion) return;
    pendingResume = loadDocumentResume();
    applyResumePreferences(pendingResume);
    if (openingGalleryKey === currentDocumentKey) {
      openingGalleryKey = undefined;
      const stored = await getRecord('extractions', currentDocumentKey).catch(() => null);
      if (stored) {
        preparedText = stored.text || '';
        preparedParagraphs = stored.paragraphs || [];
        allPreparedParagraphs = stored.allParagraphs || preparedParagraphs;
        lastFilterSummary = stored.filterSummary;
        readerTitle.textContent = file.name;
        documentSetup.hidden = true;
        pdfStatus.textContent = 'Opening saved document…';
        await retainPdfInGallery(file);
        openReader();
        return;
      }
    }
    openingGalleryKey = undefined;
    pdfStatus.textContent = 'Ready to import. Choose extraction options, then add this PDF to your library.';
  } catch {
    if (selectionVersion === documentSelectionVersion) pdfStatus.textContent = 'PDF selected. Choose extraction options to add it to your library.';
  }
}

pdf.addEventListener('change', () => { if (pdf.files[0]) beginImport(pdf.files[0]); });

function askForUrl() {
  openEntryDialog({
    title: 'Load from a web address',
    description: 'A link to a PDF is downloaded. Any other page is printed to a PDF first. This is the one action that reaches the internet.',
    withName: true,
    namePlaceholder: 'https://example.com/paper.pdf',
    withNote: false,
    confirmLabel: 'Load',
    onSave: ({name}) => importFromUrl(name),
  });
}

async function importFromUrl(url) {
  if (!url) return;
  cancelImport();
  fileName.textContent = url;
  documentSetup.hidden = false;
  extract.disabled = true;
  pdfStatus.textContent = 'Fetching that address…';
  try {
    const response = await fetch('/api/fetch-url', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url}),
    });
    if (!response.ok) throw await requestError(response, 'Could not load that address.');
    const name = decodeURIComponent(response.headers.get('X-Document-Name') || 'page.pdf');
    const file = new File([await response.blob()], name, {type: 'application/pdf'});
    // From here it is an ordinary import, so the reader, the gallery and
    // the resume record all treat it exactly like a chosen file.
    const transfer = new DataTransfer();
    transfer.items.add(file);
    pdf.files = transfer.files;
    await beginImport(file);
  } catch (error) {
    extract.disabled = true;
    pdfStatus.textContent = error.message;
  }
}

function revealParagraph(index) {
  pdfView.reveal(speech.items[index]?.sourceId);
}

// Hands the PDF view everything it needs to paint, and keeps the reader's own
// highlight button in step with the paragraph being read.
function refreshOverlays() {
  pdfView.refreshOverlays({
    items: speech.items,
    currentSourceId: speech.current?.sourceId,
    playing: speech.playing,
    highlights: readerAnnotations,
    query: normaliseSearchText(readerSearch.value || ''),
  });
  const currentHighlight = highlightFor(speech.current?.sourceId);
  readerHighlightToggle.classList.toggle('is-on', Boolean(currentHighlight));
  readerHighlightToggle.lastChild.textContent = currentHighlight ? 'Highlighted' : 'Highlight';
}

function highlightFor(sourceId) {
  return readerAnnotations.find(annotation => annotation.sourceId === sourceId);
}

function refreshReaderState() {
  drawer.refresh();
  updateReaderProgress();
  refreshOverlays();
}

function stopReader() {
  saveDocumentResume();
  speech.stop();
  exportAbortController?.abort();
  pdfView.clear();
  reader.hidden = true;
  documentSetup.hidden = true;
  reader.classList.remove('listen-only');
  readerListenOnly.textContent = 'Listen only';
  exportMenu.open = false;
  readerProgressFill.style.width = '0%';
  if (document.fullscreenElement === reader) document.exitFullscreen().catch(() => {});
  // The reader is hidden by now, so this persists the final position, and
  // the gallery you are returning to is redrawn with whatever changed while
  // you were reading - including any import that finished behind you.
  flushRecentDocumentUpdate();
  library.render();
}

// Extraction takes as long as it takes, and holding the import dialog open
// for it stops you doing anything else. The document joins the gallery as
// soon as its file is stored, in a converting state, and becomes readable
// when the text arrives.
const extractionQueue = [];
let extractionsRunning = 0;
let autoOpenKey;

extract.addEventListener('click', async () => {
  const file = pdf.files[0];
  if (!file) { pdfStatus.textContent = 'Choose a PDF first.'; return; }
  if (!currentDocumentKey) {
    pdfStatus.textContent = 'This browser could not identify the PDF, so it cannot be added to the library.';
    return;
  }
  extract.disabled = true;
  pdfStatus.textContent = `Storing ${file.name} in your library...`;
  const key = currentDocumentKey;
  const engine = readingOrder.value;
  const preset = extractionPreset.value;
  try {
    // Store the PDF first: a document card without its file is an entry the
    // gallery can never open, and a quota failure has to be said here while
    // the dialog is still the thing you are looking at.
    const [stored, thumbnail] = await Promise.all([
      retainPdfInGallery(file),
      pdfView.thumbnail(file).catch(() => null),
    ]);
    if (!stored) throw new Error('This browser could not store the PDF in the local gallery.');
    await registerRecentDocument(file, {
      thumbnail, status: 'converting', statusMessage: '',
      extraction: {engine, preset},
    });
    readerTitle.textContent = file.name;
    documentSetup.hidden = true;
    autoOpenKey = key;
    await library.render();
    queueExtraction({key, file, engine, preset});
  } catch (error) {
    pdfStatus.textContent = error.message;
  } finally {
    extract.disabled = false;
  }
});

function queueExtraction(job) {
  extractionQueue.push(job);
  runNextExtraction();
}

function runNextExtraction() {
  if (extractionsRunning >= MAX_CONCURRENT_EXTRACTIONS) return;
  const job = extractionQueue.shift();
  if (!job) return;
  extractionsRunning += 1;
  runExtraction(job).finally(() => {
    extractionsRunning -= 1;
    runNextExtraction();
  });
}

async function runExtraction({key, file, engine, preset}) {
  try {
    const response = await fetch('/api/extract-pdf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'X-Reading-Order': engine,
        'X-Extraction-Preset': preset,
      },
      body: file,
    });
    if (!response.ok) throw await requestError(response, 'Could not extract the PDF.');
    const result = await response.json();
    await putRecord('extractions', {
      key,
      text: result.text,
      paragraphs: result.paragraphs || [],
      allParagraphs: result.all_paragraphs || result.paragraphs || [],
      filterSummary: result.filter_summary,
      updatedAt: new Date().toISOString(),
    });
    await updateDocumentStatus(key, {status: 'ready', statusMessage: ''});
    // Opening the document you just added is still the expected next step,
    // as long as you have not gone somewhere else in the meantime.
    if (autoOpenKey === key && reader.hidden) {
      autoOpenKey = undefined;
      const documentRecord = await getRecord('documents', key).catch(() => null);
      if (documentRecord) { await openGalleryDocument(documentRecord); return; }
    }
  } catch (error) {
    await updateDocumentStatus(key, {status: 'failed', statusMessage: error.message});
  }
  if (reader.hidden) await library.render();
}

async function updateDocumentStatus(key, changes) {
  const existing = await getRecord('documents', key).catch(() => null);
  if (existing) await putRecord('documents', {...existing, ...changes});
}

async function retryConversion(documentRecord) {
  const file = await openOfflineDocument(documentRecord.key);
  if (!file) {
    await updateDocumentStatus(documentRecord.key, {
      status: 'failed',
      statusMessage: 'The stored PDF is no longer here. Add it again.',
    });
  } else {
    await updateDocumentStatus(documentRecord.key, {status: 'converting', statusMessage: ''});
    // Asking for it again is asking to read it, same as adding it was.
    autoOpenKey = documentRecord.key;
    queueExtraction({
      key: documentRecord.key,
      file,
      engine: documentRecord.extraction?.engine || readingOrder.value,
      preset: documentRecord.extraction?.preset || extractionPreset.value,
    });
  }
  await library.render();
}

// A conversion is held open by the page that started it, so a document still
// marked converting when this page loads was abandoned by a reload or a
// closed tab. Offer it again rather than leaving a card that never opens.
// A second tab converting right now is marked failed here too, but it writes
// its own result when it finishes, so nothing is lost either way.
async function reclaimAbandonedConversions() {
  try {
    const documents = await allRecords('documents');
    await Promise.all(documents
      .filter(item => item.status === 'converting')
      .map(item => putRecord('documents', {
        ...item,
        status: 'failed',
        statusMessage: 'Extracting the text was interrupted.',
      })));
  } catch { /* Library storage is optional. */ }
}

async function openReader() {
  const value = preparedText.trim();
  if (!pdf.files[0] || !value) {
    pdfStatus.textContent = 'Choose and extract a PDF before opening the reader.';
    return;
  }
  const paragraphs = preparedParagraphs.length
    ? preparedParagraphs.map(paragraph => ({...paragraph, text: paragraph.text, sourceId: paragraph.id}))
    : splitDocumentParagraphs(value).map(text => ({text, sourceId: null}));
  if (!paragraphs.length) return;
  reader.hidden = false;
  if (!speech.load(paragraphs)) return;
  drawer.reset();
  drawer.setQueue(speech.items);
  readerHighlightToggle.disabled = !currentDocumentKey;
  readerText.disabled = false;
  readerAnnotate.disabled = !currentDocumentKey;
  readerHighlightsButton.disabled = !currentDocumentKey;
  readerListenOnly.disabled = false;
  readerExportParagraph.disabled = false;
  readerExportSection.disabled = false;
  readerExportDocument.disabled = false;
  if (currentDocumentKey) {
    try {
      setReaderAnnotations(await recordsForDocument('annotations', currentDocumentKey));
    } catch { setReaderAnnotations([]); }
  } else { setReaderAnnotations([]); }
  drawer.show('outline');
  readerStatus.textContent = `Opening ${speech.items.length} paragraphs in the advanced reader...`;
  const resumed = speech.begin({sourceId: pendingResume?.sourceId, partIndex: pendingResume?.speechChunk});
  if (resumed) readerStatus.textContent = `Resuming paragraph ${speech.currentIndex + 1}...`;
  try {
    await pdfView.render(pdf.files[0], preparedParagraphs);
    speech.resume();
    revealParagraph(speech.currentIndex);
    pendingResume = undefined;
  } catch (error) {
    readerStatus.textContent = `PDF rendering failed: ${error.message}`;
    readerToggle.disabled = true;
  }
}

readerPlaybackSpeed.addEventListener('input', () => {
  const rate = Number(readerPlaybackSpeed.value);
  readerPlaybackValue.textContent = `${rate.toFixed(1)}x`;
  readerPlayer.playbackRate = rate;
  savePreference(preferenceKeys.readerPlaybackSpeed, String(rate));
  saveDocumentResume();
});

readerVoice.addEventListener('change', () => {
  savePreference(preferenceKeys.voice, readerVoice.value);
  if (!reader.hidden) speech.revoice();
});

readerRetry.addEventListener('click', () => speech.retryCurrent());

readingOrder.addEventListener('change', () => {
  savePreference(preferenceKeys.readingOrder, readingOrder.value);
  saveDocumentResume();
});
extractionPreset.addEventListener('change', () => {
  savePreference(preferenceKeys.extractionPreset, extractionPreset.value);
  if (!applyPreparedPreset() && pdf.files[0]) {
    pdfStatus.textContent = 'This extraction engine needs to run again before its reading preset can be applied.';
  }
  saveDocumentResume();
});
skipBracketedText.addEventListener('change', () => {
  savePreference(preferenceKeys.skipBracketedText, String(skipBracketedText.checked));
  saveDocumentResume();
});

pdfZoomOut.addEventListener('click', () => pdfView.zoomBy(-0.15));
pdfZoomIn.addEventListener('click', () => pdfView.zoomBy(0.15));
pdfViewer.addEventListener('wheel', event => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  pdfView.zoomBy(event.deltaY < 0 ? 0.15 : -0.15, event.clientY);
}, {passive: false});

readerToggle.addEventListener('click', () => speech.toggle());
readerClose.addEventListener('click', stopReader);
readerOutline.addEventListener('click', () => drawer.show('outline'));
readerText.addEventListener('click', () => drawer.show('text'));
readerHighlightToggle.addEventListener('click', () => toggleHighlight().catch(error => { readerStatus.textContent = error.message; }));
readerHighlightsButton.addEventListener('click', () => drawer.show('highlights'));
// Each keystroke rebuilds the drawer, so coalesce fast typing.
let searchTimer;
readerSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => drawer.search(), 120);
});
readerSearchNext.addEventListener('click', () => drawer.moveResult(1));
readerSearchPrev.addEventListener('click', () => drawer.moveResult(-1));
readerAnnotate.addEventListener('click', () => addNote().catch(error => { readerStatus.textContent = error.message; }));
readerListenOnly.addEventListener('click', () => {
  reader.classList.toggle('listen-only');
  readerListenOnly.textContent = reader.classList.contains('listen-only') ? 'Show reader' : 'Listen only';
});
newCollection.addEventListener('click', library.newCollection);
clearLibrary.addEventListener('click', library.clearAll);
readerPrev.addEventListener('click', () => speech.jumpTo(speech.currentIndex - 1));
readerNext.addEventListener('click', () => speech.jumpTo(speech.currentIndex + 1));
readerExportParagraph.addEventListener('click', () => { exportMenu.open = false; exportAudio('paragraph'); });
readerExportSection.addEventListener('click', () => { exportMenu.open = false; exportAudio('section'); });
readerExportDocument.addEventListener('click', () => { exportMenu.open = false; exportAudio('document'); });
readerExportCancel.addEventListener('click', () => exportAbortController?.abort());
// A <details> menu stays open until something closes it.
document.addEventListener('click', event => {
  if (exportMenu.open && !exportMenu.contains(event.target)) exportMenu.open = false;
});
readerHelp.addEventListener('click', () => { readerHelpDialog.hidden = false; readerHelpClose.focus(); });
readerHelpClose.addEventListener('click', () => { readerHelpDialog.hidden = true; readerHelp.focus(); });
// A text field owns the keyboard. A range slider does not: Space and the
// letter shortcuts mean nothing to it, and swallowing them there was half of
// why Space stopped working after touching the speed control.
function typingInAField() {
  const element = document.activeElement;
  if (!element) return false;
  if (element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') return true;
  return element.tagName === 'INPUT' && element.type !== 'range';
}

document.addEventListener('keydown', event => {
  if (reader.hidden || event.metaKey || event.ctrlKey || event.altKey) return;
  if (typingInAField()) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (!readerHelpDialog.hidden) { readerHelpDialog.hidden = true; readerHelp.focus(); }
    else stopReader();
    return;
  }
  // A dialog owns the keyboard while it is open.
  if (!readerHelpDialog.hidden || !entryDialog.hidden) return;
  if (event.key === ' ') { event.preventDefault(); speech.toggle(); return; }
  if (event.key === 'j' || event.key === 'J') { event.preventDefault(); speech.jumpTo(speech.currentIndex + 1); return; }
  if (event.key === 'k' || event.key === 'K') { event.preventDefault(); speech.jumpTo(speech.currentIndex - 1); return; }
  if (event.key === '[') { event.preventDefault(); readerPlaybackSpeed.value = String(Math.max(0.5, Number(readerPlaybackSpeed.value) - 0.1)); readerPlaybackSpeed.dispatchEvent(new Event('input')); return; }
  if (event.key === ']') { event.preventDefault(); readerPlaybackSpeed.value = String(Math.min(2, Number(readerPlaybackSpeed.value) + 0.1)); readerPlaybackSpeed.dispatchEvent(new Event('input')); return; }
  if (event.key === '-') { event.preventDefault(); pdfView.zoomBy(-0.15); return; }
  if (event.key === '=') { event.preventDefault(); pdfView.zoomBy(0.15); }
});
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && !reader.hidden) reader.focus?.(); });
