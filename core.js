'use strict';
// Shared state, data model and canvas plumbing. The other scripts build on this
// one and are loaded after it, in the order listed in index.html.

const TAU = Math.PI * 2;
const AUTOSAVE_MS = 2 * 60 * 1000;
// Layers extend past the frame so you can draw outside it. Large frames get a
// smaller margin so one layer stays at or under about 4096x4096 pixels.
const MAX_WORKSPACE_PX = 4096 * 4096;
const MAX_MARGIN = 0.5; // share of the frame size added on each side
const THUMB_W = 192;

const $ = (sel) => document.querySelector(sel);
const uid = () => crypto.randomUUID();
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const query = new URLSearchParams(location.search);

// Frame size (W, H), where the frame sits in the layer (FX, FY), and the full
// layer size (CW, CH).
const dims = {};

function computeDims(w, h) {
  const margin = clamp((Math.sqrt(MAX_WORKSPACE_PX / (w * h)) - 1) / 2, 0, MAX_MARGIN);
  const FX = Math.round(w * margin);
  const FY = Math.round(h * margin);
  return { W: w, H: h, FX, FY, CW: w + 2 * FX, CH: h + 2 * FY };
}

const thumbH = () => Math.round((THUMB_W * dims.H) / dims.W);

const viewport = $('#viewport');
const stage = $('#stage');
const layerStack = $('#layerStack');
const onionCanvas = $('#onionCanvas');
const frameEl = $('#frame');
const cursorRing = $('#cursor');

// The in-progress stroke is drawn here at full alpha, then merged into the layer
// at the brush opacity on pen-up, so semi-transparent strokes stay even.
// Not desynchronized: on this scaled canvas it measured no smoother.
const strokeCanvas = document.createElement('canvas');
strokeCanvas.className = 'stroke';
const strokeCtx = strokeCanvas.getContext('2d', { desynchronized: query.get('sdesync') === '1' });

// The newest stretch of a solid stroke is drawn on this small canvas, which
// follows the pen; finished stretches are filled onto the stroke canvas.
// Clearing part of a big canvas every frame made drawing lag badly, while
// clearing a small one is cheap.
const liveCanvas = document.createElement('canvas');
liveCanvas.className = 'live';
const liveCtx = liveCanvas.getContext('2d');
// The stroke in progress is two canvases that overlap where they meet. They are
// faded together as one group (brush opacity times layer opacity), so the
// overlap does not show darker at the pen tip.
const strokeGroup = document.createElement('div');
strokeGroup.id = 'strokeGroup';
strokeGroup.append(strokeCanvas, liveCanvas);

function setDims(w, h) {
  Object.assign(dims, computeDims(w, h));
  for (const c of [strokeCanvas, onionCanvas]) {
    c.width = dims.CW;
    c.height = dims.CH;
  }
  stage.style.width = `${dims.CW}px`;
  stage.style.height = `${dims.CH}px`;
  Object.assign(frameEl.style, {
    left: `${dims.FX}px`, top: `${dims.FY}px`, width: `${dims.W}px`, height: `${dims.H}px`,
  });
}

const state = {
  fps: 24,
  shots: [],
  cur: -1,
  time: 0, // playhead, in frames
  brushId: 'ink',
  lastDrawBrush: 'ink',
  brushes: {},
  color: '#1b1b1f',
  recentColors: [],
  onion: false,
  captions: false, // show each shot's caption as a subtitle in playback and export
  // The subtitle's text height and its gap from the bottom edge, as shares of the frame height.
  captionSize: 0.03,
  captionBottom: 0.035,
  sheetPerPage: 6, // shots on each page of the board sheets PDF
  groups: {}, // layer folders: id -> { name, open } (see layer folders)
  view: { x: 0, y: 0, z: 1, r: 0, fit: true }, // r = rotation in radians
  path: null,
  dirty: false,
  audio: null,
  // `?raw=0` turns early pen events off, for comparing in `npm run perf`.
  rawEvents: query.get('raw') !== '0',
};

// ---------------------------------------------------------------- data model

function newLayer(name) {
  // Pixels live in one of three places: the live canvas (only for the shot on
  // screen), `snap` (a fresh copy waiting to be PNG-encoded) or `blob` (PNG).
  return { id: uid(), name, visible: true, opacity: 1, parallax: 1, blob: null, snap: null, dirty: false, version: 0, pending: null };
}

function newShot() {
  const layer = newLayer('Layer 1');
  return { id: uid(), duration: 2 * state.fps, layers: [layer], activeLayerId: layer.id, thumb: null, camera: null, grid: null, notes: '' };
}

const current = () => state.shots[state.cur];

// Operations that touch shot data run one at a time, in order.
let queue = Promise.resolve();
let busy = 0;
// `blocking` work (anything that changes shots or layers) stops new strokes
// from starting; saving does not, so drawing carries on during autosave.
function enqueue(fn, { blocking = true } = {}) {
  if (blocking) busy++;
  const run = queue.then(fn).finally(() => { if (blocking) busy--; });
  queue = run.catch((err) => { console.error(err); toast('Something went wrong: ' + err.message); });
  return run;
}

// ---------------------------------------------------------------- timing

function shotStarts() {
  const starts = [];
  let t = 0;
  for (const s of state.shots) { starts.push(t); t += s.duration; }
  return starts;
}

const totalFrames = () => state.shots.reduce((sum, s) => sum + s.duration, 0);

function shotIndexAt(frame) {
  let t = 0;
  for (let i = 0; i < state.shots.length; i++) {
    t += state.shots[i].duration;
    if (frame < t) return i;
  }
  return state.shots.length - 1;
}

