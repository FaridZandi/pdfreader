import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  filterSummaryMessage,
  headingDepth,
  normaliseSearchText,
  selectParagraphsForPreset,
  splitDocumentParagraphs,
  splitForSpeech,
  statusForItem,
  textForSpeech,
} from '../../webui/lib/text.mjs';

test('search text ignores case and collapses whitespace', () => {
  assert.equal(normaliseSearchText('  The   Attention\nMechanism '), 'the attention mechanism');
  assert.equal(normaliseSearchText(''), '');
});

test('paragraphs split on blank lines and lose internal line breaks', () => {
  assert.deepEqual(
    splitDocumentParagraphs('One line\nwrapped.\n\n\n  Second.  \n\n   \n'),
    ['One line wrapped.', 'Second.'],
  );
});

test('bracketed asides are dropped only when asked', () => {
  const value = 'Prior work [12] shows a gain [see appendix].';
  assert.equal(textForSpeech(value, false), value);
  assert.equal(textForSpeech(value, true), 'Prior work shows a gain.');
});

test('nested and unbalanced brackets do not swallow the sentence', () => {
  assert.equal(textForSpeech('a [b [c] d] e', true), 'a e');
  // A stray closing bracket is literal; a stray opening one ends the aside.
  assert.equal(textForSpeech('a ] b', true), 'a ] b');
  assert.equal(textForSpeech('a [b c', true), 'a');
});

test('speech chunks stay within the limit', () => {
  const sentence = `${'word '.repeat(60).trim()}. `;
  const chunks = splitForSpeech(sentence.repeat(6), 200);
  assert.ok(chunks.length > 1, 'expected the paragraph to be split');
  for (const chunk of chunks) assert.ok(chunk.length <= 200, `chunk too long: ${chunk.length}`);
});

test('a single sentence longer than the limit is split on words, not mid-word', () => {
  const chunks = splitForSpeech(`${'supercalifragilistic '.repeat(40).trim()}.`, 100);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100);
    assert.ok(!/supercalifragilisti$|^c\b/.test(chunk), 'a word was cut in half');
  }
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), `${'supercalifragilistic '.repeat(40).trim()}.`);
});

test('short text is left as one chunk', () => {
  assert.deepEqual(splitForSpeech('A short paragraph.'), ['A short paragraph.']);
  assert.deepEqual(splitForSpeech('   '), []);
});

const paragraph = (id, label, ...reasons) => ({id, label, filter_reasons: reasons, text: id});

test('presets hide the right blocks and never renumber source ids', () => {
  const all = [
    paragraph('body', 'text'),
    paragraph('caption', 'caption'),
    paragraph('runner', 'text', 'header_footer'),
    paragraph('table', 'table'),
  ];

  const prose = selectParagraphsForPreset(all, 'prose');
  const withCaptions = selectParagraphsForPreset(all, 'prose_captions');
  const full = selectParagraphsForPreset(all, 'full');

  assert.deepEqual(prose.paragraphs.map(item => item.id), ['body']);
  assert.deepEqual(withCaptions.paragraphs.map(item => item.id), ['body', 'caption']);
  assert.deepEqual(full.paragraphs.map(item => item.id), ['body', 'caption', 'runner', 'table']);
  assert.deepEqual(prose.filter_summary.reasons, {caption: 1, header_footer: 1, non_prose: 1});
  assert.equal(prose.filter_summary.hidden, 3);
  assert.equal(prose.filter_summary.visible, 1);
});

test('a caption reason alone does not hide a block from the captions preset', () => {
  const all = [paragraph('c', 'caption', 'caption')];
  assert.deepEqual(selectParagraphsForPreset(all, 'prose_captions').paragraphs.map(i => i.id), ['c']);
  assert.deepEqual(selectParagraphsForPreset(all, 'prose').paragraphs, []);
});

test('the filter summary reads as a sentence', () => {
  assert.equal(filterSummaryMessage({visible: 186, hidden: 0}), '186 reading paragraphs ready.');
  assert.equal(
    filterSummaryMessage({visible: 186, hidden: 50, reasons: {header_footer: 12, reference_entry: 38}}),
    '186 reading paragraphs ready; 50 hidden (12 headers/footers, 38 reference entries).',
  );
  assert.equal(filterSummaryMessage(undefined), '0 reading paragraphs ready.');
});

test('a paragraph reports the state of its parts', () => {
  assert.equal(statusForItem({partStates: ['played', 'played']}), 'played');
  assert.equal(statusForItem({partStates: ['played', 'playing']}), 'playing');
  assert.equal(statusForItem({partStates: ['queued', 'converting']}), 'converting');
  assert.equal(statusForItem({partStates: ['ready', 'queued']}), 'ready');
  assert.equal(statusForItem({partStates: ['error', 'queued']}), 'error');
  assert.equal(statusForItem({partStates: ['queued']}), 'queued');
  // Playing outranks converting, so the PDF marks where you actually are.
  assert.equal(statusForItem({partStates: ['converting', 'playing']}), 'playing');
});

test('heading depth comes from numbering and is never invented', () => {
  assert.equal(headingDepth('1 Introduction'), 1);
  assert.equal(headingDepth('2.1 Attention'), 2);
  assert.equal(headingDepth('3.2.4.5 Deeply nested'), 3);
  assert.equal(headingDepth('Introduction'), 1);
  assert.equal(headingDepth('  4.1  Spaced'), 2);
});
