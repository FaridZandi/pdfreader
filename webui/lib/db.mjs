// Every local record the reader keeps, and the only place the schema lives.
// No DOM and no application state: callers pass the keys they care about.

const DATABASE = 'pdfreader';
const VERSION = 5;

/** Stores holding one row per document, keyed by the document key. */
const DOCUMENT_KEYED = ['documents', 'offlineFiles', 'extractions'];
/** Stores holding many rows per document, found through a `documentKey` index. */
const DOCUMENT_INDEXED = ['annotations', 'reviews', 'documentCollections'];
export const ALL_STORES = [...DOCUMENT_KEYED, ...DOCUMENT_INDEXED, 'collections'];

export function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB is unavailable in this browser.')); return; }
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      // Version 5 folded the separate bookmark store into `annotations`, which
      // already holds a highlight and its optional note together.
      if (database.objectStoreNames.contains('bookmarks')) database.deleteObjectStore('bookmarks');
      const ensure = (name, keyPath, indexes = []) => {
        if (database.objectStoreNames.contains(name)) return;
        const store = database.createObjectStore(name, {keyPath});
        indexes.forEach(index => store.createIndex(index, index, {unique: false}));
      };
      ensure('documents', 'key');
      ensure('offlineFiles', 'key');
      ensure('extractions', 'key');
      ensure('collections', 'id');
      ensure('documentCollections', 'id', ['documentKey', 'collectionId']);
      ensure('annotations', 'id', ['documentKey']);
      ensure('reviews', 'id', ['documentKey']);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local reader storage.'));
  });
}

/** Runs one transaction and closes the connection, whatever the outcome. */
async function withStores(names, mode, work) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(names, mode);
    const result = work(transaction);
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return await result;
  } finally { database.close(); }
}

function fromRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function putRecord(storeName, record) {
  return withStores(storeName, 'readwrite', transaction =>
    fromRequest(transaction.objectStore(storeName).put(record)));
}

export function getRecord(storeName, key) {
  return withStores(storeName, 'readonly', transaction =>
    fromRequest(transaction.objectStore(storeName).get(key)));
}

export function allRecords(storeName) {
  return withStores(storeName, 'readonly', transaction =>
    fromRequest(transaction.objectStore(storeName).getAll()));
}

export function deleteRecord(storeName, key) {
  return withStores(storeName, 'readwrite', transaction =>
    fromRequest(transaction.objectStore(storeName).delete(key)));
}

export function recordsForDocument(storeName, documentKey) {
  if (!documentKey) return Promise.resolve([]);
  return withStores(storeName, 'readonly', transaction =>
    fromRequest(transaction.objectStore(storeName).index('documentKey').getAll(documentKey)));
}

/** Removes one document and everything attached to it, in one transaction. */
export function deleteDocument(key) {
  const stores = [...DOCUMENT_KEYED, ...DOCUMENT_INDEXED];
  return withStores(stores, 'readwrite', transaction => {
    DOCUMENT_KEYED.forEach(name => transaction.objectStore(name).delete(key));
    DOCUMENT_INDEXED.forEach(name => {
      const index = transaction.objectStore(name).index('documentKey');
      index.openCursor(IDBKeyRange.only(key)).onsuccess = event => {
        const cursor = event.target.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
    });
  });
}

/** Removes a collection and its memberships. The documents themselves stay. */
export function deleteCollectionRecords(collectionId) {
  return withStores(['collections', 'documentCollections'], 'readwrite', transaction => {
    transaction.objectStore('collections').delete(collectionId);
    const index = transaction.objectStore('documentCollections').index('collectionId');
    index.openCursor(IDBKeyRange.only(collectionId)).onsuccess = event => {
      const cursor = event.target.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
  });
}

export function clearEverything() {
  return withStores(ALL_STORES, 'readwrite', transaction => {
    ALL_STORES.forEach(name => transaction.objectStore(name).clear());
  });
}
