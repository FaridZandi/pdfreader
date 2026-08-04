import { createDrawer } from './lib/drawer.mjs';
import { createLibrary } from './lib/library.mjs';
import { createPdfView } from './lib/pdf-view.mjs';
import {
  allRecords,
  deleteRecord,
  getRecord,
  putRecord,
  recordsForDocument,
} from './lib/db.mjs';
import {
  filterSummaryMessage,
  headingDepth,
  normaliseSearchText,
  selectParagraphsForPreset,
  splitDocumentParagraphs,
  splitForSpeech,
  statusForItem,
  textForSpeech,
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
let readerSessionStartedAt = 0;
let readerCompletedCharacters = 0;
let readerCompletedSeconds = 0;
let currentDocumentFile;
let exportAbortController;
let readerAnnotations = [];
let entrySubmit;
let openingGalleryKey;
let readerAutoplay = false;
let readerRun = 0;
let readerAudioUrl;
let readerItems = [];
let readerCurrentIndex = -1;
// Paragraph audio is always generated at Kokoro's natural speed; the
// reader's speed control adjusts <audio> playback rate so a change takes
// effect immediately instead of discarding prepared audio.
const SYNTHESIS_SPEED = 1;
const PREFETCH_COUNT = 2;
const preferenceKeys = {
  readerPlaybackSpeed: 'pdfreader.reader-playback-speed',
  skipBracketedText: 'pdfreader.skip-bracketed-text',
  readingOrder: 'pdfreader.reading-order',
  extractionPreset: 'pdfreader.extraction-preset',
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
  onJump: (index, options) => jumpToParagraph(index, options),
  onReveal: index => revealParagraph(index),
  onSearchChange: () => refreshOverlays(),
});

