'use strict';
// Playing the animatic, scrubbing the playhead, and the audio track.

const playerEl = $('#player');
const playerCanvas = $('#playerCanvas');
const pctx = playerCanvas.getContext('2d');

let playing = null;
let scrub = null;
let audioCtx = null;

function showPlayer() {
  if (playerCanvas.width !== dims.W || playerCanvas.height !== dims.H) {
    playerCanvas.width = dims.W;
    playerCanvas.height = dims.H;
  }
  playerEl.hidden = false;
  hideCursor();
  renderCameraBoxes();
  renderGrid();
}

function hidePlayer() {
  playerEl.hidden = true;
  renderCameraBoxes();
  renderGrid();
}

// Each shot is rendered once per session, covering everything its camera will
// see, then every frame is a quick crop of that.
const referenceShown = () => !!(state.reference && state.reference.visible);

// background: false leaves the paper transparent so the reference video shows
// through in playback. Exports always pass true.
function frameSource(cache, shot, background = !referenceShown(), maxSide = 4096) {
  let entry = cache.get(shot.id);
  if (entry) return entry;
  if (hasParallax(shot)) {
    entry = { ready: null };
    entry.promise = parallaxSource(shot, background, maxSide).then((ready) => { entry.ready = ready; return entry; });
    cache.set(shot.id, entry);
    return entry;
  }
  let rect = camRect(null);
  if (shot.camera) {
    const a = camRect(shot.camera.start);
    const b = camRect(shot.camera.end);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    rect = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  }
  const scale = Math.min(1, maxSide / Math.max(rect.w, rect.h));
  entry = { ready: null };
  entry.promise = renderRegion(shot, rect, rect.w * scale, rect.h * scale, { background }).then((off) => {
    entry.ready = { rect, scale, bm: off.transferToImageBitmap() };
    return entry;
  });
  cache.set(shot.id, entry);
  return entry;
}

// Scrubbing keeps a preview-size copy of every shot between scrubs, rebuilt
// only when the shot changes, and fills them in while the app is idle. Before,
// each scrub started from nothing, and crossing into a shot meant decoding its
// layers and compositing them at full size right then, which stalled the
// timeline every time the playhead entered a new shot.
const SCRUB_SIDE = 1280;
const scrubFrames = new Map(); // shot id -> { key, entry }
const scrubMisses = []; // for the perf test

function scrubKey(shot) {
  return [referenceShown(), dims.CW, dims.CH, dims.FX, dims.FY, JSON.stringify(shot.camera || null),
    ...shot.layers.map((l) => `${l.id}:${l.version}:${l.visible}:${l.opacity}:${l.parallax ?? 1}:${l.blend || 'normal'}`)].join('|');
}

// The previews are kept within a memory budget: past it, the ones for the
// shots furthest from the current one are let go (they are rebuilt if the
// playhead gets there). A long board used to keep one for every shot.
const SCRUB_BYTES = (typeof isWeb !== 'undefined' && isWeb ? 96 : 320) * 1024 * 1024;
function scrubLimit() {
  const k = SCRUB_SIDE / Math.max(dims.W, dims.H);
  const each = Math.max(1, dims.W * k * dims.H * k * 4);
  return Math.max(8, Math.floor(SCRUB_BYTES / each));
}
function trimScrubFrames(keepId = null) {
  const limit = scrubLimit();
  if (scrubFrames.size <= limit) return;
  const at = new Map(state.shots.map((s, i) => [s.id, i]));
  const far = [...scrubFrames.keys()].filter((id) => id !== keepId).sort((a, b) => Math.abs((at.get(b) ?? 1e9) - state.cur) - Math.abs((at.get(a) ?? 1e9) - state.cur));
  for (const id of far) {
    if (scrubFrames.size <= limit) break;
    scrubFrames.get(id).entry.promise.then(disposeFrameSource, () => {});
    scrubFrames.delete(id);
  }
}
// Lets every preview go (when memory is short).
function dropScrubFrames() {
  for (const [, { entry }] of scrubFrames) entry.promise.then(disposeFrameSource, () => {});
  scrubFrames.clear();
}

