import { test, expect } from '@playwright/test';

import {
  loadHome,
  openReaderPage,
  selectPdf,
  silentWav,
  sleep,
  startStaticServer,
} from './helpers/reader.mjs';

const paused = page => page.locator('#reader-player').evaluate(player => player.paused);

test.describe('reader playback', () => {
  let server;
  let port;

  test.beforeAll(async () => {
    server = await startStaticServer();
    port = server.address().port;
  });

  test.afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  test('Space still plays and pauses after clicking a paragraph', async ({ page }) => {
    await openReaderPage(page, port, {audio: silentWav()});
    await page.locator('.pdf-paragraph[data-source-id="p1"]').click();
    await expect.poll(() => paused(page)).toBe(false);
    // Clicking leaves the focus on the paragraph overlay, which is where the
    // reader's own play/pause key used to disappear.
    expect(await page.evaluate(() => document.activeElement?.className)).toContain('pdf-paragraph');

    await page.keyboard.press('Space');
    await expect.poll(() => paused(page)).toBe(true);
    await page.keyboard.press('Space');
    await expect.poll(() => paused(page)).toBe(false);
    // And it keeps working, rather than pausing once and never resuming.
    await page.keyboard.press('Space');
    await expect.poll(() => paused(page)).toBe(true);
  });

  test('Space still plays and pauses after using the speed slider', async ({ page }) => {
    await openReaderPage(page, port, {audio: silentWav()});
    await page.locator('.pdf-paragraph[data-source-id="p1"]').click();
    await expect.poll(() => paused(page)).toBe(false);
    // The slider is an <input>, but Space means nothing to a range control,
    // so the reader must not treat it as a field that owns the keyboard.
    await page.locator('#reader-playback-speed').focus();
    await page.keyboard.press('Space');
    await expect.poll(() => paused(page)).toBe(true);
    await page.keyboard.press('Space');
    await expect.poll(() => paused(page)).toBe(false);
  });

  test('Space while a paragraph is converting decides whether it will play', async ({ page }) => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await loadHome(page, port);
    await page.route('**/api/synthesize', async route => {
      await held;
      await route.fulfill({contentType: 'audio/wav', body: silentWav()});
    });
    await selectPdf(page);
    await page.getByRole('button', {name: 'Add to library'}).click();
    await expect(page.locator('#reader')).toBeVisible();

    await page.locator('.pdf-paragraph[data-source-id="p1"]').click();
    await expect(page.locator('#reader-toggle')).toBeDisabled();
    await expect(page.locator('#reader-toggle')).toHaveAttribute('aria-label', 'Pause');
    // The keypress used to be dropped for as long as the conversion took.
    await page.keyboard.press('Space');
    await expect(page.locator('#reader-toggle')).toHaveAttribute('aria-label', 'Play');
    await expect(page.locator('#reader-status')).toContainText('press play when it is ready');

    release();
    await expect(page.locator('#reader-toggle')).toBeEnabled();
    expect(await paused(page)).toBe(true);
  });

  test('moving on takes the model back instead of queueing behind it', async ({ page }) => {
    const asked = [];
    await loadHome(page, port);
    await page.route('**/api/synthesize', async route => {
      asked.push(JSON.parse(route.request().postData()).text);
      await sleep(1500);
      await route.fulfill({contentType: 'audio/wav', body: silentWav(0.05)});
    });
    await selectPdf(page);
    await page.getByRole('button', {name: 'Add to library'}).click();
    await expect(page.locator('#reader')).toBeVisible();
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toContain('Local reader smoke test.');

    await page.locator('.pdf-paragraph[data-source-id="p2"]').click();
    // Well inside the 1500ms the first request still has to run: the second
    // paragraph must not be waiting for audio nobody wants any more.
    await expect.poll(() => asked.length, {timeout: 900}).toBeGreaterThan(1);
    expect(asked[1]).toContain('A second paragraph to resume from.');
  });

  test('speech is reused instead of generated again', async ({ page }) => {
    let requests = 0;
    await loadHome(page, port);
    await page.route('**/api/synthesize', async route => {
      requests += 1;
      await route.fulfill({contentType: 'audio/wav', body: silentWav(0.05)});
    });
    await selectPdf(page);
    await page.getByRole('button', {name: 'Add to library'}).click();
    await expect(page.locator('#reader')).toBeVisible();
    // Both paragraphs are prepared: the current one and the prefetched one.
    await expect.poll(() => requests).toBe(2);

    await page.getByRole('button', {name: 'Library', exact: true}).click();
    await page.getByRole('button', {name: 'Open', exact: true}).click();
    await expect(page.locator('#reader')).toBeVisible();
    await page.locator('.pdf-paragraph[data-source-id="p2"]').click();
    await expect.poll(() => paused(page)).toBe(false);
    expect(requests).toBe(2);
  });

  test('the chosen voice is what the server is asked for', async ({ page }) => {
    const voices = {default: 'af_heart', voices: [
      {id: 'af_heart', label: 'Heart (female)'},
      {id: 'am_michael', label: 'Michael (male)'},
    ]};
    const asked = [];
    await loadHome(page, port, {voices});
    await page.route('**/api/synthesize', async route => {
      asked.push(JSON.parse(route.request().postData()).voice);
      await route.fulfill({contentType: 'audio/wav', body: silentWav(0.05)});
    });
    await selectPdf(page);
    await page.getByRole('button', {name: 'Add to library'}).click();
    await expect(page.locator('#reader')).toBeVisible();
    await expect.poll(() => asked.length).toBeGreaterThan(0);
    expect(asked.every(voice => voice === 'af_heart')).toBe(true);

    await page.locator('#reader-voice').selectOption('am_michael');
    // Everything already prepared was spoken in the old voice, so the
    // paragraph is prepared again rather than played in the wrong one.
    await expect.poll(() => asked.at(-1)).toBe('am_michael');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('pdfreader.voice'))).toBe('am_michael');
  });

  test('a paragraph that failed to convert can be tried again', async ({ page }) => {
    let failing = true;
    await loadHome(page, port);
    await page.route('**/api/synthesize', async route => {
      if (failing) { await route.fulfill({status: 500, json: {error: 'Kokoro ran out of memory.'}}); return; }
      await route.fulfill({contentType: 'audio/wav', body: silentWav()});
    });
    await selectPdf(page);
    await page.getByRole('button', {name: 'Add to library'}).click();
    await expect(page.locator('#reader')).toBeVisible();
    await expect(page.locator('#reader-status')).toContainText('Kokoro ran out of memory.');
    const retry = page.getByRole('button', {name: 'Try this paragraph again'});
    await expect(retry).toBeVisible();

    failing = false;
    await retry.click();
    await expect(retry).toBeHidden();
    await expect(page.locator('#reader-toggle')).toBeEnabled();
    await page.locator('#reader-toggle').click();
    await expect.poll(() => paused(page)).toBe(false);
  });
});
