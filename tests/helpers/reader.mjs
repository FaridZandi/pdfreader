// Shared setup for the browser tests: a static server that mirrors the real
// asset routes, a small real PDF, and stubs for the endpoints that would
// otherwise need Kokoro and Docling.
import { expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

export const ROOT = new URL('../../', import.meta.url).pathname;

export const PDF = Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 1200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
5 0 obj << /Length 58 >> stream
BT /F1 18 Tf 72 1080 Td (Local reader smoke test.) Tj ET
endstream endobj
xref
0 6
0000000000 65535 f\x20
0000000009 00000 n\x20
0000000058 00000 n\x20
0000000115 00000 n\x20
0000000250 00000 n\x20
0000000320 00000 n\x20
trailer << /Size 6 /Root 1 0 R >>
startxref
428
%%EOF`);

export function paragraph(id, text, top, bottom) {
  return {
    id, text, label: 'text', page: 1,
    boxes: [{page: 1, bbox: {l: 72, t: top, r: 300, b: bottom}, page_size: {width: 612, height: 1200}}],
  };
}

export const PARAGRAPHS = [
  paragraph('p1', 'Local reader smoke test.', 1080, 1050),
  paragraph('p2', 'A second paragraph to resume from.', 1000, 970),
];

export function extractionFor(paragraphs = PARAGRAPHS) {
  return {
    text: paragraphs.map(item => item.text).join('\n\n'),
    paragraphs,
    all_paragraphs: paragraphs.map(item => ({...item, filter_reasons: []})),
    filter_summary: {preset: 'prose', visible: paragraphs.length, hidden: 0, reasons: {}},
  };
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// Mirrors the asset routes the real server exposes.
function localPathFor(requestPath) {
  if (requestPath.startsWith('/static/')) return `/webui_static/${requestPath.slice('/static/'.length)}`;
  if (requestPath.startsWith('/app/')) return `/webui/${requestPath.slice('/app/'.length)}`;
  return requestPath;
}

export async function startStaticServer() {
  const server = createServer(async (request, response) => {
    const requestPath = request.url === '/' ? '/local_webui.html' : request.url.split('?')[0];
    const target = normalize(join(ROOT, localPathFor(requestPath)));
    if (!target.startsWith(ROOT)) { response.writeHead(404).end(); return; }
    try {
      const body = await readFile(target);
      const type = CONTENT_TYPES[extname(target)] || 'application/octet-stream';
      response.writeHead(200, {'content-type': type}).end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

/** Playable silence, so tests that assert on transport state are not at the
 *  mercy of the browser rejecting an undecodable stub. The header is the
 *  canonical 44 bytes Kokoro's encoder writes, which the export path needs
 *  in order to join cached chunks rather than refuse them. */
export function silentWav(seconds = 4, rate = 8000) {
  const samples = Math.floor(seconds * rate);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

export async function loadHome(page, port, {audio = silentWav(0.05), voices, paragraphs} = {}) {
  await page.route('**/api/extract-pdf', route => route.fulfill({json: extractionFor(paragraphs)}));
  await page.route('**/api/synthesize', route => route.fulfill({contentType: 'audio/wav', body: audio}));
  if (voices) await page.route('**/api/voices', route => route.fulfill({json: voices}));
  await page.goto(`http://127.0.0.1:${port}/`);
}

export async function selectPdf(page) {
  await page.locator('#pdf').setInputFiles({name: 'smoke.pdf', mimeType: 'application/pdf', buffer: PDF});
  await expect(page.locator('#document-setup')).toBeVisible();
}

/** Importing stores the document and converts it in the background, then
 *  opens the reader on it, so waiting for the reader waits for the import. */
export async function openReaderPage(page, port, options) {
  await loadHome(page, port, options);
  await selectPdf(page);
  await page.getByRole('button', {name: 'Add to library'}).click();
  await expect(page.locator('#reader')).toBeVisible();
  await expect(page.locator('#reader-progress')).toContainText(/Paragraph \d+ of \d+/);
}

export const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** A second document, distinct only in its bytes, so it hashes to its own
 *  key and the gallery treats it as a separate import. */
export const OTHER_PDF = Buffer.concat([PDF, Buffer.from('\n% a second document\n')]);
