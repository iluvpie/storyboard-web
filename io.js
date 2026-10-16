'use strict';
// Saving, opening, new boards, canvas size and video export.

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const bytesToBase64 = (bytes) => blobToBase64(new Blob([bytes]));

function applyDims(w, h) {
  setDims(w, h);
  sizeSelectionLayer();
  renderGuides();
  layoutReference();
  fitView();
}

// pack turns a PNG blob or the audio bytes into what goes in the file. By
// default that is base64 text; saving instead sends only what changed (see save).
const packBase64 = (b) => (b instanceof Blob ? blobToBase64(b) : bytesToBase64(b));

async function serialize(pack = packBase64) {
  // Called through enqueue too, which passes its own argument.
  if (typeof pack !== 'function') pack = packBase64;
  if (lift) dropSelection();
  commitLive();
  const shots = [];
  // A linked layer (one shared by several shots) is written out in full in
  // the first shot it is in; the later shots name it by id.
  const written = new Set();
  for (const s of state.shots) {
    const layers = [];
    for (const l of s.layers) {
      if (written.has(l)) { layers.push({ id: l.id, link: true }); continue; }
      written.add(l);
      const blob = await ensureBlob(l);
      layers.push({ id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, parallax: l.parallax ?? 1, blend: l.blend || 'normal', group: l.group || undefined, png: blob ? await pack(blob) : null });
    }
    shots.push({ id: s.id, duration: s.duration, activeLayerId: s.activeLayerId, camera: s.camera, grid: s.grid || null, notes: s.notes || '', thumb: s.thumbPng || null, layers });
  }
  const a = state.audio;
  return {
    app: 'storyboard-app',
    version: 2,
    // Which board this is, so its backups stay together wherever the file goes.
    id: state.boardId,
    fps: state.fps,
    width: dims.W,
    height: dims.H,
    layerSize: [dims.CW, dims.CH],
    shots,
    captions: !!state.captions,
    captionSize: state.captionSize,
    captionBottom: state.captionBottom,
    sheetPerPage: state.sheetPerPage,
    groups: Object.keys(state.groups).length ? state.groups : undefined,
    audio: a ? { name: a.name, mime: a.mime, offset: a.offset, muted: !!a.muted, data: await pack(a.bytes) } : null,
    // Only the path: the video stays where it is on disk.
    reference: state.reference ? {
      path: state.reference.path, proxy: state.reference.proxy, offset: state.reference.offset,
      opacity: state.reference.opacity, visible: state.reference.visible,
    } : null,
  };
}

