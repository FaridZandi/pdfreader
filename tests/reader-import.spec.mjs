import { test, expect } from '@playwright/test';

import {
  extractionFor,
  loadHome,
  OTHER_PDF,
  selectPdf,
  sleep,
  startStaticServer,
} from './helpers/reader.mjs';

test.describe('importing in the background', () => {
  let server;
  let port;

  test.beforeAll(async () => {
    server = await startStaticServer();
    port = server.address().port;
  });

  test.afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  test('the document joins the gallery while its text is still being extracted', async ({ page }) => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await loadHome(page, port);
    await page.route('**/api/extract-pdf', async route => {
      await held;
      await route.fulfill({json: extractionFor()});
    });

    await selectPdf(page);
    await page.getByRole('button', {name: 'Add to library'}).click();
    // The dialog is done as soon as the file is stored: the card carries the
    // rest, so nothing is blocked waiting for Docling.
    await expect(page.locator('#document-setup')).toBeHidden();
    await expect(page.locator('.doc-badge.working')).toContainText('Extracting text');
    await expect(page.locator('.library-thumbnail')).toBeVisible();
    await expect(page.getByRole('button', {name: 'Open', exact: true})).toBeDisabled();

    release();
    await expect(page.locator('#reader')).toBeVisible();
    await expect(page.locator('#reader-progress')).toContainText('Paragraph 1 of 2');
  });

  test('a conversion that failed says why and can be tried again', async ({ page }) => {
    let failing = true;
    await loadHome(page, port);
    await page.route('**/api/extract-pdf', async route => {
      if (failing) { await route.fulfill({status: 400, json: {error: 'Docling could not convert this PDF.'}}); return; }
      await route.fulfill({json: extractionFor()});
    });

    await selectPdf(page);
    await page.getByRole('button', {name: 'Add to library'}).click();
    await expect(page.locator('.doc-badge.failed')).toContainText('Docling could not convert this PDF.');

    failing = false;
    // The stored PDF is still here, so trying again needs nothing from you.
    await page.getByRole('button', {name: 'Try again'}).click();
    await expect(page.locator('#reader')).toBeVisible();
    await expect(page.locator('#reader-progress')).toContainText('Paragraph 1 of 2');
  });

  test('a conversion abandoned by a reload is offered again rather than stranded', async ({ page }) => {
    let hang = true;
    await loadHome(page, port);
    await page.route('**/api/extract-pdf', async route => {
      if (hang) { await new Promise(() => {}); return; }
      await route.fulfill({json: extractionFor()});
    });

    await selectPdf(page);
    await page.getByRole('button', {name: 'Add to library'}).click();
    await expect(page.locator('.doc-badge.working')).toBeVisible();

    hang = false;
    await page.reload();
    // Nothing is converting any more, so a card left in that state would
    // never become openable.
    await expect(page.locator('.doc-badge.failed')).toContainText('Extracting the text was interrupted.');
    await page.getByRole('button', {name: 'Try again'}).click();
    await expect(page.locator('#reader')).toBeVisible();
  });

  test('two imports convert one at a time', async ({ page }) => {
    let running = 0;
    let peak = 0;
    await loadHome(page, port);
    await page.route('**/api/extract-pdf', async route => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(900);
      running -= 1;
      await route.fulfill({json: extractionFor()});
    });

    await selectPdf(page);
    await page.getByRole('button', {name: 'Add to library'}).click();
    await expect(page.locator('#document-setup')).toBeHidden();
    await page.locator('#pdf').setInputFiles({name: 'other.pdf', mimeType: 'application/pdf', buffer: OTHER_PDF});
    await expect(page.locator('#document-setup')).toBeVisible();
    await page.getByRole('button', {name: 'Add to library'}).click();

    await expect(page.locator('#reader')).toBeVisible({timeout: 15000});
    await page.getByRole('button', {name: 'Library', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Open', exact: true})).toHaveCount(2);
    // Docling is heavy enough that two at once can swamp the machine.
    expect(peak).toBe(1);
  });
});
