import {test, expect} from '@playwright/test';
import {startStaticServer} from './helpers/reader.mjs';

let server;
let port;
test.beforeAll(async () => { server = await startStaticServer(); port = server.address().port; });
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
test.beforeEach(async ({page}) => {
  // A fresh browser context and blank same-origin page keep personal libraries untouched.
  await page.route('**/backup-test', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Backup test</title>'}));
  await page.goto(`http://127.0.0.1:${port}/backup-test`);
});

test('round trip restores PDFs, notes, collections and positions but omits generated audio', async ({page}) => {
  const result = await page.evaluate(async () => {
    const db = await import('/app/lib/db.mjs');
    const backup = await import('/app/lib/backup.mjs');
    await db.putRecord('documents', {key: 'doc', fileName: 'test.pdf'});
    await db.putRecord('offlineFiles', {key: 'doc', file: new File(['%PDF-test'], 'test.pdf', {type: 'application/pdf', lastModified: 123})});
    await db.putRecord('extractions', {key: 'doc', paragraphs: [{id: 'p1', text: 'Test'}]});
    await db.putRecord('annotations', {id: 'note', documentKey: 'doc', note: 'Keep this'});
    await db.putRecord('collections', {id: 'collection', name: 'Research'});
    await db.putRecord('documentCollections', {id: 'membership', documentKey: 'doc', collectionId: 'collection'});
    await db.putRecord('audio', {id: 'audio', documentKey: 'doc', blob: new Blob(['cached'])});
    await db.putRecord('audioMeta', {id: 'audio', documentKey: 'doc', bytes: 6});
    localStorage.setItem('pdfreader.resume.doc', '{"sourceId":"p1"}');
    localStorage.setItem('unrelated', 'untouched');
    const exported = JSON.parse(JSON.stringify(await backup.createLibraryBackup()));
    await db.clearEverything();
    localStorage.removeItem('pdfreader.resume.doc');
    await backup.importLibraryBackup(exported);
    const file = (await db.getRecord('offlineFiles', 'doc')).file;
    return {
      documents: await db.allRecords('documents'),
      file: {name: file.name, type: file.type, text: await file.text(), modified: file.lastModified},
      notes: await db.allRecords('annotations'), collections: await db.allRecords('collections'),
      memberships: await db.allRecords('documentCollections'),
      extraction: await db.getRecord('extractions', 'doc'),
      audio: await db.allRecords('audio'), audioMeta: await db.allRecords('audioMeta'),
      resume: localStorage.getItem('pdfreader.resume.doc'), unrelated: localStorage.getItem('unrelated'),
    };
  });
  expect(result.documents).toEqual([{key: 'doc', fileName: 'test.pdf'}]);
  expect(result.file).toEqual({name: 'test.pdf', type: 'application/pdf', text: '%PDF-test', modified: 123});
  expect(result.notes[0].note).toBe('Keep this');
  expect(result.collections[0].name).toBe('Research');
  expect(result.memberships[0].collectionId).toBe('collection');
  expect(result.extraction.paragraphs[0].id).toBe('p1');
  expect(result.audio).toEqual([]); expect(result.audioMeta).toEqual([]);
  expect(result.resume).toBe('{"sourceId":"p1"}'); expect(result.unrelated).toBe('untouched');
});

test('malformed records preserve both the existing library and resume state', async ({page}) => {
  const result = await page.evaluate(async () => {
    const db = await import('/app/lib/db.mjs');
    const backup = await import('/app/lib/backup.mjs');
    await db.putRecord('documents', {key: 'old'});
    localStorage.setItem('pdfreader.resume.old', '{"sourceId":"old-position"}');
    const exported = await backup.createLibraryBackup();
    exported.stores.documents = [{}];
    exported.resume = {'pdfreader.resume.new': '{"sourceId":"new-position"}'};
    let error;
    try { await backup.importLibraryBackup(exported); } catch (caught) { error = caught.message; }
    return {error, documents: await db.allRecords('documents'), old: localStorage.getItem('pdfreader.resume.old'), next: localStorage.getItem('pdfreader.resume.new')};
  });
  expect(result.error).toContain('Invalid backup records');
  expect(result.documents).toEqual([{key: 'old'}]);
  expect(result.old).toBe('{"sourceId":"old-position"}'); expect(result.next).toBeNull();
});

test('synchronous IndexedDB failure aborts queued clears', async ({page}) => {
  const result = await page.evaluate(async () => {
    const db = await import('/app/lib/db.mjs');
    await db.putRecord('documents', {key: 'old'});
    const records = Object.fromEntries(db.ALL_STORES.map(name => [name, []]));
    records.documents = [{key: 'new', uncloneable: () => {}}];
    let error;
    try { await db.replaceEverything(records); } catch (caught) { error = caught.name; }
    return {error, documents: await db.allRecords('documents')};
  });
  expect(result.error).toBe('DataCloneError');
  expect(result.documents).toEqual([{key: 'old'}]);
});

test('localStorage failure leaves the database and old reading positions intact', async ({page}) => {
  const result = await page.evaluate(async () => {
    const db = await import('/app/lib/db.mjs');
    const backup = await import('/app/lib/backup.mjs');
    await db.putRecord('documents', {key: 'old'});
    localStorage.setItem('pdfreader.resume.old', '{"sourceId":"p1"}');
    const exported = await backup.createLibraryBackup();
    exported.stores.documents = [{key: 'new'}];
    exported.resume = {'pdfreader.resume.new': '{"sourceId":"p2"}'};
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key === 'pdfreader.resume.new') throw new DOMException('Quota exceeded', 'QuotaExceededError'); return original.call(this, key, value); };
    let error;
    try { await backup.importLibraryBackup(exported); } catch (caught) { error = caught.name; }
    finally { Storage.prototype.setItem = original; }
    return {error, documents: await db.allRecords('documents'), resume: localStorage.getItem('pdfreader.resume.old')};
  });
  expect(result.error).toBe('QuotaExceededError');
  expect(result.documents).toEqual([{key: 'old'}]); expect(result.resume).toBe('{"sourceId":"p1"}');
});
