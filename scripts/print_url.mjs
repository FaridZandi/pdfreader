#!/usr/bin/env node
// Prints a web page to PDF with the Chromium that Playwright manages, so the
// reader gets a document with real text and geometry to work from.
// Usage: node scripts/print_url.mjs <url> <output.pdf>
// Writes {"title": "..."} to stdout so the caller can name the document.
import { chromium } from '@playwright/test';

const [url, output] = process.argv.slice(2);
if (!url || !output) {
  process.stderr.write('Usage: print_url.mjs <url> <output.pdf>\n');
  process.exit(2);
}

let browser;
try {
  browser = await chromium.launch();
} catch (error) {
  process.stderr.write(
    'Could not start the browser used to print web pages. '
    + 'Run "npx playwright install chromium" and try again.\n'
    + `${error.message}\n`,
  );
  process.exit(3);
}

try {
  const page = await browser.newPage();
  await page.goto(url, {waitUntil: 'load', timeout: 45000});
  // Give late layout and webfonts a moment before measuring pages.
  await page.waitForLoadState('networkidle', {timeout: 15000}).catch(() => {});
  const title = (await page.title()) || new URL(url).hostname;
  await page.emulateMedia({media: 'print'});
  await page.pdf({
    path: output,
    format: 'Letter',
    printBackground: true,
    margin: {top: '14mm', bottom: '14mm', left: '14mm', right: '14mm'},
  });
  process.stdout.write(JSON.stringify({title}));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
} finally {
  await browser.close();
}