// `opened`: what the desktop app's main process read from a file, with the
// drawings as bytes (parts) and the keys it holds them under. Without it (the
// web version, older callers) the drawings are base64 inside `data`.
async function loadData(data, filePath, opened = null) {
  // A drawing or the sound: bytes cut out of the file, or base64 in place.
  const bytesOf = (v) => {
    const m = opened && typeof v === 'string' && /^@@PART(\d+)@@$/.exec(v);
    if (!m) return { bytes: v ? base64ToBytes(v) : null, key: null };
    return { bytes: opened.parts[Number(m[1])], key: opened.keys ? opened.keys[Number(m[1])] : null };
  };
  const drawing = (v) => {
    const { bytes, key } = bytesOf(v);
    if (!bytes) return null;
    const blob = new Blob([bytes], { type: 'image/png' });
    // Already held by the main process: no need to send it on the next save.
    if (key) sentParts.set(blob, key);
    return blob;
  };
  if (!data || data.app !== 'storyboard-app') throw new Error('This is not a storyboard project file');
  const v1 = data.version === 1;
  const list = v1 ? data.panels : data.shots;
  if (!Array.isArray(list) || !list.length) throw new Error('This project has no shots');
  const fps = data.fps || 24;
  const w = v1 ? 1920 : data.width;
  const h = v1 ? 1080 : data.height;
  // Version 1 layers were exactly the frame; later ones have room around it.
  const stored = v1
    ? { W: 1920, H: 1080, FX: 0, FY: 0, CW: 1920, CH: 1080 }
    : { W: w, H: h, CW: data.layerSize[0], CH: data.layerSize[1], FX: (data.layerSize[0] - w) / 2, FY: (data.layerSize[1] - h) / 2 };

  if (lift) { lift = null; floatCanvas.style.display = 'none'; }
  setSelection(null);
  clearHistory();
  mounted = null;
  live.clear();
  state.cur = -1;
  state.fps = fps;
  // A board saved before boards had an id gets one from its path, so it is
  // the same each time the file is opened until it is next saved.
  state.boardId = data.id || (filePath ? `p${[...filePath].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7).toString(16)}` : uid());
  state.captions = !!data.captions;
  state.captionSize = Number(data.captionSize) > 0 ? Number(data.captionSize) : 0.03;
  state.captionBottom = Number(data.captionBottom) >= 0 && data.captionBottom != null ? Number(data.captionBottom) : 0.035;
  state.sheetPerPage = Number(data.sheetPerPage) >= 1 ? Math.round(data.sheetPerPage) : 6;
  state.groups = data.groups && typeof data.groups === 'object' ? structuredClone(data.groups) : {};
  // Linked layers: a later shot names the layer by id, and gets the same one.
  const byId = new Map();
  const layerOf = (l) => {
    if (l.link && byId.has(l.id)) return byId.get(l.id);
    const layer = {
      ...newLayer(l.name || 'Layer'),
      id: l.id || uid(),
      visible: l.visible !== false,
      opacity: l.opacity ?? 1,
      blend: BLENDS[l.blend] ? l.blend : 'normal',
      parallax: l.parallax ?? 1,
      group: l.group && state.groups[l.group] ? l.group : null,
      blob: drawing(l.png),
    };
    if (!byId.has(layer.id)) byId.set(layer.id, layer);
    return layer;
  };
  state.shots = list.map((s) => ({
    id: s.id || uid(),
    duration: Math.max(1, Math.round(s.duration) || 2 * fps),
    activeLayerId: s.activeLayerId,
    camera: s.camera || null,
    grid: s.grid || null,
    notes: s.notes || '',
    thumb: null,
    // The timeline picture saved with the board (remade when the shot changes).
    thumbPng: typeof s.thumb === 'string' && s.thumb ? s.thumb : null,
    thumbUrl: typeof s.thumb === 'string' && s.thumb ? `data:image/png;base64,${s.thumb}` : null,
    layers: s.layers.map(layerOf),
  }));
  const target = computeDims(w, h);
  if (stored.CW !== target.CW || stored.CH !== target.CH || stored.FX !== target.FX) await relayoutLayers(stored, target);
  applyDims(w, h);
  state.audio = null;
  if (data.audio) {
    const sound = bytesOf(data.audio.data);
    await loadAudio(sound.bytes, data.audio.name, data.audio.mime, data.audio.offset || 0, { record: false });
    if (state.audio) {
      state.audio.muted = !!data.audio.muted;
      if (sound.key) sentParts.set(state.audio.bytes, sound.key);
    }
  }
  clearReference();
  if (data.reference && data.reference.path) {
    const ref = data.reference;
    const ok = await loadReference(ref.path, { offset: ref.offset || 0, opacity: ref.opacity ?? 0.5, visible: ref.visible !== false, record: false, proxy: ref.proxy || null });
    if (!ok) toast(`The reference video was not found: ${ref.path.split(/[\\/]/).pop()}`);
  }
  state.cur = -1;
  state.time = 0;
  state.path = filePath;
  await doSelect(0);
  state.dirty = false;
  updateTitle();
  fitTimeline();
}

// Saving used to turn every drawing in the board into text and build one huge
// file here, every time, which froze drawing for up to ~80ms on a 40-shot
// board (autosave runs every two minutes). Now only drawings that changed
// since the last save are sent, as raw bytes, and the app's main process,
// which keeps the rest, turns them into text and writes the file in pieces.
// The file is exactly the same as before.
let lastSaveParts = 0; // how many drawings the last save sent (for the self-test)
let sentParts = new WeakMap(); // blob or audio bytes -> the key the main process holds it under

async function writeProject(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const parts = [];
    const fresh = [];
    const data = await serialize(async (b) => {
      let key = sentParts.get(b);
      if (!key) {
        key = uid();
        parts.push({ key, bytes: b instanceof Blob ? new Uint8Array(await b.arrayBuffer()) : b });
        fresh.push([b, key]);
      }
      return { $part: key };
    });
    lastSaveParts = parts.length;
    const res = await window.api.saveProjectParts(path, data, parts);
    if (res && res.missing) { sentParts = new WeakMap(); continue; }
    if (res && res.path) for (const [b, key] of fresh) sentParts.set(b, key);
    return res ? res.path : null;
  }
  return null;
}

