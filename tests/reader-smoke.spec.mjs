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

function paragraph(id, text, top, bottom) {
  return {
    id, text, label: 'text', page: 1,
    boxes: [{page: 1, bbox: {l: 72, t: top, r: 300, b: bottom}, page_size: {width: 612, height: 1200}}],
  };
}

const PARAGRAPHS = [
  paragraph('p1', 'Local reader smoke test.', 1080, 1050),
  paragraph('p2', 'A second paragraph to resume from.', 1000, 970),
];

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

// Playable silence, so tests that assert on transport state are not at the
// mercy of the browser rejecting an undecodable stub.
function silentWav(seconds = 4, rate = 8000) {
  const samples = Math.floor(seconds * rate);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

async function loadHome(page, port, {audio = Buffer.alloc(44)} = {}) {
  await page.route('**/api/extract-pdf', route => route.fulfill({json: {
    text: PARAGRAPHS.map(item => item.text).join('\n\n'),
    paragraphs: PARAGRAPHS,
    all_paragraphs: PARAGRAPHS.map(item => ({...item, filter_reasons: []})),
    filter_summary: {preset: 'prose', visible: PARAGRAPHS.length, hidden: 0, reasons: {}},
  }}));
  await page.route('**/api/synthesize', route => route.fulfill({contentType: 'audio/wav', body: audio}));
  await page.goto(`http://127.0.0.1:${port}/`);
}

async function selectPdf(page) {
  await page.locator('#pdf').setInputFiles({name: 'smoke.pdf', mimeType: 'application/pdf', buffer: PDF});
  await expect(page.locator('#document-setup')).toBeVisible();
}

async function openReaderPage(page, port, options) {
  await loadHome(page, port, options);
  await selectPdf(page);
  await page.getByRole('button', {name: 'Add and open'}).click();
  await expect(page.locator('#pdf-status')).toContainText('2 reading paragraphs ready');
  await expect(page.locator('#reader')).toBeVisible();
}

test.describe('local reader', () => {
  let server;
  let port;

  test.beforeAll(async () => {
    server = await startStaticServer();
    port = server.address().port;
  });

  test.afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  test('extracts, starts the reader, jumps, persists resume, and preserves zoom controls', async ({ page }) => {
    await openReaderPage(page, port);
    await expect(page.getByRole('button', {name: 'Play'})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Text'})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Highlights'})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Review'})).toHaveCount(0);
    await page.getByRole('button', {name: 'Outline'}).click();
    await expect(page.locator('#reader-drawer')).toContainText('No section headings were detected');
    await page.getByRole('button', {name: 'Text'}).click();
    await expect(page.locator('#reader-drawer')).toContainText('Local reader smoke test.');
    await page.getByRole('searchbox', {name: 'Search this reading queue'}).fill('no match');
    await expect(page.locator('#reader-drawer')).toContainText('No paragraphs match this search.');
    await page.getByRole('searchbox', {name: 'Search this reading queue'}).fill('');
    await expect(page.locator('.pdf-paragraph[data-source-id="p1"]')).toBeVisible();
    await page.locator('.pdf-paragraph[data-source-id="p1"]').click();
    await page.locator('#pdf-viewer').evaluate(viewer => { viewer.scrollTop = 220; });
    const scrollBeforeZoom = await page.locator('#pdf-viewer').evaluate(viewer => viewer.scrollTop);
    await page.getByRole('button', {name: 'Zoom in'}).click();
    await expect(page.locator('#pdf-zoom-value')).toHaveText('140%');
    await expect.poll(() => page.locator('#pdf-viewer').evaluate(viewer => viewer.scrollTop)).toBeGreaterThan(scrollBeforeZoom);
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('pdfreader.resume.')))).toBe(true);
    await page.getByRole('button', {name: 'Library', exact: true}).click();
    await expect(page.locator('.library-thumbnail')).toBeVisible();
    await expect(page.getByRole('button', {name: 'Open', exact: true})).toBeVisible();
    await page.getByRole('button', {name: 'Open', exact: true}).click();
    await expect(page.locator('#reader')).toBeVisible();
    await expect(page.locator('#document-setup')).toBeHidden();
  });

  test('reopening a stored document resumes its saved paragraph', async ({ page }) => {
    await openReaderPage(page, port);
    await page.locator('.pdf-paragraph[data-source-id="p2"]').click();
    await expect(page.locator('#reader-progress')).toContainText('Paragraph 2 of 2');
    await page.getByRole('button', {name: 'Library', exact: true}).click();
    await page.getByRole('button', {name: 'Open', exact: true}).click();
    await expect(page.locator('#reader')).toBeVisible();
    await expect(page.locator('#reader-progress')).toContainText('Paragraph 2 of 2');
  });

  test('exposes speech, export, and listen-only controls', async ({ page }) => {
    await loadHome(page, port);
    await selectPdf(page);
    await page.locator('.disclosure summary').click();
    await expect(page.locator('#skip-bracketed-text')).toBeVisible();
    await page.locator('#skip-bracketed-text').check();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('pdfreader.skip-bracketed-text'))).toBe('true');
    await page.getByRole('button', {name: 'Add and open'}).click();
    await expect(page.locator('#reader')).toBeVisible();
    await page.locator('#export-menu summary').click();
    await expect(page.getByRole('button', {name: 'Whole document'})).toBeEnabled();
    await page.locator('#export-menu summary').click();
    await page.getByRole('button', {name: 'Listen only'}).click();
    await expect(page.locator('#pdf-viewer')).toBeHidden();
    await page.getByRole('button', {name: 'Show reader'}).click();
    await expect(page.locator('#pdf-viewer')).toBeVisible();
  });

  test('clears every locally stored document', async ({ page }) => {
    await openReaderPage(page, port);
    await page.getByRole('button', {name: 'Library', exact: true}).click();
    await expect(page.locator('.doc')).toHaveCount(1);
    await page.getByRole('button', {name: 'Clear library'}).click();
    await page.getByRole('button', {name: 'Clear everything'}).click();
    await expect(page.locator('.doc')).toHaveCount(0);
    await expect(page.locator('#library-list')).toContainText('Add a PDF to start your local library');
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('pdfreader.resume.')))).toBe(false);
  });

  test('clicking a paragraph starts playing it', async ({ page }) => {
    await openReaderPage(page, port, {audio: silentWav()});
    await expect(page.locator('#reader-toggle')).toHaveAttribute('aria-label', 'Play');
    await page.locator('.pdf-paragraph[data-source-id="p2"]').click();
    await expect(page.locator('#reader-toggle')).toHaveAttribute('aria-label', 'Pause');
    await expect.poll(() => page.locator('#reader-player').evaluate(player => player.paused)).toBe(false);
    // The paragraph's own transport mirrors that state and pauses again.
    const tool = page.locator('.pdf-paragraph[data-source-id="p2"] [data-tool="play"]');
    await expect(tool).toHaveAttribute('aria-label', 'Pause');
    await page.locator('.pdf-paragraph[data-source-id="p2"]').hover();
    await tool.click();
    await expect(page.locator('#reader-toggle')).toHaveAttribute('aria-label', 'Play');
    await expect.poll(() => page.locator('#reader-player').evaluate(player => player.paused)).toBe(true);
  });

  test('the highlight control reflects and toggles the saved state', async ({ page }) => {
    await openReaderPage(page, port);
    const paragraph = page.locator('.pdf-paragraph[data-source-id="p1"]');
    const mark = paragraph.locator('[data-tool="mark"]');
    await expect(mark).not.toHaveClass(/is-on/);
    await paragraph.hover();
    await mark.click();
    await expect(mark).toHaveClass(/is-on/);
    await expect(page.locator('#reader-highlight-toggle')).toContainText('Highlighted');
    await expect(page.locator('#reader-highlight-toggle')).toHaveClass(/is-on/);
    await paragraph.hover();
    await mark.click();
    await expect(mark).not.toHaveClass(/is-on/);
    await expect(page.locator('#reader-highlight-toggle')).toContainText('Highlight');
    await expect(page.locator('#reader-status')).toContainText('Highlight removed');
  });

  test('a saved note shows its source quote, and opening it does not start playback', async ({ page }) => {
    await openReaderPage(page, port, {audio: silentWav()});
    // Start reading paragraph 1, then annotate paragraph 2: neither adding the
    // note nor saving it may disturb what is being read.
    await page.locator('.pdf-paragraph[data-source-id="p1"]').click();
    await expect.poll(() => page.locator('#reader-player').evaluate(player => player.paused)).toBe(false);
    const paragraph = page.locator('.pdf-paragraph[data-source-id="p2"]');
    await paragraph.hover();
    await paragraph.locator('[data-tool="note"]').click();
    await page.locator('#entry-note').fill('Check this against section 4.');
    await page.getByRole('button', {name: 'Save'}).click();
    await expect(page.locator('#reader-progress')).toContainText('Paragraph 1 of 2');
    await expect.poll(() => page.locator('#reader-player').evaluate(player => player.paused)).toBe(false);

    // The note is readable on the page itself, without opening a panel, and
    // stays visible while the pointer moves onto it so it can be clicked.
    const card = paragraph.locator('.paragraph-note');
    await expect(card.locator('.paragraph-note-text')).toHaveText('Check this against section 4.');
    await paragraph.hover();
    const cardBox = await card.boundingBox();
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + 15);
    await expect(card).toHaveCSS('opacity', '1');
    await card.click();
    await expect(page.locator('#entry-title')).toHaveText('Edit note');
    await expect(page.locator('#entry-note')).toHaveValue('Check this against section 4.');
    await page.getByRole('button', {name: 'Cancel'}).click();
    // Editing the note left the reader alone too.
    await expect(page.locator('#reader-progress')).toContainText('Paragraph 1 of 2');
    await expect.poll(() => page.locator('#reader-player').evaluate(player => player.paused)).toBe(false);

    await page.getByRole('button', {name: 'Highlights'}).click();
    const entry = page.locator('#reader-drawer .passage');
    await expect(entry).toHaveCount(1);
    await expect(entry.locator('.passage-quote')).toContainText('A second paragraph to resume from.');
    await expect(entry.locator('.passage-note')).toHaveText('Check this against section 4.');
    await expect(entry.locator('.drawer-meta')).toContainText('Paragraph 2');

    // Opening the passage saved on paragraph 2 while paragraph 1 is being read:
    // playback carries on and the position stays put. Only the page scrolls.
    await entry.click();
    await expect(page.locator('#reader-progress')).toContainText('Paragraph 1 of 2');
    await expect(page.locator('#reader-toggle')).toHaveAttribute('aria-label', 'Pause');
    await expect.poll(() => page.locator('#reader-player').evaluate(player => player.paused)).toBe(false);

    // And opening one while paused does not start reading.
    await page.locator('#reader-toggle').click();
    await expect.poll(() => page.locator('#reader-player').evaluate(player => player.paused)).toBe(true);
    await entry.click();
    await expect(page.locator('#reader-progress')).toContainText('Paragraph 1 of 2');
    await expect(page.locator('#reader-toggle')).toHaveAttribute('aria-label', 'Play');
    expect(await page.locator('#reader-player').evaluate(player => player.paused)).toBe(true);
  });

  test('moving the reading position scrolls the PDF to it', async ({ page }) => {
    await openReaderPage(page, port);
    // The page has to be rendered before it can be scrolled anywhere.
    await expect(page.locator('.pdf-paragraph[data-source-id="p2"]')).toBeVisible();
    // Park the view away from paragraph 2, then navigate to it by keyboard.
    await page.locator('#pdf-viewer').evaluate(viewer => { viewer.scrollTop = viewer.scrollHeight; });
    await expect.poll(() => page.locator('#pdf-viewer').evaluate(viewer => viewer.scrollTop)).toBeGreaterThan(0);
    const parked = await page.locator('#pdf-viewer').evaluate(viewer => viewer.scrollTop);
    // Take focus off any control without clicking the page, which could land
    // on a paragraph overlay and move the position by itself.
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('j');
    await expect(page.locator('#reader-progress')).toContainText('Paragraph 2 of 2');
    await expect.poll(() => page.locator('#pdf-viewer').evaluate(viewer => viewer.scrollTop)).toBeLessThan(parked);
  });

  test('a dialog owns the keyboard while it is open', async ({ page }) => {
    await openReaderPage(page, port);
    const paragraph = page.locator('.pdf-paragraph[data-source-id="p1"]');
    await paragraph.hover();
    await paragraph.locator('[data-tool="note"]').click();
    await expect(page.locator('#entry-dialog')).toBeVisible();
    // Escape closes the note, not the reader.
    await page.keyboard.press('Escape');
    await expect(page.locator('#entry-dialog')).toBeHidden();
    await expect(page.locator('#reader')).toBeVisible();
  });

  test('searching marks matches without hiding any PDF paragraph', async ({ page }) => {
    await openReaderPage(page, port);
    await page.getByRole('button', {name: 'Text'}).click();
    await page.getByRole('searchbox', {name: 'Search this reading queue'}).fill('resume');
    await expect(page.locator('#reader-drawer .drawer-item')).toHaveCount(1);
    await expect(page.locator('.pdf-paragraph[data-source-id="p2"]')).toHaveClass(/search-match/);
    // The paragraph that does not match stays fully visible and clickable.
    const other = page.locator('.pdf-paragraph[data-source-id="p1"]');
    await expect(other).toBeVisible();
    await expect(other).not.toHaveClass(/search-match/);
    expect(await other.evaluate(node => getComputedStyle(node).pointerEvents)).not.toBe('none');
    expect(await other.evaluate(node => getComputedStyle(node).opacity)).toBe('1');
    await other.click();
    await expect(page.locator('#reader-progress')).toContainText('Paragraph 1 of 2');
  });
});
