// The gallery: document cards, collection filter chips, and the actions that
// remove things. It owns which collection is selected and reads its own data
// from storage; everything outside it arrives as a callback.
import { allRecords, clearEverything, deleteCollectionRecords, deleteDocument, putRecord } from './db.mjs';

export function createLibrary({
  libraryList,
  collectionList,
  libraryCount,
  openDialog,
  onOpen = () => {},
  onReselect = () => {},
  onRetryConversion = () => {},
  onDocumentRemoved = () => {},
  onCleared = () => {},
}) {
  let activeCollectionId = null;

  async function removeDocument(key) {
    await deleteDocument(key);
    onDocumentRemoved(key);
    await renderLibrary();
  }

  async function clearAllLibraryData() {
    openDialog({
      title: 'Clear local library',
      description: 'This removes every gallery record, saved extraction, stored PDF, highlight, and note from this browser. It cannot be undone.',
      withNote: false,
      confirmLabel: 'Clear everything',
      onSave: async () => {
        await clearEverything();
        onCleared();
        await renderLibrary();
      },
    });
  }

  async function saveCollection(name) {
    const collections = await allRecords('collections');
    const existing = collections.find(collection => collection.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (existing) return existing;
    const collection = {id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, name, color: '#7052c9', order: Date.now(), createdAt: new Date().toISOString()};
    await putRecord('collections', collection);
    return collection;
  }

  async function createCollection() {
    openDialog({title: 'New collection', description: 'Collections group documents locally. Deleting one never deletes its documents.', name: 'Collection', withNote: false, onSave: async ({name}) => {
      if (!name) return;
      await saveCollection(name);
      renderLibrary();
    }});
  }

  // Naming the collection here avoids a hidden "first collection wins"
  // rule: an existing name is reused, and a new name creates a collection.
  async function addDocumentToCollection(documentRecord) {
    openDialog({title: 'Add to collection', description: `Name a collection for ${documentRecord.fileName}. An existing name adds it to that collection.`, name: 'Collection', withNote: false, confirmLabel: 'Add', onSave: async ({name}) => {
      if (!name) return;
      const collection = await saveCollection(name);
      await putRecord('documentCollections', {id: `${documentRecord.key}:${collection.id}`, documentKey: documentRecord.key, collectionId: collection.id, order: Date.now()});
      renderLibrary();
    }});
  }

  async function renameCollection(collection) {
    openDialog({title: 'Rename collection', description: 'Update this collection name.', name: collection.name, withNote: false, onSave: async ({name}) => {
      if (!name) return; await putRecord('collections', {...collection, name}); renderLibrary();
    }});
  }

  async function deleteCollection(collection) {
    await deleteCollectionRecords(collection.id);
    renderLibrary();
  }


  async function renderLibrary() {
    try {
      const [documents, collections, memberships, annotations] = await Promise.all([
        allRecords('documents'), allRecords('collections'),
        allRecords('documentCollections'), allRecords('annotations'),
      ]);
      const collectionById = new Map(collections.map(item => [item.id, item]));
      if (activeCollectionId && !collectionById.has(activeCollectionId)) activeCollectionId = null;
      renderCollectionChips(collections, memberships);
      const visible = documents
        .filter(documentRecord => !activeCollectionId
          || memberships.some(item => item.documentKey === documentRecord.key && item.collectionId === activeCollectionId))
        .sort((a, b) => (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || ''));
      libraryCount.textContent = String(documents.length);
      libraryCount.hidden = !documents.length;
      libraryList.replaceChildren();
      if (!visible.length) {
        libraryList.append(emptyState(documents.length
          ? 'No documents in this collection yet. Use the folder button on a card to add one.'
          : 'Add a PDF to start your local library. Text, position, highlights, and notes stay in this browser.'));
        return;
      }
      visible.forEach(documentRecord => {
        const tags = memberships
          .filter(item => item.documentKey === documentRecord.key)
          .map(item => collectionById.get(item.collectionId)?.name).filter(Boolean);
        const highlights = annotations.filter(annotation => annotation.documentKey === documentRecord.key).length;
        libraryList.append(documentCard(documentRecord, tags, highlights));
      });
    } catch { /* Library storage is optional. */ }
  }

  function emptyState(message) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<svg><use href="#i-file"/></svg>';
    const text = document.createElement('p');
    text.textContent = message;
    empty.append(text);
    return empty;
  }

  function renderCollectionChips(collections, memberships) {
    collectionList.replaceChildren();
    collectionList.hidden = !collections.length;
    if (!collections.length) return;
    const counts = new Map();
    memberships.forEach(item => counts.set(item.collectionId, (counts.get(item.collectionId) || 0) + 1));
    const chip = (label, id) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.textContent = label;
      button.setAttribute('aria-pressed', String(activeCollectionId === id));
      button.addEventListener('click', () => { activeCollectionId = id; renderLibrary(); });
      return button;
    };
    collectionList.append(chip('All', null));
    collections.sort((a, b) => a.order - b.order).forEach(collection => {
      collectionList.append(chip(`${collection.name} · ${counts.get(collection.id) || 0}`, collection.id));
    });
    // Renaming and deleting apply to the selected collection, so the
    // controls only appear once one is actually selected.
    const selected = collections.find(collection => collection.id === activeCollectionId);
    if (selected) {
      const rename = document.createElement('button');
      rename.type = 'button'; rename.className = 'btn btn-quiet btn-sm'; rename.textContent = 'Rename';
      rename.addEventListener('click', () => renameCollection(selected));
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'btn btn-quiet btn-danger btn-sm'; remove.textContent = 'Delete collection';
      remove.addEventListener('click', () => deleteCollection(selected));
      collectionList.append(rename, remove);
    }
  }

  function documentCard(documentRecord, tags, highlightCount) {
    // Text extraction runs in the background, so a card can exist before it
    // has anything to read. An older record has no status and always has text.
    const status = documentRecord.status || 'ready';
    const card = document.createElement('article');
    card.className = 'doc';
    const open = () => {
      if (status !== 'ready') return;
      if (documentRecord.offline) onOpen(documentRecord);
      // A metadata-only entry needs its original file selected again; the
      // caller reuses the saved extraction rather than importing it twice.
      else onReselect(documentRecord);
    };

    const cover = document.createElement('button');
    cover.type = 'button';
    cover.className = 'doc-cover';
    cover.setAttribute('aria-label', `Open ${documentRecord.fileName}`);
    cover.addEventListener('click', open);
    if (documentRecord.thumbnail) {
      const thumbnail = document.createElement('img');
      thumbnail.className = 'library-thumbnail';
      thumbnail.alt = '';
      const url = typeof documentRecord.thumbnail === 'string'
        ? documentRecord.thumbnail : URL.createObjectURL(documentRecord.thumbnail);
      thumbnail.src = url;
      if (typeof documentRecord.thumbnail !== 'string') thumbnail.onload = () => URL.revokeObjectURL(url);
      cover.append(thumbnail);
    } else {
      cover.innerHTML = '<span class="doc-cover-blank"><svg><use href="#i-file"/></svg></span>';
    }

    const body = document.createElement('div');
    body.className = 'doc-body';
    const name = document.createElement('h3');
    name.className = 'doc-name truncate';
    name.textContent = documentRecord.fileName;
    name.title = documentRecord.fileName;
    const meta = document.createElement('p');
    meta.className = 'doc-meta';
    const facts = [];
    if (documentRecord.pageCount) facts.push(`${documentRecord.pageCount} page${documentRecord.pageCount === 1 ? '' : 's'}`);
    if (highlightCount) facts.push(`${highlightCount} highlight${highlightCount === 1 ? '' : 's'}`);
    if (documentRecord.lastOpenedAt) facts.push(`opened ${new Date(documentRecord.lastOpenedAt).toLocaleDateString()}`);
    meta.textContent = facts.join(' · ');
    body.append(name, meta);

    const total = documentRecord.progress?.totalParagraphs;
    if (total) {
      const read = Math.min(total, (documentRecord.progress.paragraphIndex || 0) + 1);
      const percent = Math.round((read / total) * 100);
      const row = document.createElement('div');
      row.className = 'doc-progress';
      const bar = document.createElement('div');
      bar.className = 'progress';
      bar.innerHTML = `<span style="width:${percent}%"></span>`;
      const label = document.createElement('span');
      label.textContent = percent >= 100 ? 'Finished' : `${percent}%`;
      row.append(bar, label);
      body.append(row);
    }
    if (status !== 'ready') {
      const badge = document.createElement('p');
      badge.className = `doc-meta doc-badge ${status === 'converting' ? 'working' : 'failed'}`;
      badge.style.marginTop = '9px';
      badge.textContent = status === 'converting'
        ? 'Extracting text…'
        : documentRecord.statusMessage || 'Text extraction did not finish.';
      body.append(badge);
    } else if (!documentRecord.offline) {
      const pending = document.createElement('p');
      pending.className = 'doc-meta doc-badge pending';
      pending.style.marginTop = '9px';
      pending.textContent = 'Available after reselecting';
      body.append(pending);
    }
    if (tags.length) {
      const tagRow = document.createElement('div');
      tagRow.className = 'doc-tags';
      tags.forEach(tag => {
        const chip = document.createElement('span');
        chip.className = 'tag';
        chip.textContent = tag;
        tagRow.append(chip);
      });
      body.append(tagRow);
    }

    const actions = document.createElement('div');
    actions.className = 'doc-actions';
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'btn btn-ghost btn-sm';
    if (status === 'failed') {
      openButton.textContent = 'Try again';
      openButton.addEventListener('click', () => onRetryConversion(documentRecord));
    } else {
      openButton.textContent = documentRecord.offline ? 'Open' : 'Select original';
      openButton.disabled = status === 'converting';
      openButton.addEventListener('click', open);
    }
    const collect = document.createElement('button');
    collect.type = 'button';
    collect.className = 'icon-btn';
    collect.title = 'Add to a collection';
    collect.setAttribute('aria-label', `Add ${documentRecord.fileName} to a collection`);
    collect.innerHTML = '<svg><use href="#i-folder"/></svg>';
    collect.addEventListener('click', () => addDocumentToCollection(documentRecord));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn';
    remove.title = 'Delete from this browser';
    remove.setAttribute('aria-label', `Delete ${documentRecord.fileName}`);
    remove.innerHTML = '<svg><use href="#i-trash"/></svg>';
    remove.addEventListener('click', () => confirmRemoveDocument(documentRecord));
    actions.append(openButton, collect, remove);

    card.append(cover, body, actions);
    return card;
  }

  function confirmRemoveDocument(documentRecord) {
    openDialog({
      title: 'Delete document',
      description: `Remove ${documentRecord.fileName}, its saved text, position, highlights, and notes from this browser?`,
      withNote: false,
      confirmLabel: 'Delete',
      onSave: () => removeDocument(documentRecord.key),
    });
  }

  return {
    render: renderLibrary,
    clearAll: clearAllLibraryData,
    newCollection: createCollection,
  };
}
