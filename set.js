'use strict';
// 3D sets. Block in the environment once, in simple shapes, and give a shot a
// camera in it: the set is drawn under the drawing in that shot (like the
// reference video, but rendered from the shot's camera), and it goes into
// playback, scrubbing, the timeline and every export. Shots without a 3D
// camera are drawn exactly as before.
//
//   state.set  = { objects: [{ id, kind, name, p: [x,y,z], r: [x,y,z] (deg), s: [x,y,z] }],
//                  opacity, visible }                   one set per board, in metres
//   shot.cam3d = { start: { p, t, mm }, end: { p, t, mm } | null, ease, move?, range? }
//                (p = where the camera is, t = what it looks at, mm = lens)
//
// The engine (set3d.js, three.js) is loaded only when a board has a set or the
// 3D view is opened, so other boards start as fast as before. This file holds
// the data, its undo, the 3D mode and its panel.

state.set = null;

const SET_SHAPES = {
  box: { label: 'Box', s: [1, 1, 1] },
  wall: { label: 'Wall', s: [4, 2.6, 0.15] },
  floor: { label: 'Floor', s: [8, 0.04, 8] },
  stairs: { label: 'Stairs', s: [1.2, 1.2, 2] },
  cylinder: { label: 'Cylinder', s: [0.8, 0.9, 0.8] },
  sphere: { label: 'Ball', s: [1, 1, 1] },
  figure: { label: 'Figure', s: [1, 1, 1] }, // 1.75 m tall at scale 1
};
const FIGURE_H = 1.75;

// ---------------------------------------------------------------- the engine

let set3d = null; // the engine, once loaded
let setLoading = null;
let setVersion = 0; // goes up with every change to the set, so views know to redraw
let setSynced = -1;
function loadSet3d() {
  if (!setLoading) {
    setLoading = import('./set3d.js')
      .then((m) => {
        set3d = m.createEngine();
        // (not the timeline pictures: a board's are saved with it, set and all,
        // and making them all again is what made big boards slow to open)
        setChanged({ thumbs: false });
        return set3d;
      })
      .catch((err) => {
        setLoading = null;
        toast('Could not load the 3D view: ' + ((err && err.message) || err));
        throw err;
      });
  }
  return setLoading;
}
// Before playing or exporting a board that has a set.
const ensureSetEngine = () => (state.set ? loadSet3d().catch(() => null) : Promise.resolve(null));

function syncSetScene() {
  if (set3d && setSynced !== setVersion) {
    set3d.sync(state.set);
    setSynced = setVersion;
  }
}

// ---------------------------------------------------------------- data

const finite3 = (a, d) => (Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) ? a.map(Number) : d.slice());
function cleanSet(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.objects)) return null;
  const objects = s.objects
    .filter((o) => o && SET_SHAPES[o.kind])
    .map((o) => ({
      id: typeof o.id === 'string' && o.id ? o.id : uid(),
      kind: o.kind,
      name: typeof o.name === 'string' ? o.name.slice(0, 60) : SET_SHAPES[o.kind].label,
      p: finite3(o.p, [0, 0, 0]),
      r: finite3(o.r, [0, 0, 0]),
      s: finite3(o.s, SET_SHAPES[o.kind].s).map((v) => Math.max(0.02, Math.abs(v))),
    }));
  return { objects, opacity: Number.isFinite(s.opacity) ? clamp(s.opacity, 0.05, 1) : 0.7, visible: s.visible !== false };
}
function cleanView(v) {
  if (!v || typeof v !== 'object') return null;
  const p = finite3(v.p, [0, 1.6, 6]);
  const t = finite3(v.t, [0, 1.2, 0]);
  if (Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]) < 1e-4) t[2] -= 1;
  return { p, t, mm: Number.isFinite(v.mm) ? clamp(v.mm, 6, 600) : 35 };
}
function cleanCam3d(c) {
  if (!c || typeof c !== 'object') return null;
  const start = cleanView(c.start);
  if (!start) return null;
  const out = { start, end: cleanView(c.end), ease: EASES[c.ease] ? c.ease : 'smooth' };
  if (typeof c.move === 'string') out.move = c.move;
  if (Array.isArray(c.range) && c.range.length === 2 && c.range.every(Number.isFinite)) out.range = c.range.slice();
  return out;
}