async function save(saveAs = false) {
  return enqueue(async () => {
    const saved = await writeProject(saveAs ? null : state.path);
    if (!saved) return false;
    state.path = saved;
    state.dirty = false;
    updateTitle();
    toast('Saved');
    return true;
  }, { blocking: false });
}

// Returns true when it is OK to throw away the current board.
async function confirmDiscard() {
  if (!state.dirty) return true;
  const choice = await window.api.askUnsaved();
  if (choice === 0) return save();
  return choice === 1;
}

async function openProject() {
  if (stroke || playing || !(await confirmDiscard())) return;
  const res = await window.api.openProject();
  if (!res) return;
  let data;
  try { data = JSON.parse(res.text); } catch { toast('Could not read that file'); return; }
  await enqueue(() => loadData(data, res.path, res.parts ? res : null));
}

async function loadBlank(w = 1920, h = 1080, fps = 24) {
  if (lift) { lift = null; floatCanvas.style.display = 'none'; }
  setSelection(null);
  clearHistory();
  mounted = null;
  live.clear();
  state.cur = -1;
  state.fps = fps;
  applyDims(w, h);
  state.shots = [newShot()];
  state.groups = {};
  state.audio = null;
  clearReference();
  state.cur = -1;
  state.time = 0;
  state.path = null;
  state.boardId = uid();
  await doSelect(0);
  state.dirty = false;
  updateTitle();
}

window.api.onRequestClose(async () => {
  if (stroke) return;
  if (await confirmDiscard()) window.api.confirmClose();
});

// Autosave waits for a pause. Saving has to copy the drawing being worked on
// back from the graphics chip, and that holds up the screen for a moment
// (~100ms on this laptop), so it happens when the pen is still: two minutes
// after the last save, once nothing has been touched for 2.5 seconds, or at
// the latest after ten minutes of non-stop work.
const AUTOSAVE_IDLE_MS = 2500;
const AUTOSAVE_LATEST_MS = 10 * 60 * 1000;
let lastInput = 0;
let lastSave = performance.now();
for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel']) {
  window.addEventListener(type, () => { lastInput = performance.now(); }, { capture: true, passive: true });
}
function autosaveDue(now, input = lastInput, saved = lastSave) {
  const waited = now - saved;
  return waited >= AUTOSAVE_LATEST_MS || (waited >= AUTOSAVE_MS && now - input >= AUTOSAVE_IDLE_MS);
}
setInterval(() => {
  if (!state.path || !state.dirty || stroke || playing || lift) return;
  if (!autosaveDue(performance.now())) return;
  lastSave = performance.now();
  save();
}, 1000);

// ---------------------------------------------------------------- canvas dialog

const CANVAS_PRESETS = [
  { name: 'HD 16:9', w: 1920, h: 1080 },
  { name: 'HD 720', w: 1280, h: 720 },
  { name: 'Scope 2.39:1', w: 2048, h: 858 },
  { name: 'Flat 1.85:1', w: 1998, h: 1080 },
  { name: 'Vertical 9:16', w: 1080, h: 1920 },
  { name: 'Square', w: 1080, h: 1080 },
  { name: '4K UHD', w: 3840, h: 2160 },
];

const canvasDialog = $('#canvasDialog');
let canvasDialogMode = 'resize';

function openCanvasDialog(mode) {
  canvasDialogMode = mode;
  $('#cdTitle').textContent = mode === 'new' ? 'New board' : 'Canvas';
  $('#cdApply').textContent = mode === 'new' ? 'Create' : 'Apply';
  $('#cdNote').textContent = mode === 'new'
    ? 'You can change the size later. Drawings stay centred.'
    : 'Drawings stay centred. Anything outside the new drawing area is cropped.';
  $('#cdW').value = mode === 'new' ? 1920 : dims.W;
  $('#cdH').value = mode === 'new' ? 1080 : dims.H;
  $('#cdFps').value = String(mode === 'new' ? 24 : state.fps);
  renderPresetList();
  canvasDialog.showModal();
}

