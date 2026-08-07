// Every local record the reader keeps, and the only place the schema lives.
// No DOM and no application state: callers pass the keys they care about.

const DATABASE = 'pdfreader';
const VERSION = 6;

/** Stores holding one row per document, keyed by the document key. */
const DOCUMENT_KEYED = ['documents', 'offlineFiles', 'extractions'];
/** Stores holding many rows per document, found through a `documentKey` index. */
const DOCUMENT_INDEXED = ['annotations', 'documentCollections', 'audio', 'audioMeta'];
export const ALL_STORES = [...DOCUMENT_KEYED, ...DOCUMENT_INDEXED, 'collections'];

// One connection for the page. Every helper used to open and close its own,
// and rendering the gallery opened four at once.
let connection;

export function openDatabase() {
  connection ||= connect().catch(error => { connection = undefined; throw error; });
  return connection;
}

function connect() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB is unavailable in this browser.')); return; }
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      // Version 5 folded the separate bookmark store into `annotations`, which
      // already holds a highlight and its optional note together. Version 6
      // dropped `reviews`, which nothing had written to since the review queue
      // was removed, and added the generated-speech cache.
      ['bookmarks', 'reviews'].forEach(name => {
        if (database.objectStoreNames.contains(name)) database.deleteObjectStore(name);
      });
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
      // Speech blobs are kept apart from their sizes and use times so that
      // deciding what to evict never has to deserialise a single blob.
      ensure('audio', 'id', ['documentKey']);
      ensure('audioMeta', 'id', ['documentKey', 'usedAt']);
    };
    request.onsuccess = () => {
      const database = request.result;
      // Another tab upgrading the schema needs this connection out of its way;
      // the next call opens a fresh one at the new version.
      database.onversionchange = () => { database.close(); connection = undefined; };
      database.onclose = () => { connection = undefined; };
      resolve(database);
    };
    request.onerror = () => reject(request.error || new Error('Could not open local reader storage.'));
  });
}

/** Runs one transaction on the shared connection. */
async function withStores(names, mode, work) {
  const database = await openDatabase();
  const transaction = database.transaction(names, mode);
  const result = work(transaction);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  return result;
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

/** How much generated speech is kept before the least recently used goes. */
export const AUDIO_CACHE_BYTES = 250 * 1024 * 1024;

/** Cached speech for one chunk, if it is here, marked as used just now. */
export function readCachedAudio(id) {
  return withStores(['audio', 'audioMeta'], 'readwrite', async transaction => {
    const record = await fromRequest(transaction.objectStore('audio').get(id));
    if (!record) return undefined;
    const meta = transaction.objectStore('audioMeta');
    const existing = await fromRequest(meta.get(id));
    meta.put({...existing, id, documentKey: record.documentKey, bytes: record.blob.size, usedAt: Date.now()});
    return record.blob;
  });
}

export async function writeCachedAudio({id, documentKey, blob}) {
  await withStores(['audio', 'audioMeta'], 'readwrite', transaction => {
    transaction.objectStore('audio').put({id, documentKey, blob});
    transaction.objectStore('audioMeta').put({id, documentKey, bytes: blob.size, usedAt: Date.now()});
  });
  await evictCachedAudio();
}

/** Drops the least recently used speech until the cache is under its cap.
 *  Only the sizes are read to decide: the blobs themselves are in a separate
 *  store precisely so that this never has to load them all. */
export async function evictCachedAudio(limit = AUDIO_CACHE_BYTES) {
  const meta = await allRecords('audioMeta');
  let total = meta.reduce((sum, item) => sum + (item.bytes || 0), 0);
  if (total <= limit) return;
  const doomed = [];
  for (const item of meta.sort((a, b) => (a.usedAt || 0) - (b.usedAt || 0))) {
    if (total <= limit) break;
    doomed.push(item.id);
    total -= item.bytes || 0;
  }
  await withStores(['audio', 'audioMeta'], 'readwrite', transaction => {
    doomed.forEach(id => {
      transaction.objectStore('audio').delete(id);
      transaction.objectStore('audioMeta').delete(id);
    });
  });
}

export function clearEverything() {
  return withStores(ALL_STORES, 'readwrite', transaction => {
    ALL_STORES.forEach(name => transaction.objectStore(name).clear());
  });
}
