'use strict';
// Perspective grid: a grid laid on a plane in the scene, one per shot. Drag the
// corners to set the perspective, the dots on the edges and in the middle to
// bend it into curved perspective, and inside it to move it. With snapping on,
// strokes follow whichever grid direction they start along.
//
// The grid is stored relative to the frame centre, like camera moves, so it
// stays put when the canvas is resized.

const gridLayer = $('#gridLayer');
state.gridSnap = false;
state.gridLine = 2; // line width in layer pixels when drawing the grid onto a layer
state.gridHorizon = false; // include the horizon when drawing onto a layer
state.gridBorder = false; // include the outer edge lines when drawing onto a layer
let gridDrag = null;

const BEND_KEYS = ['top', 'right', 'bottom', 'left', 'center'];
const frameCenter = () => ({ x: dims.FX + dims.W / 2, y: dims.FY + dims.H / 2 });

// A floor plane receding to a vanishing point near the middle of the frame,
// with every handle inside the frame so it can be grabbed straight away.
function defaultGrid() {
  const W = dims.W;
  const H = dims.H;
  const zero = () => ({ x: 0, y: 0 });
  return {
    corners: [
      { x: -0.17 * W, y: 0.02 * H },
      { x: 0.17 * W, y: 0.02 * H },
      { x: 0.44 * W, y: 0.44 * H },
      { x: -0.44 * W, y: 0.44 * H },
    ],
    bends: { top: zero(), right: zero(), bottom: zero(), left: zero(), center: zero() },
    cols: 8,
    rows: 8,
    visible: true,
    opacity: 0.6,
  };
}

// Maps grid space (u across, v down, each 0 to 1) to layer coordinates: a
// projective map from the square to the four corners, plus the bends. Each
// edge bend lifts the middle of its edge and fades out towards the far edge;
// the centre bend bulges the middle.
function gridMap(grid) {
  const c = frameCenter();
  const [p0, p1, p2, p3] = grid.corners.map((p) => ({ x: p.x + c.x, y: p.y + c.y }));
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const del = dx1 * dy2 - dx2 * dy1;
  const g = Math.abs(del) > 1e-9 ? (sx * dy2 - dx2 * sy) / del : 0;
  const h = Math.abs(del) > 1e-9 ? (dx1 * sy - sx * dy1) / del : 0;
  const a = p1.x - p0.x + g * p1.x;
  const b = p3.x - p0.x + h * p3.x;
  const d = p1.y - p0.y + g * p1.y;
  const e = p3.y - p0.y + h * p3.y;
  const bn = grid.bends;
  return (u, v) => {
    const w = g * u + h * v + 1;
    const bu = 4 * u * (1 - u);
    const bv = 4 * v * (1 - v);
    const kt = (1 - v) * bu;
    const kb = v * bu;
    const kl = (1 - u) * bv;
    const kr = u * bv;
    const kc = bu * bv;
    return {
      x: (a * u + b * v + p0.x) / w + kt * bn.top.x + kb * bn.bottom.x + kl * bn.left.x + kr * bn.right.x + kc * bn.center.x,
      y: (d * u + e * v + p0.y) / w + kt * bn.top.y + kb * bn.bottom.y + kl * bn.left.y + kr * bn.right.y + kc * bn.center.y,
    };
  };
}

// Finds (u, v) for a layer point: a coarse search, then Newton steps.
function gridInverse(map, p) {
  let best = { u: 0.5, v: 0.5, d: Infinity };
  for (let u = -0.5; u <= 1.5; u += 0.1) {
    for (let v = -0.5; v <= 1.5; v += 0.1) {
      const q = map(u, v);
      const dd = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (dd < best.d) best = { u, v, d: dd };
    }
  }
  let { u, v } = best;
  for (let i = 0; i < 25; i++) {
    const q = map(u, v);
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    if (ex * ex + ey * ey < 1e-8) break;
    const s = 1e-4;
    const qu = map(u + s, v);
    const qv = map(u, v + s);
    const j11 = (qu.x - q.x) / s;
    const j21 = (qu.y - q.y) / s;
    const j12 = (qv.x - q.x) / s;
    const j22 = (qv.y - q.y) / s;
    const det = j11 * j22 - j12 * j21;
    if (Math.abs(det) < 1e-12) break;
    u -= (j22 * ex - j12 * ey) / det;
    v -= (-j21 * ex + j11 * ey) / det;
  }
  return { u, v };
}