function renderPresetList() {
  const w = Number($('#cdW').value);
  const h = Number($('#cdH').value);
  const list = $('#cdPresets');
  list.replaceChildren(...CANVAS_PRESETS.map((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset' + (p.w === w && p.h === h ? ' active' : '');
    const shape = document.createElement('span');
    shape.className = 'preset-shape';
    const k = 22 / Math.max(p.w, p.h);
    shape.style.width = `${Math.round(p.w * k)}px`;
    shape.style.height = `${Math.round(p.h * k)}px`;
    b.append(shape, Object.assign(document.createElement('span'), { className: 'preset-name', textContent: p.name }),
      Object.assign(document.createElement('span'), { className: 'preset-size num', textContent: `${p.w} × ${p.h}` }));
    b.addEventListener('click', () => { $('#cdW').value = p.w; $('#cdH').value = p.h; renderPresetList(); });
    return b;
  }));
}

$('#cdW').addEventListener('input', renderPresetList);
$('#cdH').addEventListener('input', renderPresetList);
$('#cdCancel').addEventListener('click', () => canvasDialog.close());
$('#canvasForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const w = Number($('#cdW').value);
  const h = Number($('#cdH').value);
  const fps = Number($('#cdFps').value);
  if (!(w >= 64 && h >= 64)) { toast('Width and height need to be at least 64'); return; }
  canvasDialog.close();
  if (canvasDialogMode === 'new') {
    if (!(await confirmDiscard())) return;
    await enqueue(() => loadBlank(w, h, fps));
    fitTimeline();
  } else {
    await resizeCanvas(w, h, fps);
  }
});

async function newProject() {
  if (stroke || playing) return;
  openCanvasDialog('new');
}

// ---------------------------------------------------------------- export

let exporting = null;

// Draws one shot's frames and sends them to the running export. `start` is
// the shot's first frame on the board, for the burned-in timecode. Returns
// false if the export was cancelled.
async function sendShotFrames(octx, shot, shotNo, start, job, sent) {
  const cache = new Map();
  try {
    const entry = frameSource(cache, shot, true);
    await entry.promise;
    const burn = !!(state.burnTimecode || state.burnShot);
    // With a camera move or a burn-in every frame differs, so every frame is drawn.
    const each = !!shot.camera || burn;
    const frames = each ? shot.duration : 1;
    for (let k = 0; k < frames; k++) {
      if (job.cancel) return false;
      drawFrame(octx, entry, shot, shot.camera ? k / shot.duration : 0);
      drawCaption(octx, shot);
      if (burn) drawBurnIn(octx, { frame: state.burnTimecode ? start + k : null, shot: state.burnShot ? shotNo : null });
      const repeat = each ? 1 : shot.duration;
      await window.api.exportFrame(octx.getImageData(0, 0, dims.W, dims.H).data, repeat);
      sent(repeat);
    }
    return true;
  } finally {
    closeCache(cache);
  }
}

// Renders every frame and streams it to ffmpeg, which writes an H.264 MP4
// (CRF 18) with the audio track mixed in.
async function exportVideo(path = null) {
  if (exporting || playing || stroke) return null;
  if (lift) dropSelection();
  await queue;
  commitLive();
  const total = totalFrames();
  const a = state.audio && !state.audio.muted ? state.audio : null;
  const name = state.path ? state.path.split(/[\\/]/).pop().replace(/\.sboard$/, '') : 'Untitled';
  const begin = await window.api.exportBegin({
    width: dims.W,
    height: dims.H,
    fps: state.fps,
    totalFrames: total,
    name,
    path,
    audio: a ? { bytes: a.bytes, name: a.name, offsetSec: a.offset / state.fps } : null,
  });
  if (!begin || !begin.ok) { if (begin && begin.error) toast(begin.error); return null; }

  const job = { cancel: false };
  exporting = job;
  const dlg = $('#exportDialog');
  $('#exBar').style.width = '0%';
  $('#exText').textContent = 'Rendering frames...';
  dlg.showModal();
  const octx = new OffscreenCanvas(dims.W, dims.H).getContext('2d', { willReadFrequently: true });
  let done = 0;
  let ok = true;
  try {
    for (const [i, shot] of state.shots.entries()) {
      ok = await sendShotFrames(octx, shot, i + 1, done, job, (n) => {
        done += n;
        $('#exBar').style.width = `${(done / total) * 100}%`;
        $('#exText').textContent = `Frame ${done} of ${total}`;
      });
      if (!ok) break;
    }
  } catch (err) {
    ok = false;
    toast('Export failed: ' + err.message);
  }
  $('#exText').textContent = ok ? 'Finishing the file...' : 'Cancelling...';
  const res = await window.api.exportEnd(!ok);
  dlg.close();
  exporting = null;
  if (ok && res.ok) toast(`Exported ${res.path.split(/[\\/]/).pop()}`);
  else if (ok) toast('ffmpeg could not finish the video: ' + (res.log || '').split('\n').filter(Boolean).pop());
  return ok && res.ok ? res.path : null;
}

