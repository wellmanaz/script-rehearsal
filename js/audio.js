/*
 * Audio: text-to-speech for parts nobody has recorded, playback of recorded
 * lines, and microphone recording. One thing plays at a time; stop() ends it.
 */
(function (root) {
  'use strict';
  const Core = root.RehearsalCore;

  const synth = root.speechSynthesis || null;
  let current = null; // { stop() } for whatever is playing now

  function stop() {
    if (current) {
      const c = current;
      current = null;
      c.stop();
    }
  }

  // Voices load asynchronously in Chrome; wait briefly for them.
  function getVoices() {
    if (!synth) return Promise.resolve([]);
    const now = synth.getVoices();
    if (now.length) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = () => {
        synth.removeEventListener('voiceschanged', done);
        resolve(synth.getVoices());
      };
      synth.addEventListener('voiceschanged', done);
      setTimeout(done, 1500);
    });
  }

  function hasSpeech() {
    return !!synth && typeof root.SpeechSynthesisUtterance === 'function';
  }

  // Speaks text; resolves 'ended' when done or 'stopped' if stop() was called.
  function speak(text, opts) {
    stop();
    const o = opts || {};
    const chunks = Core.chunkForSpeech(text);
    if (!hasSpeech() || !chunks.length) return Promise.resolve('ended');
    const voices = synth.getVoices();
    const voice = o.voiceURI ? voices.find((v) => v.voiceURI === o.voiceURI) : null;

    return new Promise((resolve) => {
      let finished = false;
      let watchdog = null;
      const finish = (why) => {
        if (finished) return;
        finished = true;
        clearTimeout(watchdog);
        if (current === handle) current = null;
        resolve(why);
      };
      const handle = {
        stop() {
          synth.cancel();
          finish('stopped');
        }
      };
      current = handle;
      synth.cancel();

      let i = 0;
      let seq = 0;
      const next = () => {
        if (finished) return;
        if (i >= chunks.length) return finish('ended');
        const u = new root.SpeechSynthesisUtterance(chunks[i++]);
        const id = ++seq;
        const advance = () => {
          if (id === seq) next();
        };
        if (voice) u.voice = voice;
        u.pitch = o.pitch || 1;
        u.rate = o.rate || 1;
        // Some engines never fire onend; move on after a generous estimate.
        clearTimeout(watchdog);
        const words = u.text.split(/\s+/).length;
        watchdog = setTimeout(advance, 4000 + (words * 600) / u.rate);
        u.onend = advance;
        u.onerror = (e) => {
          if (e && (e.error === 'interrupted' || e.error === 'canceled')) return;
          advance();
        };
        synth.speak(u);
      };
      next();
    });
  }

  // Plays a recorded Blob; resolves 'ended' or 'stopped'.
  function playBlob(blob, opts) {
    stop();
    const o = opts || {};
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.playbackRate = o.rate || 1;
      let finished = false;
      const finish = (why) => {
        if (finished) return;
        finished = true;
        audio.pause();
        URL.revokeObjectURL(url);
        if (current === handle) current = null;
        resolve(why);
      };
      const handle = { stop: () => finish('stopped') };
      current = handle;
      audio.onended = () => finish('ended');
      audio.onerror = () => finish('ended');
      const p = audio.play();
      if (p && p.catch) p.catch(() => finish('ended'));
    });
  }

  function wait(ms) {
    stop();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        if (current === handle) current = null;
        resolve('ended');
      }, ms);
      const handle = {
        stop() {
          clearTimeout(t);
          resolve('stopped');
        }
      };
      current = handle;
    });
  }

  // ---- Recording ----------------------------------------------------------------

  function pickMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  function canRecord() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined');
  }

  class Recorder {
    constructor() {
      this.stream = null;
      this.rec = null;
      this.parts = [];
      this.startedAt = 0;
    }

    async ensureStream() {
      if (this.stream && this.stream.active) return this.stream;
      if (!canRecord()) {
        throw new Error('This browser can’t record audio. Try Chrome or Safari, opened from an https address.');
      }
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true }
        });
      } catch (e) {
        const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
        throw new Error(denied
          ? 'Microphone access was blocked. Allow the microphone for this page and try again.'
          : 'Couldn’t open the microphone: ' + (e && e.message ? e.message : e));
      }
      return this.stream;
    }

    get recording() {
      return !!this.rec && this.rec.state === 'recording';
    }

    async start() {
      await this.ensureStream();
      if (this.recording) this.cancel();
      const mime = pickMime();
      this.rec = mime ? new MediaRecorder(this.stream, { mimeType: mime }) : new MediaRecorder(this.stream);
      this.parts = [];
      this.rec.ondataavailable = (e) => {
        if (e.data && e.data.size) this.parts.push(e.data);
      };
      this.rec.start();
      this.startedAt = performance.now();
    }

    // Resolves { blob, mime, duration } (seconds).
    stop() {
      const rec = this.rec;
      if (!rec || rec.state === 'inactive') return Promise.resolve(null);
      return new Promise((resolve) => {
        rec.onstop = () => {
          const mime = rec.mimeType || (this.parts[0] && this.parts[0].type) || 'audio/webm';
          const blob = new Blob(this.parts, { type: mime });
          const duration = (performance.now() - this.startedAt) / 1000;
          this.rec = null;
          this.parts = [];
          resolve(blob.size ? { blob, mime, duration } : null);
        };
        rec.stop();
      });
    }

    cancel() {
      if (this.rec && this.rec.state !== 'inactive') {
        this.rec.onstop = null;
        this.rec.ondataavailable = null;
        this.rec.stop();
      }
      this.rec = null;
      this.parts = [];
    }

    release() {
      this.cancel();
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  // ---- Blob <-> base64 for export files --------------------------------------------

  async function blobToBase64(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const step = 0x8000;
    for (let i = 0; i < buf.length; i += step) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + step));
    }
    return btoa(bin);
  }

  function base64ToBlob(b64, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'audio/webm' });
  }

  root.RehearsalAudio = {
    stop,
    speak,
    playBlob,
    wait,
    getVoices,
    hasSpeech,
    canRecord,
    Recorder,
    blobToBase64,
    base64ToBlob
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
