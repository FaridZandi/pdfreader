// The reading engine: the queue of paragraphs, the conversion of each one to
// speech, the cache that keeps that work, and the audio element that plays it.
// It owns the reading position and says when it moves; what that means on the
// page - scrolling, drawers, overlays - is the caller's business.
import { readCachedAudio, writeCachedAudio } from './db.mjs';
import { normaliseSearchText, splitForSpeech, textForSpeech } from './text.mjs';

// Audio is always generated at Kokoro's natural speed and the audio element
// applies the reader's rate, so changing speed takes effect at once instead
// of discarding prepared audio - and the cache needs no speed dimension.
export const SYNTHESIS_SPEED = 1;

export function createSpeech({
  player,
  toggleButton,
  retry,
  prefetch = 2,
  voice = () => '',
  speed = () => 1,
  skipBracketed = () => false,
  documentKey = () => undefined,
  title = () => '',
  requestError,
  onPosition = () => {},
  onChange = () => {},
  onStatus = () => {},
  onSave = () => {},
}) {
  let items = [];
  let currentIndex = -1;
  let run = 0;
  let autoplay = false;
  let audioUrl;
  let active = false;
  // The one request in flight, so moving the reading position can take the
  // model back rather than queueing behind work nobody wants any more. The
  // token orphans a result that arrives after its request was abandoned.
  let conversion;
  let conversionToken = 0;
  let sessionStartedAt = 0;
  let completedCharacters = 0;
  let completedSeconds = 0;

  // The transport button carries its state in its icon and accessible name;
  // it has no visible label to overwrite.
  function setButton(playing) {
    toggleButton.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
    toggleButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  /** What identifies a piece of generated speech: the words and the voice. */
  async function speechKey(text, voiceId) {
    if (!window.crypto?.subtle) return null;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${voiceId}\n${text}`));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function cached(text, voiceId) {
    const key = await speechKey(text, voiceId).catch(() => null);
    if (!key) return {key: null};
    return {key, blob: await readCachedAudio(key).catch(() => undefined)};
  }

  // Speech survives closing the reader: it costs the same model time to make
  // again, and reopening a document you were part-way through should not
  // re-synthesise everything you already heard.
  async function synthesize(value, signal) {
    const speechText = textForSpeech(value, skipBracketed());
    if (!speechText) throw new Error('No speakable text remains after skipping bracketed text.');
    const voiceId = voice();
    const {key, blob: hit} = await cached(speechText, voiceId);
    if (hit) return hit;
    const response = await fetch('/api/synthesize', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({text: speechText, speed: SYNTHESIS_SPEED, voice: voiceId}),
      signal,
    });
    if (!response.ok) throw await requestError(response, 'Could not generate audio.');
    const blob = await response.blob();
    // Storing is best effort: a full disk must not stop the reader.
    if (key) writeCachedAudio({id: key, documentKey: documentKey(), blob}).catch(() => {});
    return blob;
  }

  function unload() {
    player.pause();
    player.removeAttribute('src');
    player.load();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = undefined;
  }

  function cancelConversion() {
    if (!conversion) return;
    conversionToken += 1;
    conversion.item.partStates[conversion.partIndex] = 'queued';
    conversion.controller.abort();
    conversion = undefined;
  }

  function pump(session) {
    if (session !== run || !active || conversion) return;
    const lastIndex = Math.min(currentIndex + prefetch, items.length - 1);
    let itemIndex = -1;
    let partIndex = -1;
    for (let index = currentIndex; index <= lastIndex; index += 1) {
      const queued = items[index]?.partStates.findIndex(state => state === 'queued') ?? -1;
      if (queued >= 0) { itemIndex = index; partIndex = queued; break; }
    }
    if (itemIndex < 0) return;
    const item = items[itemIndex];
    const token = ++conversionToken;
    const controller = new AbortController();
    conversion = {item, partIndex, controller};
    item.partStates[partIndex] = 'converting';
    onChange();
    synthesize(item.parts[partIndex], controller.signal)
      .then(blob => {
        if (token !== conversionToken || session !== run) return;
        conversion = undefined;
        item.blobs[partIndex] = blob;
        item.partStates[partIndex] = 'ready';
        onChange();
        onSave();
        if (itemIndex === currentIndex && item.partIndex === partIndex) play(session);
        pump(session);
      })
      .catch(error => {
        if (token !== conversionToken || session !== run) return;
        conversion = undefined;
        item.partStates[partIndex] = 'error';
        item.error = error.message;
        onChange();
        if (itemIndex === currentIndex && item.partIndex === partIndex) {
          onStatus(`Paragraph ${itemIndex + 1} failed: ${error.message}`);
          toggleButton.disabled = true;
          retry.hidden = false;
        }
        pump(session);
      });
  }

  function announceMedia() {
    if (!('mediaSession' in navigator) || !('MediaMetadata' in window)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: sectionAt(currentIndex), artist: title(), album: 'PDF Reader',
    });
    navigator.mediaSession.setActionHandler('play', () => player.play());
    navigator.mediaSession.setActionHandler('pause', () => player.pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => jumpTo(currentIndex + 1));
    navigator.mediaSession.setActionHandler('previoustrack', () => jumpTo(currentIndex - 1));
  }

  function play(session) {
    if (session !== run || currentIndex < 0) return;
    const item = items[currentIndex];
    const partIndex = item.partIndex;
    const state = item.partStates[partIndex];
    if (state === 'queued' || state === 'converting') {
      // Audio is not ready yet, but the controls already reflect the pending
      // intent so a click never looks like it was ignored.
      onStatus(autoplay
        ? `Converting paragraph ${currentIndex + 1}; playback starts automatically…`
        : `Converting paragraph ${currentIndex + 1}…`);
      toggleButton.disabled = true;
      setButton(autoplay);
      pump(session);
      return;
    }
    if (state === 'error') return;
    unload();
    item.partStates[partIndex] = 'playing';
    audioUrl = URL.createObjectURL(item.blobs[partIndex]);
    player.src = audioUrl;
    player.playbackRate = speed();
    announceMedia();
    player.onended = () => {
      if (session !== run) return;
      item.partStates[partIndex] = 'played';
      completedCharacters += item.parts[partIndex].length;
      completedSeconds += (player.duration || 0) / Math.max(speed(), 0.1);
      if (partIndex + 1 < item.parts.length) {
        item.partIndex += 1;
        onChange();
        onSave();
        play(session);
        return;
      }
      if (currentIndex + 1 >= items.length) {
        onChange();
        onStatus('Finished reading.');
        toggleButton.disabled = true;
        onSave();
        return;
      }
      currentIndex += 1;
      onPosition(currentIndex, {reveal: true});
      play(session);
    };
    toggleButton.disabled = false;
    setButton(autoplay);
    onChange();
    onSave();
    onStatus(autoplay
      ? 'Playing. The conversion queue is preparing upcoming paragraphs.'
      : 'Ready to play. Upcoming paragraphs will prepare as you listen.');
    pump(session);
    if (autoplay) player.play().catch(() => {
      autoplay = false;
      setButton(false);
      onStatus('Audio is ready. Press Play to begin reading.');
    });
  }

  // `play` marks an explicit request to read from here. Keyboard and
  // media-key navigation omit it so they keep whatever state you were in.
  // Moving the reading position scrolls the PDF to match, except when the
  // caller is a click on the paragraph itself, which is already on screen.
  function jumpTo(index, {play: shouldPlay = false, reveal = true} = {}) {
    if (!active || index < 0 || index >= items.length) return;
    // Whatever was being generated was for where you just left, so take the
    // model back before asking it for the paragraph you actually want.
    cancelConversion();
    retry.hidden = true;
    const previous = items[currentIndex];
    if (previous?.partStates[previous.partIndex] === 'playing') previous.partStates[previous.partIndex] = 'ready';
    const target = items[index];
    target.partIndex = 0;
    target.partStates = target.partStates.map(state => state === 'played' ? 'ready' : state === 'error' ? 'queued' : state);
    unload();
    if (shouldPlay) autoplay = true;
    setButton(autoplay);
    toggleButton.disabled = true;
    currentIndex = index;
    onPosition(index, {reveal});
    onStatus(`Preparing paragraph ${index + 1}...`);
    onSave();
    play(run);
  }

  function jumpToSource(sourceId, options) {
    // Prefer a part of this paragraph that has not been played yet, so
    // returning to it does not replay what you already heard.
    const unplayed = items.findIndex(item => item.sourceId === sourceId
      && !item.partStates.every(state => state === 'played'));
    jumpTo(unplayed >= 0 ? unplayed : items.findIndex(item => item.sourceId === sourceId), options);
  }

  function togglePlayback() {
    // While the paragraph is still being generated there is nothing to play
    // yet. Dropping the keypress made Space look broken for as long as the
    // conversion took, so it switches the intent instead: the audio either
    // starts when it arrives, or waits for you.
    if (toggleButton.disabled) {
      const item = items[currentIndex];
      const state = item?.partStates[item.partIndex];
      if (state !== 'queued' && state !== 'converting') return;
      autoplay = !autoplay;
      setButton(autoplay);
      onStatus(autoplay
        ? `Converting paragraph ${currentIndex + 1}; playback starts automatically…`
        : `Converting paragraph ${currentIndex + 1}; press play when it is ready.`);
      onChange();
      return;
    }
    if (player.paused) {
      autoplay = true;
      player.play().catch(() => {});
      setButton(true);
      onStatus('Playing.');
    } else {
      autoplay = false;
      player.pause();
      setButton(false);
      onStatus('Paused.');
    }
    onChange();
  }

  function sectionAt(index) {
    for (let cursor = index; cursor >= 0; cursor -= 1) {
      const item = items[cursor];
      if (item?.label === 'title' || item?.label === 'section_header') return item.text;
    }
    return 'Introduction';
  }

  return {
    get items() { return items; },
    get currentIndex() { return currentIndex; },
    get playing() { return autoplay; },
    get current() { return items[currentIndex]; },
    sectionAt,

    /** Builds a reading queue and starts a new session. Returns how many
     *  paragraphs actually carry speakable text. */
    load(paragraphs) {
      run += 1;
      cancelConversion();
      active = true;
      autoplay = false;
      currentIndex = -1;
      sessionStartedAt = Date.now();
      completedCharacters = 0;
      completedSeconds = 0;
      retry.hidden = true;
      items = paragraphs.map(paragraph => {
        const speechText = textForSpeech(paragraph.text, skipBracketed());
        const parts = splitForSpeech(speechText);
        // Normalised once here rather than per keystroke, per paragraph.
        return {
          ...paragraph,
          text: speechText,
          searchText: normaliseSearchText(speechText),
          parts,
          blobs: Array(parts.length).fill(null),
          partStates: Array(parts.length).fill('queued'),
          partIndex: 0,
        };
      }).filter(item => item.parts.length);
      return items.length;
    },

    /** Positions the reader, at a saved place when one is given. */
    begin({sourceId, partIndex} = {}) {
      const resumed = sourceId === undefined || sourceId === null
        ? -1 : items.findIndex(item => item.sourceId === sourceId);
      currentIndex = resumed >= 0 ? resumed : 0;
      if (resumed >= 0) {
        const item = items[currentIndex];
        item.partIndex = Math.max(0, Math.min(item.parts.length - 1, Number(partIndex) || 0));
      }
      onPosition(currentIndex, {reveal: false});
      return resumed >= 0;
    },

    /** Starts the machinery once the page is ready to be looked at. */
    resume() { play(run); },

    jumpTo,
    jumpToSource,
    toggle: togglePlayback,

    /** Clicking the transport on the paragraph that is already loaded should
     *  behave like the main play button rather than restarting it. */
    toggleSource(sourceId) {
      if (items[currentIndex]?.sourceId === sourceId && player.src) { togglePlayback(); return; }
      jumpToSource(sourceId, {play: true, reveal: false});
    },

    // A failed paragraph used to be a dead end: the only way back was to
    // leave the reader and open the document again.
    retryCurrent() {
      const item = items[currentIndex];
      if (!item) return;
      item.partStates = item.partStates.map(state => state === 'error' ? 'queued' : state);
      item.error = undefined;
      retry.hidden = true;
      onStatus(`Retrying paragraph ${currentIndex + 1}…`);
      play(run);
    },

    /** Everything prepared so far was spoken in the previous voice, so it
     *  goes back to unconverted. Nothing is lost: the cache keeps each voice
     *  separately, so switching back is immediate. */
    revoice() {
      if (!active || !items.length) return;
      cancelConversion();
      items.forEach(item => {
        item.blobs = item.blobs.map(() => null);
        item.partStates = item.partStates.map(() => 'queued');
      });
      jumpTo(currentIndex, {reveal: false});
    },

    stop() {
      run += 1;
      active = false;
      cancelConversion();
      unload();
      items = [];
      currentIndex = -1;
      retry.hidden = true;
      toggleButton.disabled = true;
      setButton(false);
    },

    /** Where the reader is, for the resume record. */
    position() {
      const item = items[currentIndex];
      return item && {sourceId: item.sourceId, partIndex: item.partIndex, index: currentIndex, total: items.length};
    },

    /** Listening time so far, and an estimate of what is left once enough
     *  has been read for the estimate to mean anything. */
    estimate() {
      const elapsedSeconds = sessionStartedAt ? (Date.now() - sessionStartedAt) / 1000 : 0;
      if (completedCharacters < 80 || completedSeconds <= 0) return {elapsedSeconds, remainingSeconds: null};
      const perCharacter = completedSeconds / completedCharacters;
      const remainingCharacters = items.slice(currentIndex).reduce((total, item, offset) => (
        total + item.parts.slice(offset === 0 ? item.partIndex : 0).join(' ').length
      ), 0);
      return {elapsedSeconds, remainingSeconds: Math.round(remainingCharacters * perCharacter)};
    },

    /** The speech chunks an export covers. A section runs from the heading
     *  above the reading position to the one below it. */
    chunksFor(scope) {
      if (scope === 'paragraph') return items.slice(currentIndex, currentIndex + 1).flatMap(item => item.parts);
      if (scope === 'document') return items.flatMap(item => item.parts);
      const heading = index => ['title', 'section_header'].includes(items[index].label);
      let start = currentIndex;
      while (start > 0 && !heading(start)) start -= 1;
      let end = currentIndex + 1;
      while (end < items.length && !heading(end)) end += 1;
      return items.slice(start, end).flatMap(item => item.parts);
    },

    /** Cached speech for every one of these chunks, or null if any is
     *  missing. Used by an export to avoid asking for what it already has. */
    async cachedChunks(chunks) {
      const voiceId = voice();
      const blobs = [];
      for (const chunk of chunks) {
        const {blob} = await cached(textForSpeech(chunk, skipBracketed()), voiceId);
        if (!blob) return null;
        blobs.push(blob);
      }
      return blobs;
    },
  };
}