$('#exCancel').addEventListener('click', () => { if (exporting) exporting.cancel = true; });

// Each shot as its own PNG (shot_001.png ...) in a "<board> shots" folder:
// the shot as it looks in the frame at its camera Start, with its caption
// when Show captions is on.
async function exportShots(folder = null) {
  if (exporting || playing || stroke) return null;
  if (lift) dropSelection();
  await queue;
  commitLive();
  const picked = await window.api.exportFolder({ name: projectName(), path: folder });
  if (!picked || !picked.ok) { if (picked && picked.error) toast(picked.error); return null; }
  const job = { cancel: false };
  exporting = job;
  const dlg = $('#exportDialog');
  const title = dlg.querySelector('h3');
  const titleWas = title.textContent;
  title.textContent = 'Exporting each shot';
  $('#exBar').style.width = '0%';
  $('#exText').textContent = 'Drawing the shots...';
  dlg.showModal();
  const files = [];
  let ok = true;
  try {
    for (const [i, s] of state.shots.entries()) {
      if (job.cancel) { ok = false; break; }
      const pic = await renderFrame(s, s.camera ? camAt(s, 0) : null, dims.W, dims.H);
      drawCaption(pic.getContext('2d'), s);
      const blob = await pic.convertToBlob({ type: 'image/png' });
      const res = await window.api.exportStill(`shot_${String(i + 1).padStart(3, '0')}.png`, new Uint8Array(await blob.arrayBuffer()));
      if (!res || !res.ok) { ok = false; toast((res && res.error) || `Could not save shot ${i + 1}`); break; }
      files.push(res.path);
      $('#exBar').style.width = `${((i + 1) / state.shots.length) * 100}%`;
      $('#exText').textContent = `Shot ${i + 1} of ${state.shots.length}`;
    }
  } catch (err) {
    ok = false;
    toast('Export failed: ' + err.message);
  }
  dlg.close();
  title.textContent = titleWas;
  exporting = null;
  const where = picked.path.split(/[\\/]/).pop();
  if (ok) toast(`Saved ${files.length} shot picture${files.length === 1 ? '' : 's'} to the folder "${where}"`);
  else if (job.cancel && files.length) toast(`Stopped after ${files.length} shot${files.length === 1 ? '' : 's'}; those pictures are in "${where}"`);
  return ok ? { folder: picked.path, files } : null;
}

function clearReference() {
  state.reference = null;
  refVideo.pause();
  refVideo.removeAttribute('src');
  refVideo.load();
  layoutReference();
}

// Board sheets: each shot's first frame (camera Start) with its number, length
// and notes, `state.sheetPerPage` to a page on Letter paper.

const SHEET_MAX = 30;
const sheetPerPage = () => Math.min(SHEET_MAX, Math.max(1, Math.round(state.sheetPerPage) || 6));

// The grid and paper direction that give the biggest pictures for `n` shots a
// page. Sizes in inches; the type shrinks with the pictures.
function sheetLayout(n, aspect, notes = true) {
  let best = null;
  for (const [pw, ph] of [[11, 8.5], [8.5, 11]]) {
    const w = pw - 1;
    const h = ph - 0.9 - 0.42; // margins, then the header
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      // Leave no empty row or column.
      if (cols > 1 && Math.ceil(n / (cols - 1)) === rows) continue;
      const gapX = cols > 1 ? 0.28 : 0;
      const gapY = 0.22;
      const cellW = (w - gapX * (cols - 1)) / cols;
      const cellH = (h - gapY * (rows - 1)) / rows;
      // The label and notes take room under each picture; they scale with it,
      // so the size is found in two passes.
      let picW = cellW;
      let pt = 10;
      let textH = 0;
      for (let pass = 0; pass < 2; pass++) {
        pt = Math.min(10, Math.max(6.5, picW * 3));
        textH = 0.07 + (pt * 1.4) / 72 + (notes ? 0.09 + (3 * pt * 0.9 * 1.35) / 72 : 0);
        picW = Math.min(cellW, (cellH - textH) * aspect);
      }
      if (picW <= 0.3) continue;
      // Paper the same way round as the frame counts a little bigger, so a
      // near tie goes landscape for wide shots and portrait for tall ones.
      const area = picW * (picW / aspect) * ((pw > ph) === (aspect >= 1) ? 1.05 : 1);
      if (!best || area > best.area + 1e-6) best = { pw, ph, cols, rows, picW, picH: picW / aspect, pt, gapY, area, landscape: pw > ph };
    }
  }
  return best;
}