function scrubSource(shot) {
  const key = scrubKey(shot);
  const hit = scrubFrames.get(shot.id);
  if (hit && hit.key === key) return hit.entry;
  if (hit) hit.entry.promise.then(disposeFrameSource);
  if (scrub) scrubMisses.push(hit ? 'stale' : 'missing');
  const entry = frameSource(new Map(), shot, !referenceShown(), SCRUB_SIDE);
  // A preview that could not be made is forgotten, so it is tried again later.
  entry.promise.catch(() => { if ((scrubFrames.get(shot.id) || {}).entry === entry) scrubFrames.delete(shot.id); });
  scrubFrames.set(shot.id, { key, entry });
  trimScrubFrames(shot.id);
  return entry;
}

function pruneScrubFrames() {
  const ids = new Set(state.shots.map((s) => s.id));
  for (const [id, { entry }] of scrubFrames) {
    if (ids.has(id)) continue;
    entry.promise.then(disposeFrameSource);
    scrubFrames.delete(id);
  }
}

// Builds one out-of-date shot at a time when nothing else is going on. The
// shot being drawn on is skipped: it changes with every stroke, and a scrub
// brings it up to date itself. It also waits out quick runs of strokes: each
// shot it builds loads its layers onto the graphics chip, which held the
// screen ~100ms, and right after opening a big board it ran between strokes
// (measured: 7 layers x 40 shots, 150 late frames while drawing, 2 once done).
const WARM_IDLE_MS = 1500;
let warmTimer = 0;
let warming = false;
function warmScrubFrames() {
  if (warmTimer || warming) return;
  warmTimer = setTimeout(() => { warmTimer = 0; warming = true; requestIdleCallback(warmStep, { timeout: 2000 }); }, 500);
}
function warmStep() {
  const drawing = typeof lastInput !== 'undefined' && performance.now() - lastInput < WARM_IDLE_MS;
  if (stroke || playing || scrub || busy || drawing) { warming = false; warmScrubFrames(); return; }
  pruneScrubFrames();
  // The nearest shots first, as many as the budget holds.
  const near = state.shots.map((s, i) => ({ s, d: Math.abs(i - state.cur) })).filter(({ s }) => s !== mounted).sort((a, b) => a.d - b.d).slice(0, scrubLimit() - 1);
  const next = near.find(({ s }) => (scrubFrames.get(s.id) || {}).key !== scrubKey(s));
  if (!next) { warming = false; return; }
  const again = () => requestIdleCallback(warmStep, { timeout: 2000 });
  scrubSource(next.s).promise.then(again, () => { warming = false; });
}

// With parallax, each layer is kept on its own, covering everything its own
// view of the camera move will show, and they are stacked per frame.
async function parallaxSource(shot, background, maxSide) {
  const layers = [];
  for (const layer of shot.layers) {
    if (!layer.visible) continue;
    const k = layer.parallax ?? 1;
    const a = camRect(layerCam(shot, 0, k));
    const b = camRect(layerCam(shot, 1, k));
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const rect = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
    const scale = Math.min(1, maxSide / Math.max(rect.w, rect.h));
    const off = new OffscreenCanvas(Math.max(1, Math.round(rect.w * scale)), Math.max(1, Math.round(rect.h * scale)));
    const ctx = off.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    await drawLayerInto(ctx, layer, rect, off.width, off.height);
    layers.push({ k, rect, scale, opacity: layer.opacity, op: blendOf(layer).op, bm: off.transferToImageBitmap() });
  }
  return { layers, background };
}

function disposeFrameSource(e) {
  if (!e || !e.ready) return;
  if (e.ready.layers) for (const l of e.ready.layers) l.bm.close();
  else e.ready.bm.close();
}

