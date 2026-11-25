/*
 * Local storage for scripts and line recordings (IndexedDB) and per-script
 * settings (localStorage). Nothing leaves the device.
 */
(function (root) {
  'use strict';

  const DB_NAME = 'script-rehearsal';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('scripts')) {
          db.createObjectStore('scripts', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('recordings')) {
          const rec = db.createObjectStore('recordings', { keyPath: 'key' });
          rec.createIndex('scriptId', 'scriptId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('The script database is open in another tab. Close it and reload.'));
    });
    return dbPromise;
  }

  function promisify(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
    });
  }

  async function store(name, mode) {
    const db = await open();
    const tx = db.transaction(name, mode);
    return { tx, os: tx.objectStore(name) };
  }

  // ---- Scripts ---------------------------------------------------------------

  async function saveScript(script) {
    const { tx, os } = await store('scripts', 'readwrite');
    os.put(script);
    await txDone(tx);
    return script;
  }

  async function getScript(id) {
    const { os } = await store('scripts', 'readonly');
    return promisify(os.get(id));
  }

  async function listScripts() {
    const { os } = await store('scripts', 'readonly');
    const all = await promisify(os.getAll());
    return all.sort((a, b) => (b.openedAt || b.createdAt || 0) - (a.openedAt || a.createdAt || 0));
  }

  async function deleteScript(id) {
    const db = await open();
    const tx = db.transaction(['scripts', 'recordings'], 'readwrite');
    tx.objectStore('scripts').delete(id);
    const idx = tx.objectStore('recordings').index('scriptId');
    const keys = await promisify(idx.getAllKeys(IDBKeyRange.only(id)));
    for (const k of keys) tx.objectStore('recordings').delete(k);
    await txDone(tx);
    try { localStorage.removeItem(prefsKey(id)); } catch (e) { /* storage may be blocked */ }
  }

  // ---- Recordings ------------------------------------------------------------

  function recordingKey(scriptId, index) {
    return scriptId + ':' + index;
  }

  async function putRecording(rec) {
    const { tx, os } = await store('recordings', 'readwrite');
    os.put(Object.assign({ createdAt: Date.now() }, rec, { key: recordingKey(rec.scriptId, rec.index) }));
    await txDone(tx);
  }

  async function putRecordings(recs) {
    const { tx, os } = await store('recordings', 'readwrite');
    for (const rec of recs) {
      os.put(Object.assign({ createdAt: Date.now() }, rec, { key: recordingKey(rec.scriptId, rec.index) }));
    }
    await txDone(tx);
  }

  async function deleteRecording(scriptId, index) {
    const { tx, os } = await store('recordings', 'readwrite');
    os.delete(recordingKey(scriptId, index));
    await txDone(tx);
  }

  // Map of line index -> recording.
  async function recordingsFor(scriptId) {
    const { os } = await store('recordings', 'readonly');
    const all = await promisify(os.index('scriptId').getAll(IDBKeyRange.only(scriptId)));
    const map = new Map();
    for (const rec of all) map.set(rec.index, rec);
    return map;
  }

  // ---- Settings ---------------------------------------------------------------

  const DEFAULT_PREFS = {
    mine: [],
    hint: 'first',
    pickup: 400,
    rate: 1,
    recordMe: false,
    startIndex: 0,
    sceneOnly: true
  };

  function prefsKey(id) {
    return 'script-rehearsal:prefs:' + id;
  }

  function loadPrefs(id) {
    let saved = {};
    let defaults = {};
    try {
      saved = JSON.parse(localStorage.getItem(prefsKey(id)) || '{}') || {};
      defaults = JSON.parse(localStorage.getItem('script-rehearsal:defaults') || '{}') || {};
    } catch (e) { /* storage may be blocked or corrupt; fall back to defaults */ }
    return Object.assign({}, DEFAULT_PREFS, defaults, saved);
  }

  function savePrefs(id, prefs) {
    try {
      localStorage.setItem(prefsKey(id), JSON.stringify(prefs));
      // Delivery settings carry over to the next script.
      localStorage.setItem('script-rehearsal:defaults', JSON.stringify({
        hint: prefs.hint, pickup: prefs.pickup, rate: prefs.rate, recordMe: prefs.recordMe
      }));
    } catch (e) { /* storage may be blocked; settings just won't persist */ }
  }

  root.RehearsalStore = {
    saveScript,
    getScript,
    listScripts,
    deleteScript,
    putRecording,
    putRecordings,
    deleteRecording,
    recordingsFor,
    loadPrefs,
    savePrefs
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