// The sheets as a page to print. `src(shot)` gives each picture's address.
function sheetHtml(title, shots, aspect, perPage, src) {
  const notes = shots.some((s) => s.notes && s.notes.trim());
  const L = sheetLayout(Math.min(perPage, shots.length) || 1, aspect, notes);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pages = [];
  for (let i = 0; i < shots.length; i += perPage) pages.push(shots.slice(i, i + perPage));
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const body = pages.map((page, p) => `
    <section class="page">
      <header><span class="title">${esc(title)}</span><span>${date}</span><span>Page ${p + 1} of ${pages.length}</span></header>
      <div class="grid">${page.map((s) => `
        <figure>
          <div class="frame"><img src="${src(s)}"></div>
          <figcaption><b>Shot ${s.number}</b><span>${s.seconds}s</span></figcaption>
          ${notes ? `<p class="notes">${esc(s.notes)}</p>` : ''}
        </figure>`).join('')}
      </div>
    </section>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} board sheets</title><style>
    @page { size: ${L.pw}in ${L.ph}in; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Segoe UI", -apple-system, system-ui, sans-serif; color: #111; }
    .page { width: ${L.pw}in; height: ${L.ph}in; padding: 0.45in 0.5in; display: flex; flex-direction: column; page-break-after: always; overflow: hidden; }
    .page:last-child { page-break-after: auto; }
    header { display: flex; gap: 0.3in; align-items: baseline; font-size: 9pt; color: #666; height: 0.42in; padding-bottom: 0.12in; border-bottom: 1px solid #ddd; margin-bottom: 0; }
    header .title { font-size: 12pt; font-weight: 600; color: #111; margin-right: auto; }
    .grid { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(${L.cols}, ${L.picW.toFixed(3)}in); grid-auto-rows: max-content;
      justify-content: ${L.cols > 1 ? 'space-between' : 'center'}; align-content: space-evenly; row-gap: ${L.gapY}in; }
    figure { margin: 0; display: flex; flex-direction: column; min-width: 0; }
    .frame { height: ${L.picH.toFixed(3)}in; }
    .frame img { width: 100%; height: 100%; object-fit: contain; border: 1px solid #222; display: block; }
    figcaption { display: flex; justify-content: space-between; font-size: ${L.pt.toFixed(1)}pt; margin-top: 0.07in; }
    .notes { margin: 0.04in 0 0; font-size: ${(L.pt * 0.9).toFixed(1)}pt; line-height: 1.35; height: ${((3 * L.pt * 0.9 * 1.35) / 72 + 0.05).toFixed(3)}in; color: #333; white-space: pre-wrap; overflow: hidden; border-top: 1px solid #eee; padding-top: 0.05in; }
  </style></head><body>${body}</body></html>`;
}

async function exportPdf(path = null) {
  if (exporting || playing || stroke) return null;
  if (lift) dropSelection();
  await queue;
  commitLive();
  exporting = { cancel: false };
  toast('Making board sheets...');
  try {
    const perPage = sheetPerPage();
    const aspect = dims.W / dims.H;
    // About 200 dpi at the printed size, so a big picture stays sharp.
    const L = sheetLayout(Math.min(perPage, state.shots.length) || 1, aspect);
    const longest = Math.min(2400, Math.max(800, Math.round(200 * Math.max(L.picW, L.picH))));
    const k = Math.min(1, longest / Math.max(dims.W, dims.H));
    const shots = [];
    for (const [i, s] of state.shots.entries()) {
      const off = await renderFrame(s, s.camera ? camAt(s, 0) : null, Math.round(dims.W * k), Math.round(dims.H * k));
      const blob = await off.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      shots.push({ img: new Uint8Array(await blob.arrayBuffer()), number: i + 1, seconds: (s.duration / state.fps).toFixed(2), notes: s.notes || '' });
    }
    const html = sheetHtml(projectName(), shots, aspect, perPage, (s) => `shot-${s.number}.jpg`);
    const res = await window.api.exportPdf({ name: projectName(), title: projectName(), shots, aspect, perPage, html, path });
    if (res && res.ok) toast(`Saved ${res.pages} page${res.pages === 1 ? '' : 's'} of board sheets`);
    return res && res.ok ? res : null;
  } catch (err) {
    toast('Could not make the PDF: ' + err.message);
    return null;
  } finally {
    exporting = null;
  }
}

// ---------------------------------------------------------------- backups
//
// The desktop app keeps earlier versions of every board in its own data
// folder (backups.js), not beside the board. This lists them and opens one
// as a copy: the board's own file is never written by a restore.

function backupWhen(t) {
  const d = new Date(t);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date()) - day(d)) / 86400000);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