// The set shows in a shot that has a 3D camera, once the engine is there.
const setShown = (shot) => !!(set3d && shot && shot.cam3d && state.set && state.set.visible !== false && state.set.objects.length);
const cam3dMoves = (shot) => !!(shot && shot.cam3d && shot.cam3d.end);

// The shot camera at t (0 to 1 through the shot). A move eases from Start to
// End the way the 2D camera does, and a split shot plays its stretch of it.
function cam3dAt(shot, t) {
  const c = shot && shot.cam3d;
  if (!c) return null;
  if (!c.end) return c.start;
  const u = clamp(t, 0, 1);
  const k = (EASES[c.ease] || EASES.smooth)(c.range ? c.range[0] + (c.range[1] - c.range[0]) * u : u);
  const mix = (a, b) => a.map((v, i) => v + (b[i] - v) * k);
  return { p: mix(c.start.p, c.end.p), t: mix(c.start.t, c.end.t), mm: c.start.mm * Math.pow(c.end.mm / c.start.mm, k) };
}

// How far through the shot on screen the playhead is.
function shotFrac(shot = mounted) {
  const i = state.shots.indexOf(shot);
  if (i < 0) return 0;
  return clamp((state.time - shotStarts()[i]) / shot.duration, 0, 1);
}

// The set as the board sees it: rendered at the frame's size (at most 2560
// wide), it covers the frame on the canvas, so a 2D camera move or a crop
// sees it the way it sees the drawing.
function setPicture(shot, t, lines = false) {
  syncSetScene();
  const k = Math.min(1, 2560 / dims.W);
  return set3d.render(cam3dAt(shot, t), dims.W * k, dims.H * k, { lines });
}
// Draws the set into ctx, which shows the canvas area rect at w x h.
function drawSetInto(ctx, shot, t, rect, w, h) {
  if (!setShown(shot)) return false;
  const img = setPicture(shot, t);
  const sx = w / rect.w;
  const sy = h / rect.h;
  ctx.save();
  ctx.globalAlpha = state.set.opacity;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (dims.FX - rect.x) * sx, (dims.FY - rect.y) * sy, dims.W * sx, dims.H * sy);
  ctx.restore();
  return true;
}
// A frame of playback or export: the set as this moment's camera sees it.
const drawSetFrame = (ctx, shot, t, w = dims.W, h = dims.H) => drawSetInto(ctx, shot, t, camRect(camAt(shot, t)), w, h);

// Something about the set changed: views redraw, and the timeline pictures of
// the shots that show it are made again.
function setChanged({ thumbs = true } = {}) {
  setVersion++;
  syncSetScene();
  if (thumbs) for (const s of state.shots) if (s.cam3d) scheduleThumb(s);
  syncSetView();
  if (setMode) syncSetEditor(true);
}

// ---------------------------------------------------------------- under the drawing

// The set under the drawing on the canvas, for the shot on screen at the
// playhead. Redrawn only when something it shows has changed.
const setViewEl = $('#setView');
let setViewKey = '';
function syncSetView() {
  if (typeof playing !== 'undefined' && (playing || scrub)) return;
  const shot = mounted;
  if (!shot || !setShown(shot)) {
    // (runs on every refresh of the app: touches the page only when it changes)
    if (setViewEl.style.display !== 'none') setViewEl.style.display = 'none';
    setViewKey = '';
    return;
  }
  const t = cam3dMoves(shot) ? shotFrac(shot) : 0;
  const key = [shot.id, setVersion, JSON.stringify(shot.cam3d), t.toFixed(4), dims.W, dims.H, dims.FX, dims.FY, state.set.opacity].join('|');
  Object.assign(setViewEl.style, { display: 'block', left: `${dims.FX}px`, top: `${dims.FY}px`, width: `${dims.W}px`, height: `${dims.H}px`, opacity: state.set.opacity });
  if (key === setViewKey) return;
  setViewKey = key;
  const img = setPicture(shot, t);
  if (setViewEl.width !== img.width || setViewEl.height !== img.height) {
    setViewEl.width = img.width;
    setViewEl.height = img.height;
  }
  setViewEl.getContext('2d').drawImage(img, 0, 0);
}

