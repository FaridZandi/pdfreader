import {snapshotRecords, ALL_STORES, replaceEverything} from './db.mjs';

const FORMAT = 'pdfreader-local-library';
const VERSION = 1;
const BACKUP_STORES = ALL_STORES.filter(name => name !== 'audio' && name !== 'audioMeta');

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  return btoa(binary);
}

async function encode(value) {
  if (value instanceof Blob) {
    const bytes = new Uint8Array(await value.arrayBuffer());
    const isFile = typeof File === 'function' && value instanceof File;
    return {__appmanagerType: isFile ? 'file' : 'blob', type: value.type,
      name: isFile ? value.name : undefined, lastModified: isFile ? value.lastModified : undefined,
      data: bytesToBase64(bytes)};
  }
  if (value instanceof ArrayBuffer) return {__appmanagerType: 'arraybuffer', data: bytesToBase64(new Uint8Array(value))};
  if (ArrayBuffer.isView(value)) return {__appmanagerType: 'typedarray', name: value.constructor.name, data: Array.from(value)};
  if (Array.isArray(value)) return Promise.all(value.map(encode));
  if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await encode(entry)])));
  return value;
}

function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (!value || typeof value !== 'object') return value;
  if (value.__appmanagerType === 'blob' || value.__appmanagerType === 'file') {
    const binary = atob(value.data); const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return value.__appmanagerType === 'file' && typeof File === 'function'
      ? new File([bytes], value.name || 'document.pdf', {type: value.type, lastModified: value.lastModified})
      : new Blob([bytes], {type: value.type});
  }
  if (value.__appmanagerType === 'arraybuffer') {
    const binary = atob(value.data); const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  }
  if (value.__appmanagerType === 'typedarray') {
    const constructors = {Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array};
    const Constructor = constructors[value.name];
    if (!Constructor) throw new Error(`Unsupported typed data: ${value.name}`);
    return new Constructor(value.data);
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decode(entry)]));
}

export async function createLibraryBackup() {
  const stores = await snapshotRecords(BACKUP_STORES);
  stores.audio = []; stores.audioMeta = [];
  const resume = Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('pdfreader.resume.')).map(key => [key, localStorage.getItem(key)]));
  return {format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), stores: await encode(stores), resume};
}

export function downloadBackup(backup) {
  const blob = new Blob([JSON.stringify(backup)], {type: 'application/json'});
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = `pdf-reader-library-${new Date().toISOString().slice(0, 10)}.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function importLibraryBackup(backup) {
  if (backup?.format !== FORMAT || backup.version !== VERSION || !backup.stores || typeof backup.stores !== 'object' || Array.isArray(backup.stores)) throw new Error('This is not a PDF Reader library export.');
  const stores = decode(backup.stores);
  if (ALL_STORES.some(name => !Array.isArray(stores[name]))) throw new Error('This export is missing library records.');
  const resume = backup.resume || {};
  if (typeof resume !== 'object' || Array.isArray(resume) || Object.entries(resume).some(([key, value]) =>
    !key.startsWith('pdfreader.resume.') || typeof value !== 'string')) throw new Error('Invalid saved reading positions.');
  Object.values(resume).forEach(value => JSON.parse(value));
  const previous = Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('pdfreader.resume.')).map(key => [key, localStorage.getItem(key)]));
  const replaceResume = records => {
    Object.keys(localStorage).filter(key => key.startsWith('pdfreader.resume.')).forEach(key => localStorage.removeItem(key));
    Object.entries(records).forEach(([key, value]) => localStorage.setItem(key, value));
  };
  try {
    // Check localStorage can accept the positions before replacing the database.
    replaceResume(resume);
    await replaceEverything(stores);
  } catch (error) {
    replaceResume(previous);
    throw error;
  }
}
