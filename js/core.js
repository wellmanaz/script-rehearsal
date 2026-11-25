/*
 * Script Rehearsal core: pure functions shared by the browser app and the tests.
 * No DOM, no storage, no audio. Loaded as a classic script in the browser
 * (window.RehearsalCore) and with require() in Node.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RehearsalCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_NAME_LEN = 40;
  const MAX_NAME_WORDS = 5;
  // Lines in this many accepted speeches make a style "established", which lets
  // one-line characters in that style through (a WAITER with a single line).
  const ESTABLISHED_STYLE_MIN = 4;

  const HONORIFIC = "(?:MR|MRS|MS|MISS|DR|ST|LT|SGT|CAPT|PROF|REV|FR|SR|JR)\\.\\s?";
  const CAPS_NAME_BODY = "[A-Z][A-Z0-9'’\\-& .]*";
  const CAPS_NAME_RE = new RegExp('^(?:' + HONORIFIC + ')?' + CAPS_NAME_BODY + '$');
  const MIXED_NAME_RE = new RegExp('^(?:' + HONORIFIC + ')?' + "[A-Za-z][A-Za-z0-9'’\\-& .]*$", 'i');

  const INLINE_COLON_RE = new RegExp(
    '^(@?)((?:' + HONORIFIC + ')?' + "[A-Za-z][A-Za-z0-9'’\\-& .]{0," + (MAX_NAME_LEN - 1) + '}?)' +
      '\\s*(\\([^)]*\\))?\\s*:\\s*(\\S.*)$',
    'i'
  );
  const INLINE_PERIOD_RE = new RegExp(
    '^((?:' + HONORIFIC + ')?' + "[A-Z][A-Z0-9'’\\-& ]{0," + (MAX_NAME_LEN - 1) + '}?)' +
      '\\s*(\\([^)]*\\))?\\.\\s+(\\S.*)$'
  );

  // Words that look like a character cue but are headings, credits or notes.
  const META_WORDS = new Set([
    'TITLE', 'CREDIT', 'AUTHOR', 'AUTHORS', 'SOURCE', 'DRAFT DATE', 'DATE', 'CONTACT',
    'COPYRIGHT', 'NOTE', 'NOTES', 'SETTING', 'TIME', 'PLACE', 'CHARACTERS', 'CAST',
    'CAST OF CHARACTERS', 'SCENE', 'ACT', 'AT RISE', 'PRODUCTION NOTE', 'SYNOPSIS',
    'DRAFT', 'PAGE', 'WRITTEN BY', 'BY', 'THE END', 'END'
  ]);

  // Caps lines that are stage or camera directions, never speakers.
  const DIRECTION_WORD_RE = /^(?:LATER|MOMENTS LATER|CONTINUOUS|SILENCE|PAUSE|A PAUSE|BEAT|A BEAT|MUSIC|SOUND|SFX|DARKNESS|MONTAGE|FLASHBACK|BACK TO SCENE|SUPER|TITLE CARD|INSERT|ON SCREEN|INTERCUT|SERIES OF SHOTS|THE SAME|SAME)\b/;
  const TRANSITION_RE = /^(?:[A-Z][A-Z\s]*TO:$|FADE (?:IN|OUT)\b|FADE TO BLACK\b|CUT TO\b|SMASH CUT\b|DISSOLVE\b|BLACKOUT\b|BLACK OUT\b|CURTAIN\b|END OF (?:ACT|SCENE|PLAY)\b|THE END\b|LIGHTS? (?:UP|DOWN|OUT|FADE|RISE|COME UP)\b|INTERMISSION\b|END\.?$)/;
  const SCENE_RE = /^(?:\.(?=[A-Za-z0-9])|(?:INT|EXT|INT\.?\/EXT|I\/E)[.\s]|(?:ACT|SCENE)\s+(?:[0-9]+|[IVXLC]+|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN)\b|PROLOGUE\b|EPILOGUE\b)/i;
  const STANDARD_EXTENSION_RE = /^\((?:V\.?\s?O\.?|O\.?\s?S\.?|O\.?\s?C\.?|CONT['’]?D\.?|CONT\.?|CONTINUING|CONTINUED|PRE-?LAP|FILTERED|ON PHONE|INTO PHONE)\)$/i;
  const TITLE_PAGE_KEY_RE = /^(Title|Credit|Author|Authors|Source|Draft date|Contact|Copyright|Notes)\s*:\s*(.*)$/i;
  const PAREN_ONLY_RE = /^[([].*[)\]]$/;

  function normalizeRaw(raw) {
    return String(raw == null ? '' : raw)
      .replace(/^﻿/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/ /g, ' ')
      .replace(/\t/g, '    ')
      .trim();
  }

  function normalizeName(name) {
    return name
      .replace(/\s+/g, ' ')
      .replace(/[.:]+$/, '')
      .trim()
      .toUpperCase();
  }

  function wordCountOf(s) {
    const m = s.trim().match(/\S+/g);
    return m ? m.length : 0;
  }

  function isNameShaped(name, allowMixed) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > MAX_NAME_LEN) return false;
    if (wordCountOf(trimmed) > MAX_NAME_WORDS) return false;
    if (!/[A-Za-z]/.test(trimmed)) return false;
    return allowMixed ? MIXED_NAME_RE.test(trimmed) : CAPS_NAME_RE.test(trimmed);
  }

  function isCaps(s) {
    return /[A-Z]/.test(s) && !/[a-z]/.test(s);
  }

  function isDirectionWord(key) {
    return DIRECTION_WORD_RE.test(key) || TRANSITION_RE.test(key);
  }

  // Strips "(V.O.)"-style extensions. A delivery note such as "(whispering)" is
  // returned so it can be kept with the speech.
  function splitCueExtensions(name) {
    let rest = name.trim().replace(/\^$/, '').trim();
    const notes = [];
    let m;
    while ((m = rest.match(/\s*(\([^)]*\))\s*$/))) {
      if (!STANDARD_EXTENSION_RE.test(m[1])) notes.unshift(m[1]);
      rest = rest.slice(0, m.index).trim();
    }
    return { name: rest, notes };
  }

  function stripFountainMarkup(line) {
    return line.replace(/\[\[[\s\S]*?\]\]/g, '').replace(/\s+$/, '');
  }

  // ---- Pass 1: classify every physical line -------------------------------

  function tokenize(lines) {
    const tokens = [];
    let inBoneyard = false;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (inBoneyard) {
        const end = line.indexOf('*/');
        if (end === -1) continue;
        line = line.slice(end + 2);
        inBoneyard = false;
      }
      const start = line.indexOf('/*');
      if (start !== -1) {
        const end = line.indexOf('*/', start + 2);
        if (end === -1) {
          inBoneyard = true;
          line = line.slice(0, start);
        } else {
          line = line.slice(0, start) + line.slice(end + 2);
        }
      }
      line = stripFountainMarkup(line);
      const t = line.trim();
      if (!t) {
        tokens.push({ kind: 'blank' });
        continue;
      }
      tokens.push(classifyLine(t, lines, i));
    }
    return tokens;
  }

  function nextLineHasText(lines, i) {
    const next = lines[i + 1];
    return next != null && next.trim() !== '';
  }

  function classifyLine(t, lines, i) {
    if (t.startsWith('=')) return { kind: 'skip' }; // Fountain synopsis
    if (/^#+\s*\S/.test(t)) return { kind: 'scene', text: t.replace(/^#+\s*/, '') };
    if (t.startsWith('!')) return { kind: 'text', text: t.slice(1).trim(), forcedAction: true };
    if (/^>.*<$/.test(t)) return { kind: 'direction', text: t.slice(1, -1).trim() };
    if (t.startsWith('>')) return { kind: 'direction', text: t.slice(1).trim() };
    if (t.startsWith('~')) return { kind: 'text', text: t.slice(1).trim() };

    if (SCENE_RE.test(t)) return { kind: 'scene', text: t.replace(/^\./, '').trim() };
    if (isCaps(t) && TRANSITION_RE.test(t)) return { kind: 'direction', text: t };
    if (PAREN_ONLY_RE.test(t)) return { kind: 'paren', text: t };

    // Name alone on its line, with the speech starting on the next line.
    if (nextLineHasText(lines, i)) {
      const forced = t.startsWith('@');
      const body = forced ? t.slice(1) : t;
      const endsColon = /:$/.test(body);
      const { name, notes } = splitCueExtensions(body.replace(/:$/, '').replace(/\.$/, ''));
      if (forced && name) {
        return { kind: 'cue', style: 'block', name, notes, caps: isCaps(name), forced: true, raw: t };
      }
      if (isCaps(name) && isNameShaped(name, false)) {
        return { kind: 'cue', style: 'block', name, notes, caps: true, raw: t };
      }
      if (endsColon && isNameShaped(name, true)) {
        return { kind: 'cue', style: 'block', name, notes, caps: false, raw: t };
      }
    }

    let m = t.match(INLINE_COLON_RE);
    if (m && isNameShaped(m[2], true) && !/^https?$/i.test(m[2].trim())) {
      const note = m[3] && !STANDARD_EXTENSION_RE.test(m[3]) ? m[3] + ' ' : '';
      return {
        kind: 'inline', style: 'colon', name: m[2].trim(), caps: isCaps(m[2]),
        forced: m[1] === '@', text: note + m[4].trim(), raw: t
      };
    }

    m = t.match(INLINE_PERIOD_RE);
    if (m && isNameShaped(m[1], false)) {
      const note = m[2] && !STANDARD_EXTENSION_RE.test(m[2]) ? m[2] + ' ' : '';
      return { kind: 'inline', style: 'period', name: m[1].trim(), caps: true, text: note + m[3].trim(), raw: t };
    }

    return { kind: 'text', text: t };
  }

  // ---- Title page ------------------------------------------------------------

  function readTitlePage(lines) {
    let first = 0;
    while (first < lines.length && !lines[first].trim()) first++;
    if (first >= lines.length || !TITLE_PAGE_KEY_RE.test(lines[first].trim())) {
      return { title: '', bodyStart: 0 };
    }
    let title = '';
    let i = first;
    let currentKey = '';
    for (; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim()) break;
      const m = raw.trim().match(TITLE_PAGE_KEY_RE);
      if (m) {
        currentKey = m[1].toLowerCase();
        if (currentKey === 'title' && m[2].trim()) title = m[2].trim();
      } else if (currentKey === 'title' && !title) {
        title = raw.trim();
      }
    }
    return { title: title.replace(/[*_]/g, ''), bodyStart: i };
  }

  // ---- Pass 2: build items -----------------------------------------------------

  function parseScript(raw, options) {
    const opts = options || {};
    const text = normalizeRaw(raw);
    const allLines = text ? text.split('\n') : [];
    const titlePage = readTitlePage(allLines);
    const lines = allLines.slice(titlePage.bodyStart);
    const tokens = tokenize(lines);

    // How often each candidate name speaks, and how well each style is used.
    const counts = new Map();
    for (const tok of tokens) {
      if (tok.kind === 'cue' || tok.kind === 'inline') {
        const key = normalizeName(tok.name);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    const styleUse = { block: 0, colon: 0, period: 0 };
    for (const tok of tokens) {
      if ((tok.kind === 'cue' || tok.kind === 'inline') && counts.get(normalizeName(tok.name)) >= 2) {
        styleUse[tok.style]++;
      }
    }

    function accepted(tok) {
      const key = normalizeName(tok.name);
      if (!key || META_WORDS.has(key)) return false;
      if (tok.forced) return true;
      if (tok.caps && isDirectionWord(key)) return false;
      if (counts.get(key) >= 2) return true;
      // One-line speakers. "NAME: speech" in caps is unambiguous. A caps name
      // alone on a line needs the style to be clearly in use. Period style is
      // left out because caps stage directions ("LIGHTS UP. ...") look the same.
      if (tok.caps && tok.style === 'colon') return true;
      return tok.caps && tok.style === 'block' && styleUse.block >= ESTABLISHED_STYLE_MIN;
    }

    const items = [];
    const charOrder = [];
    const charStats = new Map();
    let speech = null; // the line item still taking continuation text
    let direction = null; // the direction item still taking text

    function pushItem(item) {
      item.index = items.length;
      items.push(item);
      return item;
    }

    function startSpeech(name, firstText) {
      const key = normalizeName(name);
      if (!charStats.has(key)) {
        charStats.set(key, { name: key, lines: 0, words: 0 });
        charOrder.push(key);
      }
      const stats = charStats.get(key);
      stats.lines++;
      const item = pushItem({ type: 'line', character: key, text: firstText || '', lineNo: stats.lines });
      speech = item;
      direction = null;
      return item;
    }

    function appendToSpeech(t) {
      speech.text = speech.text ? speech.text + '\n' + t : t;
    }

    function addDirection(t) {
      speech = null;
      if (direction) {
        direction.text += ' ' + t;
      } else {
        direction = pushItem({ type: 'direction', text: t });
      }
    }

    let blockSpeech = false; // in a block cue, everything up to a blank line is speech

    for (const tok of tokens) {
      switch (tok.kind) {
        case 'blank':
          speech = null;
          direction = null;
          blockSpeech = false;
          break;
        case 'skip':
          break;
        case 'scene':
          speech = null;
          direction = null;
          blockSpeech = false;
          pushItem({ type: 'scene', text: tok.text });
          break;
        case 'cue':
          if (blockSpeech && speech) {
            appendToSpeech(tok.raw);
          } else if (accepted(tok)) {
            startSpeech(tok.name, tok.notes.join(' '));
            blockSpeech = true;
          } else {
            addDirection(tok.raw);
          }
          break;
        case 'inline':
          if (blockSpeech && speech) {
            appendToSpeech(tok.raw);
          } else if (accepted(tok)) {
            startSpeech(tok.name, tok.text);
            blockSpeech = false;
          } else if (speech) {
            appendToSpeech(tok.raw);
          } else {
            addDirection(tok.raw);
          }
          break;
        case 'paren':
          // Inside a block cue a parenthetical is a delivery note. On its own
          // line after a "NAME: speech" line it is a stage direction.
          if (speech && blockSpeech) appendToSpeech(tok.text);
          else addDirection(tok.text);
          break;
        case 'direction':
          blockSpeech = false;
          addDirection(tok.text);
          direction = null;
          break;
        default: // text
          if (speech && !tok.forcedAction) appendToSpeech(tok.text);
          else addDirection(tok.text);
      }
    }

    // Drop speeches that never got any words (a cue followed only by a note).
    const cleaned = [];
    for (const item of items) {
      if (item.type === 'line' && !spokenText(item.text)) {
        if (item.text) cleaned.push({ type: 'direction', text: item.text });
        const stats = charStats.get(item.character);
        stats.lines--;
        continue;
      }
      cleaned.push(item);
    }
    cleaned.forEach((item, i) => { item.index = i; });

    // Recount per-character line numbers and words after cleanup.
    const perChar = new Map();
    for (const item of cleaned) {
      if (item.type !== 'line') continue;
      const n = (perChar.get(item.character) || 0) + 1;
      perChar.set(item.character, n);
      item.lineNo = n;
      charStats.get(item.character).words += wordCountOf(spokenText(item.text));
    }

    const characters = charOrder
      .map((k) => charStats.get(k))
      .filter((c) => c.lines > 0)
      .map((c) => ({ name: c.name, lines: c.lines, words: c.words }));

    return {
      title: titlePage.title || opts.fallbackTitle || '',
      items: cleaned,
      characters
    };
  }

  // ---- Helpers used by the app -------------------------------------------------

  function spokenText(text) {
    return String(text || '')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/[*_]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // How the actor sees their own line before they've said it.
  //   full   – the whole line
  //   first  – first letter of each word, punctuation kept ("T b, o n t b")
  //   hidden – nothing
  // Parenthetical delivery notes stay readable in "first" mode.
  function maskLine(text, mode) {
    const s = String(text || '');
    if (mode === 'full') return s;
    if (mode === 'hidden') return '';
    return s
      .split(/(\([^)]*\)|\[[^\]]*\])/)
      .map((seg, i) => (i % 2 ? seg : seg.replace(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu, (w) => w[0])))
      .join('');
  }

  // 32-bit FNV-1a, hex. Stable ids for scripts and lines across devices.
  function hashText(s) {
    let h = 0x811c9dc5;
    const str = String(s);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  function scriptIdFor(raw) {
    return 's' + hashText(normalizeRaw(raw));
  }

  function lineHash(item) {
    return hashText(item.character + '|' + spokenText(item.text).toLowerCase());
  }

  function sceneList(items) {
    const scenes = [];
    items.forEach((item) => {
      if (item.type === 'scene') scenes.push({ index: item.index, title: item.text });
    });
    return scenes;
  }

  // Last item index of the scene that contains startIndex.
  function sceneEnd(items, startIndex) {
    for (let i = startIndex + 1; i < items.length; i++) {
      if (items[i].type === 'scene') return i - 1;
    }
    return items.length - 1;
  }

  // Indices of the spoken lines in [startIndex, endIndex].
  function buildRun(items, startIndex, endIndex) {
    const start = Math.max(0, startIndex || 0);
    const end = endIndex == null ? items.length - 1 : Math.min(endIndex, items.length - 1);
    const run = [];
    for (let i = start; i <= end; i++) if (items[i] && items[i].type === 'line') run.push(i);
    return run;
  }

  // The previous spoken line, for showing a cue above a line being recorded.
  function cueFor(items, index) {
    for (let i = index - 1; i >= 0; i--) {
      if (items[i].type === 'line') return items[i];
      if (items[i].type === 'scene') return null;
    }
    return null;
  }

  function tailWords(text, n) {
    const words = spokenText(text).split(' ').filter(Boolean);
    if (words.length <= n) return words.join(' ');
    return '…' + words.slice(-n).join(' ');
  }

  // Match recordings exported from another device to this copy of the script.
  // Each entry carries the line's position, character and hash; the position is
  // tried first, then the first unused line with the same character and words.
  function matchImported(items, entries) {
    const used = new Set();
    const matches = [];
    const unmatched = [];
    const byHash = new Map();
    for (const item of items) {
      if (item.type !== 'line') continue;
      const h = lineHash(item);
      if (!byHash.has(h)) byHash.set(h, []);
      byHash.get(h).push(item.index);
    }
    for (const entry of entries) {
      const direct = items[entry.i];
      if (direct && direct.type === 'line' && !used.has(direct.index) &&
          direct.character === entry.character && lineHash(direct) === entry.lineHash) {
        used.add(direct.index);
        matches.push({ entry, index: direct.index });
        continue;
      }
      const candidates = (byHash.get(entry.lineHash) || []).filter((i) => !used.has(i));
      if (candidates.length) {
        used.add(candidates[0]);
        matches.push({ entry, index: candidates[0] });
      } else {
        unmatched.push(entry);
      }
    }
    return { matches, unmatched };
  }

  // Splits long text so speech engines don't cut off mid-speech (Chrome stops
  // long utterances after roughly 15 seconds).
  function chunkForSpeech(text, max) {
    const limit = max || 180;
    const clean = spokenText(text);
    if (!clean) return [];
    const sentences = clean.split(/(?<=[.!?;:])\s+/);
    const chunks = [];
    let cur = '';
    function flush() {
      if (cur) chunks.push(cur);
      cur = '';
    }
    for (const sentence of sentences) {
      if (sentence.length > limit) {
        flush();
        let rest = sentence;
        while (rest.length > limit) {
          let cut = rest.lastIndexOf(', ', limit);
          if (cut < limit / 3) cut = rest.lastIndexOf(' ', limit);
          if (cut <= 0) cut = limit;
          chunks.push(rest.slice(0, cut + (rest[cut] === ',' ? 1 : 0)).trim());
          rest = rest.slice(cut + 1).trim();
        }
        cur = rest;
      } else if ((cur + ' ' + sentence).trim().length > limit) {
        flush();
        cur = sentence;
      } else {
        cur = (cur + ' ' + sentence).trim();
      }
    }
    flush();
    return chunks;
  }

  // Gives each character a voice and pitch, spreading them across the voices
  // the device has so two characters rarely sound the same.
  function assignVoices(names, voices, lang) {
    const want = (lang || 'en').toLowerCase();
    const list = (voices || []).filter((v) => String(v.lang || '').toLowerCase().startsWith(want));
    const pool = list.length ? list : voices || [];
    const sorted = pool.slice().sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0));
    const pitches = [1, 0.85, 1.15, 0.95, 1.08];
    const out = {};
    names.forEach((name, i) => {
      const voice = sorted.length ? sorted[i % sorted.length] : null;
      const round = sorted.length ? Math.floor(i / sorted.length) : i;
      out[name] = {
        voiceURI: voice ? voice.voiceURI : null,
        pitch: pitches[(round + (sorted.length ? 0 : i)) % pitches.length]
      };
    });
    return out;
  }

  function formatDuration(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  function slugify(s) {
    return String(s || 'script')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'script';
  }

  return {
    normalizeRaw,
    parseScript,
    spokenText,
    maskLine,
    hashText,
    scriptIdFor,
    lineHash,
    sceneList,
    sceneEnd,
    buildRun,
    cueFor,
    tailWords,
    matchImported,
    chunkForSpeech,
    assignVoices,
    formatDuration,
    slugify
  };
});