// ---------------------------------------------------------------- undo

const setSnapshot = () => (state.set ? structuredClone(state.set) : null);
let setFresh = false; // the starter set made on opening; kept only once something is done with it
function commitSet(from) {
  setFresh = false;
  pushHistory({ type: 'set3d', from, to: setSnapshot() });
  setChanged();
  markDirty();
}

// A shot's camera changed (from = how it was). The other pieces of a split
// move follow, keeping their own stretch (like the 2D camera).
function setCam3d(shot, cam, from) {
  setFresh = false;
  shot.cam3d = cam;
  const entries = [{ type: 'cam3d', shotId: shot.id, from: structuredClone(from), to: structuredClone(cam) }];
  const move = (cam && cam.move) || (from && from.move);
  if (move) {
    for (const s of state.shots) {
      if (s === shot || !s.cam3d || s.cam3d.move !== move) continue;
      const was = structuredClone(s.cam3d);
      s.cam3d = cam ? { ...structuredClone(cam), range: s.cam3d.range, move } : null;
      entries.push({ type: 'cam3d', shotId: s.id, from: was, to: structuredClone(s.cam3d) });
    }
  }
  pushHistory(entries.length === 1 ? entries[0] : { type: 'multi', shotId: shot.id, entries });
  setChanged();
  markDirty();
  refreshUI();
}

// Undo and redo of set and camera steps (called from applyEntry).
async function applySetEntry(e, forward) {
  if (e.type === 'set3d') {
    state.set = structuredClone(forward ? e.to : e.from);
    if (setMode && !state.set) state.set = starterSet();
    if (setPicked && !(state.set && state.set.objects.some((o) => o.id === setPicked))) setPicked = null;
    setChanged();
  } else {
    const shot = await showShotById(e.shotId);
    if (!shot) return;
    shot.cam3d = structuredClone(forward ? e.to : e.from);
    setChanged();
  }
  refreshUI();
}

// ---------------------------------------------------------------- shapes

function starterSet() {
  return {
    objects: [
      { id: uid(), kind: 'floor', name: 'Floor', p: [0, 0, 0], r: [0, 0, 0], s: SET_SHAPES.floor.s.slice() },
      { id: uid(), kind: 'figure', name: 'Figure', p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] },
    ],
    opacity: 0.7,
    visible: true,
  };
}

function shapeName(kind) {
  const label = SET_SHAPES[kind].label;
  const used = new Set(state.set.objects.map((o) => o.name));
  if (!used.has(label)) return label;
  let n = 2;
  while (used.has(`${label} ${n}`)) n++;
  return `${label} ${n}`;
}

function addSetObject(kind) {
  if (!state.set || !set3d) return;
  const from = setSnapshot();
  const o = { id: uid(), kind, name: shapeName(kind), p: set3d.dropPoint(), r: [0, 0, 0], s: SET_SHAPES[kind].s.slice() };
  state.set.objects.push(o);
  setPicked = o.id;
  commitSet(from);
  if (set3d.editing) set3d.select(o.id);
}

const pickedObject = () => (state.set && setPicked ? state.set.objects.find((o) => o.id === setPicked) : null);

function deleteSetObject() {
  const o = pickedObject();
  if (!o) return;
  const from = setSnapshot();
  state.set.objects = state.set.objects.filter((x) => x !== o);
  setPicked = null;
  if (set3d) set3d.select(null);
  commitSet(from);
}