function timecode(frames) {
  const fps = state.fps;
  const f = Math.max(0, Math.floor(frames));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(f / fps / 60))}:${pad(Math.floor(f / fps) % 60)}:${pad(f % fps)}`;
}

// ---------------------------------------------------------------- live canvases

const live = new Map(); // layerId -> canvas, for the mounted shot only
let mounted = null;

function activeLayer() {
  return mounted && mounted.layers.find((l) => l.id === mounted.activeLayerId);
}

// Copies the mounted shot's edited layers out of their live canvases so the
// shot can be unmounted, saved or played back.
function commitLive() {
  // Leaving a shot (or playing, scrubbing, saving) keeps a colour adjustment
  // that is still open.
  if (typeof adjust !== 'undefined' && adjust) closeAdjust(true);
  if (typeof filter !== 'undefined' && filter) closeFilter(true);
  if (!mounted) return;
  for (const layer of mounted.layers) {
    if (!layer.dirty) continue;
    const c = live.get(layer.id);
    if (!c) continue;
    const snap = new OffscreenCanvas(c.width, c.height);
    snap.getContext('2d').drawImage(c, 0, 0);
    layer.dirty = false;
    layer.snap = snap;
    layer.blob = null;
    const v = ++layer.version;
    layer.pending = snap.convertToBlob({ type: 'image/png' }).then((blob) => {
      if (layer.version !== v) return;
      layer.blob = blob;
      layer.snap = null;
      layer.pending = null;
    });
  }
}

async function ensureBlob(layer) {
  if (layer.pending) await layer.pending;
  if (!layer.blob && layer.snap) {
    layer.blob = await layer.snap.convertToBlob({ type: 'image/png' });
    layer.snap = null;
  }
  return layer.blob;
}

// Calls fn with something drawable holding the layer's pixels, if it has any.
// Turns a saved drawing back into a picture. When that fails for lack of
// memory, the app lets go of what it can do without (scrub previews, then
// the older undo steps) and tries again, rather than failing the shot.
async function decodeDrawing(blob) {
  try {
    return await createImageBitmap(blob);
  } catch (first) {
    if (typeof dropScrubFrames === 'function') dropScrubFrames();
    await new Promise((r) => setTimeout(r, 60));
    try {
      return await createImageBitmap(blob);
    } catch {
      const dropped = trimHistory(HISTORY_BYTES / 8, 3);
      await new Promise((r) => setTimeout(r, 120));
      try {
        const bm = await createImageBitmap(blob);
        if (dropped) toast('Memory was running low, so the oldest undo steps were let go');
        return bm;
      } catch {
        throw new Error('there is not enough memory left to show this drawing. Your board is not damaged: save it, then close and reopen the app');
      }
    }
  }
}

async function withLayerSource(layer, fn) {
  let src = null;
  let owned = false;
  if (mounted && live.has(layer.id) && mounted.layers.includes(layer)) src = live.get(layer.id);
  else if (layer.snap) src = layer.snap;
  else if (layer.blob) { src = await decodeDrawing(layer.blob); owned = true; }
  if (!src) return;
  fn(src);
  if (owned) src.close();
}

function makeLayerCanvas(layer) {
  const c = document.createElement('canvas');
  c.width = dims.CW;
  c.height = dims.CH;
  c.dataset.layerId = layer.id;
  return c;
}

async function mountShot(shot) {
  const canvases = [];
  for (const layer of shot.layers) {
    const c = makeLayerCanvas(layer);
    const ctx = c.getContext('2d');
    await withLayerSource(layer, (src) => ctx.drawImage(src, 0, 0));
    canvases.push(c);
  }
  live.clear();
  for (const c of canvases) live.set(c.dataset.layerId, c);
  mounted = shot;
  if (!shot.layers.some((l) => l.id === shot.activeLayerId)) shot.activeLayerId = shot.layers[shot.layers.length - 1].id;
  layoutStack();
  await renderOnion();
}

// Orders the layer canvases and slots the stroke and tip canvases just above
// the active layer.
// Layer blend modes: how a layer's colours mix with what is under it. Each
// has a canvas name (for playback, export and thumbnails) and a CSS name (for
// the layers on screen), so both look the same.
//   Glow     adds light (Procreate's Add): glows, lights, magic, sparks
//   Overlay  tints and shades while keeping what is under it
const BLENDS = {
  normal: { op: 'source-over', css: 'normal', label: 'Normal' },
  glow: { op: 'lighter', css: 'plus-lighter', label: 'Glow (add)' },
  overlay: { op: 'overlay', css: 'overlay', label: 'Overlay' },
  screen: { op: 'screen', css: 'screen', label: 'Screen' },
  multiply: { op: 'multiply', css: 'multiply', label: 'Multiply' },
};
const blendOf = (l) => BLENDS[(l && l.blend) || 'normal'] || BLENDS.normal;

function layoutStack() {
  if (!mounted) { layerStack.replaceChildren(); return; }
  const kids = [];
  for (const layer of mounted.layers) {
    const c = live.get(layer.id);
    c.style.display = layer.visible ? '' : 'none';
    c.style.opacity = layer.opacity;
    c.style.mixBlendMode = blendOf(layer).css;
    kids.push(c);
    // A layer being bent with Distort or Warp, among several: its live preview.
    if (typeof meshPreviews !== 'undefined' && meshPreviews.has(layer.id)) kids.push(meshPreviews.get(layer.id));
    if (layer.id === mounted.activeLayerId) {
      // A stroke in progress mixes in the way its layer will.
      strokeGroup.style.mixBlendMode = blendOf(layer).css;
      kids.push(strokeGroup);
    }
  }
  layerStack.replaceChildren(...kids);
}

async function doSelect(i, { moveTime = true } = {}) {
  i = clamp(i, 0, state.shots.length - 1);
  const shot = state.shots[i];
  if (mounted !== shot) {
    if (typeof lift !== 'undefined' && lift) dropSelection();
    commitLive();
    state.cur = i;
    await mountShot(shot);
  }
  state.cur = i;
  if (moveTime) {
    const start = shotStarts()[i];
    if (state.time < start || state.time >= start + shot.duration) state.time = start;
  }
  refreshUI();
}

const selectShot = (i, opts) => enqueue(() => doSelect(i, opts));

// ---------------------------------------------------------------- rendering

// The part of the layer a camera sees. cam = { x, y, s }: offset of the camera
// centre from the frame centre, and its size relative to the frame.
function camRect(cam) {
  const s = cam ? cam.s : 1;
  const w = dims.W * s;
  const h = dims.H * s;
  const cx = dims.FX + dims.W / 2 + (cam ? cam.x : 0);
  const cy = dims.FY + dims.H / 2 + (cam ? cam.y : 0);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

// How a camera move speeds up and slows down across the shot.
const EASES = {
  smooth: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  linear: (t) => t,
};

// Camera for a point in the shot, t from 0 to 1.
// A shot plays the whole camera move, or, after it has been split, its own
// stretch of it (camera.range, as fractions of the move): the pieces of a
// split shot carry one move on between them, so the drawing can change
// during it (that is how something is animated while the camera moves).
// Pieces of one move share camera.move, and stay in step when it is edited.
function camAt(shot, t) {
  if (!shot.camera) return null;
  const { start: a, end: b, range } = shot.camera;
  const u = clamp(t, 0, 1);
  const k = (EASES[shot.camera.ease] || EASES.smooth)(range ? range[0] + (range[1] - range[0]) * u : u);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, s: a.s + (b.s - a.s) * k };
}

// Parallax, like a multiplane camera: during a camera move each layer sees the
// move scaled by its parallax speed. Below 1 it is further back, so it drifts
// across the screen less and grows less on a push-in; above 1 it is nearer and
// moves more. Every layer lines up as drawn at the start of the move.
function layerCam(shot, t, k = 1) {
  const cam = camAt(shot, t);
  if (!cam || k === 1) return cam;
  const a = shot.camera.start;
  return { x: a.x + k * (cam.x - a.x), y: a.y + k * (cam.y - a.y), s: a.s * (cam.s / a.s) ** k };
}
const hasParallax = (shot) => !!shot.camera && shot.layers.some((l) => l.visible && (l.parallax ?? 1) !== 1);

// Draws part of a layer (rect) into a w x h area at the context's origin.
// A layer that is only on file, wanted much smaller than it is (scrub
// previews, thumbnails), is shrunk as it is decoded, which happens in the
// background; drawing the full-size picture down instead sends every layer
// whole to the graphics chip, and opening a big board froze the screen in
// bursts for as long as that took.
async function drawLayerInto(ctx, layer, rect, w, h) {
  const onScreen = mounted && live.has(layer.id) && mounted.layers.includes(layer);
  if (!onScreen && !layer.snap && layer.blob && !window.noBitmapResize && w < rect.w * 0.75 && rect.w >= 1 && rect.h >= 1) {
    const bm = await createImageBitmap(layer.blob, Math.round(rect.x), Math.round(rect.y), Math.round(rect.w), Math.round(rect.h), { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' }).catch(() => null);
    if (bm) {
      ctx.drawImage(bm, 0, 0);
      bm.close();
      return;
    }
  }
  await withLayerSource(layer, (src) => ctx.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h));
}

// Renders a region of the shot's layers into a new canvas of size w x h.
async function renderRegion(shot, rect, w, h, { background = true } = {}) {
  const off = new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const ctx = off.getContext('2d');
  // Smooth downscaling, so thin lines do not break up in thumbnails.
  ctx.imageSmoothingQuality = 'high';
  if (background) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, off.width, off.height); }
  for (const layer of shot.layers) {
    if (!layer.visible) continue;
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = blendOf(layer).op;
    await drawLayerInto(ctx, layer, rect, off.width, off.height);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  return off;
}

const renderFrame = (shot, cam, w = dims.W, h = dims.H) => renderRegion(shot, camRect(cam), w, h);

async function updateThumb(shot) {
  const h = thumbH();
  if (!shot.thumb || shot.thumb.width !== THUMB_W || shot.thumb.height !== h) {
    shot.thumb = document.createElement('canvas');
    shot.thumb.width = THUMB_W;
    shot.thumb.height = h;
  }
  // Each layer is shrunk by createImageBitmap, which works in the background,
  // rather than drawn down onto a small canvas, which made the app wait for
  // the graphics chip (worse with every layer).
  const rect = camRect(shot.camera ? camAt(shot, 0) : null);
  const bitmaps = await Promise.all(shot.layers.filter((l) => l.visible).map(async (l) => {
    // The live canvas is the newest copy, also for another shot that shares
    // the layer (a linked layer).
    const src = mounted && live.has(l.id) && mounted.layers.includes(l) ? live.get(l.id) : l.snap || l.blob;
    if (!src) return null;
    const bm = window.noBitmapResize ? null : await createImageBitmap(src, Math.round(rect.x), Math.round(rect.y), Math.round(rect.w), Math.round(rect.h), { resizeWidth: THUMB_W, resizeHeight: h, resizeQuality: 'medium' }).catch(() => null);
    // Browsers that cannot shrink while decoding (some Safari versions) get
    // the layer itself, drawn down below (a blob is decoded first).
    if (!bm) {
      const whole = src instanceof Blob ? await createImageBitmap(src).catch(() => null) : src;
      return whole && { whole, owned: src instanceof Blob, opacity: l.opacity, op: blendOf(l).op };
    }
    return { bm, opacity: l.opacity, op: blendOf(l).op };
  }));
  const tctx = shot.thumb.getContext('2d');
  tctx.fillStyle = '#fff';
  tctx.fillRect(0, 0, THUMB_W, h);
  for (const item of bitmaps) {
    if (!item) continue;
    tctx.globalAlpha = item.opacity;
    tctx.globalCompositeOperation = item.op;
    if (item.bm) {
      tctx.drawImage(item.bm, 0, 0);
      item.bm.close();
    } else {
      tctx.imageSmoothingQuality = 'high';
      tctx.drawImage(item.whole, rect.x, rect.y, rect.w, rect.h, 0, 0, THUMB_W, h);
      if (item.owned) item.whole.close();
    }
  }
  tctx.globalAlpha = 1;
  tctx.globalCompositeOperation = 'source-over';
  // The timeline repeats this image along the clip, like a filmstrip.
  // Encoded off the main thread (toDataURL did it here and held the screen).
  const blob = await new Promise((resolve) => shot.thumb.toBlob(resolve, 'image/png'));
  if (!blob) return;
  if (shot.thumbUrl && shot.thumbUrl.startsWith('blob:')) URL.revokeObjectURL(shot.thumbUrl);
  shot.thumbUrl = URL.createObjectURL(blob);
  // Saved with the board, so opening it shows the timeline at once instead
  // of redrawing every shot.
  shot.thumbPng = await blobToBase64(blob).catch(() => null);
  if (typeof refreshClipThumb === 'function') refreshClipThumb(shot);
}

// Timeline pictures still to be made (a board saved before they were kept in
// the file, or a new shot): two at a time. All at once, a 40-shot board
// decoded 280 drawings together when it opened.
const thumbQueue = [];
let thumbsRunning = 0;
function queueThumb(shot) {
  if (shot.thumbQueued) return;
  shot.thumbQueued = true;
  thumbQueue.push(shot);
  pumpThumbs();
}
function pumpThumbs() {
  while (thumbsRunning < 2 && thumbQueue.length) {
    const shot = thumbQueue.shift();
    thumbsRunning++;
    updateThumb(shot).catch(() => {}).finally(() => {
      shot.thumbQueued = false;
      thumbsRunning--;
      pumpThumbs();
    });
  }
}

// Batches thumbnail redraws. A fixed delay, not reset by later strokes, so quick
// back-to-back strokes cannot keep pushing the refresh away.
// Thumbnails wait for a pause in drawing. Redrawing one shrinks every layer of
// the shot on the graphics chip, and with several layers that held the screen
// for up to ~90ms after each stroke. So the timeline catches up once the pen
// has been still for a moment (and within 8 seconds at the latest).
const THUMB_IDLE_MS = 600;
const THUMB_LATEST_MS = 8000;
const thumbsDue = new Set();
let thumbTimer = 0;
let thumbsWaiting = 0;
function scheduleThumb(shot = mounted) {
  if (shot) thumbsDue.add(shot);
  // Drawing on a linked layer changes every shot it is in.
  const al = shot && shot === mounted ? activeLayer() : null;
  if (al) for (const s of state.shots) if (s !== shot && s.layers.includes(al)) thumbsDue.add(s);
  if (thumbTimer) return;
  if (!thumbsWaiting) thumbsWaiting = performance.now();
  thumbTimer = setTimeout(() => {
    thumbTimer = 0;
    const now = performance.now();
    const busy = (typeof stroke !== 'undefined' && stroke) || (typeof lastInput !== 'undefined' && now - lastInput < THUMB_IDLE_MS);
    if (busy && now - thumbsWaiting < THUMB_LATEST_MS) { scheduleThumb(null); return; }
    thumbsWaiting = 0;
    for (const s of thumbsDue) updateThumb(s);
    thumbsDue.clear();
    if (typeof warmScrubFrames === 'function') warmScrubFrames();
  }, 150);
}

async function renderOnion() {
  const ctx = onionCanvas.getContext('2d');
  ctx.clearRect(0, 0, dims.CW, dims.CH);
  const idx = state.shots.indexOf(mounted);
  if (!state.onion || idx < 1) return;
  const off = await renderRegion(state.shots[idx - 1], { x: 0, y: 0, w: dims.CW, h: dims.CH }, dims.CW, dims.CH, { background: false });
  ctx.drawImage(off, 0, 0);
}

// ---------------------------------------------------------------- history

const history = { undo: [], redo: [], limit: 100 };

// Frees the GPU snapshots a pixel entry holds.
function disposeEntry(e) {
  if (e.type === 'multi') { e.entries.forEach(disposeEntry); return; }
  if (e.type !== 'pixels') return;
  for (const snap of [e.before, e.after]) Promise.resolve(snap).then((bm) => bm.close(), () => {});
}

// Goes up whenever pixels may have changed (new step, undo, redo, new file),
// so anything measured from a layer knows when to measure again.
let historyStamp = 0;

// How much graphics memory an undo step holds: its before and after
// pictures. A pen stroke keeps only the patch it touched, but moving, warping
// or blurring keeps the whole layer twice (88 MB a step on a 5120 x 2160
// canvas), and a hundred of those ran the graphics memory out after a few
// hours: drawings then failed to load ("The source image could not be
// decoded"). So the history also has a budget, and the oldest steps go first.
const HISTORY_BYTES = (typeof isWeb !== 'undefined' && isWeb ? 350 : 1200) * 1024 * 1024;
function entryBytes(e) {
  if (e.type === 'multi') return e.entries.reduce((sum, sub) => sum + entryBytes(sub), 0);
  return e.type === 'pixels' ? e.w * e.h * 8 : 0;
}
const historyBytes = () => history.undo.concat(history.redo).reduce((sum, e) => sum + entryBytes(e), 0);
// Drops the oldest steps until the history fits in `budget` (always keeping
// the newest `keep`). Returns how many went.
function trimHistory(budget = HISTORY_BYTES, keep = 1) {
  let dropped = 0;
  let bytes = historyBytes();
  while (bytes > budget && history.undo.length > keep) {
    const old = history.undo.shift();
    bytes -= entryBytes(old);
    disposeEntry(old);
    dropped++;
  }
  return dropped;
}

function pushHistory(entry) {
  historyStamp++;
  history.undo.push(entry);
  if (history.undo.length > history.limit) disposeEntry(history.undo.shift());
  history.redo.forEach(disposeEntry);
  history.redo.length = 0;
  trimHistory();
  if (entry.type !== 'selection') markDirty();
}

function clearHistory() {
  historyStamp++;
  history.undo.forEach(disposeEntry);
  history.redo.forEach(disposeEntry);
  history.undo.length = 0;
  history.redo.length = 0;
}

async function showShotById(id) {
  const idx = state.shots.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  if (mounted !== state.shots[idx]) await doSelect(idx);
  return mounted;
}

async function applyEntry(e, forward) {
  switch (e.type) {
    // Several steps taken as one (a merge, or moving several layers).
    case 'multi': {
      for (const sub of forward ? e.entries : [...e.entries].reverse()) await applyEntry(sub, forward);
      break;
    }
    case 'pixels': {
      const shot = await showShotById(e.shotId);
      const layer = shot && shot.layers.find((l) => l.id === e.layerId);
      if (!layer) return;
      const snap = await (forward ? e.after : e.before);
      const ctx = live.get(layer.id).getContext('2d');
      ctx.clearRect(e.x, e.y, e.w, e.h);
      ctx.drawImage(snap, e.x, e.y);
      layer.dirty = true;
      scheduleThumb();
      break;
    }
    case 'addShot':
      if (forward) await insertShot(e.index, e.shot); else await removeShot(e.index);
      break;
    case 'deleteShot':
      if (forward) await removeShot(e.index); else await insertShot(e.index, e.shot);
      break;
    case 'split': {
      const first = state.shots.find((s) => s.id === e.shotId);
      if (forward) {
        if (first) { first.duration = e.at; if (e.cam1) first.camera = structuredClone(e.cam1); }
        await insertShot(e.index, e.shot);
      } else {
        await removeShot(e.index);
        if (first) { first.duration = e.full; if (e.cam1) first.camera = structuredClone(e.cam0); scheduleThumb(first); }
        refreshUI();
      }
      break;
    }
    case 'moveShot':
      if (forward) reorderShot(e.from, e.to); else reorderShot(e.to, e.from);
      break;
    case 'duration': {
      const shot = state.shots.find((s) => s.id === e.shotId);
      if (shot) shot.duration = forward ? e.to : e.from;
      refreshUI();
      break;
    }
    case 'grid': {
      const shot = await showShotById(e.shotId);
      if (!shot) return;
      shot.grid = structuredClone(forward ? e.to : e.from);
      refreshUI();
      break;
    }
    case 'camera': {
      const shot = await showShotById(e.shotId);
      if (!shot) return;
      shot.camera = structuredClone(forward ? e.to : e.from);
      scheduleThumb(shot);
      refreshUI();
      break;
    }
    // A lasso selection made, added to, cut from or dropped.
    case 'selection': {
      await showShotById(e.shotId);
      const polys = forward ? e.to : e.from;
      setSelection(polys ? { polys } : null);
      break;
    }
    // A linked layer extended into another shot (see extendLayer). Undo takes
    // it out of that shot without going there.
    case 'link': {
      const shot = state.shots.find((s) => s.id === e.shotId);
      if (!shot || forward === shot.layers.includes(e.layer)) return;
      if (!forward && shot === mounted) commitLive();
      await placeLinked(shot, e.layer, e.index, forward);
      refreshUI();
      break;
    }
    // Folders made or undone, or the stack reordered.
    case 'layout': {
      const shot = await showShotById(e.shotId);
      if (!shot) return;
      restoreLayout(shot, forward ? e.after : e.before);
      layoutStack();
      refreshUI();
      scheduleThumb();
      break;
    }
    case 'addLayer':
    case 'deleteLayer': {
      const shot = await showShotById(e.shotId);
      if (!shot) return;
      const adding = (e.type === 'addLayer') === forward;
      if (!adding) commitLive();
      if (adding) await insertLayer(e.index, e.layer); else removeLayer(e.layer.id);
      break;
    }
  }
}

const undo = () => enqueue(async () => {
  if (typeof adjust !== 'undefined' && adjust) { closeAdjust(false); return; }
  if (typeof filter !== 'undefined' && filter) { closeFilter(false); return; }
  if (typeof meshLive === 'function' && meshLive()) { await cancelLift(); return; }
  // A piece still picked up is put down first, so undo takes back its move.
  if (typeof lift !== 'undefined' && lift) dropSelection();
  const e = history.undo.pop();
  if (!e) return;
  await applyEntry(e, false);
  historyStamp++;
  history.redo.push(e);
  if (e.type !== 'selection') markDirty();
});

const redo = () => enqueue(async () => {
  if (typeof adjust !== 'undefined' && adjust) closeAdjust(true);
  if (typeof filter !== 'undefined' && filter) closeFilter(true);
  if (typeof lift !== 'undefined' && lift) dropSelection();
  const e = history.redo.pop();
  if (!e) return;
  await applyEntry(e, true);
  historyStamp++;
  history.undo.push(e);
  if (e.type !== 'selection') markDirty();
});

// ---------------------------------------------------------------- shot ops

async function insertShot(index, shot) {
  state.shots.splice(index, 0, shot);
  if (!shot.thumb) await updateThumb(shot);
  await doSelect(index);
  state.time = shotStarts()[index];
  await renderOnion();
  refreshUI();
}

async function removeShot(index) {
  const shot = state.shots[index];
  if (mounted === shot) {
    commitLive();
    mounted = null;
    live.clear();
  }
  state.shots.splice(index, 1);
  await doSelect(Math.min(index, state.shots.length - 1));
}

function reorderShot(from, to) {
  const [s] = state.shots.splice(from, 1);
  state.shots.splice(to, 0, s);
  state.cur = state.shots.indexOf(mounted);
  state.time = shotStarts()[state.cur];
  refreshUI();
  renderOnion();
}

const addShot = () => enqueue(async () => {
  const shot = newShot();
  const index = state.cur + 1;
  await insertShot(index, shot);
  pushHistory({ type: 'addShot', index, shot });
});

const duplicateShot = () => enqueue(async () => {
  commitLive();
  const src = current();
  const layers = [];
  let activeLayerId = null;
  for (const l of src.layers) {
    // A linked layer stays linked in the new shot; the others are copied.
    const copy = shotsWith(l).length > 1 ? l : { ...newLayer(l.name), visible: l.visible, opacity: l.opacity, parallax: l.parallax ?? 1, blend: l.blend || 'normal', group: l.group || null, blob: await ensureBlob(l) };
    if (l.id === src.activeLayerId) activeLayerId = copy.id;
    layers.push(copy);
  }
  const camera = structuredClone(src.camera);
  if (camera) delete camera.move;
  const shot = { id: uid(), duration: src.duration, layers, activeLayerId, thumb: null, camera, grid: structuredClone(src.grid || null), notes: src.notes || '' };
  const index = state.cur + 1;
  await insertShot(index, shot);
  pushHistory({ type: 'addShot', index, shot });
});

// Cuts the shot at the playhead into two, like a razor in a video editor.
// The second part starts as a copy of the first.
const splitShot = () => enqueue(async () => {
  const starts = shotStarts();
  const i = shotIndexAt(state.time);
  const shot = state.shots[i];
  const at = Math.round(state.time - starts[i]);
  if (at <= 0 || at >= shot.duration) { toast('Move the playhead inside a shot to split it there'); return; }
  commitLive();
  const layers = [];
  let activeLayerId = null;
  for (const l of shot.layers) {
    // A linked layer stays linked in the new shot; the others are copied.
    const copy = shotsWith(l).length > 1 ? l : { ...newLayer(l.name), visible: l.visible, opacity: l.opacity, parallax: l.parallax ?? 1, blend: l.blend || 'normal', group: l.group || null, blob: await ensureBlob(l) };
    if (l.id === shot.activeLayerId) activeLayerId = copy.id;
    layers.push(copy);
  }
  const full = shot.duration;
  const rest = { id: uid(), duration: full - at, layers, activeLayerId, thumb: null, camera: structuredClone(shot.camera), grid: structuredClone(shot.grid || null), notes: shot.notes || '' };
  // A camera move carries on across the split: each piece gets its stretch.
  const cam0 = structuredClone(shot.camera);
  if (shot.camera) {
    const r = shot.camera.range || [0, 1];
    const mid = r[0] + (r[1] - r[0]) * (at / full);
    const move = shot.camera.move || uid();
    shot.camera = { ...shot.camera, move, range: [r[0], mid] };
    rest.camera = { ...rest.camera, move, range: [mid, r[1]] };
  }
  shot.duration = at;
  await insertShot(i + 1, rest);
  pushHistory({ type: 'split', shotId: shot.id, index: i + 1, shot: rest, at, full, cam0, cam1: structuredClone(shot.camera) });
});

const deleteShot = () => enqueue(async () => {
  if (state.shots.length < 2) { toast('A board needs at least one shot'); return; }
  const index = state.cur;
  const shot = current();
  await removeShot(index);
  pushHistory({ type: 'deleteShot', index, shot });
  toast(`Deleted shot ${index + 1}. Ctrl+Z brings it back.`);
});

const moveShot = (from, to) => enqueue(async () => {
  if (from === to) return;
  reorderShot(from, to);
  pushHistory({ type: 'moveShot', from, to });
});

function setDuration(shot, frames, { record = true, from = shot.duration } = {}) {
  frames = Math.max(1, Math.round(frames));
  shot.duration = frames;
  if (record && frames !== from) pushHistory({ type: 'duration', shotId: shot.id, from, to: frames });
  refreshUI();
}

function setCamera(shot, camera, from) {
  shot.camera = camera;
  const entries = [{ type: 'camera', shotId: shot.id, from: structuredClone(from), to: structuredClone(camera) }];
  // The other pieces of the same move (see camAt) follow, each keeping its
  // own stretch; turning the move off turns it off for all of them.
  const move = (camera && camera.move) || (from && from.move);
  if (move) {
    for (const s of state.shots) {
      if (s === shot || !s.camera || s.camera.move !== move) continue;
      const was = structuredClone(s.camera);
      s.camera = camera ? { ...structuredClone(camera), range: s.camera.range, move } : null;
      entries.push({ type: 'camera', shotId: s.id, from: was, to: structuredClone(s.camera) });
      scheduleThumb(s);
    }
  }
  pushHistory(entries.length === 1 ? entries[0] : { type: 'multi', shotId: shot.id, entries });
  scheduleThumb(shot);
  refreshUI();
}

// ---------------------------------------------------------------- layer ops

async function insertLayer(index, layer) {
  const c = makeLayerCanvas(layer);
  const ctx = c.getContext('2d');
  await withLayerSource(layer, (src) => ctx.drawImage(src, 0, 0));
  live.set(layer.id, c);
  mounted.layers.splice(index, 0, layer);
  mounted.activeLayerId = layer.id;
  layoutStack();
  refreshUI();
  scheduleThumb();
}

function removeLayer(layerId) {
  const idx = mounted.layers.findIndex((l) => l.id === layerId);
  if (idx < 0) return;
  mounted.layers.splice(idx, 1);
  live.delete(layerId);
  if (mounted.activeLayerId === layerId) {
    mounted.activeLayerId = mounted.layers[Math.min(idx, mounted.layers.length - 1)].id;
  }
  layoutStack();
  refreshUI();
  scheduleThumb();
}

// The layers picked in the Layers list, bottom to top (at least the current one).
function selectedLayers(shot = mounted) {
  if (!shot) return [];
  const sel = shot.selLayers;
  return shot.layers.filter((l) => l.id === shot.activeLayerId || (sel && sel.has(l.id)));
}

// Merges the selected visible layers into one, where the top one was, keeping
// how each looked (its opacity is drawn in). One undo step. Hidden layers in
// the selection are left as they are.
const mergeLayers = () => enqueue(async () => {
  const list = selectedLayers().filter((l) => l.visible);
  if (list.length < 2) { toast('Pick at least two visible layers to merge'); return; }
  commitLive();
  const top = list[list.length - 1];
  const out = new OffscreenCanvas(dims.CW, dims.CH);
  const octx = out.getContext('2d');
  for (const l of list) {
    octx.globalAlpha = l.opacity;
    octx.globalCompositeOperation = blendOf(l).op;
    await withLayerSource(l, (src) => octx.drawImage(src, 0, 0));
  }
  octx.globalCompositeOperation = 'source-over';
  const merged = { ...newLayer(top.name), parallax: top.parallax ?? 1, group: top.group || null };
  const index = mounted.layers.indexOf(top) + 1;
  await insertLayer(index, merged);
  live.get(merged.id).getContext('2d').drawImage(out, 0, 0);
  merged.dirty = true;
  const entries = [{ type: 'addLayer', shotId: mounted.id, index, layer: merged }];
  for (const l of [...list].reverse()) {
    const i = mounted.layers.indexOf(l);
    removeLayer(l.id);
    entries.push({ type: 'deleteLayer', shotId: mounted.id, index: i, layer: l });
  }
  mounted.activeLayerId = merged.id;
  if (mounted.selLayers) mounted.selLayers.clear();
  pushHistory({ type: 'multi', shotId: mounted.id, entries });
  layoutStack();
  refreshUI();
  scheduleThumb();
  markDirty();
  toast(`Merged ${list.length} layers`);
});

// ---------------------------------------------------------------- copy and paste

// The app's own clipboard: copies of layers (pixels and settings), so they can
// be pasted into any shot. With a lasso selection, just the selected part of
// the current layer is copied.
let layerClipboard = null; // { items: [{ name, opacity, parallax, visible, canvas }], fx, fy }

const copyLayers = () => enqueue(async () => {
  if (!mounted) return;
  if (typeof lift !== 'undefined' && lift) dropSelection();
  const snap = (layer, clip) => {
    const c = new OffscreenCanvas(dims.CW, dims.CH);
    const ctx = c.getContext('2d');
    if (clip) ctx.clip(clip);
    ctx.drawImage(live.get(layer.id), 0, 0);
    return { name: layer.name, opacity: layer.opacity, parallax: layer.parallax ?? 1, blend: layer.blend || 'normal', visible: layer.visible, canvas: c };
  };
  const items = state.selection ? [snap(activeLayer(), state.selection.path)] : selectedLayers().map((l) => snap(l));
  layerClipboard = { items, fx: dims.FX, fy: dims.FY };
  toast(state.selection ? 'Copied the selection' : items.length > 1 ? `Copied ${items.length} layers` : `Copied ${items[0].name}`);
});

// Pastes above the current layer, in the same place in the frame. One undo
// step; several pasted layers come in selected together.
const pasteLayers = () => enqueue(async () => {
  if (!mounted) return;
  if (!layerClipboard) { toast('Copy a layer first (Ctrl+C)'); return; }
  if (typeof lift !== 'undefined' && lift) dropSelection();
  let index = mounted.layers.findIndex((l) => l.id === mounted.activeLayerId) + 1;
  const entries = [];
  const added = [];
  for (const item of layerClipboard.items) {
    const layer = { ...newLayer(item.name), opacity: item.opacity, parallax: item.parallax, blend: item.blend, visible: item.visible };
    await insertLayer(index, layer);
    live.get(layer.id).getContext('2d').drawImage(item.canvas, dims.FX - layerClipboard.fx, dims.FY - layerClipboard.fy);
    layer.dirty = true;
    entries.push({ type: 'addLayer', shotId: mounted.id, index, layer });
    added.push(layer);
    index++;
  }
  mounted.activeLayerId = added[added.length - 1].id;
  mounted.selLayers = new Set(added.length > 1 ? added.map((l) => l.id) : []);
  pushHistory(entries.length === 1 ? entries[0] : { type: 'multi', shotId: mounted.id, entries });
  layoutStack();
  refreshUI();
  scheduleThumb();
  markDirty();
  toast(added.length > 1 ? `Pasted ${added.length} layers` : `Pasted ${added[0].name}`);
});

const addLayer = () => enqueue(async () => {
  const idx = mounted.layers.findIndex((l) => l.id === mounted.activeLayerId) + 1;
  const layer = newLayer(`Layer ${mounted.layers.length + 1}`);
  await insertLayer(idx, layer);
  pushHistory({ type: 'addLayer', shotId: mounted.id, index: idx, layer });
});

// Deletes the picked layers (a whole folder when a folder is picked).
const deleteLayer = () => enqueue(async () => {
  const list = selectedLayers();
  if (mounted.layers.length - list.length < 1) { toast('A shot needs at least one layer'); return; }
  commitLive(); // keeps the pixels on the layer object so undo can restore them
  const name = pickedName(list);
  const others = Math.max(...list.map((l) => shotsWith(l).length)) - 1;
  const entries = [];
  for (const layer of [...list].reverse()) {
    const index = mounted.layers.indexOf(layer);
    removeLayer(layer.id);
    entries.push({ type: 'deleteLayer', shotId: mounted.id, index, layer });
  }
  if (mounted.selLayers) mounted.selLayers.clear();
  mounted.selGroup = null;
  pushHistory(entries.length === 1 ? entries[0] : { type: 'multi', shotId: mounted.id, entries });
  refreshUI();
  if (others) toast(`Took ${name} out of this shot. ${list.length > 1 ? 'They are' : 'It is'} still in other shots`);
});

// ---------------------------------------------------------------- linked layers
//
// A layer can be shared by several shots, like a background held across a run
// of shots in Procreate Dreams while the characters change on their own
// layers. It is the same layer in each shot's list, so drawing on it in any of
// them changes it in all of them; its name, opacity, blend and eye are shared
// too. The file stores its drawing once (see serialize).

const shotsWith = (layer) => (layer ? state.shots.filter((s) => s.layers.includes(layer)) : []);

// The shot numbers a linked layer is in, for messages: "3 to 8", or "2, 5 and 9".
function shotList(layer) {
  const n = state.shots.map((s, i) => (s.layers.includes(layer) ? i + 1 : 0)).filter(Boolean);
  if (n.length > 2 && n[n.length - 1] - n[0] === n.length - 1) return `${n[0]} to ${n[n.length - 1]}`;
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}` : String(n[0] || '');
}

