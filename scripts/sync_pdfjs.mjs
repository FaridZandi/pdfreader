import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'node_modules', 'pdfjs-dist', 'build');
const destination = resolve(root, 'webui_static', 'pdfjs');

await mkdir(destination, { recursive: true });
for (const filename of ['pdf.mjs', 'pdf.worker.mjs']) {
  await copyFile(resolve(source, filename), resolve(destination, filename));
}
await copyFile(resolve(root, 'node_modules', 'pdfjs-dist', 'LICENSE'), resolve(destination, 'LICENSE'));
console.log('PDF.js browser assets are ready.');