function duplicateSetObject() {
  const o = pickedObject();
  if (!o) return;
  const from = setSnapshot();
  const copy = { ...structuredClone(o), id: uid(), name: shapeName(o.kind), p: [o.p[0] + 0.5, o.p[1], o.p[2] + 0.5] };
  state.set.objects.push(copy);
  setPicked = copy.id;
  commitSet(from);
  set3d.select(copy.id);
}

// A field in the panel changed one number of the picked shape.
function editSetObject(fn) {
  const o = pickedObject();
  if (!o) return;
  const from = setSnapshot();
  fn(o);
  commitSet(from);
}

// ---------------------------------------------------------------- the 3D mode

let setMode = false;
let setPicked = null;
let setLook = false; // looking through the shot's camera
let setLens = 35;
let setViewMoved = false; // the view was moved by hand since it was last set
let setEditorKey = '';
let setEditorViewKey = '';
let setHoldView = false; // keep the view through the next camera change (it came from this view)
const setEditorHost = $('#setEditor');

async function enterSetMode() {
  if (setMode || playing) return;
  if (typeof lift !== 'undefined' && lift) dropSelection();
  commitLive();
  try {
    await loadSet3d();
  } catch {
    return;
  }
  if (!state.set) {
    // A floor and a person for scale, to start from. Kept only if it gets used.
    state.set = starterSet();
    setFresh = true;
    setChanged({ thumbs: false });
  }
  setMode = true;
  setPicked = null;
  setEditorHost.hidden = false;
  document.body.classList.add('set-mode');
  set3d.openEditor(setEditorHost, {
    aspect: () => dims.W / dims.H,
    label: () => (mounted ? `Shot ${state.shots.indexOf(mounted) + 1}` : 'Camera'),
    onPick: (id) => {
      setPicked = id;
      set3d.select(id);
      renderSetPanel();
    },
    onEdit: (id, tf) => {
      const o = state.set.objects.find((x) => x.id === id);
      if (!o) return;
      const from = setSnapshot();
      Object.assign(o, tf);
      commitSet(from);
      renderSetPanel();
    },
    onView: () => {
      if (!setViewMoved) {
        setViewMoved = true;
        renderSetPanel();
      }
    },
  });
  lastPaneTab = $('#inspector').dataset.tab;
  setInspectorTab('set');
  // Through the shot's camera if it has one, otherwise round the whole set.
  const shot = mounted;
  setLook = !!(shot && shot.cam3d);
  setViewMoved = false;
  setEditorViewKey = '';
  syncSetEditor(true);
  if (!setLook) set3d.frame(null);
  setViewMoved = false;
  refreshUI();
}

function exitSetMode() {
  if (!setMode) return;
  setMode = false;
  if (set3d) set3d.closeEditor();
  setEditorHost.hidden = true;
  document.body.classList.remove('set-mode');
  setPicked = null;
  // The starter set goes again if nothing was done with it.
  if (setFresh) {
    state.set = null;
    setFresh = false;
    setChanged({ thumbs: false });
  }
  setInspectorTab(lastPaneTab || 'tool');
  refreshUI();
}
let lastPaneTab = null;
const toggleSetMode = () => (setMode ? exitSetMode() : enterSetMode());

// Keeps the editor in step with the shot and the playhead: through the
// camera, the view follows the shot's camera unless it has been moved by hand
// (then Set Start / Set End keep that view). Free, it shows where the shot's
// Start and End cameras are.
function syncSetEditor(force = false) {
  if (!setMode || !set3d || (typeof playing !== 'undefined' && playing)) return;
  const shot = mounted;
  const t = cam3dMoves(shot) ? shotFrac(shot) : 0;
  const key = [shot && shot.id, state.shots.indexOf(shot), JSON.stringify(shot && shot.cam3d), t.toFixed(4), setLook, setVersion, dims.W, dims.H].join('|');
  if (!force && key === setEditorKey) return;
  setEditorKey = key;
  set3d.select(setPicked);
  set3d.setLook(setLook);
  // The view follows the playhead only when the shot, its camera or the
  // playhead moved: not on every redraw, which would undo looking round.
  const viewKey = [shot && shot.id, JSON.stringify(shot && shot.cam3d), t.toFixed(4), setLook].join('|');
  if (viewKey !== setEditorViewKey) {
    const shotChanged = !setEditorViewKey.startsWith(`${shot && shot.id}|`);
    setEditorViewKey = viewKey;
    if (setHoldView) setHoldView = false; // just set a key from this very view: keep it
    else if (setLook && shot && shot.cam3d && (!setViewMoved || shotChanged)) {
      const v = cam3dAt(shot, t);
      setLens = v.mm;
      set3d.setView(v);
      setViewMoved = false;
    }
  }
  set3d.setLens(setLens);
  const marks = [];
  if (!setLook && shot && shot.cam3d) {
    marks.push({ view: shot.cam3d.start, color: 0xffffff });
    if (shot.cam3d.end) marks.push({ view: shot.cam3d.end, color: 0xffa04d });
  }
  set3d.showCameras(marks);
  renderSetPanel();
}

