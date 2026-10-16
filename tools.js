'use strict';
// Everything that happens when the pen touches the canvas: brushes (solid,
// airbrush, motion blur, eraser), fill, lasso and pan.

const MIN_PRESSURE = 0.02;

// kind: solid = filled outline between pen positions; air = soft dabs that
// build up; smear = motion blur trail; erase = removes pixels. (The blur
// filters, for a whole layer or selection, are in filters.js.)
// roundness < 1 makes an oval nib, tilted by `angle` degrees.
// No stabilization: lines follow the pen exactly.
const BRUSH_PRESETS = [
  // cleanup: the wiggle filter, in screen pixels (see solidPoint).
  { id: 'pencil', name: 'Pencil', kind: 'stamp', size: 5, opacity: 1, flow: 0.35, flowMin: 0.1, buildup: 0.3, spacing: 0.02, height: true, gain: 120, texture: 0.12, paperScale: 0.75, scatter: 0.05, count: 1, angle: 0, angleJitter: 0.5, sizeJitter: 0.05, opacityJitter: 0.1, minSize: 0.35, roundness: 1, cleanup: 1, tip: { shape: 'round', aspect: 1, rough: 0.8, tooth: 0.3 } },
  { id: 'ink', name: 'Ink', kind: 'solid', size: 8, opacity: 1, minSize: 0.12, roundness: 1, angle: 0, cleanup: 1 },
  // Stamp brushes matched to her Photoshop and Procreate brushes (see the stamp brushes section).
  { id: 'gink', name: 'Gesinski ink', kind: 'stamp', size: 12, opacity: 1, flow: 1, flowMin: 1, opacityMin: 1, buildup: 1, spacing: 0.06, scatter: 0.02, count: 1, angle: 35, angleJitter: 0, sizeJitter: 0, opacityJitter: 0, texture: 0.12, minSize: 0.04, roundness: 1, cleanup: 1, tip: { shape: 'round', aspect: 0.45, rough: 1.2, tooth: 0.5 } },
  { id: 'apencil', name: 'Animator pencil', kind: 'stamp', size: 7, opacity: 1, flow: 0.29, flowMin: 0, buildup: 0.108, spacing: 0.01, height: true, paperLevel: 0, gain: 150, scatter: 0.1, count: 3, angle: 39, angleJitter: 0.05, sizeJitter: 0.05, opacityJitter: 0.1, texture: 0.08, minSize: 0.12, roundness: 0.45, cleanup: 1, tilt: 2, tip: { shape: 'rect', aspect: 0.83, rough: 2.4, tooth: 0.22 } },
  { id: 'upencil', name: 'Ultimate pencil', kind: 'stamp', size: 8, opacity: 1, flow: 0.38, flowMin: 0.3, opacityMin: 0.49, buildup: 1, spacing: 0.18, height: true, paperScale: 0.5, gain: 120, texture: 0.12, scatter: 0, count: 1, angle: 74, angleJitter: 0.08, sizeJitter: 0.15, opacityJitter: 0.3, minSize: 0.3, roundness: 1, cleanup: 1, tip: { shape: 'round', aspect: 0.92, rough: 1.8, tooth: 0.45 } },
  { id: 'nib', name: 'Oval nib', kind: 'solid', size: 20, opacity: 1, minSize: 0.2, roundness: 0.3, angle: 35, cleanup: 1 },
  { id: 'marker', name: 'Marker', kind: 'solid', size: 30, opacity: 0.5, minSize: 1, roundness: 1, angle: 0, cleanup: 1 },
  { id: 'airbrush', name: 'Airbrush', kind: 'air', size: 140, opacity: 1, flow: 0.08, minSize: 0.6, roundness: 1, angle: 0 },
  { id: 'gair', name: 'Grain airbrush', kind: 'stamp', size: 300, opacity: 1, flow: 0.35, flowMin: 1, opacityMin: 0, buildup: 1, spacing: 0.25, scatter: 0, count: 1, angle: 0, angleJitter: 1, sizeJitter: 0, opacityJitter: 0, texture: 0, minSize: 1, roundness: 1, cleanup: 0, tip: { shape: 'soft', aspect: 1, rough: 0, tooth: 0, grain: 0.85 } },
  // Blurs the drawing under it along the way the stroke moves.
  // After PencilBoard's: start on the drawing and drag to pull a streaky trail.
  // (Removed for the blur filters on 2026-10-07; back by her request 2026-10-10.)
  { id: 'blur', name: 'Motion blur', kind: 'smear', size: 120, opacity: 1, strength: 0.85, length: 80, feather: 0.8, pressureStrength: true, minSize: 1, roundness: 1, angle: 0 },
  { id: 'oolong', name: 'Milk oolong', kind: 'stamp', size: 40, opacity: 1, flow: 0.5, flowMin: 0.35, opacityMin: 0.7, buildup: 0.3, spacing: 0.03, scatter: 0, count: 1, angle: -61, angleJitter: 0.02, sizeJitter: 0.04, opacityJitter: 0.1, texture: 0.1, minSize: 0.12, roundness: 1, cleanup: 1, tip: { shape: 'flat', aspect: 0.55, rough: 0, tooth: 0.19 } },
  { id: 'eraser', name: 'Eraser', kind: 'erase', size: 40, opacity: 1, minSize: 0.4, roundness: 0.6, angle: 35, cleanup: 1 },
];
for (const b of BRUSH_PRESETS) state.brushes[b.id] = { ...b };

state.tool = 'brush'; // brush | fill | lasso | pan
state.fill = { tolerance: 40, gap: 3 };
// A selection is one or more areas, each an outline with any holes cut in it
// (Shift adds an area, Ctrl cuts one out): polys is a list of
// [outline, hole, hole...], each a list of {x, y}.
state.selection = null; // { path: Path2D, polys, box }
// What a new lasso does without keys held: new, add, sub (cut) or and (overlap).
state.lassoMode = 'new';

const brush = () => state.brushes[state.brushId];

function setBrush(id) {
  if (lift) dropSelection();
  state.brushId = id;
  if (id !== 'eraser') state.lastDrawBrush = id;
  state.tool = 'brush';
  refreshUI();
}

function setTool(tool) {
  if (tool !== state.tool && typeof setInspectorTab === 'function') setInspectorTab('tool');
  if (tool === 'eraser') { setBrush('eraser'); return; }
  if (tool === 'brush') { setBrush(state.brushId === 'eraser' ? state.lastDrawBrush : state.brushId); return; }
  if (lift && tool !== 'lasso' && tool !== 'move') dropSelection();
  if (wholeMove && !lift) { wholeMove = false; setSelection(null); }
  state.tool = tool;
  if (tool === 'perspective') ensureGrid();
  refreshUI();
}

// ---------------------------------------------------------------- shapes

function dot(ctx, p) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.r, 0, TAU);
  ctx.fill();
}

// Fills the outline joining two circles, so width changes smoothly with pressure.
function segment(ctx, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d > Math.abs(a.r - b.r)) {
    const th = Math.atan2(dy, dx);
    const al = Math.acos((a.r - b.r) / d);
    ctx.beginPath();
    ctx.moveTo(a.x + a.r * Math.cos(th + al), a.y + a.r * Math.sin(th + al));
    ctx.lineTo(b.x + b.r * Math.cos(th + al), b.y + b.r * Math.sin(th + al));
    ctx.lineTo(b.x + b.r * Math.cos(th - al), b.y + b.r * Math.sin(th - al));
    ctx.lineTo(a.x + a.r * Math.cos(th - al), a.y + a.r * Math.sin(th - al));
    ctx.closePath();
    ctx.fill();
  }
  dot(ctx, b);
}

// Oval nibs: squash and tilt the canvas so the oval becomes a circle, draw the
// usual circle outline there, and let the transform turn it back into an oval.
function nibShape(b) {
  if (b.roundness >= 0.999) return null;
  const a = (b.angle * Math.PI) / 180;
  return { cos: Math.cos(a), sin: Math.sin(a), q: b.roundness };
}

function toNib(p, sh) {
  return { x: p.x * sh.cos + p.y * sh.sin, y: (-p.x * sh.sin + p.y * sh.cos) / sh.q, r: p.r };
}

function stamp(ctx, a, b, sh) {
  if (!sh) { if (a) segment(ctx, a, b); else dot(ctx, b); return; }
  ctx.save();
  ctx.transform(sh.cos, sh.sin, -sh.sin, sh.cos, 0, 0);
  ctx.scale(1, sh.q);
  const nb = toNib(b, sh);
  if (a) segment(ctx, toNib(a, sh), nb); else dot(ctx, nb);
  ctx.restore();
}

// ---------------------------------------------------------------- strokes

let stroke = null;
let pan = null;
let spaceDown = false;
let rotateDown = false;

function pressureOf(e) {
  // Mice report 0.5 while pressed; treat them as full pressure.
  return e.pointerType === 'pen' ? Math.max(MIN_PRESSURE, e.pressure) : 1;
}

// How far the pen leans (0 upright, 1 flat on the tablet) and which way, on
// screen. Null when the pen does not report tilt.
function tiltOf(e) {
  if (e.pointerType !== 'pen') return null;
  let alt = e.altitudeAngle;
  let dir = e.azimuthAngle;
  if (alt === undefined) {
    const tx = Math.tan((e.tiltX * Math.PI) / 180);
    const ty = Math.tan((e.tiltY * Math.PI) / 180);
    alt = Math.atan2(1, Math.hypot(tx, ty));
    dir = Math.atan2(ty, tx);
  }
  const mag = 1 - alt / (Math.PI / 2);
  return mag > 0.01 ? { mag, dir } : null;
}

function isPenEraser(e) {
  return e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0);
}

// A stroke in progress sits on its own canvas above the layer, so it takes the
// layer's opacity as well as the brush's; otherwise it shows at full strength
// until the pen lifts and then jumps lighter.
function workingOpacity(b) {
  const layer = activeLayer();
  return b.opacity * (layer ? layer.opacity : 1);
}

function clipToSelection(ctx) {
  if (state.selection) ctx.clip(state.selection.path);
}

