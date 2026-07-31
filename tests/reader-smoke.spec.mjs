import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const PDF = Buffer.from(`%PDF-1.4
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

async function startStaticServer() {
  const server = createServer(async (request, response) => {
    const requestPath = request.url === '/' ? '/local_webui.html' : request.url.split('?')[0];
    const localPath = requestPath.startsWith('/static/')
      ? `/webui_static/${requestPath.slice('/static/'.length)}` : requestPath;
    const target = normalize(join(ROOT, localPath));
    if (!target.startsWith(ROOT)) { response.writeHead(404).end(); return; }
    try {
      const body = await readFile(target);
      const type = extname(target) === '.html' ? 'text/html; charset=utf-8'
        : extname(target) === '.mjs' ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
      response.writeHead(200, {'content-type': type}).end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('extracts, starts the reader, jumps, persists resume, and preserves zoom controls', async ({ page }) => {
  const server = await startStaticServer();
  const port = server.address().port;
  await page.route('**/api/extract-pdf', route => route.fulfill({json: {
    text: 'Local reader smoke test.',
    paragraphs: [{id: 'p1', text: 'Local reader smoke test.', label: 'text', page: 1, boxes: [{page: 1, bbox: {l: 72, t: 1080, r: 300, b: 1050}, page_size: {width: 612, height: 1200}}]}],
    all_paragraphs: [{id: 'p1', text: 'Local reader smoke test.', label: 'text', page: 1, boxes: [{page: 1, bbox: {l: 72, t: 1080, r: 300, b: 1050}, page_size: {width: 612, height: 1200}}], filter_reasons: []}],
    filter_summary: {preset: 'prose', visible: 1, hidden: 0, reasons: {}},
  }}));
  await page.route('**/api/synthesize', route => route.fulfill({contentType: 'audio/wav', body: Buffer.alloc(44)}));
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator('#pdf').setInputFiles({name: 'smoke.pdf', mimeType: 'application/pdf', buffer: PDF});
    await page.getByRole('button', {name: 'Add and open'}).click();
    await expect(page.locator('#pdf-status')).toContainText('1 reading paragraphs ready');
    await expect(page.locator('#reader')).toBeVisible();
    await expect(page.getByRole('button', {name: 'Play'})).toBeVisible();
    await expect(page.locator('.pdf-paragraph[data-source-id="p1"]')).toBeVisible();
    await page.locator('.pdf-paragraph[data-source-id="p1"]').click();
    await page.locator('#pdf-viewer').evaluate(viewer => { viewer.scrollTop = 220; });
    const scrollBeforeZoom = await page.locator('#pdf-viewer').evaluate(viewer => viewer.scrollTop);
    await page.getByRole('button', {name: '+'}).last().click();
    await expect(page.locator('#pdf-zoom-value')).toHaveText('140%');
    await expect.poll(() => page.locator('#pdf-viewer').evaluate(viewer => viewer.scrollTop)).toBeGreaterThan(scrollBeforeZoom);
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('pdfreader.resume.')))).toBe(true);
    await page.getByRole('button', {name: 'Exit reader'}).click();
    await expect(page.locator('.library-thumbnail')).toBeVisible();
    await expect(page.getByRole('button', {name: 'Open'})).toBeVisible();
    await page.getByRole('button', {name: 'Open'}).click();
    await expect(page.locator('#reader')).toBeVisible();
    await expect(page.locator('#document-setup')).toBeHidden();
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