// Puts a layer into a shot at a place in its stack, or takes it out, without
// going to that shot.
async function placeLinked(shot, layer, index, add) {
  if (shot === mounted) {
    if (add) await insertLayer(Math.min(index, shot.layers.length), layer);
    else removeLayer(layer.id);
    return;
  }
  if (add) shot.layers.splice(Math.min(index, shot.layers.length), 0, layer);
  else {
    const i = shot.layers.indexOf(layer);
    if (i >= 0) shot.layers.splice(i, 1);
    if (shot.activeLayerId === layer.id && shot.layers.length) shot.activeLayerId = shot.layers[Math.max(0, i - 1)].id;
  }
  scheduleThumb(shot);
}

// What a message calls the picked layers: the folder's name when a whole
// folder is picked, else the layer's name, else "3 layers".
function pickedName(layers) {
  const g = layers[0] && layers[0].group;
  if (g && state.groups[g] && layers.every((l) => l.group === g) && groupMembers(mounted, g).length === layers.length) return state.groups[g].name;
  return layers.length === 1 ? layers[0].name : `${layers.length} layers`;
}

// Extend: the picked layers (one, several, or a whole folder) go into the
// next shot that does not have them all yet, in the same order. Each goes
// just above the layer under it here, if that shot has it, else at the same
// height. Pressing again carries them on.
const extendLayer = () => enqueue(async () => {
  if (!mounted) return;
  if (typeof lift !== 'undefined' && lift) dropSelection();
  const layers = selectedLayers();
  const name = pickedName(layers);
  let i = state.cur + 1;
  while (i < state.shots.length && layers.every((l) => state.shots[i].layers.includes(l))) i++;
  if (i >= state.shots.length) { toast(`${name} already runs to the last shot`); return; }
  const target = state.shots[i];
  const entries = [];
  for (const layer of layers) {
    if (target.layers.includes(layer)) continue;
    const k = mounted.layers.indexOf(layer);
    let index = Math.min(k, target.layers.length);
    for (let j = k - 1; j >= 0; j--) {
      const t = target.layers.indexOf(mounted.layers[j]);
      if (t >= 0) { index = t + 1; break; }
    }
    await placeLinked(target, layer, index, true);
    entries.push({ type: 'link', shotId: target.id, index, layer });
  }
  tidyGroups(target);
  pushHistory(entries.length === 1 ? entries[0] : { type: 'multi', shotId: mounted.id, entries });
  refreshUI();
  markDirty();
  toast(`${name} ${name.endsWith(' layers') ? 'are' : 'is'} linked in shots ${shotList(layers[0])}. Drawing on ${layers.length > 1 ? 'them' : 'it'} changes all of them`);
});