function beginStroke(e, b) {
  const layer = activeLayer();
  const canvas = live.get(layer.id);
  const onLayer = b.kind === 'erase' || b.kind === 'smear';
  let ctx;
  let backup = null;
  if (onLayer) {
    // A GPU-side snapshot for undo. Reading pixels back to the CPU stalls the app.
    backup = createImageBitmap(canvas);
    ctx = canvas.getContext('2d');
    ctx.save();
    clipToSelection(ctx);
    if (b.kind === 'erase') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
    }
  } else if (b.kind === 'stamp') {
    ctx = strokeCtx;
    ctx.save();
    clipToSelection(ctx);
  } else {
    ctx = strokeCtx;
    ctx.save();
    clipToSelection(ctx);
    ctx.fillStyle = state.color;
    strokeGroup.style.opacity = workingOpacity(b);
  }
  const rect = viewport.getBoundingClientRect();
  const p = toCanvas(e, rect);
  stroke = {
    pointerId: e.pointerId,
    b,
    shape: b.kind === 'solid' || b.kind === 'erase' ? nibShape(b) : null,
    layer,
    canvas,
    ctx,
    rect,
    backup,
    sx: p.x,
    sy: p.y,
    sp: pressureOf(e),
    raw: p,
    last: null,
    lastDab: null,
    minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
    // Solid strokes: curve buffer, the shape being built, and what is on the
    // live canvas.
    solid: b.kind === 'solid' || b.kind === 'stamp' || b.kind === 'erase',
    stamp: b.kind === 'stamp',
    erase: b.kind === 'erase',
    cr: [],
    pr: null,
    path: new Path2D(),
    segs: 0,
    lastDrawn: null,
    prov: null,
    raf: 0,
    live: null,
  };
  if (b.kind === 'smear') startSmear(stroke);
  if (b.kind === 'stamp') beginStamp(stroke);
  stroke.assist = startAssist(stroke, p);
  // Shift: a drag stays level or upright. (A Shift-click does not join up
  // with the last stroke the way Photoshop does; she did not want that.)
  if (e.shiftKey && !stroke.assist) stroke.lock = { x: p.x, y: p.y, axis: null };
  addPoint(e);
}

function lockAxis(s, p) {
  const L = s.lock;
  if (!L.axis) {
    const dx = p.x - L.x;
    const dy = p.y - L.y;
    if (Math.hypot(dx, dy) * state.view.z < 4) return { x: L.x, y: L.y };
    L.axis = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
  }
  return L.axis === 'h' ? { x: p.x, y: L.y } : { x: L.x, y: p.y };
}

function radiusFor(s, pressure = s.sp) {
  return Math.max(0.5, (s.b.size / 2) * (s.b.minSize + (1 - s.b.minSize) * pressure));
}

// ---------------------------------------------------------------- solid strokes
//
// Like Photoshop: the line through the pen positions is a smooth curve, and
// the stroke is filled as one shape so its edges are anti-aliased once. Drawing
// it piece by piece instead left little bumps wherever pieces overlapped.
// Position is never averaged or delayed: the curve passes through every point
// the pen reports, and a straight preview runs from the curve to the pen.

// The live canvas refills at most this many recent pieces each frame; older
// ones are settled onto the stroke canvas. Where one batch hands over to the
// next, one edge pixel gets a faint extra layer of anti-aliasing.
const MAX_LIVE_SEGMENTS = 48;
// How far the stroke can run from where the small live canvas was placed
// before a stretch is settled and the canvas moves along.
const LIVE_REACH = 240;

// Adds the outline around two circles (a may be null for a single dot) to a
// path. Quads and circles all wind the same way, so the path fills as one
// shape where pieces overlap.
function hullInto(path, a, b) {
  if (a) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy);
    if (d > Math.abs(a.r - b.r)) {
      const th = Math.atan2(dy, dx);
      const al = Math.acos((a.r - b.r) / d);
      path.moveTo(a.x + a.r * Math.cos(th + al), a.y + a.r * Math.sin(th + al));
      path.lineTo(b.x + b.r * Math.cos(th + al), b.y + b.r * Math.sin(th + al));
      path.lineTo(b.x + b.r * Math.cos(th - al), b.y + b.r * Math.sin(th - al));
      path.lineTo(a.x + a.r * Math.cos(th - al), a.y + a.r * Math.sin(th - al));
      path.closePath();
    }
  }
  path.moveTo(b.x + b.r, b.y);
  path.arc(b.x, b.y, b.r, 0, -TAU, true);
  path.closePath();
}

function pathSegment(path, a, b, sh) {
  if (!sh) { hullInto(path, a, b); return; }
  const piece = new Path2D();
  hullInto(piece, a && toNib(a, sh), toNib(b, sh));
  path.addPath(piece, new DOMMatrix([sh.cos, sh.sin, -sh.sin * sh.q, sh.cos * sh.q, 0, 0]));
}

// Centres the small live canvas on a point.
function placeLive(s, p) {
  const half = Math.ceil(LIVE_REACH + s.b.size + 8);
  const size = half * 2;
  if (liveCanvas.width !== size) {
    liveCanvas.width = size;
    liveCanvas.height = size;
    liveCanvas.style.width = `${size}px`;
    liveCanvas.style.height = `${size}px`;
  } else {
    liveCtx.setTransform(1, 0, 0, 1, 0, 0);
    liveCtx.clearRect(0, 0, size, size);
  }
  s.live = { ox: Math.round(p.x - half), oy: Math.round(p.y - half), size };
  liveCanvas.style.transform = `translate(${s.live.ox}px, ${s.live.oy}px)`;
  liveCanvas.style.display = 'block';
}

function insideLive(s, p) {
  const l = s.live;
  const m = p.r + 3;
  return p.x - m >= l.ox && p.y - m >= l.oy && p.x + m <= l.ox + l.size && p.y + m <= l.oy + l.size;
}

function addSolidSeg(s, a, b) {
  if (s.stamp) { stampSeg(s, a, b); return; }
  // The eraser follows the same smoothed curve as the nib brushes, cut
  // straight out of the layer.
  if (s.erase) {
    const piece = new Path2D();
    pathSegment(piece, a, b, s.shape);
    s.ctx.fill(piece);
    grow(s, b.x, b.y, b.r);
    return;
  }
  if (s.live && !insideLive(s, b)) freezeLive(s, a || b);
  if (!s.live) placeLive(s, a || b);
  pathSegment(s.path, a, b, s.shape);
  grow(s, b.x, b.y, b.r);
  if (++s.segs >= MAX_LIVE_SEGMENTS) freezeLive(s, b);
}

// Settles the finished stretch onto the stroke canvas (a fill, never a
// clear) and moves the live canvas along.
function freezeLive(s, at) {
  if (s.segs) strokeCtx.fill(s.path);
  s.path = new Path2D();
  s.segs = 0;
  if (at) placeLive(s, at); else s.live = null;
}

function scheduleLive(s) {
  if (s.raf) return;
  s.raf = requestAnimationFrame(() => {
    s.raf = 0;
    if (stroke === s) renderLive(s);
  });
}

// The stretch between the last settled point and the pen. The wiggle filter
// has to see a few pixels past a point before it can settle it, so this part
// is drawn from the pen's own path for now (it moves by a pixel at most when
// it settles). It used to be a straight line, which snapped into the curve
// behind the pen, and textured brushes drew nothing there at all, so their
// line trailed the pen.
function tailPoints(s) {
  const pts = [s.lastDrawn];
  const add = (q) => {
    const l = pts[pts.length - 1];
    if (Math.hypot(q.x - l.x, q.y - l.y) >= 0.3) pts.push({ x: q.x, y: q.y, pr: q.pr ?? s.pr });
  };
  // The pending curve piece, bent the way it will be once the next point
  // arrives, so the preview does not snap from straight to curved.
  const c = s.cr;
  if (c.length >= 3) {
    const n = Math.max(1, Math.ceil(Math.hypot(c[2].x - c[1].x, c[2].y - c[1].y) / (2 / state.view.z)));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const p = catmull(c[0], c[1], c[2], c[2], t);
      add({ x: p.x, y: p.y, pr: c[1].pr + (c[2].pr - c[1].pr) * t });
    }
  }
  if (s.prov) add({ x: s.prov.x, y: s.prov.y, pr: s.pr });
  return pts;
}

// Repeatable "random" numbers, so a textured tail redrawn every frame does
// not shimmer.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Textured brushes: the tail is stamped on the small live canvas each frame,
// carrying on exactly where the settled stamps stopped (so nothing overlaps
// and darkens), then thrown away when those stamps are made for real.
function renderStampTail(s) {
  if (!s.prov || !s.lastDrawn) return;
  const tail = tailPoints(s);
  const pen = tail[tail.length - 1];
  if (!s.live || !tail.every((p) => insideLive(s, { x: p.x, y: p.y, r: s.b.size }))) placeLive(s, pen);
  const { ox, oy, size } = s.live;
  liveCtx.setTransform(1, 0, 0, 1, 0, 0);
  liveCtx.clearRect(0, 0, size, size);
  if (tail.length < 2) return;
  liveCtx.save();
  liveCtx.setTransform(1, 0, 0, 1, -ox, -oy);
  clipToSelection(liveCtx);
  const rnd = seededRandom(Math.round(s.lastDrawn.x * 7) * 73856093 ^ Math.round(s.lastDrawn.y * 7) * 19349663);
  const h = stampSpacing(s.b);
  let carry = s.dabCarry || 0;
  for (let i = 1; i < tail.length; i++) {
    const a = tail[i - 1];
    const b = tail[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy);
    let pos = h - carry;
    while (pos <= d) {
      const t = pos / d;
      stampStep(s, a.x + dx * t, a.y + dy * t, a.pr + (b.pr - a.pr) * t, { ctx: liveCtx, rnd, ox, oy });
      pos += h;
    }
    carry = d - (pos - h);
  }
  liveCtx.restore();
  liveCtx.setTransform(1, 0, 0, 1, 0, 0);
}

// Redraws the live stretch, plus the not-yet-settled tail up to the pen, as
// one shape.
function renderLive(s) {
  if (s.erase) return;
  if (s.gpu) { pencilRender(s); return; }
  if (s.stamp) { renderStampTail(s); return; }
  if (!s.live) return;
  const { ox, oy, size } = s.live;
  liveCtx.setTransform(1, 0, 0, 1, 0, 0);
  liveCtx.clearRect(0, 0, size, size);
  liveCtx.setTransform(1, 0, 0, 1, -ox, -oy);
  liveCtx.save();
  clipToSelection(liveCtx);
  liveCtx.fillStyle = state.color;
  let path = s.path;
  if (s.prov && s.lastDrawn) {
    path = new Path2D(s.path);
    const tail = tailPoints(s);
    for (let i = 1; i < tail.length; i++) {
      pathSegment(path, { ...tail[i - 1], r: radiusFor(s, tail[i - 1].pr) }, { ...tail[i], r: radiusFor(s, tail[i].pr) }, s.shape);
    }
  }
  liveCtx.fill(path);
  liveCtx.restore();
}

