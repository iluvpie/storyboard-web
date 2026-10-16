'use strict';
// The web version (for the iPad, as a home-screen app in Safari). The desktop
// app's main process saves files, opens dialogs and runs ffmpeg; in a browser
// there is none, so this file stands in for it with the same `window.api`:
//
//   boards     kept in the browser's own storage (IndexedDB), listed by
//              Open; any of them can be downloaded as a .sboard file, and a
//              .sboard file from the computer can be opened
//   videos     kept in that storage too, so a reopened board finds its
//              reference video again
//   export     MP4 made by the browser's own video encoder (WebCodecs) and
//              mp4-muxer; board sheets as a page to print or save as PDF
//
// In the desktop app `window.api` already exists and this file does nothing.

const isWeb = !window.api;

(() => {
  if (!isWeb) return;
  const query = new URLSearchParams(location.search);
  // Under test, finished files are handed back instead of offered to save.
  const testing = query.has('selftest') || query.has('webtest');

  // ---------------------------------------------------------------- polyfills
  // `?safari`: in another browser, act like Safari, without the features it
  // lacks, so the stand-ins for them can be tested.
  if (query.has('safari')) {
    window.noCanvasFilter = true;
    window.noBitmapResize = true;
    window.requestIdleCallback = undefined;
  }
  // Safari has no requestIdleCallback.
  if (!window.requestIdleCallback) {
    window.requestIdleCallback = (fn, opts = {}) => setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 8 }), Math.min(opts.timeout || 50, 50));
    window.cancelIdleCallback = (id) => clearTimeout(id);
  }

  // ---------------------------------------------------------------- storage
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open('storyboard', 2);
    req.onupgradeneeded = () => {
      const names = req.result.objectStoreNames;
      for (const store of ['boards', 'media', 'parts']) if (!names.contains(store)) req.result.createObjectStore(store);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const tx = async (store, mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  const idbGet = (store, key) => tx(store, 'readonly', (s) => s.get(key));
  const idbPut = (store, key, value) => tx(store, 'readwrite', (s) => s.put(value, key));
  const idbDelete = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
  const idbAll = async (store) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const out = [];
      const req = d.transaction(store, 'readonly').objectStore(store).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) { resolve(out); return; }
        out.push({ key: c.key, value: c.value });
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  };
  // Asks the browser not to clear the storage when space runs low.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // ---------------------------------------------------------------- files the user picks
  const media = new Map(); // web path -> { blob, url }
  const uidw = () => Math.random().toString(36).slice(2, 10);
  // A path-like name for a file, so the rest of the app can treat it like a
  // file on disk: web:media/<id>/<name>.
  function registerFile(file, keep) {
    const p = `web:media/${uidw()}/${file.name || 'file'}`;
    media.set(p, { blob: file, url: URL.createObjectURL(file) });
    if (keep) idbPut('media', p, file).catch(() => toast('The video could not be kept for next time (storage is full)'));
    return p;
  }
  async function blobFor(p) {
    if (media.has(p)) return media.get(p).blob;
    const blob = await idbGet('media', p).catch(() => null);
    if (blob) media.set(p, { blob, url: URL.createObjectURL(blob) });
    return blob || null;
  }
  window.webMediaUrl = async (p) => (await blobFor(p)) ? media.get(p).url : '';

  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.style.display = 'none';
      input.addEventListener('change', () => { resolve(input.files[0] || null); input.remove(); });
      input.addEventListener('cancel', () => { resolve(null); input.remove(); });
      document.body.append(input);
      input.click();
    });
  }

  // ---------------------------------------------------------------- small dialogs
  // A modal with a message and buttons; resolves with the index pressed.
  function choose(message, buttons, extra = null) {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'web-dialog';
      const p = document.createElement('p');
      p.textContent = message;
      dlg.append(p);
      if (extra) dlg.append(extra);
      const row = document.createElement('div');
      row.className = 'web-dialog-buttons';
      buttons.forEach((label, i) => {
        const b = document.createElement('button');
        b.className = 'text-btn' + (i === 0 ? ' primary' : '');
        b.textContent = label;
        b.addEventListener('click', () => { dlg.close(); dlg.remove(); resolve(i); });
        row.append(b);
      });
      dlg.append(row);
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); });
      document.body.append(dlg);
      dlg.showModal();
    });
  }

  // Gives a finished file to the person: the iPad's share sheet (Save to
  // Files, AirDrop...) or a download. Both need a tap, so it waits for one.
  async function deliver(blob, name, label) {
    const file = new File([blob], name, { type: blob.type });
    const pressed = await choose(`${label} is ready.`, ['Save it', 'Not now']);
    if (pressed !== 0) return false;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return true; } catch (err) { if (err && err.name === 'AbortError') return false; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    return true;
  }

  const toBase64 = (bytes) => new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.readAsDataURL(new Blob([bytes]));
  });
  const boardName = (p) => p.replace(/^web:board\//, '');

  // ---------------------------------------------------------------- boards
  //
  // A board is kept as a small outline (shots, layers, settings) plus each
  // drawing as its own entry in the `parts` store. Saving only writes the
  // drawings that changed, and nothing is ever joined into one huge string
  // (an iPad runs out of memory long before a desktop does). Boards saved by
  // the first web version, as one text, still open.
  const partBlobs = new Map(); // key -> Blob, for the board that is open
  const partKey = (board, key) => `${board}|${key}`;

  async function saveProjectParts(filePath, data, parts) {
    for (const p of parts) partBlobs.set(p.key, new Blob([p.bytes]));
    const used = [];
    const missing = [];
    const mark = (v) => {
      if (!v || typeof v !== 'object' || !v.$part) return v;
      if (!partBlobs.has(v.$part)) { missing.push(v.$part); return null; }
      used.push(v.$part);
      return { $part: v.$part };
    };
    for (const s of data.shots || []) for (const l of s.layers || []) l.png = mark(l.png);
    if (data.audio) data.audio.data = mark(data.audio.data);
    if (missing.length) return { missing };
    let target = filePath && filePath.startsWith('web:board/') ? filePath : null;
    if (!target) {
      const name = (prompt('Name this board', 'Untitled') || '').trim().replace(/[\\/:*?"<>|]+/g, '-');
      if (!name) return null;
      target = `web:board/${name}`;
      const existing = await idbGet('boards', target).catch(() => null);
      if (existing && (await choose(`A board called "${name}" is already saved here. Replace it?`, ['Replace', 'Cancel'])) !== 0) return null;
    }
    const before = await idbGet('boards', target).catch(() => null);
    const had = new Set((before && before.keys) || []);
    // New drawings first, then the outline that names them, then the ones
    // no longer used: a save cut short leaves the last good board whole.
    let fresh = 0;
    for (const key of used) {
      if (had.has(key)) continue;
      await idbPut('parts', partKey(target, key), partBlobs.get(key));
      fresh++;
    }
    await idbPut('boards', target, { data, keys: used, saved: Date.now() });
    const now = new Set(used);
    for (const key of had) if (!now.has(key)) await idbDelete('parts', partKey(target, key)).catch(() => {});
    for (const k of [...partBlobs.keys()]) if (!now.has(k)) partBlobs.delete(k);
    window.webLastSave = { fresh, total: used.length };
    return { path: target };
  }

  // A saved board, in the shape loadData takes: the outline as text with
  // "@@PARTn@@" where drawing n goes, the drawings as bytes, and their keys.
  async function openBoard(target) {
    const rec = await idbGet('boards', target).catch(() => null);
    if (!rec) return null;
    if (typeof rec.text === 'string') return { path: target, text: rec.text };
    partBlobs.clear();
    const parts = [];
    const keys = [];
    const take = async (v) => {
      if (!v || typeof v !== 'object' || !v.$part) return v;
      const blob = await idbGet('parts', partKey(target, v.$part));
      if (!blob) return null;
      partBlobs.set(v.$part, blob);
      parts.push(new Uint8Array(await blob.arrayBuffer()));
      keys.push(v.$part);
      return `@@PART${parts.length - 1}@@`;
    };
    const data = structuredClone(rec.data);
    for (const s of data.shots || []) for (const l of s.layers || []) l.png = await take(l.png);
    if (data.audio) data.audio.data = await take(data.audio.data);
    return { path: target, text: JSON.stringify(data), parts, keys };
  }
  window.webOpenBoard = openBoard;

  // The board as a .sboard file (the same format the desktop app reads),
  // built from pieces so the whole file is never one string.
  async function boardFile(target) {
    const rec = await idbGet('boards', target).catch(() => null);
    if (!rec) return null;
    if (typeof rec.text === 'string') return new Blob([rec.text], { type: 'application/json' });
    const pieces = [];
    const data = structuredClone(rec.data);
    const cut = async (v) => {
      if (!v || typeof v !== 'object' || !v.$part) return v;
      const blob = await idbGet('parts', partKey(target, v.$part));
      if (!blob) return null;
      pieces.push(await toBase64(blob));
      return `@@PART${pieces.length - 1}@@`;
    };
    for (const s of data.shots || []) for (const l of s.layers || []) l.png = await cut(l.png);
    if (data.audio) data.audio.data = await cut(data.audio.data);
    const outline = JSON.stringify(data).split(/@@PART(\d+)@@/);
    return new Blob(outline.map((s, i) => (i % 2 ? pieces[Number(s)] : s)), { type: 'application/json' });
  }
  window.webBoardFile = boardFile;

  async function deleteBoard(target) {
    const rec = await idbGet('boards', target).catch(() => null);
    for (const key of (rec && rec.keys) || []) await idbDelete('parts', partKey(target, key)).catch(() => {});
    await idbDelete('boards', target);
  }

  // Reads a .sboard file picked from Files, the way the desktop app does
  // (see sboard-read.js): as bytes, with the drawings cut out and decoded on
  // their own, never as one string.
  const B64 = new Uint8Array(256);
  for (let i = 0; i < 64; i++) B64['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;
  function base64Bytes(buf, s, e) {
    while (e > s && buf[e - 1] === 61) e--; // padding
    const n = e - s;
    const out = new Uint8Array(Math.floor((n * 3) / 4));
    let o = 0;
    let i = s;
    for (; i + 3 < e; i += 4) {
      const v = (B64[buf[i]] << 18) | (B64[buf[i + 1]] << 12) | (B64[buf[i + 2]] << 6) | B64[buf[i + 3]];
      out[o++] = v >> 16; out[o++] = (v >> 8) & 255; out[o++] = v & 255;
    }
    if (e - i === 2) out[o++] = ((B64[buf[i]] << 18) | (B64[buf[i + 1]] << 12)) >> 16;
    else if (e - i === 3) { const v = (B64[buf[i]] << 18) | (B64[buf[i + 1]] << 12) | (B64[buf[i + 2]] << 6); out[o++] = v >> 16; out[o++] = (v >> 8) & 255; }
    return out;
  }
  async function readFile(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const latin = new TextDecoder('latin1');
    const outline = [];
    const parts = [];
    let from = 0;
    let i = 0;
    for (;;) {
      const s = buf.indexOf(34, i);
      if (s < 0) break;
      let e = s + 1;
      for (;;) {
        e = buf.indexOf(34, e);
        if (e < 0) throw new Error('The file is cut short');
        let slashes = 0;
        for (let k = e - 1; k > s && buf[k] === 92; k--) slashes++;
        if (slashes % 2 === 0) break;
        e++;
      }
      if (e - s - 1 >= 512) {
        const lead = latin.decode(buf.subarray(Math.max(0, s - 7), s));
        if (lead.endsWith('"png":') || lead.endsWith('"data":')) {
          parts.push(base64Bytes(buf, s + 1, e));
          outline.push(buf.subarray(from, s), new TextEncoder().encode(`"@@PART${parts.length - 1}@@"`));
          from = e + 1;
          // Let the screen breathe on a big file.
          if (parts.length % 8 === 0) await new Promise((r) => setTimeout(r, 0));
        }
      }
      i = e + 1;
    }
    outline.push(buf.subarray(from));
    partBlobs.clear();
    return { path: null, text: await new Blob(outline).text(), parts, name: file.name };
  }
  window.webReadFile = readFile;

  // The Open dialog: boards saved in this browser, newest first, each with
  // Open, Download (a .sboard file to keep elsewhere) and Delete; and a
  // button to open a .sboard file.
  function openProject() {
    return new Promise(async (resolve) => {
      const boards = (await idbAll('boards').catch(() => [])).sort((a, b) => b.value.saved - a.value.saved);
      const dlg = document.createElement('dialog');
      dlg.className = 'web-dialog web-open';
      const title = document.createElement('b');
      title.textContent = 'Open a board';
      dlg.append(title);
      const list = document.createElement('div');
      list.className = 'web-board-list';
      const finish = (v) => { dlg.close(); dlg.remove(); resolve(v); };
      if (!boards.length) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = 'No boards saved on this iPad yet.';
        list.append(p);
      }
      for (const { key, value } of boards) {
        const row = document.createElement('div');
        row.className = 'web-board';
        const name = document.createElement('span');
        name.textContent = boardName(key);
        const when = document.createElement('span');
        when.className = 'muted';
        when.textContent = new Date(value.saved).toLocaleString();
        const open = document.createElement('button');
        open.className = 'text-btn primary';
        open.textContent = 'Open';
        open.addEventListener('click', async () => finish(await openBoard(key)));
        const down = document.createElement('button');
        down.className = 'text-btn';
        down.textContent = 'Download';
        down.addEventListener('click', async () => {
          const blob = await boardFile(key);
          if (blob) deliver(blob, `${boardName(key)}.sboard`, `${boardName(key)}.sboard`);
        });
        const del = document.createElement('button');
        del.className = 'text-btn';
        del.textContent = 'Delete';
        del.addEventListener('click', async () => {
          if ((await choose(`Delete "${boardName(key)}" from this iPad? This cannot be undone.`, ['Delete', 'Keep it'])) !== 0) return;
          await deleteBoard(key);
          row.remove();
        });
        row.append(name, when, open, down, del);
        list.append(row);
      }
      const fromFile = document.createElement('button');
      fromFile.className = 'text-btn';
      fromFile.textContent = 'Open a .sboard file...';
      fromFile.addEventListener('click', async () => {
        const f = await pickFile('.sboard,application/json');
        if (!f) return;
        try { finish(await readFile(f)); } catch (err) { toast('Could not read that file: ' + err.message); }
      });
      const cancel = document.createElement('button');
      cancel.className = 'text-btn';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => finish(null));
      const row = document.createElement('div');
      row.className = 'web-dialog-buttons';
      row.append(fromFile, cancel);
      dlg.append(list, row);
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
      document.body.append(dlg);
      dlg.showModal();
    });
  }

  // ---------------------------------------------------------------- sound
  // A video's sound, as a WAV the board can keep (the desktop app uses ffmpeg
  // to make an AAC file; the browser can decode the video's sound itself).
  async function videoAudio(p) {
    const blob = await blobFor(p);
    if (!blob) return null;
    try {
      const ctx = new OfflineAudioContext(2, 1, 44100);
      const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
      if (!buf || buf.duration < 0.05) return null;
      return { bytes: wav(buf), mime: 'audio/wav' };
    } catch {
      return null;
    }
  }
  function wav(buf) {
    const ch = Math.min(2, buf.numberOfChannels);
    const n = buf.length;
    const rate = buf.sampleRate;
    const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
    out.setUint32(24, rate, true); out.setUint32(28, rate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
    str(36, 'data'); out.setUint32(40, n * ch * 2, true);
    const data = [...Array(ch)].map((_, c) => buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        const v = Math.max(-1, Math.min(1, data[c][i]));
        out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        o += 2;
      }
    }
    return new Uint8Array(out.buffer);
  }

  // ---------------------------------------------------------------- MP4 export
  let job = null;
  const even = (v) => Math.ceil(v / 2) * 2;
  async function pickCodec(w, h, fps) {
    for (const codec of ['avc1.640033', 'avc1.4D0033', 'avc1.42E033', 'avc1.640028', 'avc1.42E01F']) {
      const config = { codec, width: w, height: h, framerate: fps, bitrate: Math.round(w * h * fps * 0.2), latencyMode: 'quality', avc: { format: 'avc' } };
      try {
        const res = await VideoEncoder.isConfigSupported(config);
        if (res.supported) return res.config;
      } catch {}
    }
    return null;
  }
  async function exportBegin(opts) {
    if (job) return { ok: false, error: 'An export is already running' };
    if (typeof VideoEncoder === 'undefined' || typeof Mp4Muxer === 'undefined') return { ok: false, error: 'This browser cannot make MP4 videos' };
    const w = even(opts.width);
    const h = even(opts.height);
    const config = await pickCodec(w, h, opts.fps);
    if (!config) return { ok: false, error: 'This browser cannot make H.264 video at this size' };
    // Sound, if this browser can encode AAC; otherwise the video goes without.
    let sound = null;
    if (opts.audio && typeof AudioEncoder !== 'undefined') {
      try {
        const ac = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 };
        if ((await AudioEncoder.isConfigSupported(ac)).supported) sound = { ac, audio: opts.audio };
      } catch {}
    }
    if (opts.audio && !sound) toast('This browser cannot add sound to the video, so it is exported silent');
    const target = new Mp4Muxer.ArrayBufferTarget();
    const muxer = new Mp4Muxer.Muxer({
      target,
      video: { codec: 'avc', width: w, height: h, frameRate: opts.fps },
      audio: sound ? { codec: 'aac', numberOfChannels: 2, sampleRate: 48000 } : undefined,
      fastStart: 'in-memory',
    });
    const j = { muxer, target, w, h, srcW: opts.width, srcH: opts.height, fps: opts.fps, frame: 0, error: null, sound, total: opts.totalFrames, name: `${opts.name || 'Untitled'}.mp4` };
    j.encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { j.error = e; } });
    j.encoder.configure(config);
    job = j;
    return { ok: true, path: j.name };
  }
  // Every frame is written, held drawings included (as the desktop export
  // does), so editors that expect a steady frame rate take the file.
  async function exportFrame(px, repeat) {
    const j = job;
    if (!j || j.error) return false;
    let source = null;
    if (j.w !== j.srcW || j.h !== j.srcH) {
      // Odd sizes: padded white to even ones, which H.264 needs.
      source = new OffscreenCanvas(j.w, j.h);
      const x = source.getContext('2d');
      x.fillStyle = '#fff';
      x.fillRect(0, 0, j.w, j.h);
      x.putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), j.srcW, j.srcH), 0, 0);
    }
    for (let r = 0; r < repeat; r++) {
      while (j.encoder.encodeQueueSize > 3) await new Promise((res) => setTimeout(res, 4));
      const timing = { timestamp: Math.round((j.frame * 1e6) / j.fps), duration: Math.round(1e6 / j.fps) };
      const frame = source ? new VideoFrame(source, timing) : new VideoFrame(px, { format: 'RGBA', codedWidth: j.w, codedHeight: j.h, ...timing });
      j.encoder.encode(frame, { keyFrame: j.frame % (j.fps * 2) === 0 });
      frame.close();
      j.frame++;
      if (j.error) return false;
    }
    return true;
  }
  async function encodeSound(j) {
    const { audio } = j.sound;
    const seconds = j.frame / j.fps;
    const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(seconds * 48000)), 48000);
    const buf = await ctx.decodeAudioData(audio.bytes.slice().buffer);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    // Positive offset: the sound starts later. Negative: it starts partway in.
    if (audio.offsetSec >= 0) src.start(audio.offsetSec);
    else src.start(0, -audio.offsetSec);
    const mixed = await ctx.startRendering();
    const enc = new AudioEncoder({ output: (chunk, meta) => j.muxer.addAudioChunk(chunk, meta), error: (e) => { j.error = e; } });
    enc.configure(j.sound.ac);
    const step = 4800;
    const L = mixed.getChannelData(0);
    const R = mixed.getChannelData(1);
    for (let i = 0; i < mixed.length; i += step) {
      const n = Math.min(step, mixed.length - i);
      const data = new Float32Array(n * 2);
      data.set(L.subarray(i, i + n), 0);
      data.set(R.subarray(i, i + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i * 1e6) / 48000), data });
      enc.encode(ad);
      ad.close();
    }
    await enc.flush();
    enc.close();
  }
  async function exportEnd(cancel) {
    const j = job;
    job = null;
    if (!j) return { ok: false };
    if (cancel) { try { j.encoder.close(); } catch {} return { ok: false }; }
    try {
      await j.encoder.flush();
      j.encoder.close();
      if (j.sound) await encodeSound(j);
      if (j.error) throw j.error;
      j.muxer.finalize();
    } catch (err) {
      return { ok: false, log: String(err && err.message || err) };
    }
    const blob = new Blob([j.target.buffer], { type: 'video/mp4' });
    if (testing) { window.lastExport = blob; return { ok: true, path: j.name }; }
    await deliver(blob, j.name, j.name);
    return { ok: true, path: j.name };
  }

  // ---------------------------------------------------------------- board sheets
  async function exportPdf(opts) {
    // The same page as on the desktop (sheetHtml in io.js), with the pictures inside it.
    const pics = new Map();
    for (const s of opts.shots) pics.set(s.number, `data:image/jpeg;base64,${await toBase64(s.img)}`);
    const html = sheetHtml(opts.title, opts.shots, opts.aspect, opts.perPage || 6, (s) => pics.get(s.number));
    const pages = Math.ceil(opts.shots.length / (opts.perPage || 6));
    const blob = new Blob([html], { type: 'text/html' });
    if (testing) window.lastSheet = html;
    else {
      // A page to print, or Share > Print > save as PDF on the iPad.
      if ((await choose(`Board sheets are ready (${pages} page${pages === 1 ? '' : 's'}). Open them to print or save as a PDF.`, ['Open', 'Not now'])) === 0) {
        window.open(URL.createObjectURL(blob), '_blank');
      }
    }
    return { ok: true, pages };
  }

  // ---------------------------------------------------------------- the api
  const noop = () => {};
  window.api = {
    saveProject: async () => null,
    saveProjectParts,
    openProject,
    launchFile: async () => null,
    askUnsaved: () => choose('Save changes to this board?', ['Save', "Don't save", 'Cancel']),
    onRequestClose: noop,
    confirmClose: noop,
    onPerfTool: noop,
    perfReady: noop,
    perfDrags: noop,
    onPerfReport: noop,
    openAudio: async () => {
      const f = await pickFile('audio/*');
      return f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null;
    },
    openVideo: async () => {
      const f = await pickFile('video/*');
      return f ? { path: registerFile(f, true) } : null;
    },
    videoAudio,
    videoProxy: async () => null,
    pathForFile: (file) => registerFile(file, /^video\//.test(file.type)),
    exportBegin,
    exportFrame,
    exportEnd,
    exportPdf,
    // The self-test, run in a browser, has no files to write or ffmpeg to check with.
    selftestCapture: async () => {},
    selftestDone: (lines) => { window.selftestResult = lines; console.log('SELFTEST-DONE ' + JSON.stringify(lines)); },
    selftestTempDir: async () => 'web:tmp',
    selftestReadFile: async () => '',
    selftestProbe: async () => null,
    selftestPdfPages: async () => null,
    selftestMakeVideo: async () => null,
  };

  // Leaving the page with unsaved work asks first (autosave keeps the rest).
  window.addEventListener('beforeunload', (e) => {
    if (typeof state !== 'undefined' && state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------------------------------------------------------------- Check this iPad
  // A report of what this browser can do, for working out problems on the
  // iPad from a screenshot. The Pencil's readings are kept from its last press.
  const pencilSeen = { pressure: 0, tilt: false, coalesced: 0, events: 0 };
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'pen') return;
    pencilSeen.pressure = Math.max(pencilSeen.pressure, e.pressure);
    if (e.tiltX || e.tiltY || (e.altitudeAngle !== undefined && e.altitudeAngle < 1.5)) pencilSeen.tilt = true;
  }, true);
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'pen' || !e.buttons) return;
    pencilSeen.events++;
    pencilSeen.pressure = Math.max(pencilSeen.pressure, e.pressure);
    if (e.getCoalescedEvents) pencilSeen.coalesced = Math.max(pencilSeen.coalesced, e.getCoalescedEvents().length);
  }, true);
  async function runChecks() {
    const yes = (v) => (v ? 'yes' : 'NO');
    const out = [];
    const add = (label, v) => out.push(`${label.padEnd(28)} ${v}`);
    add('Browser', navigator.userAgent.replace(/^Mozilla\/5\.0 /, ''));
    add('Screen', `${screen.width}x${screen.height} @${devicePixelRatio}x, window ${innerWidth}x${innerHeight}`);
    add('Home-screen app', yes(matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone));
    let c2 = null;
    try { c2 = new OffscreenCanvas(4, 4).getContext('2d'); } catch {}
    add('OffscreenCanvas', yes(c2));
    add('Canvas blur filter', yes(c2 && 'filter' in c2) + (c2 && 'filter' in c2 ? '' : ' (uses the GPU blur instead)'));
    let gl1 = null;
    try { gl1 = new OffscreenCanvas(4, 4).getContext('webgl'); } catch {}
    add('WebGL in OffscreenCanvas', yes(gl1));
    const gl2 = document.createElement('canvas').getContext('webgl2');
    add('WebGL2', yes(gl2));
    if (gl2) {
      gl2.getExtension('EXT_color_buffer_float');
      const t = gl2.createTexture();
      gl2.bindTexture(gl2.TEXTURE_2D, t);
      gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.R16F, 4, 4, 0, gl2.RED, gl2.HALF_FLOAT, null);
      const fb = gl2.createFramebuffer();
      gl2.bindFramebuffer(gl2.FRAMEBUFFER, fb);
      gl2.framebufferTexture2D(gl2.FRAMEBUFFER, gl2.COLOR_ATTACHMENT0, gl2.TEXTURE_2D, t, 0);
      add('Half-float drawing', yes(gl2.checkFramebufferStatus(gl2.FRAMEBUFFER) === gl2.FRAMEBUFFER_COMPLETE));
    }
    add('Pencil engine', yes(typeof pencilGL === 'function' && pencilGL()));
    try {
      const src = new OffscreenCanvas(64, 64);
      src.getContext('2d').fillRect(0, 0, 64, 64);
      const bm = await createImageBitmap(src, 0, 0, 64, 64, { resizeWidth: 16, resizeHeight: 16 });
      add('Bitmap shrink', bm.width === 16 ? 'yes' : `no (${bm.width}px)`);
    } catch (e) { add('Bitmap shrink', 'NO (' + e.message + ')'); }
    add('Video encoder (MP4)', typeof VideoEncoder === 'undefined' ? 'NO' : yes((await pickCodec(1920, 1080, 24)) || false));
    let aac = 'NO';
    if (typeof AudioEncoder !== 'undefined') {
      try { aac = yes((await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 })).supported); } catch {}
    }
    add('Sound in exported MP4', aac);
    add('Share sheet for files', yes(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] })));
    try {
      const est = await navigator.storage.estimate();
      add('Storage', `${Math.round((est.usage || 0) / 1e6)} MB used of ${Math.round((est.quota || 0) / 1e6)} MB`);
      add('Storage kept safe', yes(navigator.storage.persisted && (await navigator.storage.persisted())));
    } catch { add('Storage', 'unknown'); }
    add('Pencil seen', pencilSeen.events ? `yes, pressure up to ${pencilSeen.pressure.toFixed(2)}, tilt ${yes(pencilSeen.tilt)}, up to ${pencilSeen.coalesced} points per event` : 'not yet (draw a line, then check again)');
    if (typeof penLog !== 'undefined' && penLog.length) out.push('', 'Last Pencil presses (newest last):', ...penLog);
    return out;
  }
  const checkBtn = document.getElementById('ipadCheck');
  if (checkBtn) {
    checkBtn.hidden = false;
    checkBtn.addEventListener('click', async () => {
      const pre = document.createElement('pre');
      pre.className = 'web-check';
      pre.textContent = (await runChecks()).join('\n');
      choose('What this browser can do:', ['Done'], pre);
    });
  }
  window.webChecks = runChecks;

  // The home-screen app works offline once it has been opened online.
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
