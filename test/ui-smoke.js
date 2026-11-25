// UI smoke test (npm run test:ui): loads index.html in jsdom with stubbed speech, audio and mic,
// then walks through sample -> pick part -> rehearse -> record -> share -> import.
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
require('fake-indexeddb/auto');

const APP = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;

const log = [];
const spoken = [];
const played = [];
const objectUrls = new Map();

w.indexedDB = globalThis.indexedDB;
w.IDBKeyRange = globalThis.IDBKeyRange;
w.Blob = globalThis.Blob;
w.File = globalThis.File;
w.scrollTo = () => {};
w.Element.prototype.scrollIntoView = function () {};
w.URL.createObjectURL = (b) => { const u = 'blob:' + objectUrls.size; objectUrls.set(u, b); return u; };
w.URL.revokeObjectURL = () => {};
w.HTMLAnchorElement.prototype.click = function () { log.push('download ' + this.download); };

class Utterance { constructor(text) { this.text = text; } }
w.SpeechSynthesisUtterance = Utterance;
w.speechSynthesis = {
  getVoices: () => [{ voiceURI: 'v1', lang: 'en-US', default: true }, { voiceURI: 'v2', lang: 'en-GB' }],
  speak(u) { if (u.text.trim()) spoken.push((u.voice ? u.voice.voiceURI : '-') + '|' + u.text); setTimeout(() => u.onend && u.onend(), 2); },
  cancel() {}, addEventListener() {}, removeEventListener() {}
};
w.Audio = class {
  constructor(src) { this.src = src; }
  play() { played.push(this.src); setTimeout(() => this.onended && this.onended(), 2); return Promise.resolve(); }
  pause() {}
};
class FakeRecorder {
  constructor(stream, opts) { this.state = 'inactive'; this.mimeType = (opts && opts.mimeType) || 'audio/webm'; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    if (this.ondataavailable) this.ondataavailable({ data: new Blob(['fake-audio-' + Math.random()], { type: 'audio/webm' }) });
    setTimeout(() => this.onstop && this.onstop(), 1);
  }
  static isTypeSupported(t) { return t === 'audio/webm'; }
}
w.MediaRecorder = FakeRecorder;
Object.defineProperty(w.navigator, 'mediaDevices', {
  value: { getUserMedia: async () => ({ active: true, getTracks: () => [{ stop() {} }] }) }
});
w.console.error = (...a) => log.push('console.error ' + a.join(' '));

for (const f of ['core.js', 'sample.js', 'store.js', 'audio.js', 'app.js']) {
  w.eval(fs.readFileSync(path.join(APP, 'js', f), 'utf8'));
}

const $ = (id) => w.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(5); }
  throw new Error('Timed out waiting for ' + what + '\nlog: ' + log.join('\n'));
}
function visible(id) { return !$(id).hidden; }
function click(el) { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); }
function check(cond, msg) { if (!cond) throw new Error('FAILED: ' + msg); console.log('ok - ' + msg); }