// Unlink: this shot gets its own copies of the picked linked layers, to
// change on their own; the other shots keep the linked ones.
const unlinkLayer = () => enqueue(async () => {
  if (!mounted) return;
  const layers = selectedLayers().filter((l) => shotsWith(l).length > 1);
  if (!layers.length) { toast('Nothing picked is linked to another shot'); return; }
  if (typeof lift !== 'undefined' && lift) dropSelection();
  commitLive();
  const entries = [];
  const copies = [];
  for (const layer of layers) {
    const copy = { ...newLayer(layer.name), visible: layer.visible, opacity: layer.opacity, parallax: layer.parallax ?? 1, blend: layer.blend || 'normal', group: layer.group || null, blob: await ensureBlob(layer) };
    const index = mounted.layers.indexOf(layer);
    removeLayer(layer.id);
    await insertLayer(index, copy);
    entries.push({ type: 'deleteLayer', shotId: mounted.id, index, layer }, { type: 'addLayer', shotId: mounted.id, index, layer: copy });
    copies.push(copy);
  }
  mounted.selLayers = new Set(copies.length > 1 ? copies.map((l) => l.id) : []);
  mounted.activeLayerId = copies[copies.length - 1].id;
  pushHistory({ type: 'multi', shotId: mounted.id, entries });
  layoutStack();
  refreshUI();
  markDirty();
  toast(`This shot has its own ${pickedName(copies)} now; the other shots keep the linked ${copies.length > 1 ? 'ones' : 'one'}`);
});