function drawFrame(ctx, entry, shot, t, w = dims.W, h = dims.H) {
  if (entry.ready.layers) {
    if (entry.ready.background) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
    for (const l of entry.ready.layers) {
      const r = camRect(layerCam(shot, t, l.k));
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = l.op || 'source-over';
      ctx.drawImage(l.bm, (r.x - l.rect.x) * l.scale, (r.y - l.rect.y) * l.scale, r.w * l.scale, r.h * l.scale, 0, 0, w, h);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    return;
  }
  const { rect, scale, bm } = entry.ready;
  const r = camRect(camAt(shot, t));
  ctx.drawImage(bm, (r.x - rect.x) * scale, (r.y - rect.y) * scale, r.w * scale, r.h * scale, 0, 0, w, h);
}

function closeCache(cache, keep = null) {
  for (const [id, entry] of cache) {
    if (keep && keep.has(id)) continue;
    entry.promise.then(disposeFrameSource);
    cache.delete(id);
  }
}

// Where in the board a frame falls: which shot, and how far through it (0-1).
function locate(frame) {
  const i = shotIndexAt(frame);
  const start = shotStarts()[i];
  const shot = state.shots[i];
  return { i, shot, t: (frame - start) / shot.duration };
}

// ---------------------------------------------------------------- playback

function togglePlay() {
  if (playing) stopPlay();
  else if (!stroke) enqueue(startPlay);
}

async function startPlay() {
  if (lift) dropSelection();
  commitLive();
  const total = totalFrames();
  if (state.time >= total - 0.5) state.time = 0;
  const pl = { t0: 0, f0: state.time, total, cache: new Map(), raf: 0, lastKey: null, audio: null };
  playing = pl;
  pl.withRef = referenceShown();
  refreshUI();
  // Pre-roll: the first shot is put together before the clock, the sound and
  // the video start. Starting at once showed the bare reference video for the
  // first second or two while the board was still being built.
  const { shot } = locate(pl.f0);
  const first = frameSource(pl.cache, shot);
  if (!first.ready) {
    await first.promise;
    if (playing !== pl) return;
  }
  if (pl.withRef) {
    const rt = refTimeAt(pl.f0);
    if (rt !== null) await seekReference(rt);
    if (playing !== pl) return;
  }
  // Shown only now, so the last playback's picture cannot flash up meanwhile.
  showPlayer();
  pl.t0 = performance.now();
  pl.audio = startAudio(pl.f0);
  tick(pl.t0);
}

// The picture for a shot: its full-size render, or while that is still being
// made, the preview-size copy kept for scrubbing (null if neither is ready).
function playPicture(pl, shot) {
  const entry = pl.cache.get(shot.id);
  if (entry && entry.ready) return entry;
  const kept = scrubFrames.get(shot.id);
  return kept && kept.entry.ready && kept.key === scrubKey(shot) ? kept.entry : null;
}

function tick(now) {
  const pl = playing;
  if (!pl) return;
  const f = pl.f0 + ((now - pl.t0) / 1000) * state.fps;
  if (f >= pl.total) {
    state.time = pl.total;
    stopPlay();
    return;
  }
  state.time = f;
  const { i, shot, t } = locate(f);
  const keep = new Set();
  for (let k = 0; k < 4 && i + k < state.shots.length; k++) {
    const s = state.shots[i + k];
    keep.add(s.id);
    frameSource(pl.cache, s);
  }
  closeCache(pl.cache, keep);
  const entry = playPicture(pl, shot);
  const key = shot.camera ? `${shot.id}@${Math.floor(f)}` : shot.id;
  if (!entry) {
    // Not ready yet (a heavy shot coming up fast): keep the last picture
    // rather than show the video, or the previous shot, on its own.
    placePlayhead(true);
    pl.raf = requestAnimationFrame(tick);
    return;
  }
  if (pl.withRef) {
    // Keep the reference video playing in step, and redraw every frame.
    const rt = refTimeAt(f);
    if (rt === null) { if (!refVideo.paused) refVideo.pause(); }
    else {
      if (Math.abs(refVideo.currentTime - rt) > 0.15) refVideo.currentTime = rt;
      if (refVideo.paused) refVideo.play().catch(() => {});
    }
    pctx.fillStyle = '#fff';
    pctx.fillRect(0, 0, dims.W, dims.H);
    if (rt !== null) drawReferenceFrame(pctx, camAt(shot, t));
    drawFrame(pctx, entry, shot, t);
    drawCaption(pctx, shot);
  } else if (key !== pl.lastKey || entry !== pl.lastEntry) {
    pl.lastEntry = entry;
    drawFrame(pctx, entry, shot, t);
    drawCaption(pctx, shot);
    pl.lastKey = key;
  }
  placePlayhead(true);
  pl.raf = requestAnimationFrame(tick);
}

function stopPlay() {
  const pl = playing;
  if (!pl) return;
  playing = null;
  cancelAnimationFrame(pl.raf);
  if (pl.audio) { try { pl.audio.stop(); } catch {} }
  refVideo.pause();
  closeCache(pl.cache);
  hidePlayer();
  const total = totalFrames();
  selectShot(shotIndexAt(Math.min(state.time, total - 1)), { moveTime: false });
}

// ---------------------------------------------------------------- scrubbing

function scrubTo(frame) {
  if (!scrub) {
    if (lift) dropSelection();
    commitLive();
    pruneScrubFrames();
    keepRefStill();
    scrub = { frame };
    showPlayer();
  }
  scrub.frame = frame;
  state.time = frame;
  placePlayhead();
  const { shot } = locate(frame);
  const entry = scrubSource(shot);
  const s = scrub;
  // The boards draw as soon as they are ready; the reference video catches up
  // as its seeks land (see requestRefSeek), redrawing this view each time.
  entry.promise.then(() => { if (scrub === s && s.frame === frame) requestScrubDraw(s); });
}

// At most one redraw of the full-size preview per screen frame, however many
// pen events and video seeks arrive in between.
function requestScrubDraw(s) {
  if (s.raf) return;
  s.raf = requestAnimationFrame(() => {
    s.raf = 0;
    if (scrub === s) drawScrubFrame(s);
  });
}

function drawScrubFrame(s) {
  const { shot, t } = locate(s.frame);
  const entry = scrubSource(shot);
  if (!entry.ready) return;
  if (referenceShown()) {
    pctx.fillStyle = '#fff';
    pctx.fillRect(0, 0, dims.W, dims.H);
    if (refTimeAt(s.frame) !== null) drawReferenceFrame(pctx, camAt(shot, t), refPicture());
  }
  drawFrame(pctx, entry, shot, t);
  drawCaption(pctx, shot);
}

function endScrub() {
  if (!scrub) return;
  cancelAnimationFrame(scrub.raf);
  scrub = null;
  warmScrubFrames();
  hidePlayer();
  selectShot(shotIndexAt(state.time), { moveTime: false });
}

// ---------------------------------------------------------------- audio

function startAudio(frame) {
  const a = state.audio;
  if (!a || a.muted) return null;
  audioCtx = audioCtx || new AudioContext();
  audioCtx.resume();
  const src = audioCtx.createBufferSource();
  src.buffer = a.buffer;
  src.connect(audioCtx.destination);
  const into = (frame - a.offset) / state.fps; // seconds into the audio file
  if (into >= a.buffer.duration) return null;
  if (into >= 0) src.start(0, into);
  else src.start(audioCtx.currentTime - into, 0);
  return src;
}

// Peak level per 1/200 s, for drawing the waveform.
function computePeaks(buffer) {
  const per = Math.max(1, Math.floor(buffer.sampleRate / 200));
  const n = Math.ceil(buffer.length / per);
  const peaks = new Float32Array(n);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      let m = peaks[i];
      const end = Math.min(data.length, (i + 1) * per);
      for (let j = i * per; j < end; j++) {
        const v = Math.abs(data[j]);
        if (v > m) m = v;
      }
      peaks[i] = m;
    }
  }
  return peaks;
}

const AUDIO_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac' };

async function loadAudio(bytes, name, mime, offset = 0, { record = true } = {}) {
  audioCtx = audioCtx || new AudioContext();
  let buffer;
  try {
    buffer = await audioCtx.decodeAudioData(bytes.slice().buffer);
  } catch {
    toast(`Could not read ${name} as audio`);
    return;
  }
  const ext = (name.split('.').pop() || '').toLowerCase();
  state.audio = { name, mime: mime || AUDIO_TYPES[ext] || 'audio/mpeg', bytes, buffer, peaks: computePeaks(buffer), offset, muted: false };
  if (record) { markDirty(); toast(`Added ${name}`); }
  refreshUI();
}

function removeAudio() {
  state.audio = null;
  markDirty();
  refreshUI();
}

async function importAudio() {
  const res = await window.api.openAudio();
  if (res) await loadAudio(res.bytes, res.name, null, 0);
}