(async () => {
  await until(() => visible('view-library'), 'library');
  check($('script-list').children.length === 0, 'library starts empty');

  click($('btn-sample'));
  await until(() => visible('view-script'), 'script page');
  check($('page-title').textContent === 'The Callback', 'sample opens with its title');
  const chips = [...$('char-picker').querySelectorAll('.chip-name')].map((c) => c.textContent);
  check(JSON.stringify(chips) === JSON.stringify(['MAYA', 'THEO', 'MS. OKAFOR']), 'character picker lists MAYA, THEO, MS. OKAFOR');

  click($('char-picker').querySelector('.chip'));
  check($('char-picker').querySelector('.chip').getAttribute('aria-pressed') === 'true', 'tapping MAYA selects her');
  check(/playing MAYA/.test($('picker-hint').textContent), 'hint says you are playing MAYA');

  // Rehearse the whole scene with first-letter hints.
  click($('btn-rehearse'));
  await until(() => visible('view-rehearse'), 'rehearse view');
  check($('run-next').textContent === 'Start', 'run waits for Start');
  const firstMine = $('run-script').querySelector('.run-line.mine .say');
  check(firstMine.textContent === 'O. R B. J t o p.', 'MAYA’s first line shows first letters: ' + firstMine.textContent);

  click($('run-next')); // Start
  await until(() => /Your line/.test($('run-status').textContent), 'first MAYA line');
  check($('run-next').textContent === 'Next', 'Next button during your line');
  click($('run-reveal'));
  check(firstMine.textContent === 'Okay. Read Benedick. Just the one page.', 'Reveal shows the full line');

  click($('run-next')); // done with MAYA line 1 -> THEO speaks
  await until(() => spoken.some((s) => s.includes('I read Benedick yesterday')), 'THEO line spoken');
  await until(() => /Your line/.test($('run-status').textContent), 'second MAYA line');
  check(spoken.length >= 1, 'THEO’s line was read by the device voice');

  // Walk to the end.
  for (let guard = 0; guard < 1000 && $('run-done').hidden; guard++) {
    if (/Your line/.test($('run-status').textContent)) click($('run-next'));
    await sleep(20);
  }
  await until(() => !$('run-done').hidden, 'run end');
  const spokenText = spoken.join('\n');
  check(!/You're supposed to mean it/.test(spokenText), 'MAYA’s own lines are never spoken');
  check(/Building closes in ten minutes/.test(spokenText), 'MS. OKAFOR’s lines are spoken');
  check(!/sighing/.test(spokenText), 'delivery notes are not read aloud');
  const voiceOf = (who) => spoken.find((s) => s.includes(who)).split('|')[0];
  check(voiceOf('I read Benedick') !== voiceOf('Building closes'), 'THEO and MS. OKAFOR get different voices');
  check($('run-playback').hidden, 'no playback offered when not recording');

  // Back to the script, record THEO's lines.
  click($('run-exit'));
  await until(() => visible('view-script'), 'script page again');
  click($('btn-record'));
  await until(() => visible('view-record'), 'record view');
  check($('rec-character').value === 'MAYA', 'record view defaults to your part');
  $('rec-character').value = 'THEO';
  $('rec-character').dispatchEvent(new w.Event('change'));
  await sleep(10);
  const rows = $('rec-lines').querySelectorAll('.rec-line');
  check(rows.length === 7, 'THEO has 7 lines to record');
  check(/0 of 7/.test($('rec-progress').textContent), 'progress starts at 0 of 7');
  click(rows[0].querySelector('.rec-btn'));
  await until(() => $('rec-lines').querySelector('.rec-line.recording'), 'recording state');
  click($('rec-lines').querySelector('.rec-line.recording .rec-btn'));
  await until(() => $('rec-lines').querySelector('.rec-line.has-rec'), 'saved recording');
  check(/1 of 7/.test($('rec-progress').textContent), 'progress shows 1 of 7');

  // Record a second line by tapping Record on another row while recording.
  const rowsNow = $('rec-lines').querySelectorAll('.rec-line');
  click(rowsNow[1].querySelector('.rec-btn'));
  await until(() => $('rec-lines').querySelector('.rec-line.recording'), 'second recording');
  click($('rec-lines').querySelectorAll('.rec-line')[2].querySelector('.rec-btn'));
  await until(() => $('rec-lines').querySelectorAll('.rec-line.has-rec').length === 2, 'second saved on switch');
  click($('rec-lines').querySelector('.rec-line.recording .rec-btn'));
  await until(() => $('rec-lines').querySelectorAll('.rec-line.has-rec').length === 3, 'third saved');

  // Rehearse again: THEO's recorded lines play as audio, not speech.
  click($('nav-back'));
  await until(() => visible('view-script'), 'script page after record');
  check(/3 of 7 recorded/.test($('rec-summary').textContent), 'summary shows THEO 3 of 7 recorded');
  $('opt-record-me').checked = true;
  $('opt-record-me').dispatchEvent(new w.Event('change'));
  spoken.length = 0;
  played.length = 0;
  click($('btn-rehearse'));
  await until(() => visible('view-rehearse'), 'rehearse view 2');
  await sleep(10);
  click($('run-next'));
  for (let guard = 0; guard < 1000 && $('run-done').hidden; guard++) {
    if (/Your line/.test($('run-status').textContent) && !$('run-next').disabled) click($('run-next'));
    await sleep(15);
  }
  await until(() => !$('run-done').hidden, 'run 2 end');
  check(played.length === 3, 'THEO’s 3 recorded lines played as audio (' + played.length + ')');
  check(!spoken.some((s) => s.includes('I read Benedick yesterday')), 'recorded line not also spoken');
  check(!$('run-playback').hidden, 'playback offered after recording yourself');
  played.length = 0;
  click($('run-playback'));
  await until(() => played.length === 9 + 3 && !$('run-done').hidden, 'playback of takes and recordings', 15000);
  await until(() => !$('run-done').hidden, 'playback end', 15000);
  check(true, 'playback ran through your takes and the recorded lines');

  // Share recordings, then import them into a second copy of the script.
  click($('run-exit'));
  await until(() => visible('view-script'), 'script page 3');
  click($('btn-export'));
  await until(() => log.some((l) => l.startsWith('download ')), 'export download');
  const exported = [...objectUrls.values()].find((b) => b.name && b.name.endsWith('recordings.json'));
  const payload = JSON.parse(await exported.text());
  check(payload.recordings.length === 3 && payload.recordings.every((r) => r.character === 'THEO'),
    'export holds THEO’s 3 recordings (' + exported.name + ')');

  // Second copy of the script with an extra note at the top (different id).
  const altered = '(Rehearsal copy)\n\n' + w.RehearsalSample.text.replace(/^Title:.*\nAuthor:.*\n/, '');
  w.location.hash = '#/new';
  await until(() => visible('view-new'), 'new view');
  $('new-text').value = altered;
  $('new-title').value = 'Callback copy';
  $('new-text').dispatchEvent(new w.Event('input'));
  await until(() => !$('btn-save-script').disabled, 'preview parsed');
  check(/3 characters/.test($('new-preview').textContent), 'preview finds 3 characters');
  click($('btn-save-script'));
  await until(() => visible('view-script') && $('page-title').textContent === 'Callback copy', 'copy saved');
  const input = $('import-file');
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([JSON.stringify(payload)], 'x.json')] });
  input.dispatchEvent(new w.Event('change'));
  await until(() => /Added/.test($('share-status').textContent), 'import status');
  check(/Added 3 recordings for THEO/.test($('share-status').textContent), 'import matched all 3 lines: ' + $('share-status').textContent);
  check(/3 of 7 recorded/.test($('rec-summary').textContent), 'copy now has THEO 3 of 7 recorded');

  // Library lists both scripts.
  w.location.hash = '#/';
  await until(() => visible('view-library') && $('script-list').children.length === 2, 'library with two scripts');
  check(true, 'library lists both scripts');

  const errors = log.filter((l) => l.startsWith('console.error'));
  check(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join('\n') : ''));
  console.log('\nALL UI CHECKS PASSED');
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