// Set Start / Set End: the view as it is now becomes that end of the shot's
// camera. With no camera yet, both ends start out the same (a still camera).
function setCamKey(which) {
  const shot = mounted;
  if (!shot || !set3d) return;
  const view = set3d.getView();
  view.mm = Math.round(setLens * 10) / 10;
  const from = shot.cam3d ? structuredClone(shot.cam3d) : null;
  const cam = shot.cam3d ? structuredClone(shot.cam3d) : { start: view, end: null, ease: 'smooth' };
  if (which === 'start') cam.start = view;
  else cam.end = view;
  setViewMoved = false;
  setHoldView = true;
  setLook = true; // and see it as the shot does, framed
  setCam3d(shot, cam, from);
  toast(which === 'start'
    ? (cam.end ? 'Start set: the camera moves from here to End across the shot' : 'This shot now sees the set from here')
    : 'End set: the camera moves from Start to here across the shot');
}

function lookAtKey(which) {
  const shot = mounted;
  if (!shot || !shot.cam3d || !set3d) return;
  const v = which === 'end' ? shot.cam3d.end || shot.cam3d.start : shot.cam3d.start;
  setLook = true;
  setViewMoved = false;
  syncSetEditor(true); // through the camera, markers off
  // then that key's view, until the playhead or the camera next changes
  setLens = v.mm;
  set3d.setView(v);
  set3d.setLens(v.mm);
  renderSetPanel(true);
}

function clearCamMove() {
  const shot = mounted;
  if (!shot || !shot.cam3d || !shot.cam3d.end) return;
  const from = structuredClone(shot.cam3d);
  const cam = structuredClone(shot.cam3d);
  cam.end = null;
  delete cam.range;
  delete cam.move;
  setCam3d(shot, cam, from);
}
function clearCam() {
  const shot = mounted;
  if (!shot || !shot.cam3d) return;
  setCam3d(shot, null, structuredClone(shot.cam3d));
  setLook = false;
  syncSetEditor(true);
  toast('This shot has no 3D camera now: the set is not drawn under it');
}

// Draws the set's lines (what the shot's camera sees, at the playhead) onto
// a new layer, to trace over or keep.
const traceSetToLayer = () => enqueue(async () => {
  const shot = mounted;
  if (!shot || !setShown(shot)) { toast('Give this shot a 3D camera first (Set Start in the 3D view)'); return; }
  const img = setPicture(shot, cam3dMoves(shot) ? shotFrac(shot) : 0, true);
  const idx = mounted.layers.findIndex((l) => l.id === mounted.activeLayerId) + 1;
  const layer = newLayer('Set lines');
  await insertLayer(idx, layer);
  live.get(layer.id).getContext('2d').drawImage(img, dims.FX, dims.FY, dims.W, dims.H);
  layer.dirty = true;
  pushHistory({ type: 'addLayer', shotId: mounted.id, index: idx, layer });
  scheduleThumb();
  markDirty();
  toast('Drew the set onto a new layer, Set lines');
});

// ---------------------------------------------------------------- the panel