// ---------------------------------------------------------------- layer folders
//
// Folders of layers, one level deep, like Photoshop's groups. A layer's
// `group` is its folder's id; the folders' names and whether they are open
// are kept on the board (`state.groups`). A folder's layers always sit
// together in the stack. Because the folder is written on the layer, a linked
// layer is in the same folder in every shot it is in.

const groupMembers = (shot, g) => (shot && g ? shot.layers.filter((l) => l.group === g) : []);

// The stack's order and folders, to undo a change to them.
function layoutOf(shot) {
  return { order: [...shot.layers], groups: shot.layers.map((l) => l.group || null), defs: structuredClone(state.groups) };
}
function restoreLayout(shot, at) {
  shot.layers.splice(0, shot.layers.length, ...at.order);
  at.order.forEach((l, i) => { l.group = at.groups[i]; });
  state.groups = structuredClone(at.defs);
}

// Keeps each folder's layers together: any that drifted apart join the
// folder's top layer.
function tidyGroups(shot) {
  for (let pass = 0; pass < 20; pass++) {
    let moved = false;
    for (const g of new Set(shot.layers.map((l) => l.group).filter(Boolean))) {
      const idx = shot.layers.map((l, i) => (l.group === g ? i : -1)).filter((i) => i >= 0);
      if (idx[idx.length - 1] - idx[0] === idx.length - 1) continue;
      const members = idx.map((i) => shot.layers[i]);
      const rest = shot.layers.filter((l) => l.group !== g);
      const at = rest.indexOf(shot.layers[idx[idx.length - 1] + 1]);
      rest.splice(at < 0 ? rest.length : at, 0, ...members);
      shot.layers.splice(0, shot.layers.length, ...rest);
      moved = true;
      break;
    }
    if (!moved) return;
  }
}