// Where the edges meet when they are straight: the vanishing points, and the
// horizon through them.
function lineCross(a, b, c, d) {
  const den = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
  if (Math.abs(den) < 1e-6) return null;
  const t = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x)) / den;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

function vanishingPoints(grid) {
  const c = frameCenter();
  const [p0, p1, p2, p3] = grid.corners.map((p) => ({ x: p.x + c.x, y: p.y + c.y }));
  const far = (q) => q && Math.hypot(q.x - c.x, q.y - c.y) < dims.W * 20;
  const vps = [lineCross(p0, p1, p3, p2), lineCross(p0, p3, p1, p2)].filter(far);
  return vps;
}

// ---------------------------------------------------------------- drawing

function renderGrid() {
  const shot = current();
  const grid = shot && shot.grid;
  const editing = state.tool === 'perspective';
  if (!grid || (!grid.visible && !editing) || playing || scrub) { gridLayer.replaceChildren(); return; }
  const map = gridMap(grid);
  const S = (p) => toScreen(p);
  const N = 48;
  const path = [];
  const curve = (fn) => {
    const pts = [];
    for (let k = 0; k <= N; k++) {
      const q = S(fn(k / N));
      pts.push(`${q.x.toFixed(1)},${q.y.toFixed(1)}`);
    }
    path.push(`M${pts.join('L')}`);
  };
  for (let i = 0; i <= grid.cols; i++) curve((t) => map(i / grid.cols, t));
  for (let j = 0; j <= grid.rows; j++) curve((t) => map(t, j / grid.rows));

  // Horizon through the vanishing points (or level through a single one).
  let horizon = '';
  const vps = vanishingPoints(grid).map(S);
  const r = viewport.getBoundingClientRect();
  if (vps.length) {
    const [a, b] = vps.length === 2 ? vps : [vps[0], { x: vps[0].x + 1, y: vps[0].y }];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const k = (r.width + r.height) * 2;
    horizon = `<path class="grid-horizon" d="M${a.x - (dx / len) * k},${a.y - (dy / len) * k}L${a.x + (dx / len) * k},${a.y + (dy / len) * k}"/>` +
      vps.map((v) => `<circle class="grid-vp" cx="${v.x}" cy="${v.y}" r="4"/>`).join('');
  }

  let handles = '';
  if (editing) {
    const corner = grid.corners.map((p, i) => {
      const q = S(map(i === 1 || i === 2 ? 1 : 0, i >= 2 ? 1 : 0));
      return `<rect class="grid-handle corner" data-kind="corner" data-key="${i}" x="${q.x - 6}" y="${q.y - 6}" width="12" height="12" rx="2"/>`;
    }).join('');
    const spots = { top: [0.5, 0], right: [1, 0.5], bottom: [0.5, 1], left: [0, 0.5], center: [0.5, 0.5] };
    const bend = BEND_KEYS.map((key) => {
      const q = S(map(...spots[key]));
      return `<circle class="grid-handle bend" data-kind="bend" data-key="${key}" cx="${q.x}" cy="${q.y}" r="6"/>`;
    }).join('');
    handles = corner + bend;
  }
  gridLayer.innerHTML = `<svg width="${r.width}" height="${r.height}">` +
    `<g opacity="${grid.visible ? grid.opacity : 0.25}">${horizon}<path class="grid-lines" d="${path.join('')}"/></g>${handles}</svg>`;
}

// ---------------------------------------------------------------- editing

function setGrid(shot, grid, from) {
  shot.grid = grid;
  pushHistory({ type: 'grid', shotId: shot.id, from: structuredClone(from), to: structuredClone(grid) });
  refreshUI();
}

