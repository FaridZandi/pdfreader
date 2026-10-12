import {test, expect} from '@playwright/test';
import {loadHome, selectPdf, silentWav, startStaticServer} from './helpers/reader.mjs';
import {splitForSpeech} from '../webui/lib/text.mjs';

const paused = page => page.locator('#reader-player').evaluate(player => player.paused);
async function paste(page, text) {
  await page.getByRole('button', {name: 'Paste text', exact: true}).click();
  await page.getByLabel('Text to read aloud').fill(text);
  await page.getByRole('button', {name: 'Read aloud', exact: true}).click();
}

test.describe('temporary pasted reading', () => {
  let server, port;
  test.beforeAll(async () => { server = await startStaticServer(); port = server.address().port; });
  test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

  test('blank input gives feedback; cancel and Escape return to the library', async ({page}) => {
    await loadHome(page, port);
    await paste(page, '  \n  ');
    await expect(page.locator('#paste-error')).toContainText('Paste some text');
    await expect(page.locator('#reader')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('#paste-dialog')).not.toBeVisible();
    await page.getByRole('button', {name: 'Paste text', exact: true}).click();
    await page.getByRole('button', {name: 'Cancel', exact: true}).click();
    await expect(page.locator('#paste-dialog')).not.toBeVisible();
  });

  test('literal HTML is safe, controls work, and text/audio are discarded across close and reload', async ({page}) => {
    const asked = [];
    await loadHome(page, port, {voices: {default: 'af_heart', voices: [{id: 'af_heart', label: 'Heart'}, {id: 'am_michael', label: 'Michael'}]}});
    await page.route('**/api/synthesize', async route => {
      asked.push(route.request().postDataJSON());
      await route.fulfill({contentType: 'audio/wav', body: silentWav(30)});
    });
    const literal = '<img src=x onerror="window.pasteExecuted=true"> <script>alert(1)</script> [Read this too.]';
    await paste(page, literal);
    await expect(page.locator('#pasted-text')).toHaveText(literal);
    await expect(page.locator('#pasted-text img, #pasted-text script')).toHaveCount(0);
    expect(await page.evaluate(() => window.pasteExecuted)).toBeUndefined();
    await expect(page.locator('#reader-temporary')).toContainText('discarded on close or reload');
    await expect(page.locator('#reader-toggle')).toBeEnabled();
    await page.locator('#reader-toggle').click();
    await expect.poll(() => paused(page)).toBe(false);
    await page.locator('#reader-toggle').click();
    await expect.poll(() => paused(page)).toBe(true);
    await page.locator('#reader-playback-speed').fill('1.5');
    expect(await page.locator('#reader-player').evaluate(player => player.playbackRate)).toBe(1.5);
    await page.locator('#reader-voice').selectOption('am_michael');
    await expect.poll(() => asked.at(-1)?.voice).toBe('am_michael');
    expect(asked[0].text).toBe(literal);
    await page.getByRole('button', {name: 'Library', exact: true}).click();
    await expect(page.locator('#pasted-text')).toBeEmpty();
    await expect(page.locator('#reader-drawer')).toBeEmpty();
    expect(await page.locator('#reader-player').getAttribute('src')).toBeNull();
    await paste(page, literal);
    await expect.poll(() => asked.length).toBe(3); // no audio cache reuse
    await page.reload();
    await expect(page.locator('#reader')).toBeHidden();
    await expect(page.locator('#library-list .doc')).toHaveCount(0);
    await page.getByRole('button', {name: 'Paste text', exact: true}).click();
    await expect(page.getByLabel('Text to read aloud')).toHaveValue('');
    const stored = await page.evaluate(async () => {
      const {allRecords} = await import('/app/lib/db.mjs');
      return {audio: await allRecords('audio'), documents: await allRecords('documents'), resume: Object.keys(localStorage).filter(key => key.startsWith('pdfreader.resume.'))};
    });
    expect(stored).toEqual({audio: [], documents: [], resume: []});
  });

  test('long paragraphs are synthesized and played in chunk and paragraph order', async ({page}) => {
    const first = Array.from({length: 60}, (_, index) => `Sentence ${index} has words.`).join(' ');
    const second = 'Final paragraph follows the long one.';
    const expected = [...splitForSpeech(first), second];
    const asked = [];
    await loadHome(page, port);
    await page.route('**/api/synthesize', async route => {
      const text = route.request().postDataJSON().text;
      asked.push(text);
      await route.fulfill({contentType: 'audio/wav', body: silentWav(0.6 + expected.indexOf(text) * 0.1)});
    });
    await page.evaluate(() => {
      window.playedChunks = [];
      document.querySelector('#reader-player').addEventListener('playing', event => {
        window.playedChunks.push({duration: event.target.duration, paragraph: document.querySelector('#reader-progress').textContent});
      });
    });
    await paste(page, `${first}\n\n${second}`);
    await expect(page.locator('.pasted-paragraph')).toHaveCount(2);
    await expect.poll(() => asked.length).toBe(expected.length);
    expect(asked).toEqual(expected);
    expect(asked.every(text => text.length <= 440)).toBe(true);
    await page.locator('#reader-toggle').click();
    await expect(page.locator('#reader-status')).toHaveText('Finished reading.');
    const played = await page.evaluate(() => window.playedChunks);
    expect(played).toEqual(expected.map((text, index) => ({duration: 0.6 + index * 0.1, paragraph: `Paragraph ${index < expected.length - 1 ? 1 : 2} of 2`})));
  });

  test('synthesis failure can be retried and closing cancels pending playback', async ({page}) => {
    await loadHome(page, port);
    await page.route('**/api/synthesize', route => route.fulfill({status: 500, json: {error: 'Speech engine unavailable.'}}));
    await paste(page, 'Retry this pasted paragraph.');
    await expect(page.locator('#reader-status')).toContainText('Speech engine unavailable.');
    await expect(page.locator('#reader-retry')).toBeVisible();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let started = false;
    await page.route('**/api/synthesize', async route => {
      started = true;
      await held;
      await route.fulfill({contentType: 'audio/wav', body: silentWav(30)}).catch(() => {});
    });
    await page.locator('#reader-retry').click();
    await expect.poll(() => started).toBe(true);
    await page.keyboard.press('Space');
    await page.getByRole('button', {name: 'Library', exact: true}).click();
    release();
    await expect(page.locator('#reader')).toBeHidden();
    await expect.poll(() => paused(page)).toBe(true);
    expect(await page.locator('#reader-player').getAttribute('src')).toBeNull();
    await page.unroute('**/api/synthesize');
    await page.route('**/api/synthesize', route => route.fulfill({contentType: 'audio/wav', body: silentWav(30)}));
    await paste(page, 'Retry this pasted paragraph.');
    await expect(page.locator('#reader-toggle')).toBeEnabled();
    await page.locator('#reader-toggle').click();
    await expect.poll(() => paused(page)).toBe(false);
  });

  test('retry succeeds in the same pasted session', async ({page}) => {
    let failing = true;
    await loadHome(page, port);
    await page.route('**/api/synthesize', route => failing
      ? route.fulfill({status: 500, json: {error: 'Please retry speech.'}})
      : route.fulfill({contentType: 'audio/wav', body: silentWav(30)}));
    await paste(page, 'Recover without pasting again.');
    await expect(page.locator('#reader-status')).toContainText('Please retry speech.');
    failing = false;
    await page.locator('#reader-retry').click();
    await expect(page.locator('#reader-toggle')).toBeEnabled();
    await expect(page.locator('#reader-retry')).toBeHidden();
    await page.locator('#reader-toggle').click();
    await expect.poll(() => paused(page)).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.locator('#reader')).toBeHidden();
    expect(await page.locator('#reader-player').getAttribute('src')).toBeNull();
  });

  test('text and transport fit a narrow reader', async ({page}) => {
    await page.setViewportSize({width: 390, height: 844});
    await loadHome(page, port);
    await paste(page, 'Text to listen to on a narrow screen.');
    await expect(page.locator('#reader-title')).toHaveText('Pasted text');
    await expect(page.locator('#reader-temporary')).toBeVisible();
    for (const selector of ['.pasted-paragraph', '#reader-title', '#reader-playback-speed', '#reader-voice', '#reader-close']) {
      const box = await page.locator(selector).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    await page.screenshot({path: '/tmp/pdf-018-narrow-final.png'});
  });

  test('a PDF still opens and plays after pasted reading', async ({page}) => {
    await loadHome(page, port, {audio: silentWav(30)});
    await paste(page, 'Temporary text before the PDF.');
    await page.getByRole('button', {name: 'Library', exact: true}).click();
    await selectPdf(page);
    await page.getByRole('button', {name: 'Add to library'}).click();
    await expect(page.locator('.pdf-paragraph[data-source-id="p1"]')).toBeVisible();
    await expect(page.locator('#reader-temporary')).toBeHidden();
    await page.locator('.pdf-paragraph[data-source-id="p1"]').click();
    await expect.poll(() => paused(page)).toBe(false);
  });
});