// A folder no layer in any shot uses any more is forgotten.
function forgetEmptyGroups() {
  const used = new Set(state.shots.flatMap((s) => s.layers.map((l) => l.group)).filter(Boolean));
  for (const g of Object.keys(state.groups)) if (!used.has(g)) delete state.groups[g];
}

function pushLayout(shot, before) {
  pushHistory({ type: 'layout', shotId: shot.id, before, after: layoutOf(shot) });
  layoutStack();
  refreshUI();
  scheduleThumb();
  markDirty();
}

// Picks every layer in a folder (the folder's top layer is the one drawn on).
function selectGroup(shot, g, how = 'one') {
  const ids = groupMembers(shot, g).map((l) => l.id);
  if (!ids.length) return;
  const sel = shot.selLayers || (shot.selLayers = new Set());
  if (how === 'toggle') {
    sel.add(shot.activeLayerId);
    const all = ids.every((id) => sel.has(id));
    for (const id of ids) all ? sel.delete(id) : sel.add(id);
    if (!sel.size) sel.add(ids[ids.length - 1]);
    if (!sel.has(shot.activeLayerId)) shot.activeLayerId = [...sel].pop();
    shot.selGroup = null;
  } else {
    sel.clear();
    for (const id of ids) sel.add(id);
    shot.activeLayerId = ids[ids.length - 1];
    shot.selGroup = g;
  }
  if (sel.size < 2) sel.clear();
  layoutStack();
  refreshUI();
}