async function openBackup(id, version) {
  if (stroke || playing || !(await confirmDiscard())) return false;
  const res = await window.api.backupLoad(id, version);
  await enqueue(() => loadData(JSON.parse(res.text), null, { parts: res.parts, keys: null }));
  // The same board, as it was: saving asks where to put it.
  state.boardId = id;
  state.dirty = true;
  updateTitle();
  toast(`Opened the backup from ${backupWhen(res.savedAt)} as a copy. Save it where you want it.`);
  return true;
}

async function showBackups() {
  const dlg = $('#backupDialog');
  const list = $('#backupList');
  const boards = await window.api.backupList();
  // This board first.
  boards.sort((a, b) => (b.id === state.boardId) - (a.id === state.boardId));
  list.replaceChildren();
  if (!boards.length) list.append(el('p', { className: 'hint', textContent: 'No backups yet. One is made each time a board is saved.' }));
  for (const b of boards) {
    const box = el('details', { className: 'backup-board' });
    box.open = b.id === state.boardId || boards.length === 1;
    const clear = el('button', { className: 'text-btn sm', textContent: 'Delete these', title: 'Delete every backup of this board (the board file itself is not touched)' });
    clear.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!window.confirm(`Delete all ${b.versions.length} backups of "${b.name}"? The board file itself is not touched.`)) return;
      await window.api.backupRemove(b.id);
      showBackups();
    });
    box.append(el('summary', {}, el('b', { textContent: b.name }), el('span', { className: 'muted', textContent: `${b.versions.length} version${b.versions.length === 1 ? '' : 's'}${b.id === state.boardId ? ', this board' : ''}` }), clear));
    for (const v of b.versions) {
      const open = el('button', { className: 'text-btn sm', textContent: 'Open a copy' });
      open.addEventListener('click', async () => { if (await openBackup(b.id, v.version)) dlg.close(); });
      box.append(el('div', { className: 'backup-row' }, el('span', { textContent: backupWhen(v.savedAt) }), el('span', { className: 'muted', textContent: `${v.shots} shot${v.shots === 1 ? '' : 's'}` }), open));
    }
    list.append(box);
  }
  if (!dlg.open) dlg.showModal();
}
$('#backupsBtn').addEventListener('click', showBackups);
$('#backupClose').addEventListener('click', () => $('#backupDialog').close());
// The web version keeps its boards in the browser and has no backups yet.
$('#backupsBtn').hidden = typeof isWeb !== 'undefined' && isWeb;