// Centripetal Catmull-Rom: a curve from p1 to p2 that passes exactly through
// the pen positions, without loops or overshoot on uneven spacing.
function catmull(p0, p1, p2, p3, t) {
  const knot = (a, b) => Math.max(1e-4, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)));
  const t1 = knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const mix = (a, b, ta, tb) => ({ x: ((tb - u) * a.x + (u - ta) * b.x) / (tb - ta), y: ((tb - u) * a.y + (u - ta) * b.y) / (tb - ta) });
  const a1 = mix(p0, p1, 0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  return mix(mix(a1, a2, 0, t2), mix(a2, a3, t1, t3), t1, t2);
}

function curveSegment(s, p0, p1, p2, p3) {
  const n = Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 3));
  let prev = s.lastDrawn;
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const q = catmull(p0, p1, p2, p3, t);
    const pr = p1.pr + (p2.pr - p1.pr) * t;
    const cur = { x: q.x, y: q.y, r: radiusFor(s, pr), pr };
    addSolidSeg(s, prev, cur);
    prev = cur;
  }
  s.lastDrawn = prev;
}

// One pen position for a solid stroke. Each curve piece is drawn once the
// position after it is known; until then the preview covers the gap.
function pushCurvePoint(s, q) {
  const pts = s.cr;
  pts.push(q);
  if (pts.length === 4) {
    curveSegment(s, pts[0], pts[1], pts[2], pts[3]);
    pts.shift();
  }
}

function solidPoint(s, x, y, pressure) {
  // Pressure is smoothed a little, which evens out the width jitter raw
  // tablet pressure has.
  s.pr = s.pr === null ? pressure : s.pr + (pressure - s.pr) * 0.5;
  const q = { x, y, pr: s.pr };
  const pts = s.cr;
  if (!pts.length) {
    pts.push(q, q);
    const first = { x, y, r: radiusFor(s, s.pr), pr: s.pr };
    addSolidSeg(s, null, first);
    s.lastDrawn = first;
    s.euro = null;
    if (s.b.cleanup) steadyPoint(s, x, y);
  } else {
    const f = s.b.cleanup ? steadyPoint(s, x, y) : q;
    const last = pts[pts.length - 1];
    if (Math.hypot(f.x - last.x, f.y - last.y) >= 0.75) pushCurvePoint(s, { x: f.x, y: f.y, pr: s.pr });
  }
  s.prov = { x, y };
  scheduleLive(s);
}

// ---------------------------------------------------------------- wiggle filter
//
// Like Photoshop's and Procreate's smoothing, it only works forward: each pen
// position is eased towards, and what is drawn never moves afterwards. (The
// earlier filter re-smoothed the last few pixels after drawing them, so the
// line near the pen kept shifting.) How much it eases depends on speed, a
// "one euro" filter: slow, careful lines, where a shaky hand shows, are
// smoothed most, and as the pen is moving slowly the line stays within a
// pixel or two of it; fast strokes are barely smoothed, so they do not lag
// either. When the pen lifts the line runs on to exactly where it stopped.
// `cleanup` (screen pixels) sets the strength, 0 turns it off; it is measured
// on screen so it feels the same at any zoom.

const PEN_DT_MS = 4; // for events with no usable timing (tests): a 240Hz pen
function euroAlpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}
function steadyPoint(s, x, y) {
  const z = state.view.z;
  const t = s.t || performance.now();
  const E = s.euro;
  if (!E) {
    s.euro = { x, y, rx: x, ry: y, vx: 0, vy: 0, t };
    return { x, y };
  }
  let ms = t - E.t;
  if (!(ms >= 1)) ms = PEN_DT_MS;
  ms = Math.min(ms, 50);
  E.t = t;
  const dt = ms / 1000;
  // How fast the pen is going on screen, itself smoothed a little.
  const ad = euroAlpha(1.5, dt);
  E.vx += (((x - E.rx) * z) / dt - E.vx) * ad;
  E.vy += (((y - E.ry) * z) / dt - E.vy) * ad;
  const step = Math.hypot(x - E.rx, y - E.ry) * z;
  E.rx = x;
  E.ry = y;
  const speed = Math.hypot(E.vx, E.vy);
  // Pen samples far apart on screen mean a quick stroke, where a shaky hand
  // cannot show: follow the pen exactly there.
  const a = Math.max(euroAlpha(10 / Math.max(0.5, s.b.cleanup) + 0.02 * speed, dt), Math.min(1, Math.max(0, (step - 8) / 8)));
  E.x += (x - E.x) * a;
  E.y += (y - E.y) * a;
  return { x: E.x, y: E.y };
}

function finishSolid(s) {
  const pts = s.cr;
  // End exactly where the pen lifted (the smoothed line catches up).
  if (s.prov && pts.length) {
    const last = pts[pts.length - 1];
    if (Math.hypot(s.prov.x - last.x, s.prov.y - last.y) >= 0.5) pushCurvePoint(s, { x: s.prov.x, y: s.prov.y, pr: s.pr });
  }
  if (pts.length >= 3) {
    const [a, b, c] = pts.slice(-3);
    curveSegment(s, a, b, c, c);
  }
  if (s.raf) cancelAnimationFrame(s.raf);
  s.raf = 0;
  s.prov = null;
  freezeLive(s, null);
  liveCanvas.style.display = 'none';
}

function grow(s, x, y, r) {
  s.minX = Math.min(s.minX, x - r);
  s.minY = Math.min(s.minY, y - r);
  s.maxX = Math.max(s.maxX, x + r);
  s.maxY = Math.max(s.maxY, y + r);
}

// Walks from the last dab to the new point, placing dabs at an even spacing.
function dabsTo(s, pt, spacing, fn) {
  if (!s.lastDab) { fn(pt, null); s.lastDab = pt; return; }
  const dx = pt.x - s.lastDab.x;
  const dy = pt.y - s.lastDab.y;
  const d = Math.hypot(dx, dy);
  if (d < spacing) return;
  const n = Math.floor(d / spacing);
  let prev = s.lastDab;
  for (let i = 1; i <= n; i++) {
    const t = (i * spacing) / d;
    const p = { x: s.lastDab.x + dx * t, y: s.lastDab.y + dy * t, r: pt.r };
    fn(p, prev);
    prev = p;
  }
  s.lastDab = prev;
}