// Group (Ctrl+G): the picked layers go into a new folder where the top one
// is. If some of them are already in one folder and the rest in none, the
// rest join that folder instead.
const groupLayers = () => enqueue(async () => {
  if (!mounted) return;
  if (typeof lift !== 'undefined' && lift) dropSelection();
  const list = selectedLayers();
  if (!list.length) return;
  const before = layoutOf(mounted);
  const had = [...new Set(list.map((l) => l.group).filter(Boolean))];
  let g;
  if (had.length === 1 && list.some((l) => !l.group)) g = had[0];
  else {
    g = uid();
    const n = Object.keys(state.groups).length + 1;
    state.groups[g] = { name: `Folder ${n}`, open: true };
  }
  const topAt = mounted.layers.indexOf(list[list.length - 1]);
  const below = mounted.layers.filter((l, i) => i < topAt && !list.includes(l)).length;
  const rest = mounted.layers.filter((l) => !list.includes(l));
  rest.splice(below, 0, ...list);
  mounted.layers.splice(0, mounted.layers.length, ...rest);
  for (const l of list) l.group = g;
  tidyGroups(mounted);
  forgetEmptyGroups();
  selectGroup(mounted, g);
  pushLayout(mounted, before);
  toast(had.length === 1 && g === had[0] ? `Added to ${state.groups[g].name}` : `Grouped ${list.length} layer${list.length === 1 ? '' : 's'} into ${state.groups[g].name}. Double-click its name to rename it`);
});

// Ungroup (Ctrl+Shift+G): the picked folder's layers stay where they are,
// out of the folder.
const ungroupLayers = () => enqueue(async () => {
  if (!mounted) return;
  const al = activeLayer();
  const g = mounted.selGroup || (al && al.group);
  if (!g) { toast('Pick a folder to ungroup'); return; }
  const before = layoutOf(mounted);
  const name = state.groups[g] ? state.groups[g].name : 'the folder';
  for (const l of groupMembers(mounted, g)) l.group = null;
  mounted.selGroup = null;
  forgetEmptyGroups();
  pushLayout(mounted, before);
  toast(`Ungrouped ${name}`);
});

// Opens or closes a folder in the Layers list (not an undo step).
function toggleGroupOpen(g) {
  if (!state.groups[g]) return;
  state.groups[g].open = !state.groups[g].open;
  refreshUI();
  markDirty();
}

// Moves the selected layers up or down the stack together, keeping their order.
// With folders: a whole folder moves as one, steps over another folder in
// one go, and layers picked inside a folder leave it when they reach its edge.
const moveLayer = (dir) => enqueue(async () => {
  const layers = mounted.layers;
  const list = selectedLayers();
  const picked = new Set(list.map((l) => l.id));
  const at = layers.map((l, i) => (picked.has(l.id) ? i : -1)).filter((i) => i >= 0);
  if (!at.length) return;
  const n = dir > 0 ? at[at.length - 1] + 1 : at[0] - 1;
  const before = layoutOf(mounted);
  const own = list.every((l) => l.group && l.group === list[0].group) ? list[0].group : null;
  const wholeFolder = own && groupMembers(mounted, own).length === list.length;
  const next = layers[n];
  if (own && !wholeFolder && (!next || next.group !== own)) {
    // At the folder's edge: step out of it.
    for (const l of list) l.group = null;
    forgetEmptyGroups();
  } else {
    if (!next) return;
    // Over a whole other folder at once, or one layer.
    const span = next.group && next.group !== own ? groupMembers(mounted, next.group).length : 1;
    for (let k = 0; k < span; k++) {
      const idx = layers.map((l, i) => (picked.has(l.id) ? i : -1)).filter((i) => i >= 0);
      // Each steps past its neighbour, starting from the side they are heading to.
      for (const i of dir > 0 ? [...idx].reverse() : idx) [layers[i], layers[i + dir]] = [layers[i + dir], layers[i]];
    }
    tidyGroups(mounted);
  }
  pushLayout(mounted, before);
});

// Places a picture on a new layer above the current one, fitted inside the
// frame and centred.
const importImage = (bitmap, name) => enqueue(async () => {
  const idx = mounted.layers.findIndex((l) => l.id === mounted.activeLayerId) + 1;
  const layer = newLayer(name.replace(/\.[^.]+$/, '') || 'Image');
  await insertLayer(idx, layer);
  const k = Math.min(1, dims.W / bitmap.width, dims.H / bitmap.height);
  const w = bitmap.width * k;
  const h = bitmap.height * k;
  live.get(layer.id).getContext('2d').drawImage(bitmap, dims.FX + (dims.W - w) / 2, dims.FY + (dims.H - h) / 2, w, h);
  bitmap.close();
  layer.dirty = true;
  pushHistory({ type: 'addLayer', shotId: mounted.id, index: idx, layer });
  scheduleThumb();
  toast(`Added ${name} as a layer`);
});

const clearLayer = () => enqueue(async () => {
  const layer = activeLayer();
  const canvas = live.get(layer.id);
  // GPU snapshots for undo; reading pixels back to the CPU would stall.
  const before = createImageBitmap(canvas);
  canvas.getContext('2d').clearRect(0, 0, dims.CW, dims.CH);
  const after = createImageBitmap(canvas);
  layer.dirty = true;
  pushHistory({ type: 'pixels', shotId: mounted.id, layerId: layer.id, x: 0, y: 0, w: dims.CW, h: dims.CH, before, after });
  scheduleThumb();
});

// ---------------------------------------------------------------- view

// While the zoom is changing, the browser scales what it already drew instead
// of redrawing the frame shading and safe-area guides at every step (that cost
// a frame now and then mid-zoom). They redraw sharp once the zoom settles.
let viewZoom = 0;
let zoomSettle = 0;
// The current shot's caption, under the frame while drawing.
// The caption while drawing. With Show captions on it is drawn in the frame
// by the same code that burns it into the exported video (drawCaption), at
// the same place and size, so the editor shows what the export will. With it
// off, the caption is not exported, and shows under the frame as a note.
let captionTimer = 0;
function renderCaptionView() {
  const el = document.getElementById('captionView');
  const cv = document.getElementById('captionCanvas');
  if (!el || !cv) return;
  const shot = current();
  const text = shot && !playing ? (shot.notes || '').trim() : '';
  const inFrame = !!text && state.captions;
  cv.hidden = !inFrame;
  if (inFrame) {
    const z = state.view.z;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const k = Math.min(1, 3200 / (dims.W * z * dpr));
    const w = Math.max(1, Math.round(dims.W * z * dpr * k));
    const h = Math.max(1, Math.round(dims.H * z * dpr * k));
    const at = toScreen({ x: dims.FX, y: dims.FY });
    // Placed at once (stretching the last picture while zooming), redrawn
    // sharp when the zoom settles or the words change.
    cv.style.width = `${dims.W * z}px`;
    cv.style.height = `${dims.H * z}px`;
    cv.style.transform = `translate(${at.x}px, ${at.y}px) rotate(${state.view.r}rad)`;
    // What it says and how it is set, then how big it is on screen.
    const look = `${text}|${state.captionSize}|${state.captionBottom}`;
    const key = `${look}#${w}x${h}`;
    const draw = () => {
      captionTimer = 0;
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      drawCaption(ctx, shot, w, h);
      cv.dataset.key = key;
    };
    if (cv.dataset.key !== key) {
      clearTimeout(captionTimer);
      if (!cv.dataset.key || cv.dataset.key.slice(0, cv.dataset.key.lastIndexOf('#')) !== look) draw(); else captionTimer = setTimeout(draw, 120);
    }
  } else {
    clearTimeout(captionTimer);
    delete cv.dataset.key;
  }
  el.hidden = !text || inFrame;
  if (!text || inFrame) return;
  if (el.textContent !== text) el.textContent = text;
  const z = state.view.z;
  const x = state.view.x + (dims.FX + dims.W / 2) * z;
  const y = state.view.y + (dims.FY + dims.H) * z + 10;
  el.style.transform = `translate(${x}px, ${y}px) translateX(-50%)`;
  el.style.width = `${Math.max(160, dims.W * z)}px`;
}