// ---------------------------------------------------------------- source files
//
// A board file only opens in this app. For handing the work to someone who
// does not have it, this writes a .zip of ordinary files: every layer of
// every shot as a PNG, each shot flattened, a sheet of the timings, and a
// short note saying what is what (and, if wanted, the board file itself).
async function exportSource(path = null) {
  if (exporting || playing || stroke) return null;
  if (lift) dropSelection();
  await queue;
  commitLive();
  // The board file goes in as it is on disk, so it is saved first if it has changes.
  let board = null;
  if ($('#exSourceBoard').checked) {
    if (state.path) { if (state.dirty) await save(); board = state.path; }
    else toast('This board has not been saved to a file yet, so the zip will have the pictures but not the board file');
  }
  const begin = await window.api.sourceBegin({ name: `${projectName()} source files`, path, board });
  if (!begin || !begin.ok) { if (begin && begin.error) toast(begin.error); return null; }
  const job = { cancel: false };
  exporting = job;
  const dlg = $('#exportDialog');
  const title = dlg.querySelector('h3');
  const titleWas = title.textContent;
  title.textContent = 'Exporting source files';
  $('#exBar').style.width = '0%';
  $('#exText').textContent = 'Gathering the layers...';
  dlg.showModal();
  const pad = (n, w = 3) => String(n).padStart(w, '0');
  const safe = (s) => String(s || 'Layer').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 60) || 'Layer';
  const csv = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const rows = ['shot,start timecode,frames,seconds,layers,camera move,caption'];
  let ok = true;
  let res = null;
  try {
    let start = 0;
    for (const [i, s] of state.shots.entries()) {
      if (job.cancel) { ok = false; break; }
      const folder = `shots/shot_${pad(i + 1)}`;
      let n = 0;
      for (const [li, l] of s.layers.entries()) {
        const blob = await ensureBlob(l);
        if (!blob) continue;
        n++;
        await window.api.sourceFile(`${folder}/${pad(li + 1, 2)} ${safe(l.name)}${l.visible ? '' : ' (hidden)'}.png`, new Uint8Array(await blob.arrayBuffer()));
      }
      const flat = await renderFrame(s, s.camera ? camAt(s, 0) : null, dims.W, dims.H);
      await window.api.sourceFile(`frames/shot_${pad(i + 1)}.png`, new Uint8Array(await (await flat.convertToBlob({ type: 'image/png' })).arrayBuffer()));
      rows.push([i + 1, burnTimecode(start), s.duration, (s.duration / state.fps).toFixed(3), n, s.camera ? 'yes' : 'no', csv(s.notes)].join(','));
      start += s.duration;
      $('#exBar').style.width = `${((i + 1) / state.shots.length) * 100}%`;
      $('#exText').textContent = `Shot ${i + 1} of ${state.shots.length}`;
    }
    if (ok) {
      const enc = new TextEncoder();
      const total = totalFrames();
      // A byte-order mark, so Excel reads the captions as UTF-8.
      await window.api.sourceFile('shots.csv', enc.encode('\ufeff' + rows.join('\r\n') + '\r\n'));
      const facts = `${state.shots.length} shots, ${state.fps} fps, ${(total / state.fps).toFixed(2)} s (${total} frames)`;
      const readme = [
        'Storyboard source files',
        '',
        'This board was drawn in Storyboard, a storyboard and animatic program. Its project file (.sboard) only opens in that program, so the same content is given here as ordinary pictures.',
        '',
        'shots/shot_001/ ...   One folder per shot. Each PNG is one layer, numbered from the bottom layer (01) upward.',
        `                      Layers are the whole working canvas (${dims.CW} x ${dims.CH} px); the camera frame (${dims.W} x ${dims.H} px) sits in its centre.`,
        'frames/shot_001.png   Each shot with its layers combined, as it appears in the frame.',
        'shots.csv             Each shot\'s start time, length in frames and seconds, and caption.',
        ...(begin.board ? ['board.sboard          The project file itself.'] : []),
        '',
        `Board: ${facts}.`,
        '',
        '分镜源文件',
        '',
        '本分镜使用 Storyboard（一款分镜/动态分镜软件）绘制。工程文件（.sboard）只能用该软件打开，因此这里以普通图片的形式提供相同内容。',
        '',
        'shots/shot_001/ ...   每个文件夹是一个镜头；每张 PNG 是一个图层，从最底层（01）向上编号。',
        `                      图层为完整工作画布（${dims.CW} x ${dims.CH} 像素），镜头画面（${dims.W} x ${dims.H} 像素）位于正中。`,
        'frames/shot_001.png   每个镜头合并所有图层后的画面。',
        'shots.csv             每个镜头的起始时间、帧数、秒数和字幕。',
        ...(begin.board ? ['board.sboard          工程文件本身。'] : []),
        '',
        `共 ${state.shots.length} 个镜头，${state.fps} 帧/秒，总时长 ${(total / state.fps).toFixed(2)} 秒（${total} 帧）。`,
        '',
      ].join('\r\n');
      await window.api.sourceFile('README.txt', enc.encode('\ufeff' + readme));
    }
  } catch (err) {
    ok = false;
    toast('Could not make the source files: ' + err.message);
  }
  $('#exText').textContent = ok ? 'Finishing the file...' : 'Cancelling...';
  try { res = await window.api.sourceEnd(!ok); } catch (err) { toast('Could not finish the zip: ' + err.message); }
  dlg.close();
  title.textContent = titleWas;
  exporting = null;
  if (ok && res && res.ok) toast(`Saved ${res.files} files (${Math.round(res.bytes / 1048576)} MB) to ${res.path.split(/[\\/]/).pop()}`);
  return ok && res && res.ok ? res : null;
}
