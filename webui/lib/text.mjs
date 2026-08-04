// Pure text and reading-queue helpers: no DOM, no shared state, no storage.
// Everything here is directly unit testable, which the rest of the application
// is not.

const PROSE_LABELS = new Set(['text', 'section_header', 'title', 'list_item']);

const FILTER_LABELS = {
  header_footer: 'headers/footers',
  caption: 'captions',
  reference_heading: 'reference headings',
  reference_entry: 'reference entries',
  figure_label: 'figure labels',
  isolated_token: 'isolated tokens',
  non_prose: 'non-prose blocks',
};

/** Mirrors the server's `content_for_preset`, so a preset can be reapplied
 *  locally without extracting the PDF again. Source ids never change. */
export function selectParagraphsForPreset(allParagraphs, preset) {
  const reasons = {};
  const paragraphs = allParagraphs.filter(paragraph => {
    const label = paragraph.label || '';
    const filterReasons = paragraph.filter_reasons || [];
    let hiddenReason;
    if (preset !== 'full') {
      if (!PROSE_LABELS.has(label) && !(preset === 'prose_captions' && label === 'caption')) {
        hiddenReason = label === 'caption' ? 'caption' : 'non_prose';
      } else {
        hiddenReason = filterReasons.find(reason => reason !== 'caption');
      }
    }
    if (!hiddenReason) return true;
    reasons[hiddenReason] = (reasons[hiddenReason] || 0) + 1;
    return false;
  });
  return {
    paragraphs,
    filter_summary: {
      preset,
      visible: paragraphs.length,
      hidden: allParagraphs.length - paragraphs.length,
      reasons,
    },
  };
}

export function filterSummaryMessage(summary) {
  if (!summary || !summary.hidden) return `${summary?.visible || 0} reading paragraphs ready.`;
  const detail = Object.entries(summary.reasons || {})
    .map(([reason, count]) => `${count} ${FILTER_LABELS[reason] || reason}`)
    .join(', ');
  return `${summary.visible} reading paragraphs ready; ${summary.hidden} hidden (${detail}).`;
}

export function normaliseSearchText(value) {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

export function splitDocumentParagraphs(value) {
  return value.split(/\n\s*\n+/).map(item => item.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Drops bracketed asides from what is spoken, leaving the paragraph itself
 *  untouched. Brackets nest, so an unbalanced one never eats the rest. */
export function textForSpeech(value, skipBracketed) {
  if (!skipBracketed) return value;
  let depth = 0;
  let result = '';
  for (const character of value) {
    if (character === '[') { depth += 1; continue; }
    if (character === ']' && depth) { depth -= 1; continue; }
    if (!depth) result += character;
  }
  return result.replace(/\s+([,.;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

/** Breaks a paragraph into pieces the speech endpoint will accept, preferring
 *  sentence boundaries and falling back to words for a very long sentence. */
export function splitForSpeech(value, limit = 440) {
  const result = [];
  for (const paragraph of splitDocumentParagraphs(value)) {
    if (paragraph.length <= limit) { result.push(paragraph); continue; }
    const sentences = paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [paragraph];
    let current = '';
    for (let sentence of sentences) {
      sentence = sentence.trim();
      if (sentence.length > limit) {
        for (const word of sentence.split(' ')) {
          if ((current + ' ' + word).trim().length > limit && current) { result.push(current); current = word; }
          else current = `${current} ${word}`.trim();
        }
      } else if ((current + ' ' + sentence).trim().length > limit && current) {
        result.push(current);
        current = sentence;
      } else current = `${current} ${sentence}`.trim();
    }
    if (current) result.push(current);
  }
  return result;
}

/** One label for a paragraph built from the state of its speech parts. */
export function statusForItem(item) {
  const states = item.partStates;
  if (states.every(state => state === 'played')) return 'played';
  if (states.includes('playing')) return 'playing';
  if (states.includes('converting')) return 'converting';
  if (states.includes('ready')) return 'ready';
  if (states.includes('error')) return 'error';
  return 'queued';
}

/** Heading depth from leading numbering only; unnumbered headings stay flat
 *  rather than having a hierarchy invented for them. */
export function headingDepth(value) {
  const match = value.match(/^\s*(\d+(?:\.\d+)*)\b/);
  return match ? Math.min(match[1].split('.').length, 3) : 1;
}