// Draws a shot's caption as a subtitle: white text on a soft dark band, near
// the bottom inside title safe, wrapped to at most three lines.
function drawCaption(ctx, shot, w = dims.W, h = dims.H) {
  const text = state.captions && shot ? (shot.notes || '').trim() : '';
  if (!text) return;
  const size = Math.max(6, Math.round(h * (state.captionSize || 0.03)));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.font = `600 ${size}px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const maxW = w * 0.76;
  const lines = [];
  // Words wrap at spaces; Chinese, Japanese and Korean have none, so there a
  // line can break between any two characters (it used to run off the frame).
  const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3000-\u30ff]/;
  for (const para of text.split(/\n+/)) {
    const words = [];
    for (const chunk of para.split(/\s+/)) {
      let run = '';
      let first = true;
      for (const ch of chunk) {
        if (CJK.test(ch)) {
          if (run) { words.push({ t: run, space: first }); run = ''; first = false; }
          words.push({ t: ch, space: first });
          first = false;
        } else run += ch;
      }
      if (run) words.push({ t: run, space: first });
    }
    let line = '';
    for (const { t, space } of words) {
      const next = line ? `${line}${space ? ' ' : ''}${t}` : t;
      if (line && ctx.measureText(next).width > maxW) { lines.push(line); line = t; } else line = next;
    }
    if (line) lines.push(line);
  }
  if (lines.length > 3) { lines.length = 3; lines[2] += '...'; }
  const lh = size * 1.3;
  const boxW = Math.min(w * 0.84, Math.max(...lines.map((l) => ctx.measureText(l).width)) + size * 1.2);
  const boxH = lines.length * lh + size * 0.6;
  const bottom = h * (1 - (state.captionBottom ?? 0.035));
  ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
  ctx.fillRect(Math.round(w / 2 - boxW / 2), Math.round(bottom - boxH), Math.round(boxW), Math.round(boxH));
  ctx.fillStyle = '#fff';
  lines.forEach((l, i) => ctx.fillText(l, w / 2, bottom - boxH + size * 0.3 + lh * (i + 0.5)));
  ctx.restore();
}

// Burn-in for an exported video: the running timecode (hours:minutes:
// seconds:frames) top left, and the shot number top right, on dark tabs.
function burnTimecode(frame) {
  const fps = state.fps;
  const f = Math.max(0, Math.floor(frame));
  const pad = (n) => String(n).padStart(2, '0');
  const secs = Math.floor(f / fps);
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}:${pad(f % fps)}`;
}
function drawBurnIn(ctx, { frame = null, shot = null }, w = dims.W, h = dims.H) {
  const size = Math.round(h * 0.034);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.font = `600 ${size}px Consolas, "Cascadia Mono", ui-monospace, Menlo, monospace`;
  ctx.textBaseline = 'middle';
  const tab = (text, right) => {
    const tw = ctx.measureText(text).width;
    const bw = tw + size * 0.9;
    const bh = size * 1.5;
    const x = right ? w - bw - size * 0.6 : size * 0.6;
    const y = size * 0.6;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    // Square corners (her call), like a broadcast burn-in.
    ctx.fillRect(x, y, bw, bh);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.fillText(text, x + size * 0.45, y + bh / 2 + size * 0.04);
  };
  if (frame !== null) tab(burnTimecode(frame), false);
  if (shot !== null) tab(`Shot ${shot}`, true);
  ctx.restore();
}

// Shift, like Photoshop: a drag is held to the nearest of horizontal,
// vertical or 45 degrees.
function constrain45(dx, dy) {
  const step = Math.PI / 4;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  const len = dx * Math.cos(a) + dy * Math.sin(a);
  return { dx: len * Math.cos(a), dy: len * Math.sin(a) };
}

function applyView() {
  const { x, y, z, r } = state.view;
  if (z !== viewZoom) {
    if (viewZoom) {
      stage.style.willChange = 'transform';
      clearTimeout(zoomSettle);
      zoomSettle = setTimeout(() => { stage.style.willChange = ''; }, 150);
    }
    viewZoom = z;
  }
  stage.style.transform = `translate(${x}px, ${y}px) rotate(${r}rad) scale(${z})`;
  if (typeof renderCameraBoxes === 'function') renderCameraBoxes();
  if (typeof renderGrid === 'function') renderGrid();
  if (typeof refreshCursorSoon === 'function') refreshCursorSoon();
  renderCaptionView();
  if (typeof renderMoveBox === 'function') renderMoveBox();
  if (typeof renderFilterMark === 'function') renderFilterMark();
}

// Fits the frame (not the whole drawing area) to the screen, upright.
function fitView() {
  const r = viewport.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const z = Math.min((r.width - 96) / dims.W, (r.height - 96) / dims.H);
  state.view = {
    z,
    r: 0,
    x: r.width / 2 - (dims.FX + dims.W / 2) * z,
    y: r.height / 2 - (dims.FY + dims.H / 2) * z,
    fit: true,
  };
  applyView();
}

function zoomAt(clientX, clientY, factor) {
  const r = viewport.getBoundingClientRect();
  const v = state.view;
  const z = clamp(v.z * factor, 0.03, 8);
  const px = clientX - r.left;
  const py = clientY - r.top;
  v.x = px - ((px - v.x) * z) / v.z;
  v.y = py - ((py - v.y) * z) / v.z;
  v.z = z;
  v.fit = false;
  applyView();
}

// Screen (client) position to layer position, and layer position to a
// position inside the viewport. vr is the viewport's on-screen box.
function toCanvas(e, vr = viewport.getBoundingClientRect()) {
  const { x, y, z, r } = state.view;
  const px = e.clientX - vr.left - x;
  const py = e.clientY - vr.top - y;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: (px * c + py * s) / z, y: (-px * s + py * c) / z };
}

function toScreen(p) {
  const { x, y, z, r } = state.view;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: x + (p.x * c - p.y * s) * z, y: y + (p.x * s + p.y * c) * z };
}

// Turns the canvas by da radians around a point in the viewport.
function rotateAt(px, py, da) {
  const v = state.view;
  const c = Math.cos(da);
  const s = Math.sin(da);
  const dx = v.x - px;
  const dy = v.y - py;
  v.x = px + dx * c - dy * s;
  v.y = py + dx * s + dy * c;
  v.r += da;
  v.fit = false;
  applyView();
}

// ---------------------------------------------------------------- canvas size

// Moves every layer onto a canvas of the new size, keeping the frame centres
// lined up, so drawings stay put when the frame grows or shrinks.
async function relayoutLayers(from, to) {
  const dx = to.FX + to.W / 2 - (from.FX + from.W / 2);
  const dy = to.FY + to.H / 2 - (from.FY + from.H / 2);
  // A linked layer is in several shots but is moved once.
  const done = new Set();
  for (const shot of state.shots) {
    for (const layer of shot.layers) {
      if (done.has(layer)) continue;
      done.add(layer);
      const blob = await ensureBlob(layer);
      if (!blob) continue;
      const bm = await createImageBitmap(blob);
      const off = new OffscreenCanvas(to.CW, to.CH);
      off.getContext('2d').drawImage(bm, Math.round(dx), Math.round(dy));
      bm.close();
      layer.blob = await off.convertToBlob({ type: 'image/png' });
      layer.snap = null;
      layer.version++;
    }
  }
}

const resizeCanvas = (w, h, fps) => enqueue(async () => {
  w = clamp(Math.round(w), 64, 8192);
  h = clamp(Math.round(h), 64, 8192);
  const sizeChanged = w !== dims.W || h !== dims.H;
  if (sizeChanged) {
    commitLive();
    const from = { ...dims };
    const to = computeDims(w, h);
    toast('Resizing the canvas...');
    await relayoutLayers(from, to);
    // The pixel undo steps no longer line up with the resized layers.
    clearHistory();
    mounted = null;
    live.clear();
    setDims(w, h);
    sizeSelectionLayer();
    renderGuides();
  }
  if (fps && fps !== state.fps) {
    for (const s of state.shots) s.duration = Math.max(1, Math.round((s.duration * fps) / state.fps));
    if (state.audio) state.audio.offset = Math.round((state.audio.offset * fps) / state.fps);
    // The reference video keeps its place in seconds too.
    if (state.reference) state.reference.offset = Math.round((state.reference.offset * fps) / state.fps);
    state.time = Math.round((state.time * fps) / state.fps);
    state.fps = fps;
  }
  if (sizeChanged) {
    for (const s of state.shots) await updateThumb(s);
    await doSelect(Math.max(0, state.cur), { moveTime: false });
    fitView();
  }
  markDirty();
  refreshUI();
});
