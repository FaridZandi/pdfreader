import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = new URL('../', import.meta.url).pathname;
const PAGE = `<!doctype html><html><head><title>A Printed Article</title></head>
<body><h1>A Printed Article</h1><p>Body text that has to survive the print.</p></body></html>`;

// The printer is what turns a web page into something the reader can show, so
// exercise it for real rather than stubbing the browser away.
test('prints a web page to a PDF with its text intact', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8'}).end(PAGE);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'print-url-'));
  const output = join(directory, 'page.pdf');
  try {
    const {stdout} = await run('node', [join(ROOT, 'scripts/print_url.mjs'),
      `http://127.0.0.1:${server.address().port}/article`, output], {timeout: 120000});

    expect(JSON.parse(stdout)).toEqual({title: 'A Printed Article'});
    const pdf = await readFile(output);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.byteLength).toBeGreaterThan(1000);
  } finally {
    await rm(directory, {recursive: true, force: true});
    await new Promise(resolve => server.close(resolve));
  }
});

test('reports a bad address instead of writing a broken file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'print-url-'));
  try {
    await expect(run('node', [join(ROOT, 'scripts/print_url.mjs'),
      'http://127.0.0.1:1/nothing', join(directory, 'page.pdf')], {timeout: 120000})).rejects.toThrow();
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
