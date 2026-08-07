import { test, expect } from '@playwright/test';

import {
  loadHome,
  openReaderPage,
  paragraph,
  PDF,
  selectPdf,
  silentWav,
  startStaticServer,
} from './helpers/reader.mjs';

// Enough paragraphs that the Text list has to scroll, which is the only time
// the reading position can be off screen.
const MANY = Array.from({length: 40}, (_, index) => paragraph(
  `m${index + 1}`,
  `Paragraph number ${index + 1} in a long reading queue.`,
  1180 - (index * 25),
  1160 - (index * 25),
));

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
    await page.getByRole('button', {name: 'Add to library'}).click();
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

  test('loading a URL imports the fetched PDF like a chosen file', async ({ page }) => {
    await loadHome(page, port);
    await page.route('**/api/fetch-url', async (route, request) => {
      expect(JSON.parse(request.postData())).toEqual({url: 'https://example.com/article'});
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'x-document-name': encodeURIComponent('A Printed Page.pdf'),
        },
        body: PDF,
      });
    });
    await page.getByRole('button', {name: 'From URL'}).click();
    await page.locator('#entry-name').fill('https://example.com/article');
    await page.getByRole('button', {name: 'Load'}).click();
    // From here it is the ordinary import panel, named after the fetched file.
    await expect(page.locator('#document-setup')).toBeVisible();
    await expect(page.locator('#file-name')).toHaveText('A Printed Page.pdf');
    await page.getByRole('button', {name: 'Add to library'}).click();
    await expect(page.locator('#reader')).toBeVisible();
    await expect(page.locator('#reader-title')).toHaveText('A Printed Page.pdf');
    await page.getByRole('button', {name: 'Library', exact: true}).click();
    await expect(page.locator('.doc-name')).toHaveText('A Printed Page.pdf');
  });

  test('a URL that cannot be loaded reports why', async ({ page }) => {
    await loadHome(page, port);
    await page.route('**/api/fetch-url', route => route.fulfill({
      status: 400,
      json: {error: 'Enter an http:// or https:// address.'},
    }));
    await page.getByRole('button', {name: 'From URL'}).click();
    await page.locator('#entry-name').fill('file:///etc/passwd');
    await page.getByRole('button', {name: 'Load'}).click();
    await expect(page.locator('#pdf-status')).toContainText('Enter an http:// or https:// address.');
    await expect(page.getByRole('button', {name: 'Add to library'})).toBeDisabled();
  });

  test('a server without the endpoint says to restart it', async ({ page }) => {
    await loadHome(page, port);
    // What http.server itself returns for an unknown path: HTML, not JSON.
    await page.route('**/api/fetch-url', route => route.fulfill({
      status: 404,
      contentType: 'text/html;charset=utf-8',
      body: '<!DOCTYPE HTML><html><body>Error 404: Not Found</body></html>',
    }));
    await page.getByRole('button', {name: 'From URL'}).click();
    await page.locator('#entry-name').fill('https://example.com/article');
    await page.getByRole('button', {name: 'Load'}).click();
    await expect(page.locator('#pdf-status')).toContainText('restart it with ./scripts/run.sh');
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

  test('the text list says which way the paragraph being read went', async ({ page }) => {
    await openReaderPage(page, port, {paragraphs: MANY});
    await page.getByRole('button', {name: 'Text'}).click();
    const up = page.getByRole('button', {name: 'Reading above'});
    const down = page.getByRole('button', {name: 'Reading below'});
    // The list opens at the top, where the first paragraph already is.
    await expect(up).toBeHidden();
    await expect(down).toBeHidden();

    await page.locator('#reader-drawer').evaluate(drawer => { drawer.scrollTop = drawer.scrollHeight; });
    await expect(up).toBeVisible();
    await expect(down).toBeHidden();
    // The indicator is also the way back to it, and only scrolls the list.
    await up.click();
    await expect(up).toBeHidden();
    await expect(page.locator('#reader-progress')).toContainText('Paragraph 1 of 40');

    await page.locator('#reader-drawer .drawer-item').nth(30).click();
    await expect(page.locator('#reader-progress')).toContainText('Paragraph 31 of 40');
    await page.locator('#reader-drawer').evaluate(drawer => { drawer.scrollTop = 0; });
    await expect(down).toBeVisible();
    await expect(up).toBeHidden();

    // Only the Text view has a reading position to point at.
    await page.getByRole('button', {name: 'Outline'}).click();
    await expect(down).toBeHidden();

    // And listen-only hides the list altogether, so it must not leave an
    // arrow floating over an empty panel.
    await page.getByRole('button', {name: 'Text'}).click();
    await page.locator('#reader-drawer').evaluate(drawer => { drawer.scrollTop = 0; });
    await expect(down).toBeVisible();
    await page.getByRole('button', {name: 'Listen only'}).click();
    await expect(down).toBeHidden();
  });
});