const secSet = $('#secSet');
let setPanelKey = '';
const fmtM = (v) => `${Math.round(v * 100) / 100}`;

function renderSetPanel(force = false) {
  if (!setMode) return;
  const shot = mounted;
  const o = pickedObject();
  const key = [setVersion, setPicked, shot && shot.id, JSON.stringify(shot && shot.cam3d), setLook, Math.round(setLens), setViewMoved, set3d && set3d._mode].join('|');
  if (!force && key === setPanelKey) return;
  setPanelKey = key;
  const rows = [];
  rows.push(el('div', { className: 'sec-head' }, el('h2', { textContent: '3D set' }), el('button', { className: 'text-btn sm primary', id: 'setDone', textContent: 'Done', title: 'Back to drawing (Esc)', onclick: exitSetMode })));

  // Add a shape
  const add = el('div', { className: 'set-add' });
  for (const kind of Object.keys(SET_SHAPES)) {
    add.append(el('button', { className: 'text-btn sm set-shape', textContent: SET_SHAPES[kind].label, title: `Add a ${SET_SHAPES[kind].label.toLowerCase()} where you are looking`, onclick: () => addSetObject(kind) }));
  }
  rows.push(el('p', { className: 'set-label', textContent: 'Add' }), add);

  // The picked shape
  if (o) {
    rows.push(el('div', { className: 'sec-head sub' }, el('h2', { textContent: o.name })));
    const name = el('input', { className: 'field', value: o.name, maxLength: 60, spellcheck: false });
    name.addEventListener('change', () => editSetObject((x) => { x.name = name.value.trim() || x.name; }));
    rows.push(el('label', { className: 'set-row' }, el('span', { textContent: 'Name' }), name));
    const num = (label, get, set, step = 0.1, title = '') => {
      const input = el('input', { className: 'field num', type: 'number', step, value: fmtM(get()), title });
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) editSetObject((x) => set(x, v));
      });
      return el('label', { className: 'set-num' }, el('span', { textContent: label }), input);
    };
    if (o.kind === 'figure') {
      rows.push(el('div', { className: 'set-nums' },
        num('Height m', () => o.s[1] * FIGURE_H, (x, v) => { const k = Math.max(0.1, v) / FIGURE_H; x.s = [k, k, k]; }, 0.05),
        num('Turn °', () => o.r[1], (x, v) => { x.r[1] = v; }, 15)));
    } else {
      rows.push(el('div', { className: 'set-nums' },
        num('Width', () => o.s[0], (x, v) => { x.s[0] = Math.max(0.02, v); }),
        num('Height', () => o.s[1], (x, v) => { x.s[1] = Math.max(0.02, v); }),
        num('Depth', () => o.s[2], (x, v) => { x.s[2] = Math.max(0.02, v); }),
        num('Turn °', () => o.r[1], (x, v) => { x.r[1] = v; }, 15)));
    }
    const mode = set3d ? set3d._mode || 'translate' : 'translate';
    const seg = el('div', { className: 'seg' });
    for (const [m, label, k] of [['translate', 'Move', 'W'], ['rotate', 'Turn', 'E'], ['scale', 'Size', 'R']]) {
      seg.append(el('button', { className: 'seg-btn' + (mode === m ? ' active' : ''), textContent: label, title: `${label} the shape with the handles (${k})`, onclick: () => setGizmo(m) }));
    }
    rows.push(seg);
    rows.push(el('div', { className: 'link-row' },
      el('button', { className: 'text-btn sm', textContent: 'Duplicate', title: 'Duplicate (Ctrl+D)', onclick: duplicateSetObject }),
      el('button', { className: 'text-btn sm danger', textContent: 'Delete', title: 'Delete (Delete)', onclick: deleteSetObject })));
  }

  // This shot's camera
  rows.push(el('div', { className: 'sec-head sub' }, el('h2', { textContent: shot ? `Shot ${state.shots.indexOf(shot) + 1} camera` : 'Camera' })));
  const view = el('div', { className: 'seg two' });
  view.append(
    el('button', { className: 'seg-btn' + (setLook ? '' : ' active'), textContent: 'Free view', title: 'Look round the set (C switches)', onclick: () => { setLook = false; syncSetEditor(true); } }),
    el('button', { className: 'seg-btn' + (setLook ? ' active' : ''), textContent: 'Through the camera', title: 'See exactly what the shot sees (C switches)', onclick: () => { setLook = true; setViewMoved = !(shot && shot.cam3d); syncSetEditor(true); } }));
  rows.push(view);
  const lens = el('input', { type: 'range', min: 12, max: 135, step: 1, value: Math.round(setLens) });
  const lensVal = el('span', { className: 'num', textContent: `${Math.round(setLens)} mm` });
  lens.addEventListener('input', () => {
    setLens = Number(lens.value);
    lensVal.textContent = `${setLens} mm`;
    set3d.setLens(setLens);
    setViewMoved = true;
  });
  lens.addEventListener('change', () => renderSetPanel());
  rows.push(el('label', { className: 'slider-row', title: '24 is wide, 35 and 50 are normal, 85 and up are long' }, el('span', { textContent: 'Lens' }), lens, lensVal));
  const cam = shot && shot.cam3d;
  rows.push(el('div', { className: 'set-keys' },
    el('button', { className: 'outline-btn', textContent: cam ? 'Set Start here' : 'Use this view', title: cam ? 'This view becomes where the shot starts' : "This view becomes the shot's camera", onclick: () => setCamKey('start') }),
    el('button', { className: 'outline-btn', textContent: 'Set End here', title: 'This view becomes where the shot ends: the camera moves across the shot', onclick: () => setCamKey('end'), disabled: !cam })));
  if (cam) {
    rows.push(el('div', { className: 'link-row' },
      el('button', { className: 'text-btn sm', textContent: 'Look at Start', onclick: () => lookAtKey('start') }),
      cam.end ? el('button', { className: 'text-btn sm', textContent: 'Look at End', onclick: () => lookAtKey('end') }) : null,
      cam.end ? el('button', { className: 'text-btn sm', textContent: 'No move', title: 'Keep only Start: a still camera', onclick: clearCamMove }) : null,
      el('button', { className: 'text-btn sm danger', textContent: 'Remove camera', title: 'This shot goes back to plain drawing, without the set', onclick: clearCam })));
    if (cam.end) {
      const ease = el('select', { className: 'field' });
      for (const [v, label] of [['smooth', 'Ease in and out'], ['in', 'Slow start'], ['out', 'Slow end'], ['linear', 'Constant speed']]) ease.append(el('option', { value: v, textContent: label }));
      ease.value = cam.ease || 'smooth';
      ease.addEventListener('change', () => setCam3d(shot, { ...structuredClone(cam), ease: ease.value }, structuredClone(cam)));
      rows.push(el('label', { className: 'select-row' }, el('span', { textContent: 'Move' }), ease));
    }
    if (setLook && setViewMoved) rows.push(el('p', { className: 'hint set-moved', textContent: 'The view has moved: Set Start or Set End to keep it, or move the playhead to go back.' }));
  } else {
    rows.push(el('p', { className: 'hint', textContent: 'Find the angle, then Use this view: the set appears under this shot\'s drawing. Set End too and the camera moves across the shot.' }));
  }

  // Everything in the set
  const list = el('ul', { className: 'set-list' });
  for (const x of state.set ? state.set.objects : []) {
    const li = el('li', { className: x.id === setPicked ? 'active' : '', textContent: x.name, title: SET_SHAPES[x.kind].label });
    li.addEventListener('click', () => { setPicked = x.id; set3d.select(x.id); renderSetPanel(); });
    li.addEventListener('dblclick', () => set3d.frame(x.id));
    list.append(li);
  }
  rows.push(el('div', { className: 'sec-head sub' }, el('h2', { textContent: 'In the set' })), list);

  // How it sits under the drawing
  rows.push(el('div', { className: 'sec-head sub' }, el('h2', { textContent: 'Under the drawing' })));
  const showBtn = el('button', { className: 'switch' + (state.set && state.set.visible ? ' on' : ''), type: 'button' });
  showBtn.append(el('span'));
  showBtn.addEventListener('click', () => {
    if (!state.set) return;
    const from = setSnapshot();
    state.set.visible = !state.set.visible;
    commitSet(from);
    renderSetPanel(true);
  });
  rows.push(el('div', { className: 'field-row' }, el('span', { textContent: 'Show the set' }), showBtn));
  const op = el('input', { type: 'range', min: 5, max: 100, value: Math.round((state.set ? state.set.opacity : 0.7) * 100) });
  const opVal = el('span', { className: 'num', textContent: `${op.value}%` });
  let opFrom = null;
  op.addEventListener('input', () => {
    if (!opFrom) opFrom = setSnapshot();
    state.set.opacity = Number(op.value) / 100;
    opVal.textContent = `${op.value}%`;
    setVersion++;
    syncSetView();
  });
  op.addEventListener('change', () => { const f = opFrom; opFrom = null; if (f) commitSet(f); });
  rows.push(el('label', { className: 'slider-row' }, el('span', { textContent: 'Opacity' }), op, opVal));
  rows.push(el('button', { className: 'text-btn wide', textContent: 'Trace the set onto a new layer', title: 'Draws the set\'s lines, as this shot\'s camera sees them at the playhead, onto a new layer', onclick: traceSetToLayer, disabled: !cam }));
  const snap = el('button', { className: 'switch' + (setSnapOn ? ' on' : ''), type: 'button' });
  snap.append(el('span'));
  snap.addEventListener('click', () => { setSnapOn = !setSnapOn; set3d.setSnap(setSnapOn); renderSetPanel(true); });
  rows.push(el('div', { className: 'field-row' }, el('span', { textContent: 'Snap' }), snap));
  rows.push(el('p', { className: 'hint', textContent: 'Keys: W moves, E turns, R sizes the picked shape, F frames it, C switches the view, Esc goes back to drawing. Snap keeps moves to quarter metres and turns to 15°.' }));
  secSet.replaceChildren(...rows);
}
let setSnapOn = true;