const pdfView = createPdfView({
  viewer: pdfViewer,
  zoomLabel: pdfZoomValue,
  onSelect: sourceId => jumpToSource(sourceId, {play: true, reveal: false}),
  onTogglePlayback: toggleParagraphPlayback,
  onToggleHighlight: toggleHighlight,
  onEditNote: addNote,
  onScaleChange: () => saveDocumentResume(),
  onDocumentLoaded: (file, pageCount) => {
    if (currentDocumentKey) registerRecentDocument(file, {pageCount}).catch(() => {});
  },
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
  const item = readerItems[readerCurrentIndex];
  if (!key || !item) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      sourceId: item.sourceId,
      speechChunk: item.partIndex,
      readingOrder: readingOrder.value,
      preset: extractionPreset.value,
      playbackSpeed: Number(readerPlaybackSpeed.value),
      skipBracketedText: skipBracketedText.checked,
      zoom: pdfView.getScale(),
      updatedAt: new Date().toISOString(),
    }));
    queueRecentDocumentUpdate({
      extraction: {engine: readingOrder.value, preset: extractionPreset.value},
      progress: {sourceId: item.sourceId, paragraphIndex: readerCurrentIndex, totalParagraphs: readerItems.length},
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

async function toggleHighlight(sourceId = readerItems[readerCurrentIndex]?.sourceId) {
  if (!currentDocumentKey || !sourceId) return;
  const item = readerItems.find(entry => entry.sourceId === sourceId);
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
async function addNote(sourceId = readerItems[readerCurrentIndex]?.sourceId) {
  if (!currentDocumentKey || !sourceId) return;
  const item = readerItems.find(entry => entry.sourceId === sourceId);
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

// The transport button carries its state in its icon and accessible name;
// it has no visible label to overwrite.
function setPlaybackButton(playing) {
  readerToggle.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  readerToggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

function currentSection(index = readerCurrentIndex) {
  for (let itemIndex = index; itemIndex >= 0; itemIndex -= 1) {
    const item = readerItems[itemIndex];
    if (item?.label === 'title' || item?.label === 'section_header') return item.text;
  }
  return 'Introduction';
}

function updateReaderProgress() {
  if (readerCurrentIndex < 0 || !readerItems.length) return;
  const elapsedSeconds = readerSessionStartedAt ? (Date.now() - readerSessionStartedAt) / 1000 : 0;
  let remaining = '';
  if (readerCompletedCharacters >= 80 && readerCompletedSeconds > 0) {
    const averageSecondsPerCharacter = readerCompletedSeconds / readerCompletedCharacters;
    const remainingCharacters = readerItems.slice(readerCurrentIndex).reduce((total, item, index) => {
      const startPart = index === 0 ? item.partIndex : 0;
      return total + item.parts.slice(startPart).join(' ').length;
    }, 0);
    const seconds = Math.round(remainingCharacters * averageSecondsPerCharacter);
    const minutes = Math.floor(seconds / 60);
    remaining = ` · ~${minutes ? `${minutes}m ` : ''}${seconds % 60}s left`;
  }
  readerProgress.textContent = `Paragraph ${readerCurrentIndex + 1} of ${readerItems.length}`;
  readerDetail.textContent = `${currentSection()} · ${Math.floor(elapsedSeconds / 60)}m listened${remaining}`;
  readerProgressFill.style.width = `${((readerCurrentIndex + 1) / readerItems.length) * 100}%`;
  readerPrev.disabled = readerCurrentIndex <= 0;
  readerNext.disabled = readerCurrentIndex >= readerItems.length - 1;
}

function exportItems(scope) {
  if (scope === 'paragraph') return readerItems.slice(readerCurrentIndex, readerCurrentIndex + 1);
  if (scope === 'section') {
    let start = readerCurrentIndex;
    while (start > 0 && !['title', 'section_header'].includes(readerItems[start].label)) start -= 1;
    let end = readerCurrentIndex + 1;
    while (end < readerItems.length && !['title', 'section_header'].includes(readerItems[end].label)) end += 1;
    return readerItems.slice(start, end);
  }
  return readerItems;
}

async function exportAudio(scope) {
  const chunks = exportItems(scope).flatMap(item => item.parts).filter(Boolean);
  if (!chunks.length) return;
  const controls = [readerExportParagraph, readerExportSection, readerExportDocument];
  controls.forEach(button => { button.disabled = true; });
  readerExportCancel.hidden = false;
  exportAbortController = new AbortController();
  readerStatus.textContent = `Exporting ${scope} locally (${chunks.length} speech chunks)...`;
  try {
    const response = await fetch('/api/export-audio', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      // Live playback reaches the chosen speed through the audio element,
      // so an export has to ask Kokoro for it to sound the same.
      body: JSON.stringify({chunks, speed: Number(readerPlaybackSpeed.value)}),
      signal: exportAbortController.signal,
    });
    if (!response.ok) throw await requestError(response, 'Could not export audio.');
    const url = URL.createObjectURL(await response.blob());
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
    controls.forEach(button => { button.disabled = !readerItems.length; });
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

loadPreferences();
library.render();

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

async function synthesize(value, rate) {
  const speechText = textForSpeech(value, skipBracketedText.checked);
  if (!speechText) throw new Error('No speakable text remains after skipping bracketed text.');
  const response = await fetch('/api/synthesize', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({text: speechText, speed: rate})
  });
  if (!response.ok) throw await requestError(response, 'Could not generate audio.');
  return response.blob();
}

function revealParagraph(index) {
  pdfView.reveal(readerItems[index]?.sourceId);
}

// Hands the PDF view everything it needs to paint, and keeps the reader's own
// highlight button in step with the paragraph being read.
function refreshOverlays() {
  pdfView.refreshOverlays({
    items: readerItems,
    currentSourceId: readerItems[readerCurrentIndex]?.sourceId,
    playing: readerAutoplay,
    highlights: readerAnnotations,
    query: normaliseSearchText(readerSearch.value || ''),
  });
  const currentHighlight = highlightFor(readerItems[readerCurrentIndex]?.sourceId);
  readerHighlightToggle.classList.toggle('is-on', Boolean(currentHighlight));
  readerHighlightToggle.lastChild.textContent = currentHighlight ? 'Highlighted' : 'Highlight';
}

function highlightFor(sourceId) {
  return readerAnnotations.find(annotation => annotation.sourceId === sourceId);
}

function jumpToSource(sourceId, options) {
  const index = readerItems.findIndex(item => item.sourceId === sourceId && statusForItem(item) !== 'played');
  jumpToParagraph(index >= 0 ? index : readerItems.findIndex(item => item.sourceId === sourceId), options);
}

// Clicking the transport on the paragraph that is already loaded should
// behave like the main play button rather than restarting it.
function toggleParagraphPlayback(sourceId) {
  if (readerItems[readerCurrentIndex]?.sourceId === sourceId && readerPlayer.src) {
    toggleReaderPlayback();
    return;
  }
  jumpToSource(sourceId, {play: true, reveal: false});
}

function refreshReaderState() {
  drawer.refresh();
  updateReaderProgress();
  refreshOverlays();
}

function focusParagraph(index, reveal = false) {
  readerCurrentIndex = index;
  drawer.setCurrent(index);
  refreshReaderState();
  if (reveal) revealParagraph(index);
  saveDocumentResume();
}



function unloadReaderAudio() {
  readerPlayer.pause();
  readerPlayer.removeAttribute('src');
  readerPlayer.load();
  if (readerAudioUrl) URL.revokeObjectURL(readerAudioUrl);
  readerAudioUrl = undefined;
}

function stopReader() {
  saveDocumentResume();
  readerRun += 1;
  unloadReaderAudio();
  exportAbortController?.abort();
  readerItems = [];
  readerCurrentIndex = -1;
  pdfView.clear();
  reader.hidden = true;
  documentSetup.hidden = true;
  reader.classList.remove('listen-only');
  readerListenOnly.textContent = 'Listen only';
  exportMenu.open = false;
  readerToggle.disabled = true;
  setPlaybackButton(false);
  readerProgressFill.style.width = '0%';
  if (document.fullscreenElement === reader) document.exitFullscreen().catch(() => {});
  // The reader is hidden by now, so this both persists the final position
  // and refreshes the gallery you are returning to.
  flushRecentDocumentUpdate();
}

// `play` marks an explicit request to read from here. Keyboard and
// media-key navigation omit it so they keep whatever state you were in.
// Moving the reading position scrolls the PDF to match, except when the
// caller is a click on the paragraph itself, which is already on screen.
function jumpToParagraph(index, {play = false, reveal = true} = {}) {
  if (reader.hidden || index < 0 || index >= readerItems.length) return;
  const previous = readerItems[readerCurrentIndex];
  if (previous?.partStates[previous.partIndex] === 'playing') previous.partStates[previous.partIndex] = 'ready';
  const target = readerItems[index];
  target.partIndex = 0;
  target.partStates = target.partStates.map(state => state === 'played' ? 'ready' : state === 'error' ? 'queued' : state);
  unloadReaderAudio();
  if (play) readerAutoplay = true;
  setPlaybackButton(readerAutoplay);
  readerToggle.disabled = true;
  focusParagraph(index, reveal);
  readerStatus.textContent = `Preparing paragraph ${index + 1}...`;
  saveDocumentResume();
  startCurrentParagraph(readerRun);
}

function pumpConversionQueue(run) {
  if (run !== readerRun || reader.hidden || readerItems.some(item => item.partStates.includes('converting'))) return;
  const lastIndex = Math.min(readerCurrentIndex + PREFETCH_COUNT, readerItems.length - 1);
  let itemIndex = -1;
  let partIndex = -1;
  for (let i = readerCurrentIndex; i <= lastIndex; i += 1) {
    const queuedPart = readerItems[i]?.partStates.findIndex(state => state === 'queued') ?? -1;
    if (queuedPart >= 0) { itemIndex = i; partIndex = queuedPart; break; }
  }
  if (itemIndex < 0) return;
  const item = readerItems[itemIndex];
  item.partStates[partIndex] = 'converting';
  refreshReaderState();
  synthesize(item.parts[partIndex], SYNTHESIS_SPEED)
    .then(blob => {
      if (run !== readerRun) return;
      item.blobs[partIndex] = blob;
      item.partStates[partIndex] = 'ready';
      refreshReaderState();
      saveDocumentResume();
      if (itemIndex === readerCurrentIndex && item.partIndex === partIndex) startCurrentParagraph(run);
      pumpConversionQueue(run);
    })
    .catch(error => {
      if (run !== readerRun) return;
      item.partStates[partIndex] = 'error';
      item.error = error.message;
      refreshReaderState();
      if (itemIndex === readerCurrentIndex && item.partIndex === partIndex) {
        readerStatus.textContent = `Paragraph ${itemIndex + 1} failed: ${error.message}`;
        readerToggle.disabled = true;
      }
      pumpConversionQueue(run);
    });
}

function startCurrentParagraph(run) {
  if (run !== readerRun || readerCurrentIndex < 0) return;
  const item = readerItems[readerCurrentIndex];
  const partIndex = item.partIndex;
  const partState = item.partStates[partIndex];
  if (partState === 'queued' || partState === 'converting') {
    // Audio is not ready yet, but the controls already reflect the
    // pending intent so a click never looks like it was ignored.
    readerStatus.textContent = readerAutoplay
      ? `Converting paragraph ${readerCurrentIndex + 1}; playback starts automatically…`
      : `Converting paragraph ${readerCurrentIndex + 1}…`;
    readerToggle.disabled = true;
    setPlaybackButton(readerAutoplay);
    pumpConversionQueue(run);
    return;
  }
  if (partState === 'error') return;
  unloadReaderAudio();
  item.partStates[partIndex] = 'playing';
  readerAudioUrl = URL.createObjectURL(item.blobs[partIndex]);
  readerPlayer.src = readerAudioUrl;
  readerPlayer.playbackRate = Number(readerPlaybackSpeed.value);
  if ('mediaSession' in navigator && 'MediaMetadata' in window) {
    navigator.mediaSession.metadata = new MediaMetadata({title: currentSection(), artist: readerTitle.textContent, album: 'PDF Reader'});
    navigator.mediaSession.setActionHandler('play', () => readerPlayer.play());
    navigator.mediaSession.setActionHandler('pause', () => readerPlayer.pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => jumpToParagraph(Math.min(readerItems.length - 1, readerCurrentIndex + 1)));
    navigator.mediaSession.setActionHandler('previoustrack', () => jumpToParagraph(Math.max(0, readerCurrentIndex - 1)));
  }
  readerPlayer.onended = () => {
    if (run !== readerRun) return;
    item.partStates[partIndex] = 'played';
    readerCompletedCharacters += item.parts[partIndex].length;
    readerCompletedSeconds += (readerPlayer.duration || 0) / Math.max(Number(readerPlaybackSpeed.value), 0.1);
    if (partIndex + 1 < item.parts.length) {
      item.partIndex += 1;
      refreshReaderState();
      saveDocumentResume();
      startCurrentParagraph(run);
      return;
    }
    const nextIndex = readerCurrentIndex + 1;
    if (nextIndex >= readerItems.length) {
      refreshReaderState();
      readerStatus.textContent = 'Finished reading.';
      readerToggle.disabled = true;
      saveDocumentResume();
      return;
    }
    focusParagraph(nextIndex, true);
    startCurrentParagraph(run);
  };
  readerToggle.disabled = false;
  setPlaybackButton(readerAutoplay);
  refreshReaderState();
  saveDocumentResume();
  readerStatus.textContent = readerAutoplay ? 'Playing. The conversion queue is preparing upcoming paragraphs.' : 'Ready to play. Upcoming paragraphs will prepare as you listen.';
  pumpConversionQueue(run);
  if (readerAutoplay) readerPlayer.play().catch(() => {
    readerAutoplay = false;
    setPlaybackButton(false);
    readerStatus.textContent = 'Audio is ready. Press Play to begin reading.';
  });
}

extract.addEventListener('click', async () => {
  const file = pdf.files[0];
  if (!file) { pdfStatus.textContent = 'Choose a PDF first.'; return; }
  extract.disabled = true;
  pdfStatus.textContent = `Extracting text from ${file.name}...`;
  try {
    const response = await fetch('/api/extract-pdf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'X-Reading-Order': readingOrder.value,
        'X-Extraction-Preset': extractionPreset.value,
      },
      body: file
    });
    if (!response.ok) throw await requestError(response, 'Could not extract the PDF.');
    const result = await response.json();
    preparedText = result.text;
    preparedParagraphs = result.paragraphs || [];
    allPreparedParagraphs = result.all_paragraphs || preparedParagraphs;
    lastFilterSummary = result.filter_summary;
    if (currentDocumentKey) {
      // Store the PDF first: a saved extraction without its document is
      // an orphan record the gallery can never open.
      const [stored, thumbnail] = await Promise.all([retainPdfInGallery(file), pdfView.thumbnail(file).catch(() => null)]);
      if (!stored) throw new Error('This browser could not store the PDF in the local gallery.');
      await putRecord('extractions', {
        key: currentDocumentKey, text: result.text, paragraphs: preparedParagraphs,
        allParagraphs: allPreparedParagraphs, filterSummary: lastFilterSummary, updatedAt: new Date().toISOString(),
      });
      await registerRecentDocument(file, {thumbnail, extraction: {engine: readingOrder.value, preset: extractionPreset.value}});
    }
    readerTitle.textContent = file.name;
    const summary = preparedParagraphs.length
      ? filterSummaryMessage(lastFilterSummary)
      : 'Text is ready (this fallback does not expose PDF paragraph geometry).';
    pdfStatus.textContent = `Imported ${file.name}. ${summary}`;
    documentSetup.hidden = true;
    openReader();
  } catch (error) {
    pdfStatus.textContent = error.message;
  } finally {
    extract.disabled = false;
  }
});

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
  readerRun += 1;
  const run = readerRun;
  readerAutoplay = false;
  readerItems = paragraphs.map(paragraph => {
    const speechText = textForSpeech(paragraph.text, skipBracketedText.checked);
    const parts = splitForSpeech(speechText);
    // Normalised once here rather than per keystroke, per paragraph.
    return { ...paragraph, text: speechText, searchText: normaliseSearchText(speechText), parts, blobs: Array(parts.length).fill(null), partStates: Array(parts.length).fill('queued'), partIndex: 0 };
  }).filter(item => item.parts.length);
  if (!readerItems.length) return;
  readerSessionStartedAt = Date.now();
  readerCompletedCharacters = 0;
  readerCompletedSeconds = 0;
  drawer.reset();
  drawer.setQueue(readerItems);
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
  readerStatus.textContent = `Opening ${readerItems.length} paragraphs in the advanced reader...`;
  const resumeIndex = pendingResume?.sourceId === undefined || pendingResume?.sourceId === null
    ? -1
    : readerItems.findIndex(item => item.sourceId === pendingResume.sourceId);
  readerCurrentIndex = resumeIndex >= 0 ? resumeIndex : 0;
  if (resumeIndex >= 0) {
    const item = readerItems[readerCurrentIndex];
    item.partIndex = Math.max(0, Math.min(item.parts.length - 1, Number(pendingResume.speechChunk) || 0));
    readerStatus.textContent = `Resuming paragraph ${readerCurrentIndex + 1}...`;
  }
  focusParagraph(readerCurrentIndex);
  try {
    await pdfView.render(pdf.files[0], preparedParagraphs);
    startCurrentParagraph(run);
    revealParagraph(readerCurrentIndex);
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

function toggleReaderPlayback() {
  if (readerToggle.disabled) return;
  if (readerPlayer.paused) { readerAutoplay = true; readerPlayer.play().catch(() => {}); setPlaybackButton(true); readerStatus.textContent = 'Playing.'; }
  else { readerAutoplay = false; readerPlayer.pause(); setPlaybackButton(false); readerStatus.textContent = 'Paused.'; }
  refreshOverlays();
}

readerToggle.addEventListener('click', toggleReaderPlayback);
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
readerPrev.addEventListener('click', () => jumpToParagraph(readerCurrentIndex - 1));
readerNext.addEventListener('click', () => jumpToParagraph(readerCurrentIndex + 1));
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
document.addEventListener('keydown', event => {
  if (reader.hidden || event.metaKey || event.ctrlKey || event.altKey) return;
  const tagName = document.activeElement?.tagName;
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (!readerHelpDialog.hidden) { readerHelpDialog.hidden = true; readerHelp.focus(); }
    else stopReader();
    return;
  }
  // A dialog owns the keyboard while it is open.
  if (!readerHelpDialog.hidden || !entryDialog.hidden) return;
  if (event.key === ' ') { event.preventDefault(); toggleReaderPlayback(); return; }
  if (event.key === 'j' || event.key === 'J') { event.preventDefault(); jumpToParagraph(Math.min(readerItems.length - 1, readerCurrentIndex + 1)); return; }
  if (event.key === 'k' || event.key === 'K') { event.preventDefault(); jumpToParagraph(Math.max(0, readerCurrentIndex - 1)); return; }
  if (event.key === '[') { event.preventDefault(); readerPlaybackSpeed.value = String(Math.max(0.5, Number(readerPlaybackSpeed.value) - 0.1)); readerPlaybackSpeed.dispatchEvent(new Event('input')); return; }
  if (event.key === ']') { event.preventDefault(); readerPlaybackSpeed.value = String(Math.min(2, Number(readerPlaybackSpeed.value) + 0.1)); readerPlaybackSpeed.dispatchEvent(new Event('input')); return; }
  if (event.key === '-') { event.preventDefault(); pdfView.zoomBy(-0.15); return; }
  if (event.key === '=') { event.preventDefault(); pdfView.zoomBy(0.15); }
});
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && !reader.hidden) reader.focus?.(); });