function airDab(ctx, p, flow) {
  const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
  g.addColorStop(0, hexToRgba(state.color, flow));
  g.addColorStop(1, hexToRgba(state.color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
}

// The brush's soft round footprint, and the blurred patch under it.
const smearFoot = new OffscreenCanvas(8, 8);
const smearFootCtx = smearFoot.getContext('2d');
const smearPatch = new OffscreenCanvas(8, 8);
const smearPatchCtx = smearPatch.getContext('2d');

// Motion blur brush: wherever it passes, the drawing under it is blurred
// along the way the stroke is moving, like the Motion blur filter but only
// under the brush. It blurs the layer as it was when the stroke began, so
// going back over a spot settles on that blur instead of smearing further,
// and nothing is carried along. (It used to pick up what was under the start
// of the stroke and stamp faint copies of it all the way along, which read as
// a dirty smudge, not a blur.)
function startSmear(s) {
  const b = s.b;
  s.snap = new OffscreenCanvas(s.canvas.width, s.canvas.height);
  s.snap.getContext('2d').drawImage(s.canvas, 0, 0);
  s.dir = null;
  const size = Math.max(2, Math.ceil(b.size));
  if (smearFoot.width !== size) { smearFoot.width = size; smearFoot.height = size; }
  if (smearPatch.width !== size) { smearPatch.width = size; smearPatch.height = size; }
  const r = size / 2;
  const g = smearFootCtx.createRadialGradient(r, r, Math.min(r * (1 - b.feather), r - 0.5), r, r, r);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  smearFootCtx.clearRect(0, 0, size, size);
  smearFootCtx.fillStyle = g;
  smearFootCtx.fillRect(0, 0, size, size);
}

function smearDab(s, p, prev) {
  if (!prev) return;
  const b = s.b;
  const dx = p.x - prev.x;
  const dy = p.y - prev.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return;
  // The way the stroke is heading, eased a little so a shaky hand does not
  // twist the blur.
  if (!s.dir) s.dir = { x: dx / d, y: dy / d };
  else {
    const vx = s.dir.x * 0.7 + (dx / d) * 0.3;
    const vy = s.dir.y * 0.7 + (dy / d) * 0.3;
    const n = Math.hypot(vx, vy) || 1;
    s.dir = { x: vx / n, y: vy / n };
  }
  const strength = Math.min(1, b.strength * (b.pressureStrength ? s.sp : 1));
  if (strength <= 0.002) return;
  const size = smearPatch.width;
  const r = size / 2;
  const ox = Math.round(p.x - r);
  const oy = Math.round(p.y - r);
  // The patch, averaged along the stroke's direction: copies of the drawing
  // as it was, spread over `length` and added together, the middle ones
  // counting most so the streaks fade off at their ends instead of stopping
  // square.
  const len = b.length;
  const n = Math.max(5, Math.min(48, Math.round(len / 2)));
  const weight = (k) => 1 - 0.85 * Math.abs((2 * k) / (n - 1) - 1);
  let total = 0;
  for (let k = 0; k < n; k++) total += weight(k);
  const pc = smearPatchCtx;
  pc.globalCompositeOperation = 'copy';
  pc.globalAlpha = 1;
  pc.clearRect(0, 0, size, size);
  pc.globalCompositeOperation = 'lighter';
  for (let k = 0; k < n; k++) {
    const t = (k / (n - 1) - 0.5) * len;
    pc.globalAlpha = weight(k) / total;
    pc.drawImage(s.snap, ox + s.dir.x * t, oy + s.dir.y * t, size, size, 0, 0, size, size);
  }
  // Only under the soft footprint.
  pc.globalAlpha = 1;
  pc.globalCompositeOperation = 'destination-in';
  pc.drawImage(smearFoot, 0, 0);
  // Mixed into the layer: what is there fades out under the footprint by
  // `strength` and the blurred patch comes in by the same amount.
  const ctx = s.ctx;
  ctx.globalCompositeOperation = 'destination-out';
  ctx.globalAlpha = strength;
  ctx.drawImage(smearFoot, ox, oy);
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(smearPatch, ox, oy);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

function placePoint(x, y) {
  const s = stroke;
  const r = radiusFor(s);
  const pt = { x, y, r };
  const kind = s.b.kind;
  if (kind === 'solid' || kind === 'stamp' || kind === 'erase') {
    solidPoint(s, x, y, s.sp);
  } else if (kind === 'air') {
    const flow = s.b.flow * (0.3 + 0.7 * s.sp);
    dabsTo(s, pt, Math.max(1, r * 0.15), (p) => { airDab(s.ctx, p, flow); grow(s, p.x, p.y, p.r); });
  } else if (kind === 'smear') {
    dabsTo(s, pt, Math.max(1, s.b.size * 0.06), (p, prev) => {
      smearDab(s, p, prev);
      grow(s, p.x, p.y, s.b.size / 2 + 2);
    });
  }
  s.last = pt;
}

function addPoint(e) {
  const s = stroke;
  let p = toCanvas(e, s.rect);
  if (s.lock) p = lockAxis(s, p);
  s.raw = p;
  if (s.assist) { assistPoint(s, p, pressureOf(e)); return; }
  s.sx = p.x;
  s.sy = p.y;
  s.sp = pressureOf(e);
  s.tilt = tiltOf(e);
  s.t = e.timeStamp;
  placePoint(p.x, p.y);
}

function endStroke() {
  const s = stroke;
  // A tap with snapping on never picked a direction: leave a dot.
  if (s.assist && !s.assist.axis) {
    s.sp = s.assist.buffer.length ? s.assist.buffer[0].pressure : 1;
    placePoint(s.assist.start.x, s.assist.start.y);
  }
  if (s.solid) finishSolid(s);
  if (s.gpu) { pencilEnd(s); s.usedGPU = true; }
  stroke = null;
  s.ctx.restore();
  const x = clamp(Math.floor(s.minX) - 2, 0, dims.CW);
  const y = clamp(Math.floor(s.minY) - 2, 0, dims.CH);
  const w = clamp(Math.ceil(s.maxX) + 2, 0, dims.CW) - x;
  const h = clamp(Math.ceil(s.maxY) + 2, 0, dims.CH) - y;
  const lctx = s.canvas.getContext('2d');

  if (w <= 0 || h <= 0) {
    strokeCtx.clearRect(0, 0, dims.CW, dims.CH);
    if (s.backup) s.backup.then((b) => b.close());
    return;
  }

  // Undo keeps GPU snapshots of the changed area. Each one is taken the moment
  // createImageBitmap is called, so `before` is captured ahead of the merge.
  let before;
  if (s.backup) {
    before = s.backup.then((full) => createImageBitmap(full, x, y, w, h).finally(() => full.close()));
  } else {
    if (s.stamp && !s.usedGPU) stampTexture(x, y, w, h, s.b.texture);
    before = createImageBitmap(s.canvas, x, y, w, h);
    lctx.save();
    lctx.globalAlpha = s.b.opacity;
    lctx.drawImage(strokeCanvas, x, y, w, h, x, y, w, h);
    lctx.restore();
    strokeCtx.clearRect(x, y, w, h);
  }
  const after = createImageBitmap(s.canvas, x, y, w, h);
  s.layer.dirty = true;
  pushHistory({ type: 'pixels', shotId: mounted.id, layerId: s.layer.id, x, y, w, h, before, after });
  scheduleThumb();
}

// ---------------------------------------------------------------- fill

// ---------------------------------------------------------------- stamp brushes
//
// Brushes that stamp a textured tip along the stroke, the way Photoshop's
// brush engine does. Each is matched to a brush she exported, using its
// settings only: the tip images and textures belong to Adobe and Procreate,
// so the tips here are generated from noise in matching proportions.
//
//   Pencil:          a plain graphite pencil on the same GPU engine.
//   Animator pencil: Kyle Webster's Animator Pencil 2016 (Photoshop .abr):
//                    size and angle by pen tilt with a 200% tilt scale, flow
//                    by pressure, 1% spacing, paper in Height mode: drawn by
//                    the GPU pencil engine (pencil.js). Paper depth and
//                    build-up were tuned by eye against her Photoshop
//                    strokes, as Photoshop's own maths is not published.
//                    Then, at her request (2026-10-09), more like the
//                    Procreate version: an oval tip (45%, little angle jitter
//                    or scatter so the oval shows) and size by pressure down
//                    to 12% for more taper. A pressure curve for taper was
//                    tried and dropped: light touches vanished.
//   Ultimate pencil: KYLE Ultimate Pencil Hard (Photoshop .abr)
//   Grain airbrush:  颗粒纹理喷枪, a soft airbrush through a grain texture (.abr)
//   Gesinski ink:    Jonathan Gesinski's Gesinski Ink (Procreate .brush): a
//                    slim oval, size 100% by pressure with no minimum, full
//                    opacity, spacing 0 with 2% jitter, and a textured-ink
//                    grain at full depth. Its 10% streamline is left off.
//   Milk oolong:     吹石's 奶香乌龙 (Procreate .brush): a flat bristle mark
//                    about half as wide as it is tall, 3 to 4 stamps a step,
//                    size 88% and opacity 30% by pressure, flow mostly by
//                    pressure, a light (19%) charcoal grain. Its wet paint
//                    mixing, speed dynamics and 22% stabilization are left out.
//
// Per stamp: flow (scaled by pressure, never below flowMin) builds up within
// the stroke; opacity follows pressure down to opacityMin; size follows
// pressure down to minSize; plus angle, size and opacity jitter and scatter.
// `buildup` compensates where Photoshop's spacing is far tighter than ours.

const stampMasks = new Map();

// tip: { shape: 'rect' | 'round' | 'soft' | 'flat', aspect, rough, tooth, grain }
// 'flat' is a flat paint brush mark in a square tip, `aspect` wide.
function stampMask(tip) {
  const key = JSON.stringify(tip);
  if (stampMasks.has(key)) return stampMasks.get(key);
  const W = tip.shape === 'soft' || tip.shape === 'flat' ? 128 : 64;
  const H = tip.shape === 'flat' ? W : Math.round(W * tip.aspect);
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const rnd = new Float32Array(W * H).map(() => Math.random());
  const noise = (x, y) => rnd[((y % H) + H) % H * W + (((x % W) + W) % W)];
  // Smooth noise for the lumpy outline of a bristle mark.
  const smooth = (x, y, cell) => {
    const gx = x / cell;
    const gy = y / cell;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const v = (i, j) => noise(i * 17 + 3, j * 29 + 7);
    const top = v(x0, y0) * (1 - fx) + v(x0 + 1, y0) * fx;
    const bottom = v(x0, y0 + 1) * (1 - fx) + v(x0 + 1, y0 + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = (x + 0.5 - W / 2) / (W / 2);
      const ny = (y + 0.5 - H / 2) / (H / 2);
      let a;
      if (tip.shape === 'flat') {
        // A rounded-off rectangle (superellipse), its ends pushed in and out
        // in lumps like bristle tufts, with a speckled dry-brush fringe.
        const hw = tip.aspect * 0.95;
        const lump = (smooth(x, 0, W / 8) - 0.5) * 0.14 * Math.abs(ny);
        const sx = Math.abs(nx) / hw;
        const sy = Math.abs(ny) / (0.94 + lump);
        const r = (sx ** 5 + sy ** 5) ** 0.2;
        const fringe = 0.07;
        a = r <= 1 - fringe ? 1 : r >= 1 + fringe * 0.5 ? 0 : 1 - (r - (1 - fringe)) / (fringe * 1.5);
        if (a > 0 && a < 1) a = noise(x, y) < a ** 0.7 ? Math.min(1, a * 1.6) : a * 0.25;
      } else if (tip.shape === 'soft') {
        // Hardness 0: fades all the way from the centre to the edge.
        const r = Math.hypot(nx, ny);
        a = r >= 1 ? 0 : (1 - r * r) ** 2;
      } else {
        const d = tip.shape === 'rect'
          ? Math.max(Math.abs(x + 0.5 - W / 2) - (W / 2 - 3), Math.abs(y + 0.5 - H / 2) - (H / 2 - 3))
          : (Math.hypot(nx, ny) - 1) * (W / 2) + 3;
        // Ragged edges: push the edge in and out with smoothed noise.
        const ragged = (noise(x, y) + noise(x + 1, y) + noise(x, y + 1) - 1.5) * tip.rough;
        a = Math.max(0, Math.min(1, 0.5 - (d + ragged) / 1.4));
      }
      a *= 1 - tip.tooth + tip.tooth * noise(x * 7, y * 3);
      if (tip.grain) {
        // A grain texture through the tip, for the grainy airbrush.
        const g = noise(x * 13 + 5, y * 11 + 3);
        a *= Math.max(0, Math.min(1, (g - tip.grain * 0.6) / (1 - tip.grain * 0.6)));
      }
      img.data[(y * W + x) * 4 + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  stampMasks.set(key, c);
  return c;
}

const stampTips = new Map();
function stampTip(tip, color) {
  const key = JSON.stringify(tip) + color;
  if (stampTips.has(key)) return stampTips.get(key);
  const mask = stampMask(tip);
  const c = new OffscreenCanvas(mask.width, mask.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0);
  stampTips.set(key, c);
  return c;
}

// Paper texture: canvas-space noise that lifts a little colour out of the
// finished stroke (Photoshop's texture depth).
const paperNoise = (() => {
  const size = 256;
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const raw = new Float32Array(size * size).map(() => Math.random());
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const [dx, dy, w] of [[0, 0, 0.4], [1, 0, 0.15], [-1, 0, 0.15], [0, 1, 0.15], [0, -1, 0.15]]) {
        v += raw[((y + dy + size) % size) * size + ((x + dx + size) % size)] * w;
      }
      const spread = Math.max(0, Math.min(1, 0.5 + (v - 0.5) * 2.6));
      img.data[(y * size + x) * 4 + 3] = Math.round(Math.max(0, (spread - 0.35) / 0.65) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
})();
let paperPattern = null;

function stampTexture(x, y, w, h, depth) {
  if (!depth) return;
  paperPattern = paperPattern || strokeCtx.createPattern(paperNoise, 'repeat');
  strokeCtx.save();
  strokeCtx.setTransform(1, 0, 0, 1, 0, 0);
  strokeCtx.globalCompositeOperation = 'destination-out';
  strokeCtx.globalAlpha = depth;
  strokeCtx.fillStyle = paperPattern;
  strokeCtx.fillRect(x, y, w, h);
  strokeCtx.restore();
}

function beginStamp(s) {
  s.tip = stampTip(s.b.tip, state.color);
  s.dabCarry = 0;
  strokeGroup.style.opacity = workingOpacity(s.b);
  if (usesPencilGL(s.b)) pencilBegin(s);
}

// Distance between spacing steps. The 2D stamp brushes stop at 0.3px, as
// tighter is too slow there; GPU pencils go down to Photoshop's own spacing.
const stampSpacing = (b) => Math.max(b.height ? 0.05 : 0.3, b.size * b.spacing);

const byPressure = (min, p) => (min ?? 1) + (1 - (min ?? 1)) * p;

// One spacing step: \`count\` stamps scattered around the point, each turned,
// sized and faded a little at random.
function stampStep(s, x, y, pr, preview = null) {
  if (s.gpu) { pencilStep(s, x, y, pr, Math.random, s.gpu.dabs); return; }
  const b = s.b;
  const random = preview ? preview.rnd : Math.random;
  const D = b.size * byPressure(b.minSize, pr);
  const flow = Math.min(0.999, b.flow * byPressure(b.flowMin ?? 0, pr));
  // Darkness builds up per length of line, so stamps spread wider (very small
  // sizes, see stampSeg) each lay down more.
  const spread = stampSpacing(b) / (b.size * b.spacing);
  const a = (1 - Math.pow(1 - flow, b.buildup * spread)) * byPressure(b.opacityMin, pr);
  // Pen tilt, for brushes that use it (Photoshop's Pen Tilt control): the tip
  // turns to face the way the pen leans and stretches along it, up to `tilt`
  // times as long with the pen flat, like the side of a pencil lead.
  const lean = b.tilt && s.tilt ? s.tilt : null;
  const baseAngle = lean ? ((lean.dir - state.view.r) * 180) / Math.PI : b.angle;
  const stretch = lean ? 1 + (b.tilt - 1) * lean.mag : 1;
  const tip = s.tip;
  const ctx = preview ? preview.ctx : strokeCtx;
  const ox = preview ? preview.ox : 0;
  const oy = preview ? preview.oy : 0;
  for (let k = 0; k < b.count; k++) {
    const sc = b.scatter * D;
    const px = x + (random() - 0.5) * 2 * sc;
    const py = y + (random() - 0.5) * 2 * sc;
    const ang = ((baseAngle + (random() - 0.5) * 2 * b.angleJitter * 180) * Math.PI) / 180;
    const size = D * (1 - b.sizeJitter * random());
    const k2 = (size / tip.width) * b.roundness;
    const k1 = (size / tip.width) * stretch;
    const c = Math.cos(ang);
    const sn = Math.sin(ang);
    ctx.setTransform(c * k1, sn * k1, -sn * k2, c * k2, px - ox, py - oy);
    ctx.globalAlpha = a * (1 - b.opacityJitter * random());
    ctx.drawImage(tip, -tip.width / 2, -tip.height / 2);
    if (!preview) grow(s, px, py, size * 0.75 * stretch);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

// Stamps evenly along a piece of the curve, carrying the leftover distance
// into the next piece.
function stampSeg(s, a, b) {
  const h = stampSpacing(s.b);
  if (!a) { stampStep(s, b.x, b.y, b.pr ?? s.pr); s.dabCarry = 0; return; }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const pa = a.pr ?? s.pr;
  const pb = b.pr ?? s.pr;
  let pos = h - s.dabCarry;
  while (pos <= d) {
    const t = pos / d;
    stampStep(s, a.x + dx * t, a.y + dy * t, pa + (pb - pa) * t);
    pos += h;
  }
  s.dabCarry = d - (pos - h);
}

function hexToRgba(hex, a = 1) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Grows a mask by r pixels (square), within the box [x0, x1) x [y0, y1).
function dilate(mask, W, x0, y0, x1, y1, r) {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(mask.length);
  for (let y = y0; y < y1; y++) {
    let count = 0;
    const row = y * W;
    for (let x = x0; x < Math.min(x1, x0 + r); x++) count += mask[row + x];
    for (let x = x0; x < x1; x++) {
      if (x + r < x1) count += mask[row + x + r];
      if (x - r - 1 >= x0) count -= mask[row + x - r - 1];
      tmp[row + x] = count > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = x0; x < x1; x++) {
    let count = 0;
    for (let y = y0; y < Math.min(y1, y0 + r); y++) count += tmp[y * W + x];
    for (let y = y0; y < y1; y++) {
      if (y + r < y1) count += tmp[(y + r) * W + x];
      if (y - r - 1 >= y0) count -= tmp[(y - r - 1) * W + x];
      out[y * W + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

// Fills the area around the click that is bounded by lines on any visible
// layer. Small gaps in the lines are closed first, and the fill is grown a
// little under the lines so no white edge is left between line and fill.
const fillAt = (p) => enqueue(async () => {
  const layer = activeLayer();
  if (!layer || !layer.visible) { toast('Show this layer to fill on it.'); return; }
  const W = dims.CW;
  const H = dims.CH;
  const x0 = Math.floor(p.x);
  const y0 = Math.floor(p.y);
  if (x0 < 0 || y0 < 0 || x0 >= W || y0 >= H) return;

  const ref = new OffscreenCanvas(W, H);
  const rctx = ref.getContext('2d', { willReadFrequently: true });
  for (const l of mounted.layers) {
    if (!l.visible) continue;
    rctx.globalAlpha = l.opacity;
    rctx.drawImage(live.get(l.id), 0, 0);
  }
  const px = rctx.getImageData(0, 0, W, H).data;
  const n = W * H;
  const seed = (y0 * W + x0) * 4;
  const sr = px[seed], sg = px[seed + 1], sb = px[seed + 2], sa = px[seed + 3];
  const tol = state.fill.tolerance;
  // Pixels that differ from the clicked colour are walls.
  let wall = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const d = Math.max(Math.abs(px[j] - sr), Math.abs(px[j + 1] - sg), Math.abs(px[j + 2] - sb), Math.abs(px[j + 3] - sa));
    wall[i] = d > tol ? 1 : 0;
  }
  const gap = state.fill.gap;
  if (gap > 0) {
    const closed = dilate(wall, W, 0, 0, W, H, gap);
    if (!closed[y0 * W + x0]) wall = closed;
  }
  if (wall[y0 * W + x0]) return;

  // Scanline flood fill.
  const region = new Uint8Array(n);
  const stack = [x0, y0];
  let bx0 = x0, by0 = y0, bx1 = x0, by1 = y0;
  while (stack.length) {
    const y = stack.pop();
    let x = stack.pop();
    let i = y * W + x;
    while (x > 0 && !wall[i - 1] && !region[i - 1]) { x--; i--; }
    let upOpen = false;
    let downOpen = false;
    while (x < W && !wall[i] && !region[i]) {
      region[i] = 1;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
      if (y > 0) {
        const u = i - W;
        if (!wall[u] && !region[u]) { if (!upOpen) { stack.push(x, y - 1); upOpen = true; } } else upOpen = false;
      }
      if (y < H - 1) {
        const d = i + W;
        if (!wall[d] && !region[d]) { if (!downOpen) { stack.push(x, y + 1); downOpen = true; } } else downOpen = false;
      }
      x++;
      i++;
    }
  }

  // Grow under the lines, within a box around the fill.
  const pad = gap + 2;
  const gx0 = Math.max(0, bx0 - pad), gy0 = Math.max(0, by0 - pad);
  const gx1 = Math.min(W, bx1 + pad + 1), gy1 = Math.min(H, by1 + pad + 1);
  const grown = dilate(region, W, gx0, gy0, gx1, gy1, pad);

  const bw = gx1 - gx0;
  const bh = gy1 - gy0;
  const core = new ImageData(bw, bh);
  const ring = new ImageData(bw, bh);
  const c = parseInt(state.color.slice(1), 16);
  const cr = (c >> 16) & 255, cg = (c >> 8) & 255, cb = c & 255;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = (gy0 + y) * W + gx0 + x;
      const target = region[i] ? core.data : grown[i] ? ring.data : null;
      if (!target) continue;
      const j = (y * bw + x) * 4;
      target[j] = cr; target[j + 1] = cg; target[j + 2] = cb; target[j + 3] = 255;
    }
  }
  const coreC = new OffscreenCanvas(bw, bh);
  coreC.getContext('2d').putImageData(core, 0, 0);
  const ringC = new OffscreenCanvas(bw, bh);
  ringC.getContext('2d').putImageData(ring, 0, 0);

  const canvas = live.get(layer.id);
  const lctx = canvas.getContext('2d');
  const before = createImageBitmap(canvas, gx0, gy0, bw, bh);
  lctx.save();
  clipToSelection(lctx);
  // The grown edge goes behind existing pixels, so lines on this layer stay on top.
  lctx.globalCompositeOperation = 'destination-over';
  lctx.drawImage(ringC, gx0, gy0);
  lctx.globalCompositeOperation = 'source-over';
  lctx.drawImage(coreC, gx0, gy0);
  lctx.restore();
  const after = createImageBitmap(canvas, gx0, gy0, bw, bh);
  layer.dirty = true;
  pushHistory({ type: 'pixels', shotId: mounted.id, layerId: layer.id, x: gx0, y: gy0, w: bw, h: bh, before, after });
  scheduleThumb();
});

// Alt+click: picks up the colour under the pen from all visible layers.
async function pickColor(p) {
  const shot = mounted;
  const off = await renderRegion(shot, { x: Math.floor(p.x), y: Math.floor(p.y), w: 1, h: 1 }, 1, 1);
  const [r, g, b] = off.getContext('2d').getImageData(0, 0, 1, 1).data;
  const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  setColor(hex);
  toast(`Picked ${hex.toUpperCase()}`);
}

// ---------------------------------------------------------------- lasso

const selSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
selSvg.id = 'selSvg';
const selPaths = [0, 1].map((i) => {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('class', i ? 'ants ants-b' : 'ants ants-a');
  selSvg.append(p);
  return p;
});
stage.append(selSvg);

const floatCanvas = document.createElement('canvas');
floatCanvas.id = 'floating';
stage.append(floatCanvas);

let lasso = null; // the path being drawn
let lift = null; // pixels picked up for moving

function sizeSelectionLayer() {
  selSvg.setAttribute('viewBox', `0 0 ${dims.CW} ${dims.CH}`);
  selSvg.setAttribute('width', dims.CW);
  selSvg.setAttribute('height', dims.CH);
}

// Draws marching ants around a shape: a single outline (a list of points), or
// a selection-like { polys }, plus an `open` lasso still being drawn.
function drawSelectionOutline(shape) {
  const ring = (pts, close) => (pts.length ? 'M' + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L') + (close ? 'Z' : '') : '');
  let d;
  if (Array.isArray(shape)) d = ring(shape, !lasso);
  else d = shape.polys.flat().map((r) => ring(r, true)).join('') + (shape.open ? ring(shape.open, false) : '');
  for (const p of selPaths) p.setAttribute('d', d);
}

// The lasso being drawn, with the selection it will add to or cut from.
function drawLasso() {
  if (lasso.mode && state.selection) drawSelectionOutline({ polys: state.selection.polys, open: lasso.points });
  else drawSelectionOutline(lasso.points);
}

// Joins a new lasso outline to the selection (add), cuts it out (sub), or
// keeps only where they overlap (and).
function combineSelection(mode, points) {
  const pair = (r) => r.map((p) => [p.x, p.y]);
  const a = state.selection.polys.map((poly) => poly.map(pair));
  const b = [[pair(points)]];
  let polys;
  try {
    const out = polygonClipping[{ add: 'union', sub: 'difference', and: 'intersection' }[mode]](a, b);
    polys = out.map((poly) => poly.map((r) => r.slice(0, -1).map(([x, y]) => ({ x, y }))));
  } catch (err) {
    // Shapes the maths cannot handle: adding still works by keeping both.
    console.warn(err);
    polys = mode === 'add' ? [...state.selection.polys, [points]] : state.selection.polys;
  }
  setSelection(polys.length ? { polys } : null);
}

// `exact` skips the one-pixel margin a lasso box gets for its soft edge (the
// Move tool picks up a whole layer by its exact drawn area).
// Takes a single outline (a list of points) or { polys }.
function setSelection(shape, exact = false) {
  const polys = !shape ? [] : Array.isArray(shape) ? [[shape]] : shape.polys;
  const usable = polys.map((poly) => poly.filter((r) => r.length >= 3)).filter((poly) => poly.length && poly[0].length >= 3);
  if (!usable.length) {
    state.selection = null;
    drawSelectionOutline([]);
    refreshUI();
    return;
  }
  // Holes run the other way round from their outline, so filling with the
  // nonzero rule leaves them empty.
  const path = new Path2D();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of usable.flat()) {
    path.moveTo(r[0].x, r[0].y);
    for (const p of r.slice(1)) path.lineTo(p.x, p.y);
    path.closePath();
    for (const p of r) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
  }
  const pad = exact ? 0 : 1;
  x0 = clamp(Math.floor(x0) - pad, 0, dims.CW);
  y0 = clamp(Math.floor(y0) - pad, 0, dims.CH);
  x1 = clamp(Math.ceil(x1) + pad, 0, dims.CW);
  y1 = clamp(Math.ceil(y1) + pad, 0, dims.CH);
  state.selection = { path, polys: usable, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
  drawSelectionOutline(state.selection);
  refreshUI();
}

const hitCtx = new OffscreenCanvas(1, 1).getContext('2d');
const inSelection = (p) => state.selection && hitCtx.isPointInPath(state.selection.path, p.x, p.y);

// Picks the selected pixels up off the layer so they can be dragged.
function liftSelection() {
  const sel = state.selection;
  const layer = activeLayer();
  const canvas = live.get(layer.id);
  const { x, y, w, h } = sel.box;
  if (w <= 0 || h <= 0) return null;
  floatCanvas.width = w;
  floatCanvas.height = h;
  const fctx = floatCanvas.getContext('2d');
  fctx.save();
  fctx.translate(-x, -y);
  fctx.clip(sel.path);
  fctx.drawImage(canvas, 0, 0);
  fctx.restore();
  const backup = createImageBitmap(canvas);
  const lctx = canvas.getContext('2d');
  lctx.save();
  lctx.clip(sel.path);
  lctx.clearRect(x, y, w, h);
  lctx.restore();
  // Shown at the layer's opacity, so the piece does not jump darker while it moves.
  Object.assign(floatCanvas.style, { display: 'block', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, transform: '', transformOrigin: '0 0', opacity: layer.opacity });
  return { layer, canvas, backup, dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 };
}

// Where the lifted piece is shown: moved by (dx, dy) and stretched by (sx, sy)
// from its top-left corner (negative means flipped).
function applyLiftStyle(l) {
  if (l.group) {
    const b = l.box;
    for (const { canvas } of l.items) {
      canvas.style.transformOrigin = '0 0';
      canvas.style.transform = `translate(${b.x + l.dx}px, ${b.y + l.dy}px) rotate(${l.rot || 0}rad) scale(${l.sx}, ${l.sy}) translate(${-b.x}px, ${-b.y}px)`;
    }
    return;
  }
  floatCanvas.style.transform = `translate(${l.dx}px, ${l.dy}px) rotate(${l.rot || 0}rad) scale(${l.sx}, ${l.sy})`;
}
// The selection outline, moved and stretched with the piece.
function liftedPoints(l) {
  const { x, y, w, h } = state.selection.box;
  let place;
  if (l.mode && l.mode !== 'free') {
    const f = meshMap(l);
    place = (p) => f((p.x - x) / w, (p.y - y) / h);
  } else {
    place = liftMapper(l, state.selection.box);
  }
  return { polys: state.selection.polys.map((poly) => poly.map((r) => r.map(place))) };
}

function dropSelection() {
  if (!lift) return;
  if (lift.group) { dropGroup(); return; }
  const l = lift;
  const { layer, canvas, backup } = l;
  lift = null;
  const { x, y } = state.selection.box;
  const ctx = canvas.getContext('2d');
  if (l.mode && l.mode !== 'free') {
    commitMesh(l, ctx);
  } else if (l.sx === 1 && l.sy === 1 && !l.rot) {
    // A plain move lands on whole pixels, so lines stay as crisp as they were.
    l.dx = Math.round(l.dx);
    l.dy = Math.round(l.dy);
    ctx.drawImage(floatCanvas, x + l.dx, y + l.dy);
  } else {
    ctx.save();
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(x + l.dx, y + l.dy);
    ctx.rotate(l.rot || 0);
    ctx.scale(l.sx, l.sy);
    ctx.drawImage(floatCanvas, 0, 0);
    ctx.restore();
  }
  floatCanvas.style.display = 'none';
  const after = createImageBitmap(canvas);
  layer.dirty = true;
  const pixels = { type: 'pixels', shotId: mounted.id, layerId: layer.id, x: 0, y: 0, w: dims.CW, h: dims.CH, before: backup, after };
  const from = selPolys();
  setSelection(liftedPoints(l));
  // A lasso selection's outline moves with the pixels, in the same step.
  pushHistory(l.whole ? pixels : { type: 'multi', shotId: mounted.id, entries: [pixels, { type: 'selection', shotId: mounted.id, from, to: selPolys() }] });
  scheduleThumb();
}

// Arrow keys move the selection by a pixel (or ten with Shift).
function nudgeSelection(dx, dy) {
  if (!dx && !dy) return;
  if (meshLive()) {
    lift.pts = lift.pts.map((q) => ({ x: q.x + dx, y: q.y + dy }));
    renderMesh();
    renderMoveBox();
    return;
  }
  if (!lift) lift = state.selection ? liftSelection() : state.tool === 'move' ? (movingMany() ? liftGroup() : liftWholeLayer()) : null;
  if (!lift) return;
  lift.dx += dx;
  lift.dy += dy;
  applyLiftStyle(lift);
  renderMoveBox();
  if (lift.group) {
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => { if (lift && lift.group && !lift.drag) dropGroup(); }, 700);
  } else if (!lift.whole) drawSelectionOutline(liftedPoints(lift));
  else {
    // Nudging a whole layer settles a moment after the last key press.
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => { if (lift && lift.whole && !lift.drag) dropWholeLayer(); }, 700);
  }
}
let nudgeTimer = 0;

// The Move tool with no selection moves the whole active layer: it picks the
// layer up as one big selection (with no outline drawn) and puts it down when
// the drag ends, as one undo step.
let wholeMove = false;
function liftWholeLayer() {
  // Only what is drawn is picked up, so the handles hug the drawing.
  const b = contentBounds();
  if (!b) return null;
  wholeMove = true;
  // Exactly the drawn area (it already includes every visible pixel), so
  // snapping lines up the drawing itself with the frame.
  const x0 = b.x;
  const y0 = b.y;
  const x1 = b.x + b.w;
  const y1 = b.y + b.h;
  setSelection([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], true);
  drawSelectionOutline([]);
  const l = liftSelection();
  if (l) l.whole = true;
  else { wholeMove = false; setSelection(null); }
  return l;
}
function dropWholeLayer() {
  dropSelection();
  wholeMove = false;
  setSelection(null);
}

function deselect() {
  dropSelection();
  setSelection(null);
}

// Selection changes the person makes are undo steps (Photoshop's are too).
const selPolys = () => (state.selection ? state.selection.polys : null);
function recordSelection(from) {
  const to = selPolys();
  if (from === to || !mounted) return;
  pushHistory({ type: 'selection', shotId: mounted.id, from, to });
}
// Deselect from a button, Escape, or a tap off the selection: undoable.
function deselectStep() {
  if (lift) dropSelection();
  const from = selPolys();
  setSelection(null);
  recordSelection(from);
}

// Clears or fills the selected area on the active layer.
const paintSelection = (mode) => enqueue(async () => {
  if (!state.selection) return;
  dropSelection();
  const layer = activeLayer();
  const canvas = live.get(layer.id);
  const { x, y, w, h } = state.selection.box;
  if (w <= 0 || h <= 0) return;
  const before = createImageBitmap(canvas, x, y, w, h);
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.clip(state.selection.path);
  if (mode === 'clear') ctx.clearRect(x, y, w, h);
  else { ctx.fillStyle = state.color; ctx.fillRect(x, y, w, h); }
  ctx.restore();
  const after = createImageBitmap(canvas, x, y, w, h);
  layer.dirty = true;
  pushHistory({ type: 'pixels', shotId: mounted.id, layerId: layer.id, x, y, w, h, before, after });
  scheduleThumb();
});

// ---------------------------------------------------------------- pointer input

// The brush outline is the system cursor itself where it fits (Chromium allows
// up to 128px), because Windows draws that the instant the pen moves. An
// outline drawn by the page trails the pen by a frame or two, which makes the
// whole app feel sluggish. Bigger brushes fall back to a page-drawn ring, with
// a crosshair as the system cursor so the pen position is still instant.
const HW_CURSOR_MAX = 120;
const cursorImages = new Map();
function brushCursor(w, h, deg) {
  const key = `${Math.round(w * 2)}|${Math.round(h * 2)}|${Math.round(deg)}`;
  if (cursorImages.has(key)) return cursorImages.get(key);
  const dpr = window.devicePixelRatio || 1;
  let S = Math.ceil(Math.max(w, h)) + 6;
  S += S % 2;
  // An SVG costs nothing to build, unlike a PNG. It is drawn at the screen's
  // real pixel size so the ring stays sharp at 150% scaling.
  const D = Math.round(S * dpr);
  const ring = `cx="${S / 2}" cy="${S / 2}" rx="${(w / 2).toFixed(2)}" ry="${(h / 2).toFixed(2)}" transform="rotate(${deg.toFixed(1)} ${S / 2} ${S / 2})" fill="none"`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${D}" height="${D}" viewBox="0 0 ${S} ${S}">`
    + `<ellipse ${ring} stroke="rgba(255,255,255,0.8)" stroke-width="3"/>`
    + `<ellipse ${ring} stroke="rgba(0,0,0,0.85)" stroke-width="1"/></svg>`;
  const css = `image-set(url("data:image/svg+xml,${encodeURIComponent(svg)}") ${dpr}x) ${S / 2} ${S / 2}, crosshair`;
  if (cursorImages.size > 64) cursorImages.clear();
  cursorImages.set(key, css);
  return css;
}

// Kept up to date here rather than measured on every pen move.
let viewportRect = viewport.getBoundingClientRect();
new ResizeObserver(() => { viewportRect = viewport.getBoundingClientRect(); }).observe(viewport);
window.addEventListener('resize', () => { viewportRect = viewport.getBoundingClientRect(); });

let cursorCss = '';
function setViewportCursor(css) {
  if (css === cursorCss) return;
  cursorCss = css;
  viewport.style.cursor = css;
}

// The last pen or mouse position over the canvas, so the outline can follow
// zoom and size changes without waiting for the pen to move.
let cursorEvent = null;
function hideCursor() {
  cursorRing.style.display = 'none';
  setViewportCursor('');
}
function refreshCursor() {
  if (cursorEvent) updateCursor(cursorEvent);
}
// While the view is zooming, redraw the outline once it settles rather than
// building a new cursor image every frame.
let cursorTimer = 0;
function refreshCursorSoon() {
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(refreshCursor, 60);
}

function updateCursor(e) {
  cursorEvent = e;
  const hide = pan || spaceDown || rotateDown || !mounted || playing || state.tool !== 'brush' || lasso;
  viewport.dataset.tool = rotateDown || (pan && pan.rotate) ? 'rotate' : spaceDown || pan ? 'pan' : state.tool;
  if (hide) {
    cursorRing.style.display = 'none';
    if (state.tool === 'move' && !pan && !spaceDown) {
      const h = state.moveMode !== 'free' ? null : lift && lift.drag ? lift.drag.handle : handleAt(e);
      setViewportCursor(h ? handleCursor(h) : '');
      return;
    }
    // With the lasso, the cursor shows when it is over something it can move.
    const overSelection = state.tool === 'lasso' && !lasso && !pan && state.selection && inSelection(toCanvas(e, viewportRect));
    setViewportCursor(overSelection || (lift && lift.drag) ? 'move' : '');
    return;
  }
  const b = isPenEraser(e) ? state.brushes.eraser : brush();
  const w = Math.max(4, b.size * state.view.z);
  const oval = b.kind === 'solid' || b.kind === 'erase' || b.kind === 'stamp';
  const h = Math.max(4, b.size * (oval ? b.roundness : 1) * state.view.z);
  const nib = b.roundness < 1 && oval ? b.angle : 0;
  const deg = nib + (state.view.r * 180) / Math.PI;
  if (w <= HW_CURSOR_MAX && h <= HW_CURSOR_MAX) {
    setViewportCursor(brushCursor(w, h, deg));
    if (cursorRing.style.display !== 'none') cursorRing.style.display = 'none';
    return;
  }
  setViewportCursor('crosshair');
  const r = viewportRect;
  cursorRing.style.display = 'block';
  cursorRing.style.width = `${w}px`;
  cursorRing.style.height = `${h}px`;
  cursorRing.style.transform = `translate(${e.clientX - r.left}px, ${e.clientY - r.top}px) translate(-50%, -50%) rotate(${deg}deg)`;
}

// Panels that float over the canvas (their buttons and sliders are not the
// canvas: pressing them must not start a stroke, a drag or a filter change).
const CANVAS_OVERLAYS = '#filterPanel, #adjustPanel, #meshBar, #selBar, #perfHud';

// ---------------------------------------------------------------- fingers (iPad)
//
// Like Procreate: the Pencil draws, fingers never do. One finger moves the
// canvas; two move, pinch to zoom and turn it (turning only starts once the
// fingers clearly twist, so a pinch does not tilt the page by accident). A
// quick two-finger tap undoes, three fingers redo. While the Pencil is down,
// fingers are ignored, so a resting palm does nothing.
const touches = new Map(); // pointerId -> { x, y, x0, y0 }
let gesture = null;
let touchTap = null; // { most, t0, moved }
const TWIST_START = (8 * Math.PI) / 180;

function gestureFrom() {
  const pts = [...touches.values()];
  if (pts.length === 1) return { n: 1, x: pts[0].x, y: pts[0].y };
  const [a, b] = pts;
  return {
    n: 2,
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
    d: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
    ang: Math.atan2(b.y - a.y, b.x - a.x),
    twist: gesture && gesture.n === 2 ? gesture.twist : 0,
    turning: gesture && gesture.n === 2 ? gesture.turning : false,
  };
}
function touchDown(e) {
  try { viewport.setPointerCapture(e.pointerId); } catch {}
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
  if (touches.size === 1) touchTap = { most: 1, t0: performance.now(), moved: false };
  else if (touchTap) touchTap.most = Math.max(touchTap.most, touches.size);
  gesture = gestureFrom();
}
function touchMove(e) {
  const t = touches.get(e.pointerId);
  if (!t) return;
  t.x = e.clientX;
  t.y = e.clientY;
  if (touchTap && Math.hypot(t.x - t.x0, t.y - t.y0) > 12) touchTap.moved = true;
  const g = gesture;
  const now = gestureFrom();
  const v = state.view;
  if (g.n === 1 && now.n === 1) {
    v.x += now.x - g.x;
    v.y += now.y - g.y;
    v.fit = false;
    applyView();
  } else if (g.n === 2 && now.n === 2) {
    const vr = viewport.getBoundingClientRect();
    v.x += now.cx - g.cx;
    v.y += now.cy - g.cy;
    v.fit = false;
    applyView();
    zoomAt(now.cx, now.cy, now.d / g.d);
    let da = now.ang - g.ang;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    if (!now.turning) {
      now.twist += da;
      if (Math.abs(now.twist) > TWIST_START) { now.turning = true; da = now.twist; } else da = 0;
    }
    if (da) rotateAt(now.cx - vr.left, now.cy - vr.top, da);
  }
  gesture = now;
}
function touchUp(e) {
  if (!touches.delete(e.pointerId)) return;
  if (touches.size) { gesture = gestureFrom(); return; }
  const tap = touchTap;
  touchTap = null;
  gesture = null;
  if (tap && !tap.moved && e.type !== 'pointercancel' && performance.now() - tap.t0 < 350) {
    if (tap.most === 2) { undo(); toast('Undo'); } else if (tap.most >= 3) { redo(); toast('Redo'); }
  }
  // Snap back to upright when close, as with the rotate key.
  const deg = ((((state.view.r * 180) / Math.PI) % 360) + 540) % 360 - 180;
  if (deg && Math.abs(deg) < 4) {
    const r = viewport.getBoundingClientRect();
    rotateAt(r.width / 2, r.height / 2, (-deg * Math.PI) / 180);
  }
}
// Safari's own pinch-to-zoom of the whole page.
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault());
// iPadOS also watches each Pencil and finger touch for its own uses (Scribble
// handwriting, double-tap zoom, long-press text selection), and while it does
// it can keep a Pencil stroke from reaching the app. Taking the touches on
// the canvas stops that. Panels and buttons over the canvas keep theirs, so
// they still get clicks.
for (const type of ['touchstart', 'touchmove', 'touchend']) {
  viewport.addEventListener(type, (e) => {
    if (e.target.closest && e.target.closest(`${CANVAS_OVERLAYS}, input, textarea, button, select`)) return;
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
}

// The last few Pencil presses and what became of each, for "Check this iPad".
const penLog = [];
function penNote(e, what) {
  if (e.pointerType !== 'pen') return;
  penLog.push(`${(performance.now() / 1000).toFixed(2)}s ${e.type.replace('pointer', '')} p${e.pressure.toFixed(2)} b${e.buttons} ${what}`);
  if (penLog.length > 40) penLog.shift();
}

viewport.addEventListener('pointerdown', (e) => {
  if (e.target.closest(CANVAS_OVERLAYS)) { penNote(e, 'on a panel'); return; }
  if (e.pointerType === 'touch') { if (!stroke && !lasso) touchDown(e); return; }
  // A press while an earlier one is still open: the earlier one's lift never
  // arrived (it can go missing on the iPad), so it is finished now rather
  // than every new stroke being turned away until it does.
  if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
    if (stroke && stroke.pointerId !== e.pointerId) { penNote(e, 'ended a stuck stroke'); endStroke(); }
    if (lasso && lasso.id !== e.pointerId) { penNote(e, 'ended a stuck lasso'); endPointer({ pointerId: lasso.id, pointerType: e.pointerType }); }
    if (pan && pan.id !== e.pointerId) pan = null;
  }
  // An open blur filter takes canvas drags (Space or the middle button still pan).
  if (filter && e.button === 0 && !spaceDown && !playing) { penNote(e, 'blur filter'); filterPointerDown(e); return; }
  if (playing || stroke || pan || lasso || adjust) { penNote(e, `ignored (${playing ? 'playing' : stroke ? 'drawing' : pan ? 'panning' : lasso ? 'lasso' : 'adjusting'})`); return; }
  if (e.target.closest('.cam-handle')) return;
  const panning = e.button === 1 || (e.button === 0 && (spaceDown || rotateDown || state.tool === 'pan'));
  if (panning) {
    pan = { id: e.pointerId, x: e.clientX, y: e.clientY, rotate: rotateDown && e.button === 0 };
    try { viewport.setPointerCapture(e.pointerId); } catch {}
    updateCursor(e);
    return;
  }
  if (e.button !== 0 && !isPenEraser(e)) { penNote(e, `ignored (button ${e.button})`); return; }
  if (busy || !mounted) { penNote(e, busy ? 'ignored (app busy)' : 'ignored (no shot)'); return; }
  const p = toCanvas(e);

  // Alt-click picks a colour, except with Move, where Alt stretches from the centre.
  if (e.altKey && state.tool !== 'pan' && state.tool !== 'move') { pickColor(p); return; }
  if (state.tool === 'perspective') { gridPointerDown(e, p); return; }
  if (state.tool === 'fill' && !isPenEraser(e)) { fillAt(p); return; }

  if (state.tool === 'move' && !isPenEraser(e)) {
    try { viewport.setPointerCapture(e.pointerId); } catch {}
    beginTransform(e, p);
    return;
  }

  if (state.tool === 'lasso' && !isPenEraser(e)) {
    try { viewport.setPointerCapture(e.pointerId); } catch {}
    // Shift adds to the selection, Ctrl cuts from it, both together keep the
    // overlap (Alt picks a colour, as with the brushes). Without keys, the
    // Lasso panel's mode does.
    const cut = e.ctrlKey || e.metaKey;
    const keyed = e.shiftKey && cut ? 'and' : e.shiftKey ? 'add' : cut ? 'sub' : null;
    const mode = keyed || (state.lassoMode !== 'new' ? state.lassoMode : null);
    if (state.selection && !mode && inSelection(p)) {
      if (!lift) lift = liftSelection();
      if (lift) lift.drag = { id: e.pointerId, x: p.x - lift.dx, y: p.y - lift.dy };
      return;
    }
    if (lift) dropSelection();
    const before = selPolys();
    if (!(mode && state.selection)) setSelection(null);
    lasso = { id: e.pointerId, points: [p], mode: state.selection ? mode : null, before };
    drawLasso();
    return;
  }

  const layer = activeLayer();
  if (!layer.visible) { penNote(e, 'ignored (layer hidden)'); toast('This layer is hidden. Show it to draw on it.'); return; }
  try { viewport.setPointerCapture(e.pointerId); } catch {}
  beginStroke(e, isPenEraser(e) ? state.brushes.eraser : brush());
  penNote(e, `stroke (${state.tool}, ${brush().id})`);
});

// `pointerrawupdate` arrives as soon as the pen reports, instead of waiting for
// the next screen frame like `pointermove` does.
const RAW_EVENTS = 'onpointerrawupdate' in window;

function onDrawEvent(e) {
  if (!stroke || e.pointerId !== stroke.pointerId) return;
  const t0 = performance.now();
  // Pens report many more positions than the screen draws; use all of them.
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const ev of events.length ? events : [e]) addPoint(ev);
  if (perf.on) {
    perf.sample(t0 - e.timeStamp, performance.now() - t0, events.length || 1);
    const dpr = window.devicePixelRatio || 1;
    for (const ev of events.length ? events : [e]) {
      if (ev.pointerType === 'pen') perf.pressures.push(ev.pressure);
      const fx = ev.clientX * dpr;
      perf.positions++;
      if (Math.abs(fx - Math.round(fx)) > 0.01) perf.finer++;
    }
  }
}
if (RAW_EVENTS) viewport.addEventListener('pointerrawupdate', (e) => { if (state.rawEvents) onDrawEvent(e); });

viewport.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') { touchMove(e); return; }
  updateCursor(e);
  if (pan && e.pointerId === pan.id) {
    if (pan.rotate) {
      // Turn around the middle of the viewport, by the angle the pointer swept.
      const r = viewport.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const da = Math.atan2(e.clientY - cy, e.clientX - cx) - Math.atan2(pan.y - cy, pan.x - cx);
      rotateAt(r.width / 2, r.height / 2, Math.atan2(Math.sin(da), Math.cos(da)));
      toast(`Rotation ${Math.round((((state.view.r * 180) / Math.PI) % 360 + 540) % 360 - 180)}°`);
    } else {
      state.view.x += e.clientX - pan.x;
      state.view.y += e.clientY - pan.y;
      state.view.fit = false;
      applyView();
    }
    pan.x = e.clientX;
    pan.y = e.clientY;
    return;
  }
  if (lasso && e.pointerId === lasso.id) {
    const p = toCanvas(e);
    const last = lasso.points[lasso.points.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) > 2 / state.view.z) {
      lasso.points.push(p);
      drawLasso();
    }
    return;
  }
  if (lift && lift.drag && e.pointerId === lift.drag.id) {
    if (lift.drag.p0) { updateTransform(e); return; }
    const p = toCanvas(e);
    lift.dx = p.x - lift.drag.x;
    lift.dy = p.y - lift.drag.y;
    applyLiftStyle(lift);
    if (!lift.whole) drawSelectionOutline(liftedPoints(lift));
    return;
  }
  if (!RAW_EVENTS || !state.rawEvents) onDrawEvent(e);
});

function endPointer(e) {
  if (e.pointerType === 'touch') { touchUp(e); return; }
  if (e.type) penNote(e, stroke && e.pointerId === stroke.pointerId ? `ends stroke (${stroke.segs ?? ''})` : 'no stroke');
  if (pan && e.pointerId === pan.id) {
    // Snap back to upright when close.
    if (pan.rotate) {
      const deg = ((((state.view.r * 180) / Math.PI) % 360) + 540) % 360 - 180;
      if (Math.abs(deg) < 4) {
        const r = viewport.getBoundingClientRect();
        rotateAt(r.width / 2, r.height / 2, (-deg * Math.PI) / 180);
      }
    }
    pan = null;
  }
  if (lasso && e.pointerId === lasso.id) {
    const { points: pts, mode, before } = lasso;
    lasso = null;
    if (mode && state.selection) {
      if (pts.length > 2) combineSelection(mode, pts);
      else drawSelectionOutline(state.selection);
    } else setSelection(pts.length > 2 ? pts : null);
    recordSelection(before);
  }
  if (lift && lift.drag && e.pointerId === lift.drag.id) {
    lift.drag = null;
    // Distort and Warp stay live until Enter or Apply.
    if (meshLive()) { /* keep */ }
    else if (lift.whole) dropWholeLayer();
    else if (lift.group) dropGroup();
    renderMoveBox();
  }
  if (stroke && e.pointerId === stroke.pointerId) endStroke();
}
viewport.addEventListener('pointerup', endPointer);
viewport.addEventListener('pointercancel', endPointer);
viewport.addEventListener('pointerleave', () => { cursorEvent = null; hideCursor(); });
viewport.addEventListener('contextmenu', (e) => e.preventDefault());

// Image files dropped on the canvas become a new layer.
viewport.addEventListener('dragover', (e) => {
  if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault();
});
viewport.addEventListener('drop', async (e) => {
  const video = [...e.dataTransfer.files].find((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name));
  if (video) {
    e.preventDefault();
    await useVideo(window.api.pathForFile(video));
    return;
  }
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
  if (!file) return;
  e.preventDefault();
  try {
    importImage(await createImageBitmap(file), file.name);
  } catch {
    toast(`Could not open ${file.name}`);
  }
});
// Mouse wheel notches glide to the new zoom over a few frames instead of
// jumping; trackpad pinches already arrive as small steps, so they apply as is.
let zoomGlide = null;
function glideZoom(x, y, factor) {
  const from = zoomGlide ? zoomGlide.target : state.view.z;
  const target = clamp(from * factor, 0.03, 8);
  if (!zoomGlide) {
    zoomGlide = { x, y, target, last: performance.now() };
    requestAnimationFrame(stepZoomGlide);
  }
  Object.assign(zoomGlide, { x, y, target });
}
function stepZoomGlide(t) {
  const g = zoomGlide;
  if (!g) return;
  const dt = Math.max(0, t - g.last);
  g.last = t;
  const gap = Math.log(g.target / state.view.z);
  if (Math.abs(gap) < 0.002) {
    zoomAt(g.x, g.y, g.target / state.view.z);
    zoomGlide = null;
    return;
  }
  // Closes most of the gap in about 90ms, whatever the frame rate.
  zoomAt(g.x, g.y, Math.exp(gap * (1 - Math.exp(-dt / 30))));
  requestAnimationFrame(stepZoomGlide);
}

// The scroll wheel works like Photoshop's: scrolling moves the canvas up and
// down, Ctrl (or Shift) moves it sideways, and Alt zooms at the pointer. A
// trackpad pinch arrives as Ctrl with small fractional steps, and zooms.
viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
  const dy = e.deltaY * unit;
  const dx = e.deltaX * unit;
  const notch = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 50;
  const pinch = e.ctrlKey && !notch && !Number.isInteger(e.deltaY);
  if (e.altKey || pinch) {
    const factor = Math.exp(-dy * 0.0015);
    if (notch) glideZoom(e.clientX, e.clientY, factor);
    else { zoomGlide = null; zoomAt(e.clientX, e.clientY, factor); }
    return;
  }
  if (e.ctrlKey || e.shiftKey) state.view.x -= dy || dx;
  else { state.view.y -= dy; state.view.x -= dx; }
  state.view.fit = false;
  applyView();
}, { passive: false });