function setGizmo(mode) {
  if (!set3d) return;
  set3d.setMode(mode);
  set3d._mode = mode;
  renderSetPanel(true);
}

// The Shot tab's 3D section, in drawing mode.
function renderShotSetInfo() {
  const box = $('#shotSetInfo');
  if (!box) return;
  const shot = mounted;
  const cam = shot && shot.cam3d;
  const text = !cam ? 'No 3D camera: this shot is plain drawing.'
    : cam.end ? 'Seen through a moving 3D camera (Start to End).' : 'Seen through a 3D camera.';
  if (box.textContent !== text) box.textContent = text;
}

// Keys in the 3D view. Returns true when it used the key (or kept it from the
// drawing tools).
function setKeydown(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (ctrl) {
    if (key === 'd') { duplicateSetObject(); e.preventDefault(); return true; }
    return !['z', 'y', 's', 'o', 'n', 'e'].includes(key); // undo, save, open, new, export work as usual
  }
  switch (key) {
    case 'w': setGizmo('translate'); break;
    case 'e': setGizmo('rotate'); break;
    case 'r': setGizmo('scale'); break;
    case 'f': set3d.frame(setPicked); break;
    case 'c': setLook = !setLook; if (setLook && mounted && !mounted.cam3d) setViewMoved = true; syncSetEditor(true); break;
    case 'delete': case 'backspace': deleteSetObject(); break;
    case 'escape':
      if (setPicked) { setPicked = null; set3d.select(null); renderSetPanel(); } else exitSetMode();
      break;
    // the timeline keys work as usual
    case ',': case '.': case 'home': case 'enter': case '=': case '+': case '-': case '\\': case 'f2':
      return false;
    default:
      break;
  }
  e.preventDefault();
  return true;
}

$('#setBtn').addEventListener('click', toggleSetMode);
$('#openSetBtn').addEventListener('click', enterSetMode);
