/*
 * Script Rehearsal UI. Hash routes:
 *   #/                 your scripts
 *   #/new              add a script
 *   #/script/<id>      pick your part and settings
 *   #/rehearse/<id>    run lines
 *   #/record/<id>      record lines for a character
 */
(function () {
  'use strict';
  const Core = window.RehearsalCore;
  const Store = window.RehearsalStore;
  const A = window.RehearsalAudio;

  const $ = (id) => document.getElementById(id);

  function h(tag, props) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (let i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) kid.forEach((k) => append(node, k));
    else node.append(kid.nodeType ? kid : String(kid));
  }

  const VIEWS = ['library', 'new', 'script', 'rehearse', 'record'];

  const state = {
    script: null, // { id, title, raw, createdAt, characters, lineCount }
    parsed: null, // { title, items, characters }
    prefs: null,
    recordings: new Map(), // line index -> recording
    voices: {}, // character -> { voiceURI, pitch }
    pendingRun: null
  };

  // ---- Shell -------------------------------------------------------------------

  function showView(name, title, backTo) {
    for (const v of VIEWS) $('view-' + v).hidden = v !== name;
    $('page-title').textContent = title;
    document.title = name === 'library' ? 'Script Rehearsal' : title + ' · Script Rehearsal';
    const back = $('nav-back');
    back.hidden = backTo == null;
    back.dataset.target = backTo == null ? '' : backTo;
    document.body.dataset.view = name;
    window.scrollTo(0, 0);
  }

  let toastTimer = null;
  function toast(message, isError) {
    const t = $('toast');
    t.textContent = message;
    t.classList.toggle('error', !!isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 7000 : 3500);
  }
  function showError(e) {
    console.error(e);
    toast(e && e.message ? e.message : String(e), true);
  }

  function go(path) {
    const target = '#/' + path;
    if (location.hash === target) route();
    else location.hash = target;
  }

  async function route() {
    leaveRehearse();
    leaveRecord();
    const [page, rawId] = location.hash.replace(/^#\/?/, '').split('/');
    const id = rawId ? decodeURIComponent(rawId) : '';
    try {
      if (page === 'new') return showNew();
      if ((page === 'script' || page === 'rehearse' || page === 'record') && id) {
        if (!(await loadScript(id))) {
          toast('That script isn’t on this device.', true);
          return go('');
        }
        if (page === 'record') return showRecord();
        // A run has to start from a tap, so a reload of a run goes to the script page.
        if (page === 'rehearse' && state.pendingRun) return showRehearse();
        if (page === 'rehearse') return go('script/' + encodeURIComponent(id));
        return showScript();
      }
      return showLibrary();
    } catch (e) {
      showError(e);
    }
  }

  async function loadScript(id) {
    if (state.script && state.script.id === id) return true;
    const script = await Store.getScript(id);
    if (!script) return false;
    state.script = script;
    state.parsed = Core.parseScript(script.raw, { fallbackTitle: script.title });
    state.prefs = Store.loadPrefs(id);
    const names = state.parsed.characters.map((c) => c.name);
    state.prefs.mine = state.prefs.mine.filter((n) => names.includes(n));
    state.recordings = await Store.recordingsFor(id);
    script.openedAt = Date.now();
    Store.saveScript(script).catch(() => {});
    return true;
  }

  function savePrefs() {
    Store.savePrefs(state.script.id, state.prefs);
  }

  function isMine(item) {
    return state.prefs.mine.includes(item.character);
  }

  // ---- Library -------------------------------------------------------------------

  async function showLibrary() {
    showView('library', 'Script Rehearsal', null);
    const scripts = await Store.listScripts();
    $('library-heading').hidden = !scripts.length;
    $('script-list').replaceChildren(
      ...scripts.map((s) =>
        h('li', null,
          h('button', { class: 'card', type: 'button', onclick: () => go('script/' + encodeURIComponent(s.id)) },
            h('strong', { text: s.title }),
            h('span', {
              class: 'meta',
              text: (s.characters || []).length + ' characters · ' + (s.lineCount || 0) + ' lines'
            })
          )
        )
      )
    );
  }

  async function saveScript(raw, title) {
    const parsed = Core.parseScript(raw);
    const id = Core.scriptIdFor(raw);
    const existing = await Store.getScript(id);
    const script = existing || { id, raw: Core.normalizeRaw(raw), createdAt: Date.now() };
    script.title = title || existing && existing.title || parsed.title || 'Untitled script';
    script.characters = parsed.characters.map((c) => c.name);
    script.lineCount = parsed.items.filter((i) => i.type === 'line').length;
    await Store.saveScript(script);
    state.script = null; // reload on open
    return script;
  }

  // ---- Add a script -----------------------------------------------------------------

  function showNew() {
    showView('new', 'Add a script', '');
    $('new-title').value = '';
    $('new-title').placeholder = 'Title';
    $('new-text').value = '';
    $('new-file').value = '';
    updatePreview();
  }

  let previewTimer = null;
  function updatePreview() {
    const raw = $('new-text').value;
    const box = $('new-preview');
    const save = $('btn-save-script');
    if (!raw.trim()) {
      box.replaceChildren();
      save.disabled = true;
      return;
    }
    const p = Core.parseScript(raw);
    if (p.title) $('new-title').placeholder = p.title;
    if (!p.characters.length) {
      box.replaceChildren(h('p', {
        class: 'status error',
        text: 'No characters found yet. Put each speaker’s name in capitals, either on its own line above the speech or before a colon, like ROMEO: But soft…'
      }));
      save.disabled = true;
      return;
    }
    const lineCount = p.items.filter((i) => i.type === 'line').length;
    const scenes = Core.sceneList(p.items).length;
    const firstLines = p.items.filter((i) => i.type === 'line').slice(0, 3);
    box.replaceChildren(
      h('p', null, 'Found ', h('strong', { text: p.characters.length + ' characters' }),
        ' and ' + lineCount + ' lines' + (scenes ? ' in ' + scenes + ' scenes' : '') + '.'),
      h('ul', { class: 'chips static' }, p.characters.map((c) => h('li', { class: 'chip', text: c.name + ' · ' + c.lines }))),
      h('p', { class: 'fine', text: 'First lines, to check it read the script right:' }),
      h('ul', { class: 'mini-script' }, firstLines.map((l) =>
        h('li', null, h('span', { class: 'who', text: l.character }), ' ' + Core.tailWords(l.text, 14).replace(/^…/, '')))),
      p.characters.length > 12
        ? h('p', { class: 'status', text: 'That’s a lot of characters. If some are really stage directions, put directions in parentheses or on their own lines.' })
        : null
    );
    save.disabled = false;
  }

  async function onFileChosen() {
    const file = $('new-file').files[0];
    if (!file) return;
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
      toast('PDFs aren’t supported yet. Copy the text out of the PDF and paste it here.', true);
      return;
    }
    $('new-text').value = await file.text();
    if (!$('new-title').value) $('new-title').value = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    updatePreview();
  }

  async function onSaveNew() {
    const raw = $('new-text').value;
    if (!Core.parseScript(raw).characters.length) return;
    const script = await saveScript(raw, $('new-title').value.trim());
    go('script/' + encodeURIComponent(script.id));
  }

  async function onSample() {
    const script = await saveScript(window.RehearsalSample.text, '');
    go('script/' + encodeURIComponent(script.id));
  }

  // ---- Script page ----------------------------------------------------------------------

  function showScript() {
    showView('script', state.script.title, '');
    renderCharPicker();
    renderOptions();
    renderRecSummary();
    $('share-status').textContent = '';
    $('voice-note').hidden = A.hasSpeech();
    const del = $('btn-delete');
    del.textContent = 'Delete script and its recordings';
    delete del.dataset.armed;
  }

  function renderCharPicker() {
    const { characters } = state.parsed;
    $('char-picker').replaceChildren(
      ...characters.map((c) => {
        const on = state.prefs.mine.includes(c.name);
        return h('button', {
          type: 'button',
          class: 'chip toggle' + (on ? ' on' : ''),
          'aria-pressed': on ? 'true' : 'false',
          onclick: () => {
            const mine = new Set(state.prefs.mine);
            if (mine.has(c.name)) mine.delete(c.name);
            else mine.add(c.name);
            state.prefs.mine = characters.map((x) => x.name).filter((n) => mine.has(n));
            savePrefs();
            renderCharPicker();
            renderRecSummary();
          }
        }, h('span', { class: 'chip-name', text: c.name }), h('span', { class: 'chip-count', text: c.lines + (c.lines === 1 ? ' line' : ' lines') }));
      })
    );
    const mine = state.prefs.mine;
    $('picker-hint').textContent = mine.length
      ? 'You’re playing ' + mine.join(' and ') + '. Everyone else is read aloud.'
      : 'Pick one or more parts. With none picked, Rehearse just plays the scene.';
  }

  function renderOptions() {
    const { items } = state.parsed;
    const scenes = Core.sceneList(items);
    const start = $('opt-start');
    start.replaceChildren(
      h('option', { value: '0', text: 'The beginning' }),
      ...scenes.filter((s) => s.index > 0).map((s) => h('option', { value: String(s.index), text: s.title }))
    );
    if (scenes.length && scenes[0].index === 0) start.options[0].textContent = scenes[0].title;
    const valid = [...start.options].some((o) => Number(o.value) === state.prefs.startIndex);
    if (!valid) state.prefs.startIndex = 0;
    start.value = String(state.prefs.startIndex);
    $('opt-start-wrap').hidden = start.options.length < 2;
    $('opt-scene-only-wrap').hidden = scenes.length < 2;
    $('opt-scene-only').checked = !!state.prefs.sceneOnly;
    $('opt-hint').value = state.prefs.hint;
    $('opt-pickup').value = String(state.prefs.pickup);
    $('opt-rate').value = String(state.prefs.rate);
    $('opt-rate-out').textContent = Number(state.prefs.rate).toFixed(2) + '×';
    $('opt-record-me').checked = !!state.prefs.recordMe;
    $('opt-record-me-wrap').hidden = !A.canRecord();
  }

  function bindOptions() {
    $('opt-start').addEventListener('change', (e) => { state.prefs.startIndex = Number(e.target.value); savePrefs(); });
    $('opt-scene-only').addEventListener('change', (e) => { state.prefs.sceneOnly = e.target.checked; savePrefs(); });
    $('opt-hint').addEventListener('change', (e) => { state.prefs.hint = e.target.value; savePrefs(); });
    $('opt-pickup').addEventListener('change', (e) => { state.prefs.pickup = Number(e.target.value); savePrefs(); });
    $('opt-rate').addEventListener('input', (e) => {
      state.prefs.rate = Number(e.target.value);
      $('opt-rate-out').textContent = state.prefs.rate.toFixed(2) + '×';
      savePrefs();
    });
    $('opt-record-me').addEventListener('change', (e) => { state.prefs.recordMe = e.target.checked; savePrefs(); });
  }

  function renderRecSummary() {
    const { characters, items } = state.parsed;
    const counts = new Map();
    for (const [index] of state.recordings) {
      const item = items[index];
      if (item && item.type === 'line') counts.set(item.character, (counts.get(item.character) || 0) + 1);
    }
    $('rec-summary').replaceChildren(
      ...characters.map((c) => {
        const n = counts.get(c.name) || 0;
        const label = n === 0 ? 'device voice' : n === c.lines ? 'all ' + n + ' recorded' : n + ' of ' + c.lines + ' recorded';
        return h('li', { class: n === c.lines ? 'done' : n ? 'partial' : '' },
          h('span', { class: 'who', text: c.name }), h('span', { class: 'meta', text: label }));
      })
    );
    const mineRecorded = state.prefs.mine.some((m) => counts.get(m));
    $('btn-export').textContent = mineRecorded
      ? 'Share my recordings (' + state.prefs.mine.filter((m) => counts.get(m)).join(', ') + ')'
      : 'Share recordings';
    $('btn-export').disabled = state.recordings.size === 0;
  }

  async function onDelete() {
    const btn = $('btn-delete');
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = 'Tap again to delete';
      setTimeout(() => {
        if (btn.dataset.armed) {
          delete btn.dataset.armed;
          btn.textContent = 'Delete script and its recordings';
        }
      }, 4000);
      return;
    }
    await Store.deleteScript(state.script.id);
    state.script = null;
    toast('Script deleted.');
    go('');
  }

  // ---- Sharing recordings between cast members -------------------------------------------

  async function onExport() {
    const status = $('share-status');
    const { items } = state.parsed;
    const all = [...state.recordings.values()].filter((r) => items[r.index] && items[r.index].type === 'line');
    let chosen = all.filter((r) => state.prefs.mine.includes(items[r.index].character));
    if (!chosen.length) chosen = all;
    if (!chosen.length) {
      status.textContent = 'Nothing recorded yet.';
      return;
    }
    const who = [...new Set(chosen.map((r) => items[r.index].character))];
    const payload = {
      app: 'script-rehearsal',
      version: 1,
      scriptId: state.script.id,
      title: state.script.title,
      exportedAt: new Date().toISOString(),
      recordings: await Promise.all(chosen.map(async (r) => ({
        i: r.index,
        character: items[r.index].character,
        lineHash: Core.lineHash(items[r.index]),
        mime: r.mime,
        duration: r.duration,
        data: await A.blobToBase64(r.blob)
      })))
    };
    const name = Core.slugify(state.script.title) + '-' + Core.slugify(who.length > 2 ? 'cast' : who.join('-')) + '-recordings.json';
    const file = new File([JSON.stringify(payload)], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: state.script.title + ' recordings' });
        status.textContent = 'Shared ' + chosen.length + ' recordings for ' + who.join(', ') + '.';
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        // Fall through to a download.
      }
    }
    const url = URL.createObjectURL(file);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    status.textContent = 'Saved ' + name + ' (' + chosen.length + ' recordings). Send it to your castmates; they add it with “Add castmates’ recordings”.';
  }

  async function onImport() {
    const input = $('import-file');
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    const status = $('share-status');
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      status.textContent = 'That file isn’t a recordings file from this app.';
      return;
    }
    if (!data || data.app !== 'script-rehearsal' || !Array.isArray(data.recordings)) {
      status.textContent = 'That file isn’t a recordings file from this app.';
      return;
    }
    const { items } = state.parsed;
    const { matches, unmatched } = Core.matchImported(items, data.recordings);
    const toSave = [];
    let keptMine = 0;
    for (const { entry, index } of matches) {
      const item = items[index];
      // Don't replace your own recordings of your own part.
      if (isMine(item) && state.recordings.has(index)) {
        keptMine++;
        continue;
      }
      toSave.push({
        scriptId: state.script.id,
        index,
        character: item.character,
        lineHash: Core.lineHash(item),
        mime: entry.mime,
        duration: entry.duration,
        blob: A.base64ToBlob(entry.data, entry.mime),
        from: 'import'
      });
    }
    await Store.putRecordings(toSave);
    state.recordings = await Store.recordingsFor(state.script.id);
    renderRecSummary();
    const who = [...new Set(toSave.map((r) => r.character))];
    const parts = [];
    parts.push(toSave.length ? 'Added ' + toSave.length + ' recordings for ' + who.join(', ') + '.' : 'No new recordings added.');
    if (keptMine) parts.push('Kept your own recordings for ' + keptMine + ' of your lines.');
    if (unmatched.length) parts.push(unmatched.length + ' didn’t match a line in this copy of the script.');
    status.textContent = parts.join(' ');
  }

  // ---- Playing one line -----------------------------------------------------------------------

  function playLine(item) {
    const rec = state.recordings.get(item.index);
    if (rec && rec.blob) return A.playBlob(rec.blob);
    const voice = state.voices[item.character] || {};
    return A.speak(item.text, { voiceURI: voice.voiceURI, pitch: voice.pitch, rate: Number(state.prefs.rate) || 1 });
  }

  async function prepareVoices() {
    const voices = await A.getVoices();
    state.voices = Core.assignVoices(
      state.parsed.characters.map((c) => c.name),
      voices.map((v) => ({ voiceURI: v.voiceURI, lang: v.lang, default: v.default }))
    );
  }

  // iOS only lets a page make sound after a tap; prime both outputs inside one.
  function unlockAudio() {
    try {
      if (window.speechSynthesis && window.SpeechSynthesisUtterance) {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        window.speechSynthesis.speak(u);
      }
    } catch (e) { /* not fatal */ }
  }

  // ---- Rehearse ------------------------------------------------------------------------------------

  const run = {
    active: false,
    indices: [],
    pos: 0,
    token: 0,
    phase: 'idle', // ready | mine | other | done
    mode: 'rehearse', // rehearse | playback
    takes: new Map(), // line index -> { blob, duration } recorded during this run
    revealed: new Set(),
    recorder: null,
    recStarting: null,
    recordMe: false,
    els: new Map(),
    current: null,
    busy: false,
    wakeLock: null,
    range: [0, 0]
  };

  function onRehearse() {
    unlockAudio();
    const { items } = state.parsed;
    const start = state.prefs.startIndex || 0;
    const end = state.prefs.sceneOnly && start > 0 && items[start] && items[start].type === 'scene'
      ? Core.sceneEnd(items, start)
      : items.length - 1;
    const indices = Core.buildRun(items, start, end);
    if (!indices.length) {
      toast('There are no lines in that part of the script.', true);
      return;
    }
    state.pendingRun = { start, end, indices };
    go('rehearse/' + encodeURIComponent(state.script.id));
  }

  async function showRehearse() {
    const pending = state.pendingRun;
    state.pendingRun = null;
    const { items } = state.parsed;
    const scene = Core.sceneList(items).filter((s) => s.index <= pending.start).pop();
    showView('rehearse', scene ? scene.title : state.script.title, 'script/' + encodeURIComponent(state.script.id));

    Object.assign(run, {
      active: true, indices: pending.indices, pos: 0, phase: 'ready', mode: 'rehearse',
      takes: new Map(), revealed: new Set(), els: new Map(), current: null, busy: false,
      range: [pending.start, pending.end], recordMe: !!state.prefs.recordMe && A.canRecord()
    });
    run.token++;
    renderRunScript();
    $('run-done').hidden = true;
    setRunButtons();
    const first = items[run.indices[0]];
    setStatus(isMine(first) ? 'You start. Tap Start, then say your line.' : 'Tap Start when you’re ready.', '');
    highlight(run.indices[0], false);

    requestWakeLock();
    prepareVoices().catch(() => {});
    if (run.recordMe) {
      run.recorder = new A.Recorder();
      try {
        await run.recorder.ensureStream();
      } catch (e) {
        run.recordMe = false;
        setStatus(e.message + ' Rehearsing without recording.', 'warn');
      }
    }
  }

  function renderRunScript() {
    const { items } = state.parsed;
    const box = $('run-script');
    const nodes = [];
    run.els = new Map();
    for (let i = run.range[0]; i <= run.range[1]; i++) {
      const item = items[i];
      if (item.type === 'scene') nodes.push(h('h3', { class: 'run-scene', text: item.text }));
      else if (item.type === 'direction') nodes.push(h('p', { class: 'run-direction', text: item.text }));
      else {
        const say = h('div', { class: 'say' });
        const row = h('div', { class: 'run-line' + (isMine(item) ? ' mine' : ''), dataset: { index: String(i) } },
          h('div', { class: 'who', text: item.character }), say);
        row.addEventListener('click', () => onLineTap(i));
        run.els.set(i, { row, say });
        nodes.push(row);
        setLineText(i);
      }
    }
    box.replaceChildren(...nodes);
  }

  function setLineText(index) {
    const item = state.parsed.items[index];
    const el = run.els.get(index);
    if (!el) return;
    const show = !isMine(item) || run.mode === 'playback' || run.revealed.has(index) || state.prefs.hint === 'full';
    const text = show ? item.text : Core.maskLine(item.text, state.prefs.hint);
    el.say.textContent = text;
    el.row.classList.toggle('masked', !show);
    el.row.classList.toggle('hidden-line', !show && state.prefs.hint === 'hidden');
  }

  function highlight(index, scroll) {
    if (run.current != null && run.els.get(run.current)) run.els.get(run.current).row.classList.remove('current');
    run.current = index;
    const el = run.els.get(index);
    if (!el) return;
    el.row.classList.add('current');
    for (const [i, e] of run.els) e.row.classList.toggle('past', i < index);
    if (scroll !== false) el.row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function setStatus(text, kind) {
    const s = $('run-status');
    s.textContent = text;
    s.className = 'run-status' + (kind ? ' ' + kind : '');
  }

  function setRunButtons() {
    const next = $('run-next');
    const reveal = $('run-reveal');
    const back = $('run-back');
    if (run.phase === 'ready') next.textContent = 'Start';
    else if (run.phase === 'mine') next.textContent = 'Next';
    else if (run.phase === 'other') next.textContent = 'Skip';
    else next.textContent = 'Next';
    next.disabled = run.phase === 'done';
    reveal.disabled = run.phase !== 'mine' || run.revealed.has(run.indices[run.pos]) || state.prefs.hint === 'full';
    back.disabled = run.phase === 'ready' || run.pos === 0;
  }

  async function stepRun() {
    const token = ++run.token;
    run.recStarting = null;
    if (run.pos >= run.indices.length) return finishRun();
    const { items } = state.parsed;
    const index = run.indices[run.pos];
    const item = items[index];
    highlight(index);

    if (run.mode === 'rehearse' && isMine(item)) {
      run.phase = 'mine';
      setRunButtons();
      setStatus('Your line', 'mine');
      if (run.recordMe && run.recorder) {
        try {
          run.recStarting = run.recorder.start();
          await run.recStarting;
          if (token !== run.token) {
            run.recorder.cancel();
            return;
          }
          setStatus('Your line · recording', 'mine rec');
        } catch (e) {
          run.recordMe = false;
          setStatus('Your line. ' + e.message, 'mine warn');
        }
      }
      return; // waits for Next
    }

    run.phase = 'other';
    setRunButtons();
    const playbackOfMine = run.mode === 'playback' && isMine(item);
    const take = playbackOfMine ? run.takes.get(index) : null;
    if (playbackOfMine) setStatus(take ? 'You' : 'You (not recorded)', 'mine');
    else setStatus(item.character + (state.recordings.has(index) ? '' : ' · device voice'), 'other');

    const prev = run.pos > 0 ? items[run.indices[run.pos - 1]] : null;
    const afterMine = run.mode === 'rehearse' && prev && isMine(prev);
    const gap = afterMine ? Number(state.prefs.pickup) || 0 : 250;
    if (gap > 0) {
      await A.wait(gap);
      if (token !== run.token) return;
    }
    if (playbackOfMine) {
      if (take) await A.playBlob(take.blob);
      else await A.wait(700);
    } else {
      await playLine(item);
    }
    if (token !== run.token) return;
    run.pos++;
    stepRun();
  }

  async function onNext() {
    if (!run.active || run.busy) return;
    if (run.phase === 'ready') {
      unlockAudio();
      return stepRun();
    }
    if (run.phase === 'mine') {
      const index = run.indices[run.pos];
      run.revealed.add(index);
      setLineText(index);
      const token = run.token;
      if (run.recStarting) {
        // A quick tap can land while the mic is still starting; finish the take anyway.
        run.busy = true;
        try { await run.recStarting; } catch (e) { /* reported by stepRun */ }
        run.busy = false;
        if (token !== run.token) return;
      }
      if (run.recorder && run.recorder.recording) {
        run.busy = true;
        try {
          const take = await run.recorder.stop();
          if (take) run.takes.set(index, take);
        } finally {
          run.busy = false;
        }
        if (token !== run.token) return;
      }
      run.pos++;
      return stepRun();
    }
    if (run.phase === 'other') {
      run.token++;
      A.stop();
      run.pos++;
      return stepRun();
    }
  }

  function onBack() {
    if (!run.active || run.phase === 'ready' || run.pos === 0) return;
    run.token++;
    A.stop();
    if (run.recorder) run.recorder.cancel();
    if (run.phase === 'done') {
      $('run-done').hidden = true;
      run.pos = run.indices.length;
    }
    run.pos = Math.max(0, run.pos - 1);
    stepRun();
  }

  function onReveal() {
    if (run.phase !== 'mine') return;
    const index = run.indices[run.pos];
    run.revealed.add(index);
    setLineText(index);
    setRunButtons();
  }

  // Tapping a line jumps there (handy for going back a few lines).
  function onLineTap(index) {
    if (!run.active || run.phase === 'ready') return;
    const pos = run.indices.indexOf(index);
    if (pos === -1 || pos === run.pos) return;
    run.token++;
    A.stop();
    if (run.recorder) run.recorder.cancel();
    $('run-done').hidden = true;
    run.pos = pos;
    stepRun();
  }

  function finishRun() {
    run.phase = 'done';
    A.stop();
    if (run.recorder) run.recorder.cancel();
    setRunButtons();
    setStatus(run.mode === 'playback' ? 'End of playback' : 'Scene done', '');
    for (const [, e] of run.els) e.row.classList.remove('current');
    $('run-playback').hidden = run.takes.size === 0;
    $('run-done').hidden = false;
    $('run-again').focus();
  }

  function onRunAgain() {
    run.token++;
    A.stop();
    run.mode = 'rehearse';
    run.pos = 0;
    run.takes = new Map();
    run.revealed = new Set();
    for (const i of run.els.keys()) setLineText(i);
    $('run-done').hidden = true;
    unlockAudio();
    stepRun();
  }

  function onPlayback() {
    run.token++;
    A.stop();
    run.mode = 'playback';
    run.pos = 0;
    for (const i of run.els.keys()) setLineText(i);
    $('run-done').hidden = true;
    unlockAudio();
    stepRun();
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) run.wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {
      run.wakeLock = null;
    }
  }

  function leaveRehearse() {
    if (!run.active) return;
    run.active = false;
    run.token++;
    A.stop();
    if (run.recorder) run.recorder.release();
    run.recorder = null;
    if (run.wakeLock) run.wakeLock.release().catch(() => {});
    run.wakeLock = null;
  }

  function onKey(e) {
    if (document.body.dataset.view !== 'rehearse') return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
      e.preventDefault();
      onNext();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onBack();
    } else if (e.key === 'r' || e.key === 'R') {
      onReveal();
    }
  }

  // ---- Record lines --------------------------------------------------------------------------------

  const rec = { recorder: null, index: null, busy: false };

  function showRecord() {
    showView('record', 'Record lines', 'script/' + encodeURIComponent(state.script.id));
    $('rec-error').textContent = A.canRecord() ? '' : 'This browser can’t record audio. Open the app in Chrome or Safari from an https address.';
    const sel = $('rec-character');
    const names = state.parsed.characters.map((c) => c.name);
    sel.replaceChildren(...state.parsed.characters.map((c) =>
      h('option', { value: c.name, text: c.name + ' (' + c.lines + ')' })));
    const preferred = state.prefs.recordFor && names.includes(state.prefs.recordFor)
      ? state.prefs.recordFor
      : state.prefs.mine[0] || names[0];
    sel.value = preferred;
    prepareVoices().catch(() => {});
    renderRecLines();
  }

  function renderRecLines() {
    const name = $('rec-character').value;
    const lines = state.parsed.items.filter((i) => i.type === 'line' && i.character === name);
    const done = lines.filter((l) => state.recordings.has(l.index)).length;
    $('rec-progress').textContent = done + ' of ' + lines.length + ' recorded';
    $('rec-lines').replaceChildren(...lines.map(recRow));
  }

  function recRow(item) {
    const { items } = state.parsed;
    const cue = Core.cueFor(items, item.index);
    const saved = state.recordings.get(item.index);
    const isRecording = rec.index === item.index;
    const recBtn = h('button', {
      type: 'button',
      class: 'btn rec-btn' + (isRecording ? ' recording' : ''),
      onclick: () => onRecordTap(item)
    }, isRecording ? 'Stop' : saved ? 'Redo' : 'Record');
    return h('li', { class: 'rec-line' + (saved ? ' has-rec' : '') + (isRecording ? ' recording' : ''), dataset: { index: String(item.index) } },
      cue
        ? h('p', { class: 'cue' }, h('span', { class: 'who', text: cue.character }), ' ' + Core.tailWords(cue.text, 10))
        : h('p', { class: 'cue', text: 'Opens the scene' }),
      h('p', { class: 'say', text: item.text }),
      h('div', { class: 'row rec-controls' },
        recBtn,
        cue ? h('button', { type: 'button', class: 'btn small', onclick: () => playLine(cue) }, 'Hear cue') : null,
        saved ? h('button', { type: 'button', class: 'btn small', onclick: () => A.playBlob(saved.blob) }, 'Play') : null,
        saved ? h('button', { type: 'button', class: 'btn small subtle', onclick: () => onDeleteRecording(item) }, 'Delete') : null,
        h('span', { class: 'meta', text: isRecording ? 'Recording…' : saved ? Core.formatDuration(saved.duration) : '' })
      )
    );
  }

  function replaceRow(index) {
    const old = $('rec-lines').querySelector('[data-index="' + index + '"]');
    if (old) old.replaceWith(recRow(state.parsed.items[index]));
  }

  async function onRecordTap(item) {
    if (rec.busy) return;
    rec.busy = true;
    try {
      if (!rec.recorder) rec.recorder = new A.Recorder();
      A.stop();
      if (rec.index === item.index) {
        await finishRecording(true);
        return;
      }
      if (rec.index != null) await finishRecording(false);
      await rec.recorder.start();
      rec.index = item.index;
      $('rec-error').textContent = '';
      replaceRow(item.index);
    } catch (e) {
      rec.index = null;
      $('rec-error').textContent = e.message;
    } finally {
      rec.busy = false;
    }
  }

  async function finishRecording(moveOn) {
    const index = rec.index;
    rec.index = null;
    const result = await rec.recorder.stop();
    const item = state.parsed.items[index];
    if (result) {
      const record = {
        scriptId: state.script.id,
        index,
        character: item.character,
        lineHash: Core.lineHash(item),
        mime: result.mime,
        duration: result.duration,
        blob: result.blob
      };
      await Store.putRecording(record);
      state.recordings.set(index, record);
    }
    replaceRow(index);
    renderRecProgress();
    if (moveOn) {
      const rows = [...$('rec-lines').querySelectorAll('.rec-line:not(.has-rec)')];
      const next = rows.find((r) => Number(r.dataset.index) > index) || rows[0];
      if (next) {
        next.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const btn = next.querySelector('.rec-btn');
        if (btn) btn.focus({ preventScroll: true });
      }
    }
  }

  function renderRecProgress() {
    const name = $('rec-character').value;
    const lines = state.parsed.items.filter((i) => i.type === 'line' && i.character === name);
    const done = lines.filter((l) => state.recordings.has(l.index)).length;
    $('rec-progress').textContent = done + ' of ' + lines.length + ' recorded';
  }

  async function onDeleteRecording(item) {
    A.stop();
    await Store.deleteRecording(state.script.id, item.index);
    state.recordings.delete(item.index);
    replaceRow(item.index);
    renderRecProgress();
  }

  function leaveRecord() {
    A.stop();
    if (rec.recorder) rec.recorder.release();
    rec.recorder = null;
    rec.index = null;
    rec.busy = false;
  }

  // ---- Wiring ----------------------------------------------------------------------------------------

  function bind(id, event, fn) {
    $(id).addEventListener(event, (e) => {
      Promise.resolve(fn(e)).catch(showError);
    });
  }

  function init() {
    bind('nav-back', 'click', () => go($('nav-back').dataset.target || ''));
    bind('btn-new', 'click', () => go('new'));
    bind('btn-sample', 'click', onSample);
    bind('new-text', 'input', () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(updatePreview, 250);
    });
    bind('new-file', 'change', onFileChosen);
    bind('btn-save-script', 'click', onSaveNew);
    bindOptions();
    bind('btn-rehearse', 'click', onRehearse);
    bind('btn-record', 'click', () => go('record/' + encodeURIComponent(state.script.id)));
    bind('btn-export', 'click', onExport);
    bind('import-file', 'change', onImport);
    bind('btn-delete', 'click', onDelete);
    bind('run-next', 'click', onNext);
    bind('run-back', 'click', onBack);
    bind('run-reveal', 'click', onReveal);
    bind('run-again', 'click', onRunAgain);
    bind('run-playback', 'click', onPlayback);
    bind('run-exit', 'click', () => go('script/' + encodeURIComponent(state.script.id)));
    bind('rec-character', 'change', () => {
      leaveRecord();
      state.prefs.recordFor = $('rec-character').value;
      savePrefs();
      renderRecLines();
    });
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', route);
    route();
  }

  init();
})();