function ensureGrid() {
  const shot = current();
  if (shot && !shot.grid) setGrid(shot, defaultGrid(), null);
}

function beginGridDrag(e, shot, kind, key) {
  e.stopPropagation();
  e.preventDefault();
  try { viewport.setPointerCapture(e.pointerId); } catch {}
  gridDrag = { id: e.pointerId, shot, kind, key, from: structuredClone(shot.grid), p0: toCanvas(e) };
  const move = (ev) => {
    if (!gridDrag || ev.pointerId !== gridDrag.id) return;
    const p = toCanvas(ev);
    let dx = p.x - gridDrag.p0.x;
    let dy = p.y - gridDrag.p0.y;
    if (ev.shiftKey) ({ dx, dy } = constrain45(dx, dy));
    const g = gridDrag.shot.grid;
    const f = gridDrag.from;
    if (gridDrag.kind === 'corner') {
      g.corners[gridDrag.key] = { x: f.corners[gridDrag.key].x + dx, y: f.corners[gridDrag.key].y + dy };
    } else if (gridDrag.kind === 'bend') {
      g.bends[gridDrag.key] = { x: f.bends[gridDrag.key].x + dx, y: f.bends[gridDrag.key].y + dy };
    } else {
      g.corners = f.corners.map((c) => ({ x: c.x + dx, y: c.y + dy }));
    }
    renderGrid();
  };
  const up = (ev) => {
    if (!gridDrag || ev.pointerId !== gridDrag.id) return;
    const d = gridDrag;
    gridDrag = null;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    setGrid(d.shot, d.shot.grid, d.from);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

gridLayer.addEventListener('pointerdown', (e) => {
  const h = e.target.closest('.grid-handle');
  const shot = current();
  if (!h || !shot || !shot.grid || e.button !== 0) return;
  beginGridDrag(e, shot, h.dataset.kind, h.dataset.kind === 'corner' ? Number(h.dataset.key) : h.dataset.key);
});

// Called by the canvas when the Perspective tool is active: dragging inside
// the grid moves it.
function gridPointerDown(e, p) {
  const shot = current();
  if (!shot) return;
  if (!shot.grid) { ensureGrid(); return; }
  const { u, v } = gridInverse(gridMap(shot.grid), p);
  if (u >= 0 && u <= 1 && v >= 0 && v <= 1) beginGridDrag(e, shot, 'move');
}

function straightenGrid() {
  const shot = current();
  if (!shot || !shot.grid) return;
  const from = structuredClone(shot.grid);
  const zero = () => ({ x: 0, y: 0 });
  setGrid(shot, { ...shot.grid, bends: { top: zero(), right: zero(), bottom: zero(), left: zero(), center: zero() } }, from);
}

function updateGrid(props) {
  const shot = current();
  if (!shot || !shot.grid) return;
  const from = structuredClone(shot.grid);
  setGrid(shot, { ...shot.grid, ...props }, from);
}

function copyGridToAll() {
  const src = current();
  if (!src || !src.grid) return;
  for (const shot of state.shots) {
    if (shot === src) continue;
    const from = structuredClone(shot.grid || null);
    shot.grid = structuredClone(src.grid);
    pushHistory({ type: 'grid', shotId: shot.id, from, to: structuredClone(shot.grid) });
  }
  toast(`Copied the grid to all ${state.shots.length} shots`);
  refreshUI();
}

function removeGrid() {
  const shot = current();
  if (!shot || !shot.grid) return;
  setGrid(shot, null, shot.grid);
}

// ---------------------------------------------------------------- drawing onto a layer

// Draws the grid (and the horizon, if asked) as real pixels on a new layer
// above the current one, in the current colour. From then on it is ordinary
// artwork: erasable, and included in exports.
const stampGrid = () => enqueue(async () => {
  const shot = mounted;
  const grid = shot && shot.grid;
  if (!grid) return;
  const index = shot.layers.findIndex((l) => l.id === shot.activeLayerId) + 1;
  const layer = newLayer('Grid');
  await insertLayer(index, layer);
  const ctx = live.get(layer.id).getContext('2d');
  const map = gridMap(grid);
  const N = 96;
  ctx.save();
  ctx.strokeStyle = state.color;
  ctx.lineWidth = state.gridLine;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const curve = (fn) => {
    const p0 = fn(0);
    ctx.moveTo(p0.x, p0.y);
    for (let k = 1; k <= N; k++) {
      const p = fn(k / N);
      ctx.lineTo(p.x, p.y);
    }
  };
  // Only the inner lines, unless the border is asked for: the guide on screen
  // keeps its outline so the plane can still be seen while adjusting it.
  const edge = state.gridBorder ? 0 : 1;
  for (let i = edge; i <= grid.cols - edge; i++) curve((t) => map(i / grid.cols, t));
  for (let j = edge; j <= grid.rows - edge; j++) curve((t) => map(t, j / grid.rows));
  if (state.gridHorizon) {
    const vps = vanishingPoints(grid);
    if (vps.length) {
      const [a, b] = vps.length === 2 ? vps : [vps[0], { x: vps[0].x + 1, y: vps[0].y }];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const k = dims.CW + dims.CH;
      ctx.moveTo(a.x - (dx / len) * k, a.y - (dy / len) * k);
      ctx.lineTo(a.x + (dx / len) * k, a.y + (dy / len) * k);
    }
  }
  ctx.stroke();
  ctx.restore();
  layer.dirty = true;
  pushHistory({ type: 'addLayer', shotId: shot.id, index, layer });
  scheduleThumb();
  // The blue guide sat right on top of the drawn lines, so turning the new
  // layer's opacity down seemed to do nothing. The guide is hidden now (it can
  // be shown again in the grid tool) and the brush comes back. Not an undo
  // step of its own, so one undo still takes the drawn grid away.
  shot.grid = { ...grid, visible: false };
  setTool('brush');
  toast('Drew the grid onto a new layer and hid the guide');
});

// ---------------------------------------------------------------- snapping

// Sets a stroke up to follow the grid, if snapping is on.
function startAssist(s, p) {
  const shot = current();
  if (!state.gridSnap || !shot || !shot.grid || !shot.grid.visible) return null;
  if (s.b.kind !== 'solid' && s.b.kind !== 'erase') return null;
  const map = gridMap(shot.grid);
  return { map, start: p, ...gridInverse(map, p), axis: null, t: 0, buffer: [] };
}

// The first few pixels decide which grid direction the stroke follows; after
// that every pen position is pulled onto that grid line.
function assistPoint(s, p, pressure) {
  const a = s.assist;
  if (!a.axis) {
    a.buffer.push({ p, pressure });
    if (Math.hypot(p.x - a.start.x, p.y - a.start.y) < 10 / state.view.z) return;
    const q = a.map(a.u, a.v);
    const qu = a.map(a.u + 1e-3, a.v);
    const qv = a.map(a.u, a.v + 1e-3);
    const mx = p.x - a.start.x;
    const my = p.y - a.start.y;
    const along = (q2) => {
      const dx = q2.x - q.x;
      const dy = q2.y - q.y;
      return Math.abs(mx * dx + my * dy) / (Math.hypot(dx, dy) || 1);
    };
    a.axis = along(qu) >= along(qv) ? 'u' : 'v';
    a.t = a.axis === 'u' ? a.u : a.v;
    const buffered = a.buffer;
    a.buffer = [];
    for (const b of buffered) assistPoint(s, b.p, b.pressure);
    return;
  }
  const at = (t) => (a.axis === 'u' ? a.map(t, a.v) : a.map(a.u, t));
  let t = a.t;
  for (let i = 0; i < 6; i++) {
    const q = at(t);
    const q2 = at(t + 1e-4);
    const dx = (q2.x - q.x) / 1e-4;
    const dy = (q2.y - q.y) / 1e-4;
    const dd = dx * dx + dy * dy;
    if (dd < 1e-12) break;
    t += ((p.x - q.x) * dx + (p.y - q.y) * dy) / dd;
  }
  a.t = t;
  const q = at(t);
  s.sp = pressure;
  placePoint(q.x, q.y);
}
